import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPublicCatalog, getInternalCatalog } from './lib/sheets.js';
import {
  initDatabase,
  getSettings,
  getPublicSettings,
  updateSettings,
  createOrder,
  listAllOrdersInternal,
  listPublicOrders,
  toPublicOrder,
  updateOrderById,
  getOrderReceiptById,
  softDeleteArchivedOrders,
  checkDatabaseConnection,
} from './lib/db.js';
import {
  isWhatsappRelayConfigured,
  getWhatsappRelayConfig,
  relayOrderToWhatsapp,
} from './lib/whatsapp-relay.js';
import { createMedlinkRouter } from './lib/medlink/router.js';
import { queueWorker } from './lib/medlink/queue.js';
import {
  getOrderByOrderId,
  getOrderStatusMap,
  retryOrderManually,
} from './lib/medlink/store.js';
import { whatsappService } from './lib/medlink/whatsapp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

// Ephemeral fallback signing key when SESSION_SECRET isn't configured in env
const RUNTIME_SESSION_SECRET =
  (process.env.SESSION_SECRET || '').trim() || crypto.randomBytes(32).toString('hex');

const SESSION_COOKIE_NAME = 'chef_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const VALID_PAYMENT_METHODS = new Set([
  'Vodafone Cash',
  'Orange Cash',
  'Etisalat Cash',
  'COD',
]);

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function createSessionToken() {
  const payload = {
    role: 'chef',
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
    nonce: crypto.randomBytes(8).toString('hex'),
  };
  const data = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', RUNTIME_SESSION_SECRET)
    .update(data)
    .digest('base64url');
  return `${data}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [data, sig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', RUNTIME_SESSION_SECRET)
    .update(data)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length) return false;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return false;

  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf-8'));
    if (!payload || payload.role !== 'chef') return false;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyHashedPin(pin, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, keyHex] = storedHash.split(':');
  const keyBuf = Buffer.from(keyHex, 'hex');
  const derivedBuf = crypto.scryptSync(String(pin), salt, 64);
  if (keyBuf.length !== derivedBuf.length) return false;
  return crypto.timingSafeEqual(keyBuf, derivedBuf);
}

function verifyEnvPin(inputPin, envPin) {
  const a = Buffer.from(String(inputPin || ''), 'utf-8');
  const b = Buffer.from(String(envPin || ''), 'utf-8');
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function setSessionCookie(res, token) {
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(
      token
    )}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=None; Partitioned`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None; Partitioned`
  );
}

function extractAuthToken(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice(7).trim();
    if (bearer) return { token: bearer, viaCookie: false };
  }
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[SESSION_COOKIE_NAME]) {
    return { token: cookies[SESSION_COOKIE_NAME], viaCookie: true };
  }
  return { token: null, viaCookie: false };
}

function requireChefAuth(req, res, next) {
  const { token, viaCookie } = extractAuthToken(req);
  if (!token || !verifySessionToken(token)) {
    return res.status(401).json({ error: 'غير مصرح. يرجى تسجيل الدخول أولاً.' });
  }

  // CSRF check for cookie-authenticated mutations
  if (viaCookie && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const xRequestedWith = req.headers['x-requested-with'];
    const origin = req.headers.origin;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    let originOk = false;
    if (origin && host) {
      try {
        originOk = new URL(origin).host === host;
      } catch {
        originOk = false;
      }
    }
    if (!originOk && xRequestedWith !== 'XMLHttpRequest') {
      return res.status(403).json({ error: 'طلب غير موثوق المصدر.' });
    }
  }

  next();
}

function validateReceiptDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return false;
  const match = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return false;
  const base64Data = match[2];
  const approxBytes = Math.floor((base64Data.length * 3) / 4);
  return approxBytes <= 8 * 1024 * 1024;
}

function toChefOrderSummary(order) {
  const { receiptImage, ...rest } = order;
  return {
    ...rest,
    hasReceipt: Boolean(receiptImage),
  };
}

async function startServer() {
  await initDatabase();

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '16mb' }));
  app.use(express.urlencoded({ extended: true, limit: '16mb' }));

  app.use(['/api', '/med-link/api'], (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  });

  // --- Built-in /med-link WhatsApp Relay Router ---
  app.use('/med-link', createMedlinkRouter({ requireAdminAuth: requireChefAuth }));

  // --- Public API Routes ---
  app.get('/api/health', async (_req, res) => {
    const db = await checkDatabaseConnection();
    const relayCfg = getWhatsappRelayConfig();
    const waState = whatsappService.getPublicState();
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      database: {
        mode: db.mode,
        configured: db.configured,
        connected: db.connected,
        storeSettingsOk: db.storeSettingsOk,
        ordersOk: db.ordersOk,
        supportNumberColumnOk: db.supportNumberColumnOk ?? false,
        httpStatus: db.httpStatus ?? null,
      },
      whatsappRelay: {
        configured: isWhatsappRelayConfigured(),
        mode: relayCfg ? relayCfg.mode : null,
        whatsappStatus: waState.status,
      },
    });
  });

  app.get('/api/settings', async (_req, res) => {
    try {
      const settings = await getPublicSettings();
      res.json(settings);
    } catch (err) {
      res.status(500).json({ error: 'تعذر تحميل إعدادات المتجر.' });
    }
  });

  app.get('/api/products', async (req, res) => {
    try {
      const fresh = req.query.fresh === '1' || req.query.fresh === 'true';
      const catalog = await getPublicCatalog({ fresh });
      res.json(catalog);
    } catch (err) {
      res.status(500).json({ error: 'تعذر مزامنة المنتجات من Google Sheets.' });
    }
  });

  app.get('/api/orders', async (req, res) => {
    try {
      const codesParam = String(req.query.codes || '');
      const codes = codesParam
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const phone = String(req.query.phone || '').trim();

      if (codes.length === 0 && !phone) {
        return res.json({ orders: [] });
      }

      const orders = await listPublicOrders({ codes, phone });
      res.json({ orders });
    } catch (err) {
      res.status(500).json({ error: 'تعذر تحميل سجل الطلبات.' });
    }
  });

  app.post('/api/orders', async (req, res) => {
    try {
      const settings = await getPublicSettings();
      if (!settings.isOpen) {
        return res.status(403).json({
          error: `المتجر مغلق حالياً. مواعيد العمل من ${settings.openTime} إلى ${settings.closeTime}.`,
        });
      }

      const {
        customerName,
        customerPhone,
        deliveryAddress,
        deliveryNotes,
        paymentMethod,
        senderWalletPhone,
        receiptImage,
        items,
      } = req.body || {};

      const normalizeDigits = (v) =>
        String(v || '')
          .trim()
          .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
          .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

      const cleanName = String(customerName || '').trim();
      const cleanPhone = normalizeDigits(customerPhone);
      const cleanAddress = String(deliveryAddress || '').trim();
      const cleanNotes = String(deliveryNotes || '').trim();
      const cleanMethod = String(paymentMethod || '').trim();
      const cleanWalletPhone = normalizeDigits(senderWalletPhone);

      if (!cleanName || cleanName.length < 2) {
        return res.status(400).json({ error: 'يرجى إدخال الاسم بالكامل.' });
      }
      if (!cleanPhone || cleanPhone.replace(/\D/g, '').length < 8) {
        return res.status(400).json({ error: 'يرجى إدخال رقم هاتف صحيح.' });
      }
      if (!cleanAddress || cleanAddress.length < 5) {
        return res.status(400).json({ error: 'يرجى إدخال عنوان التوصيل بالتفصيل.' });
      }
      if (!VALID_PAYMENT_METHODS.has(cleanMethod)) {
        return res.status(400).json({ error: 'وسيلة الدفع غير صالحة.' });
      }
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'السلة فارغة.' });
      }

      const isElectronic = cleanMethod !== 'COD';
      if (isElectronic) {
        if (!cleanWalletPhone || cleanWalletPhone.replace(/\D/g, '').length < 8) {
          return res.status(400).json({ error: 'يرجى إدخال رقم المحفظة أو الحساب المُحوّل منه.' });
        }
        if (!validateReceiptDataUrl(receiptImage)) {
          return res.status(400).json({
            error: 'يرجى إرفاق صورة إيصال التحويل صالحة (بحد أقصى 8 ميجابايت).',
          });
        }
      }

      const catalog = await getInternalCatalog({ fresh: false });
      const catalogById = new Map(catalog.products.map((p) => [p.id, p]));
      const catalogBySlug = new Map(catalog.products.map((p) => [p.slug, p]));

      const normalizedItems = [];
      let subtotal = 0;
      let totalProfit = 0;

      for (const reqItem of items) {
        const qty = Math.floor(Number(reqItem.quantity));
        if (!Number.isFinite(qty) || qty < 1 || qty > 99) {
          return res.status(400).json({ error: 'كمية المنتج غير صالحة.' });
        }

        const product =
          catalogById.get(reqItem.productId) || catalogBySlug.get(reqItem.slug);
        if (!product) {
          return res.status(400).json({ error: 'أحد المنتجات في السلة لم يعد متاحاً.' });
        }

        const unitPrice = Number(product.price);
        const unitProfitSnapshot = Number(product.profit);
        const lineTotal = Math.round(unitPrice * qty * 100) / 100;

        subtotal += lineTotal;
        totalProfit += Math.round(unitProfitSnapshot * qty * 100) / 100;

        normalizedItems.push({
          productId: product.id,
          slug: product.slug,
          name: product.name,
          category: product.category,
          unitPrice,
          quantity: qty,
          lineTotal,
          unitProfitSnapshot,
        });
      }

      subtotal = Math.round(subtotal * 100) / 100;
      totalProfit = Math.round(totalProfit * 100) / 100;
      const deliveryFee = Number(settings.deliveryFee || 0);
      const grandTotal = Math.round((subtotal + deliveryFee) * 100) / 100;

      const created = await createOrder({
        customerName: cleanName,
        customerPhone: cleanPhone,
        deliveryAddress: cleanAddress,
        deliveryNotes: cleanNotes,
        paymentMethod: cleanMethod,
        senderWalletPhone: isElectronic ? cleanWalletPhone : '',
        receiptImage: isElectronic ? receiptImage : '',
        items: normalizedItems,
        subtotal,
        deliveryFee,
        grandTotal,
        totalProfit,
      });

      // Server-side WhatsApp notification relay (builtin queues in-process in ~1ms; external runs non-blocking)
      const relayCfg = getWhatsappRelayConfig();
      if (relayCfg && relayCfg.mode === 'external') {
        void relayOrderToWhatsapp(created);
      } else {
        await relayOrderToWhatsapp(created);
      }

      res.status(201).json({ order: toPublicOrder(created) });
    } catch (err) {
      console.error('[api/orders POST]', err);
      res.status(500).json({ error: 'حدث خطأ أثناء إرسال الطلب. حاول مرة أخرى.' });
    }
  });

  // --- Chef / Admin Authentication Endpoints ---
  app.get('/api/chef/auth/status', async (req, res) => {
    const envPin = (process.env.CHEF_PIN || '').trim();
    const settings = await getSettings();
    const { token } = extractAuthToken(req);
    const authenticated = Boolean(token && verifySessionToken(token));

    res.json({
      authenticated,
      envPinConfigured: Boolean(envPin),
      needsPinSetup: !envPin && !settings.adminPinHash,
    });
  });

  app.post('/api/chef/setup-pin', async (req, res) => {
    const envPin = (process.env.CHEF_PIN || '').trim();
    if (envPin) {
      return res.status(403).json({
        error: 'تم ضبط رمز الدخول عبر متغير البيئة CHEF_PIN بالفعل.',
      });
    }

    const settings = await getSettings();
    if (settings.adminPinHash) {
      return res.status(403).json({ error: 'تم إعداد رمز الدخول مسبقاً.' });
    }

    const pin = String((req.body && req.body.pin) || '').trim();
    if (pin.length < 4 || pin.length > 32) {
      return res.status(400).json({ error: 'يجب أن يتكون رمز الدخول من 4 أحرف أو أرقام على الأقل.' });
    }

    await updateSettings({ adminPinHash: hashPin(pin) });
    const token = createSessionToken();
    setSessionCookie(res, token);
    res.json({ authenticated: true, token });
  });

  app.post('/api/chef/auth', async (req, res) => {
    const pin = String((req.body && req.body.pin) || '').trim();
    if (!pin) {
      return res.status(400).json({ error: 'يرجى إدخال رمز الدخول.' });
    }

    const envPin = (process.env.CHEF_PIN || '').trim();
    const settings = await getSettings();

    let valid = false;
    if (envPin) {
      valid = verifyEnvPin(pin, envPin);
    } else if (settings.adminPinHash) {
      valid = verifyHashedPin(pin, settings.adminPinHash);
    } else {
      return res.status(403).json({ error: 'لم يتم إعداد رمز الدخول بعد.' });
    }

    if (!valid) {
      return res.status(401).json({ error: 'رمز الدخول غير صحيح.' });
    }

    const token = createSessionToken();
    setSessionCookie(res, token);
    res.json({ authenticated: true, token });
  });

  app.post('/api/chef/logout', (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // --- Protected Chef / Admin API Endpoints ---
  app.get('/api/chef/orders', requireChefAuth, async (_req, res) => {
    try {
      const [orders, settings] = await Promise.all([
        listAllOrdersInternal(),
        getSettings(),
      ]);
      const waMap = getOrderStatusMap();
      const enrichedOrders = orders.map((o) => {
        const wa = waMap.get(o.orderCode);
        return {
          ...toChefOrderSummary(o),
          whatsappStatus: wa ? wa.status : 'none',
          whatsappLastError: wa ? wa.lastError : '',
          whatsappSentAt: wa ? wa.sentAt : null,
        };
      });
      const { adminPinHash, ...safeSettings } = settings;
      res.json({
        orders: enrichedOrders,
        settings: safeSettings,
        whatsappConnectionStatus: whatsappService.getPublicState().status,
      });
    } catch (err) {
      res.status(500).json({ error: 'تعذر تحميل الطلبات.' });
    }
  });

  app.get('/api/chef/orders/:id/receipt', requireChefAuth, async (req, res) => {
    try {
      const receiptImage = await getOrderReceiptById(req.params.id);
      if (!receiptImage) {
        return res.status(404).json({ error: 'صورة الإيصال غير متوفرة.' });
      }
      res.json({ receiptImage });
    } catch (err) {
      res.status(500).json({ error: 'تعذر تحميل صورة الإيصال.' });
    }
  });

  app.post('/api/chef/orders/:id/whatsapp', requireChefAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const orders = await listAllOrdersInternal();
      const target = orders.find((o) => o.id === id || o.orderCode === id);
      if (!target) {
        return res.status(404).json({ error: 'الطلب غير موجود.' });
      }

      const existing = getOrderByOrderId(target.orderCode);
      if (existing) {
        if (existing.status === 'sent') {
          return res.json({ ok: true, status: 'sent', alreadySent: true });
        }
        const retried = retryOrderManually(target.orderCode);
        void queueWorker.trigger();
        return res.status(202).json({
          ok: true,
          status: retried ? retried.status : 'pending',
          retried: true,
        });
      }

      const relayRes = await relayOrderToWhatsapp(target);
      if (!relayRes.ok) {
        return res.status(502).json({
          error: 'تعذر تمرير الطلب إلى أداة الواتساب.',
        });
      }

      res.status(202).json({ ok: true, status: 'pending', queued: true });
    } catch (err) {
      res.status(500).json({ error: 'حدث خطأ أثناء إرسال الطلب إلى الواتساب.' });
    }
  });

  app.patch('/api/chef/orders/:id', requireChefAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const { action, rejectionReason } = req.body || {};

      let patch = null;
      if (action === 'start') {
        patch = { status: 'In Progress' };
      } else if (action === 'finish') {
        patch = {
          status: 'Finished',
          isPaid: true,
          completedAt: new Date().toISOString(),
        };
      } else if (action === 'reject') {
        const cleanReason = String(rejectionReason || '').trim();
        if (!cleanReason) {
          return res.status(400).json({ error: 'يجب كتابة سبب الرفض.' });
        }
        patch = {
          status: 'Rejected',
          rejectionReason: cleanReason,
        };
      } else if (action === 'archive') {
        patch = { isArchived: true };
      } else {
        return res.status(400).json({ error: 'إجراء غير معروف.' });
      }

      const updated = await updateOrderById(id, patch);
      if (!updated) {
        return res.status(404).json({ error: 'الطلب غير موجود.' });
      }
      const wa = getOrderStatusMap().get(updated.orderCode);
      res.json({
        order: {
          ...toChefOrderSummary(updated),
          whatsappStatus: wa ? wa.status : 'none',
          whatsappLastError: wa ? wa.lastError : '',
          whatsappSentAt: wa ? wa.sentAt : null,
        },
      });
    } catch (err) {
      res.status(500).json({ error: 'تعذر تحديث حالة الطلب.' });
    }
  });

  app.delete('/api/chef/orders/:id', requireChefAuth, async (req, res) => {
    try {
      const count = await softDeleteArchivedOrders([req.params.id]);
      if (count === 0) {
        return res.status(404).json({ error: 'الطلب غير موجود.' });
      }
      res.json({ ok: true, deletedCount: count });
    } catch (err) {
      res.status(500).json({ error: 'تعذر حذف الطلب.' });
    }
  });

  app.post('/api/chef/orders/bulk-delete', requireChefAuth, async (req, res) => {
    try {
      const { ids, clearAllArchive } = req.body || {};
      let targetIds = [];
      if (clearAllArchive) {
        const all = await listAllOrdersInternal();
        targetIds = all.filter((o) => o.isArchived).map((o) => o.id);
      } else if (Array.isArray(ids)) {
        targetIds = ids.map((v) => String(v));
      }

      if (targetIds.length === 0) {
        return res.json({ ok: true, deletedCount: 0 });
      }

      const deletedCount = await softDeleteArchivedOrders(targetIds);
      res.json({ ok: true, deletedCount });
    } catch (err) {
      res.status(500).json({ error: 'تعذر تنفيذ الحذف الجماعي.' });
    }
  });

  app.get('/api/chef/analytics', requireChefAuth, async (req, res) => {
    try {
      const period = String(req.query.period || 'today');
      const [orders, settings] = await Promise.all([
        listAllOrdersInternal(),
        getSettings(),
      ]);

      const now = new Date();
      let startMs = 0;
      if (period === 'today') {
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        startMs = startOfDay.getTime();
      } else if (period === '7d') {
        startMs = now.getTime() - 7 * 24 * 60 * 60 * 1000;
      } else if (period === '30d') {
        startMs = now.getTime() - 30 * 24 * 60 * 60 * 1000;
      }

      const resetMs = settings.profitResetAt ? new Date(settings.profitResetAt).getTime() : 0;
      const effectiveStartMs = Math.max(startMs, resetMs);

      const finishedOrders = orders.filter((o) => {
        if (o.status !== 'Finished') return false;
        const ts = new Date(o.completedAt || o.updatedAt || o.createdAt).getTime();
        return ts >= effectiveStartMs;
      });

      let totalSalesRevenue = 0;
      let totalNetProfit = 0;
      let totalItemsSold = 0;
      const soldProductsLog = [];

      for (const o of finishedOrders) {
        const saleDate = o.completedAt || o.updatedAt || o.createdAt;
        totalSalesRevenue += Number(o.grandTotal || 0);

        for (const item of o.items || []) {
          const qty = Number(item.quantity || 0);
          const unitPrice = Number(item.unitPrice || 0);
          const lineTotal = Number(item.lineTotal || unitPrice * qty);
          const unitProfit = Number(item.unitProfitSnapshot || 0);
          const lineProfit = Math.round(unitProfit * qty * 100) / 100;

          totalItemsSold += qty;
          totalNetProfit += lineProfit;

          soldProductsLog.push({
            orderId: o.id,
            orderCode: o.orderCode,
            productName: item.name,
            category: item.category,
            quantity: qty,
            unitPrice,
            lineTotal,
            unitProfit,
            lineProfit,
            saleDate,
          });
        }
      }

      totalSalesRevenue = Math.round(totalSalesRevenue * 100) / 100;
      totalNetProfit = Math.round(totalNetProfit * 100) / 100;
      const profitMarginPercent =
        totalSalesRevenue > 0
          ? Math.round((totalNetProfit / totalSalesRevenue) * 1000) / 10
          : 0;

      res.json({
        period,
        profitResetAt: settings.profitResetAt,
        kpis: {
          totalSalesRevenue,
          totalNetProfit,
          profitMarginPercent,
          completedOrdersCount: finishedOrders.length,
          totalItemsSold,
        },
        completedOrders: finishedOrders.map(toChefOrderSummary),
        soldProductsLog,
      });
    } catch (err) {
      res.status(500).json({ error: 'تعذر حساب تحليلات المبيعات والأرباح.' });
    }
  });

  app.post('/api/chef/sales-profits/reset', requireChefAuth, async (_req, res) => {
    try {
      const updated = await updateSettings({
        profitResetAt: new Date().toISOString(),
      });
      res.json({ ok: true, profitResetAt: updated.profitResetAt });
    } catch (err) {
      res.status(500).json({ error: 'تعذر تصفير عداد الأرباح.' });
    }
  });

  app.get('/api/chef/settings', requireChefAuth, async (_req, res) => {
    try {
      const settings = await getSettings();
      const { adminPinHash, ...safeSettings } = settings;
      res.json({ settings: safeSettings });
    } catch (err) {
      res.status(500).json({ error: 'تعذر تحميل الإعدادات.' });
    }
  });

  app.put('/api/chef/settings', requireChefAuth, async (req, res) => {
    try {
      const {
        isOpen,
        openTime,
        closeTime,
        customerNote,
        deliveryFee,
        transferNumber,
        supportNumber,
      } = req.body || {};

      const parsedFee = Number(deliveryFee);
      if (!Number.isFinite(parsedFee) || parsedFee < 0 || parsedFee > 10000) {
        return res.status(400).json({ error: 'قيمة رسوم التوصيل غير صالحة.' });
      }

      const cleanTransfer = String(transferNumber || '').trim();
      if (!cleanTransfer || cleanTransfer.replace(/\D/g, '').length < 6) {
        return res.status(400).json({ error: 'يرجى إدخال رقم تحويل صحيح.' });
      }

      const cleanSupport = String(supportNumber || '').trim();
      if (!cleanSupport || cleanSupport.replace(/\D/g, '').length < 6) {
        return res.status(400).json({ error: 'يرجى إدخال رقم خدمة العملاء والشكاوى بشكل صحيح.' });
      }

      const nextIsOpen = Boolean(isOpen);

      const updated = await updateSettings({
        isOpen: nextIsOpen,
        openTime: String(openTime || '11:00 ص').trim(),
        closeTime: String(closeTime || '02:00 ص').trim(),
        customerNote: String(customerNote || '').trim(),
        deliveryFee: Math.round(parsedFee * 100) / 100,
        transferNumber: cleanTransfer,
        supportNumber: cleanSupport,
      });

      let clearedArchiveCount = 0;
      if (!nextIsOpen) {
        const allOrders = await listAllOrdersInternal();
        const archivedIds = allOrders.filter((o) => o.isArchived).map((o) => o.id);
        if (archivedIds.length > 0) {
          clearedArchiveCount = await softDeleteArchivedOrders(archivedIds);
        }
      }

      const { adminPinHash, ...safeSettings } = updated;
      res.json({ settings: safeSettings, clearedArchiveCount });
    } catch (err) {
      res.status(500).json({ error: 'تعذر حفظ إعدادات المتجر.' });
    }
  });

  app.get('/api/chef/catalog', requireChefAuth, async (req, res) => {
    try {
      const fresh = req.query.fresh === '1' || req.query.fresh === 'true';
      const catalog = await getInternalCatalog({ fresh });
      res.json(catalog);
    } catch (err) {
      res.status(500).json({ error: 'تعذر تحميل الكتالوج الداخلي.' });
    }
  });

  // --- Frontend Serving (Dev Vite Middleware / Production dist/) ---
  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'custom',
    });

    app.use(vite.middlewares);

    app.get('/chef', async (req, res, next) => {
      try {
        const htmlPath = path.resolve(__dirname, 'chef.html');
        let template = fs.readFileSync(htmlPath, 'utf-8');
        template = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e) {
        vite.ssrFixStacktrace(e);
        next(e);
      }
    });

    app.get(['/med-link', '/med-link/*'], async (req, res, next) => {
      if (req.path.startsWith('/med-link/api/')) return next();
      try {
        const htmlPath = path.resolve(__dirname, 'med-link.html');
        let template = fs.readFileSync(htmlPath, 'utf-8');
        template = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e) {
        vite.ssrFixStacktrace(e);
        next(e);
      }
    });

    app.get('*', async (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/med-link/api/')) return next();
      try {
        const htmlPath = path.resolve(__dirname, 'index.html');
        let template = fs.readFileSync(htmlPath, 'utf-8');
        template = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e) {
        vite.ssrFixStacktrace(e);
        next(e);
      }
    });
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir, { index: false }));

    app.get('/chef', (_req, res) => {
      res.sendFile(path.join(distDir, 'chef.html'));
    });

    app.get(['/med-link', '/med-link/*'], (req, res, next) => {
      if (req.path.startsWith('/med-link/api/')) return next();
      res.sendFile(path.join(distDir, 'med-link.html'));
    });

    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/med-link/api/')) return next();
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  queueWorker.start();
  void whatsappService.initializeIfSavedSession();
  void getInternalCatalog({ fresh: false }).catch(() => {});

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Halabiya Grill server running at http://0.0.0.0:${PORT}`);
  });

  const gracefulShutdown = async () => {
    queueWorker.stop();
    await whatsappService.shutdown();
    server.close(() => process.exit(0));
  };
  process.once('SIGTERM', () => { void gracefulShutdown(); });
  process.once('SIGINT', () => { void gracefulShutdown(); });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
