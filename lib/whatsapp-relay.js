import net from 'node:net';
import {
  INTERNAL_MEDLINK_BRIDGE_TOKEN,
  enqueueIncomingOrderPayload,
} from './medlink/router.js';

const ARABIC_WALLET_NAMES = {
  'Vodafone Cash': 'فودافون كاش',
  'Orange Cash': 'أورانج كاش',
  'Etisalat Cash': 'اتصالات كاش',
};

function isBlockedIpLiteral(host) {
  const clean = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!net.isIP(clean)) return false;

  if (net.isIPv4(clean)) {
    const parts = clean.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }

  if (clean === '::1' || clean === '::') return true;
  if (clean.startsWith('::ffff:')) {
    return isBlockedIpLiteral(clean.slice(7));
  }
  if (
    clean.startsWith('fc') ||
    clean.startsWith('fd') ||
    clean.startsWith('fe8') ||
    clean.startsWith('fe9') ||
    clean.startsWith('fea') ||
    clean.startsWith('feb')
  ) {
    return true;
  }
  return false;
}

export function resolveWhatsappRelayEndpoint(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) return null;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    isBlockedIpLiteral(host)
  ) {
    return null;
  }

  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  if (
    cleanPath.endsWith('/887med-link999/api/orders') ||
    cleanPath.endsWith('/med-link/api/orders') ||
    cleanPath.endsWith('/api/orders')
  ) {
    parsed.pathname = cleanPath;
  } else if (cleanPath.endsWith('/887med-link999') || cleanPath.endsWith('/med-link')) {
    parsed.pathname = `${cleanPath}/api/orders`;
  } else {
    parsed.pathname = `${cleanPath}/887med-link999/api/orders`;
  }

  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

export function getWhatsappRelayConfig() {
  const externalEndpoint = resolveWhatsappRelayEndpoint(process.env.WHATSAPP_RELAY_URL);
  const secret = String(
    process.env.WHATSAPP_RELAY_SECRET || process.env.WEBHOOK_SECRET || ''
  ).trim();

  if (externalEndpoint && secret) {
    return {
      mode: 'external',
      endpointUrl: externalEndpoint,
      secret,
    };
  }

  const port = Number(process.env.PORT || 3000);
  return {
    mode: 'builtin',
    endpointUrl: `http://127.0.0.1:${port}/887med-link999/api/orders`,
    secret,
    internalToken: INTERNAL_MEDLINK_BRIDGE_TOKEN,
  };
}

export function isWhatsappRelayConfigured() {
  return Boolean(getWhatsappRelayConfig());
}

export function normalizePaymentReceiptForRelay(receiptImage) {
  const raw = String(receiptImage || '').trim();
  if (!raw) return '';
  if (/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(raw)) {
    return raw;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
  } catch {
    // Not a valid http/https URL
  }
  return '';
}

export function buildWhatsappOrderPayload(order) {
  const isCod = order.paymentMethod === 'COD';
  const walletName = isCod
    ? ''
    : ARABIC_WALLET_NAMES[order.paymentMethod] || String(order.paymentMethod || '').trim();

  const paymentMethodLabel = isCod ? 'كاش عند الاستلام' : 'تحويل محفظة إلكترونية';
  const transferReference = isCod ? '' : String(order.senderWalletPhone || '').trim();
  const paymentReceiptUrl = isCod ? '' : normalizePaymentReceiptForRelay(order.receiptImage);

  return {
    orderId: String(order.orderCode || order.id || '').trim(),
    customerName: String(order.customerName || '').trim(),
    customerPhone: String(order.customerPhone || '').trim(),
    deliveryAddress: String(order.deliveryAddress || '').trim(),
    items: (Array.isArray(order.items) ? order.items : []).map((it) => ({
      name: String(it.name || '').trim(),
      quantity: Number(it.quantity || 1),
      price: Number(it.unitPrice ?? it.price ?? 0),
      notes: String(it.notes || '').trim(),
    })),
    subtotal: Number(order.subtotal || 0),
    deliveryFee: Number(order.deliveryFee || 0),
    totalAmount: Number(order.grandTotal ?? order.totalAmount ?? 0),
    currency: 'ج.م',
    customerNotes: String(order.deliveryNotes || '').trim(),
    paymentMethod: paymentMethodLabel,
    walletName,
    transferReference,
    paymentReceiptUrl,
  };
}

export async function relayOrderToWhatsapp(order) {
  const cfg = getWhatsappRelayConfig();
  if (!cfg) {
    return { ok: false, skipped: true, reason: 'not_configured' };
  }

  const payload = buildWhatsappOrderPayload(order);

  if (cfg.mode === 'builtin') {
    try {
      const result = await enqueueIncomingOrderPayload(payload);
      if (result.httpStatus === 202 || result.httpStatus === 200) {
        return { ok: true, status: result.httpStatus, queued: true, mode: 'builtin' };
      }
      if (result.httpStatus === 409) {
        return { ok: true, status: 409, duplicate: true, mode: 'builtin' };
      }
      console.warn(
        `[whatsapp-relay] Builtin relay responded ${result.httpStatus} for ${payload.orderId}:`,
        result.body && result.body.message ? result.body.message : ''
      );
      return { ok: false, status: result.httpStatus, mode: 'builtin' };
    } catch (err) {
      console.warn(
        `[whatsapp-relay] Builtin relay error for ${payload.orderId}:`,
        err && err.message ? err.message : 'error'
      );
      return { ok: false, error: err && err.message ? err.message : 'error' };
    }
  }

  const headers = {
    'Content-Type': 'application/json',
  };
  if (cfg.secret) {
    headers['X-Webhook-Secret'] = cfg.secret;
  }
  if (cfg.internalToken) {
    headers['X-Medlink-Internal'] = cfg.internalToken;
  }

  try {
    const res = await fetch(cfg.endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 202 || res.ok) {
      return { ok: true, status: res.status, queued: true, mode: cfg.mode };
    }

    if (res.status === 409) {
      return { ok: true, status: 409, duplicate: true, mode: cfg.mode };
    }

    const errText = await res.text().catch(() => '');
    console.warn(
      `[whatsapp-relay] Relay (${cfg.mode}) responded ${res.status} for ${payload.orderId}: ${errText.slice(0, 200)}`
    );
    return { ok: false, status: res.status, mode: cfg.mode };
  } catch (err) {
    console.warn(
      `[whatsapp-relay] Failed relaying order ${payload.orderId}:`,
      err && err.message ? err.message : 'network error'
    );
    return { ok: false, error: err && err.message ? err.message : 'network error' };
  }
}
