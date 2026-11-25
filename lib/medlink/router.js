import express from 'express';
import crypto from 'node:crypto';
import { formatArabicOrderMessage } from './formatter.js';
import { validateReceiptInputSafety } from './media.js';
import { maskPhone, toWhatsAppJid } from './phone.js';
import { queueWorker } from './queue.js';
import {
  createQueuedOrder,
  generateAndStoreWebhookSecret,
  getAppConfig,
  getOrderStats,
  getWebhookSecretHash,
  listOrders,
  listRecentLogs,
  retryOrderManually,
  updateAppConfig,
} from './store.js';
import {
  configUpdateSchema,
  incomingOrderSchema,
  testMessageSchema,
} from './validation.js';
import { whatsappService } from './whatsapp.js';

// Per-process bridge token so internal server-to-server dispatch works even before an external secret is generated
export const INTERNAL_MEDLINK_BRIDGE_TOKEN = crypto.randomBytes(32).toString('hex');

function timingSafeCompare(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function getWebhookSecretSource() {
  if (String(process.env.WHATSAPP_RELAY_SECRET || '').trim()) return 'env';
  if (String(process.env.WEBHOOK_SECRET || '').trim()) return 'env';
  if (getWebhookSecretHash()) return 'stored';
  return 'none';
}

function verifyWebhookRequest(req) {
  // Allow trusted internal server-side bridge token from same Node process
  const bridgeHeader = String(req.header('x-medlink-internal') || '').trim();
  if (bridgeHeader && timingSafeCompare(bridgeHeader, INTERNAL_MEDLINK_BRIDGE_TOKEN)) {
    return { authorized: true };
  }

  const envSecret = String(
    process.env.WHATSAPP_RELAY_SECRET || process.env.WEBHOOK_SECRET || ''
  ).trim();
  const storedHash = getWebhookSecretHash();

  if (!envSecret && !storedHash) {
    return {
      authorized: false,
      notConfigured: true,
      reason: 'لم يتم إنشاء Webhook Secret بعد في إعدادات أداة الواتساب.',
    };
  }

  let candidate = String(req.header('x-webhook-secret') || '').trim();
  if (!candidate) {
    const authHeader = String(req.header('authorization') || '').trim();
    const bearer = authHeader.match(/^Bearer\s+(.+)$/i);
    if (bearer) candidate = bearer[1].trim();
  }

  if (!candidate) {
    return {
      authorized: false,
      reason: 'ترويسة X-Webhook-Secret مفقودة.',
    };
  }

  if (envSecret && timingSafeCompare(candidate, envSecret)) {
    return { authorized: true };
  }

  if (storedHash) {
    const candidateHash = crypto.createHash('sha256').update(candidate).digest('hex');
    if (timingSafeCompare(candidateHash, storedHash)) {
      return { authorized: true };
    }
  }

  return { authorized: false, reason: 'قيمة X-Webhook-Secret غير صحيحة.' };
}

export async function enqueueIncomingOrderPayload(rawBody) {
  const parsed = incomingOrderSchema.safeParse(rawBody);
  if (!parsed.success) {
    return {
      httpStatus: 400,
      body: {
        ok: false,
        error: 'VALIDATION_ERROR',
        message: 'Invalid order payload',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    };
  }

  const orderPayload = parsed.data;
  if (orderPayload.paymentReceiptUrl) {
    try {
      await validateReceiptInputSafety(orderPayload.paymentReceiptUrl);
    } catch (err) {
      return {
        httpStatus: 400,
        body: {
          ok: false,
          error: 'INVALID_RECEIPT_IMAGE',
          message: err instanceof Error ? err.message : 'Invalid receipt image',
        },
      };
    }
  }

  const formattedMessage = formatArabicOrderMessage(orderPayload);
  const { created, order } = createQueuedOrder(orderPayload, formattedMessage);

  if (!created) {
    return {
      httpStatus: 409,
      body: {
        ok: false,
        error: 'DUPLICATE_ORDER',
        message: `الطلب ${order.order_id} مسجل مسبقاً في طابور الإشعارات.`,
        orderId: order.order_id,
        status: order.status,
      },
    };
  }

  void queueWorker.trigger();

  return {
    httpStatus: 202,
    body: {
      ok: true,
      queued: true,
      orderId: order.order_id,
      status: order.status,
      whatsappStatus: whatsappService.getPublicState().status,
    },
  };
}

export function createMedlinkRouter({ requireAdminAuth }) {
  const router = express.Router();

  // Health endpoint for med-link subsystem
  router.get('/api/health', (_req, res) => {
    const wa = whatsappService.getPublicState();
    res.json({
      ok: true,
      whatsappStatus: wa.status,
      qrReady: Boolean(wa.qrDataUrl),
      statusDetail: wa.statusDetail,
      stats: getOrderStats(),
    });
  });

  // Order Webhook: POST /med-link/api/orders
  router.post('/api/orders', async (req, res) => {
    const authCheck = verifyWebhookRequest(req);
    if (!authCheck.authorized) {
      if (authCheck.notConfigured) {
        return res.status(503).json({
          ok: false,
          error: 'WEBHOOK_NOT_CONFIGURED',
          message: authCheck.reason,
        });
      }
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: authCheck.reason || 'Unauthorized webhook request',
      });
    }

    const result = await enqueueIncomingOrderPayload(req.body);
    return res.status(result.httpStatus).json(result.body);
  });

  // --- Admin-Protected Dashboard Routes (/med-link/api/*) ---
  router.get('/api/whatsapp/status', requireAdminAuth, (_req, res) => {
    res.json({
      ok: true,
      ...whatsappService.getPublicState(),
      stats: getOrderStats(),
    });
  });

  router.post('/api/whatsapp/connect', requireAdminAuth, (_req, res) => {
    void whatsappService.connectFresh(true);
    res.status(202).json({
      ok: true,
      message: 'جاري تشغيل جلسة واتساب وتوليد رمز QR...',
      ...whatsappService.getPublicState(),
    });
  });

  router.post('/api/whatsapp/disconnect', requireAdminAuth, async (_req, res) => {
    await whatsappService.disconnectAndClearSession();
    res.json({
      ok: true,
      message: 'تم قطع اتصال واتساب ومسح الجلسة.',
      ...whatsappService.getPublicState(),
    });
  });

  router.post('/api/whatsapp/test', requireAdminAuth, async (req, res) => {
    if (!whatsappService.isConnected()) {
      return res.status(409).json({
        ok: false,
        error: 'واتساب غير متصل. يرجى مسح رمز QR أولاً.',
      });
    }
    const parsed = testMessageSchema.safeParse(req.body || {});
    const cfg = getAppConfig();
    const recipientJid = toWhatsAppJid(cfg.recipientNumber, cfg.defaultCountryCode);
    const text =
      (parsed.success && parsed.data.message) ||
      'رسالة اختبار من أداة حلبية للواتساب — الاتصال يعمل بنجاح ✅';
    try {
      const result = await whatsappService.sendText(recipientJid, text);
      res.json({
        ok: true,
        messageId: result.messageId,
        recipient: cfg.recipientNumber,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'فشل إرسال رسالة الاختبار.',
      });
    }
  });

  router.get('/api/config', requireAdminAuth, (_req, res) => {
    const cfg = getAppConfig();
    let senderJidPreview = '';
    let recipientJidPreview = '';
    try {
      senderJidPreview = maskPhone(toWhatsAppJid(cfg.senderNumber, cfg.defaultCountryCode));
    } catch {
      senderJidPreview = '—';
    }
    try {
      recipientJidPreview = toWhatsAppJid(cfg.recipientNumber, cfg.defaultCountryCode);
    } catch {
      recipientJidPreview = '—';
    }
    res.json({
      ok: true,
      ...cfg,
      senderJidPreview,
      recipientJidPreview,
      webhookSecretSource: getWebhookSecretSource(),
    });
  });

  router.put('/api/config', requireAdminAuth, (req, res) => {
    const parsed = configUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error: parsed.error.issues[0]?.message || 'بيانات الإعدادات غير صالحة.',
      });
    }
    const updated = updateAppConfig(parsed.data);
    res.json({
      ok: true,
      ...updated,
      senderJidPreview: maskPhone(toWhatsAppJid(updated.senderNumber, updated.defaultCountryCode)),
      recipientJidPreview: toWhatsAppJid(updated.recipientNumber, updated.defaultCountryCode),
      webhookSecretSource: getWebhookSecretSource(),
    });
  });

  router.post('/api/config/webhook-secret', requireAdminAuth, (_req, res) => {
    const secret = generateAndStoreWebhookSecret();
    res.json({
      ok: true,
      secret,
      webhookSecretSource: getWebhookSecretSource(),
    });
  });

  router.get('/api/orders', requireAdminAuth, (req, res) => {
    const status = String(req.query.status || 'all');
    const search = String(req.query.search || '');
    const orders = listOrders({ status, search, limit: 150 });
    const stats = getOrderStats();
    const logs = listRecentLogs(40);
    res.json({ ok: true, orders, stats, logs });
  });

  router.post('/api/orders/:orderId/retry', requireAdminAuth, (req, res) => {
    const order = retryOrderManually(req.params.orderId);
    if (!order) {
      return res.status(404).json({ ok: false, error: 'الطلب غير موجود في الطابور.' });
    }
    void queueWorker.trigger();
    res.json({ ok: true, orderId: order.order_id, status: order.status });
  });

  return router;
}
