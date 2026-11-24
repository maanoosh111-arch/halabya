import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const PRIMARY_DATA_DIR = path.resolve(process.cwd(), 'data');
const FALLBACK_DATA_DIR = path.join(os.tmpdir(), 'halabiya-medlink-data');

function resolveWritableDataDir() {
  for (const dir of [PRIMARY_DATA_DIR, FALLBACK_DATA_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.medlink-write-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
      return dir;
    } catch {
      // Try next directory
    }
  }
  return FALLBACK_DATA_DIR;
}

const DATA_DIR = resolveWritableDataDir();
const STORE_FILE = path.join(DATA_DIR, 'medlink.json');
const PRIMARY_STORE_FILE = path.join(PRIMARY_DATA_DIR, 'medlink.json');

const DEFAULT_CONFIG = {
  senderNumber: (process.env.DEFAULT_SENDER_NUMBER || '01204457813').trim(),
  recipientNumber: (process.env.DEFAULT_RECIPIENT_NUMBER || '010 15678913').trim(),
  defaultCountryCode: (process.env.DEFAULT_COUNTRY_CODE || '20').trim(),
  webhookSecretHash: null,
  whatsappAuthenticated: false,
  whatsappManualDisconnect: false,
};

let store = {
  config: { ...DEFAULT_CONFIG },
  orders: [],
  logs: [],
  nextOrderId: 1,
  nextLogId: 1,
};

let saveInFlight = null;
let savePending = false;

function saveStoreSync() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const tmp = `${STORE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf-8');
    fs.renameSync(tmp, STORE_FILE);
  } catch (err) {
    console.warn('[medlink-store] Failed saving store:', err.message);
  }
}

function loadStore() {
  try {
    const sourceFile = fs.existsSync(STORE_FILE)
      ? STORE_FILE
      : fs.existsSync(PRIMARY_STORE_FILE)
        ? PRIMARY_STORE_FILE
        : null;
    if (sourceFile) {
      const raw = fs.readFileSync(sourceFile, 'utf-8');
      const parsed = JSON.parse(raw);
      store = {
        config: { ...DEFAULT_CONFIG, ...(parsed.config || {}) },
        orders: Array.isArray(parsed.orders) ? parsed.orders : [],
        logs: Array.isArray(parsed.logs) ? parsed.logs : [],
        nextOrderId: Number.isFinite(Number(parsed.nextOrderId)) ? Number(parsed.nextOrderId) : 1,
        nextLogId: Number.isFinite(Number(parsed.nextLogId)) ? Number(parsed.nextLogId) : 1,
      };
    } else {
      saveStoreSync();
    }
  } catch (err) {
    console.warn('[medlink-store] Failed loading store:', err.message);
  }
}

function saveStore() {
  savePending = true;
  if (saveInFlight) return;
  saveInFlight = (async () => {
    while (savePending) {
      savePending = false;
      try {
        await fs.promises.mkdir(DATA_DIR, { recursive: true });
        const tmp = `${STORE_FILE}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(store), 'utf-8');
        await fs.promises.rename(tmp, STORE_FILE);
      } catch (err) {
        console.warn('[medlink-store] Failed saving store:', err.message);
      }
    }
    saveInFlight = null;
  })();
}

loadStore();

export function getAppConfig() {
  return {
    senderNumber: store.config.senderNumber || DEFAULT_CONFIG.senderNumber,
    recipientNumber: store.config.recipientNumber || DEFAULT_CONFIG.recipientNumber,
    defaultCountryCode: store.config.defaultCountryCode || '20',
  };
}

export function updateAppConfig({ senderNumber, recipientNumber, defaultCountryCode }) {
  store.config.senderNumber = String(senderNumber || '').trim();
  store.config.recipientNumber = String(recipientNumber || '').trim();
  store.config.defaultCountryCode = String(defaultCountryCode || '20').trim() || '20';
  saveStore();
  return getAppConfig();
}

export function getFlag(key) {
  return Boolean(store.config[key]);
}

export function setFlag(key, value) {
  store.config[key] = Boolean(value);
  saveStore();
}

export function getWebhookSecretHash() {
  return store.config.webhookSecretHash || null;
}

export function generateAndStoreWebhookSecret() {
  const plainSecret = `whsec_${crypto.randomBytes(24).toString('hex')}`;
  store.config.webhookSecretHash = crypto
    .createHash('sha256')
    .update(plainSecret)
    .digest('hex');
  saveStore();
  return plainSecret;
}

export function addLog(orderId, eventType, detail) {
  store.logs.unshift({
    id: store.nextLogId++,
    order_id: String(orderId),
    event_type: String(eventType),
    detail: String(detail || ''),
    created_at: Date.now(),
  });
  if (store.logs.length > 300) {
    store.logs.length = 300;
  }
  saveStore();
}

export function createQueuedOrder(payload, formattedMessage) {
  const existing = store.orders.find((o) => o.order_id === payload.orderId);
  if (existing) {
    return { created: false, order: existing };
  }

  const now = Date.now();
  const record = {
    id: store.nextOrderId++,
    order_id: payload.orderId,
    customer_name: payload.customerName,
    customer_phone: payload.customerPhone,
    delivery_address: payload.deliveryAddress,
    items_json: JSON.stringify(payload.items || []),
    subtotal: Number(payload.subtotal || 0),
    delivery_fee: Number(payload.deliveryFee || 0),
    total_amount: Number(payload.totalAmount || 0),
    currency: payload.currency || 'ج.م',
    customer_notes: payload.customerNotes || '',
    payment_method: payload.paymentMethod,
    wallet_name: payload.walletName || '',
    transfer_reference: payload.transferReference || '',
    payment_receipt_url: payload.paymentReceiptUrl || '',
    formatted_message: formattedMessage,
    status: 'pending',
    attempts: 0,
    max_attempts: 5,
    next_retry_at: null,
    last_error: null,
    whatsapp_message_id: null,
    recipient_jid: null,
    created_at: now,
    updated_at: now,
    sent_at: null,
  };

  store.orders.unshift(record);
  if (store.orders.length > 500) {
    store.orders.length = 500;
  }
  addLog(record.order_id, 'queued', 'تمت إضافة الطلب إلى طابور إرسال الواتساب');
  return { created: true, order: record };
}

export function getNextDueOrder(now = Date.now()) {
  const due = store.orders.filter(
    (o) => o.status === 'pending' && (o.next_retry_at === null || o.next_retry_at <= now)
  );
  if (due.length === 0) return null;
  due.sort((a, b) => a.created_at - b.created_at);
  return due[0];
}

export function claimOrderForSending(orderId) {
  const order = store.orders.find((o) => o.order_id === orderId && o.status === 'pending');
  if (!order) return false;
  order.status = 'sending';
  order.attempts += 1;
  order.updated_at = Date.now();
  saveStore();
  return true;
}

export function markOrderSent(orderId, messageId, recipientJid) {
  const order = store.orders.find((o) => o.order_id === orderId);
  if (!order) return;
  const now = Date.now();
  order.status = 'sent';
  order.whatsapp_message_id = messageId;
  order.recipient_jid = recipientJid;
  order.next_retry_at = null;
  order.last_error = null;
  order.sent_at = now;
  order.updated_at = now;
  addLog(orderId, 'sent', `تم الإرسال إلى ${recipientJid} (${messageId})`);
}

export function markOrderRetryOrFail(orderId, nextStatus, nextRetryAt, errorMessage) {
  const order = store.orders.find((o) => o.order_id === orderId);
  if (!order) return;
  order.status = nextStatus;
  order.next_retry_at = nextRetryAt;
  order.last_error = String(errorMessage || '').slice(0, 500);
  order.updated_at = Date.now();
  addLog(
    orderId,
    nextStatus === 'failed' ? 'failed' : 'retry_scheduled',
    order.last_error
  );
}

export function releaseOrderWithoutAttemptPenalty(orderId, reason) {
  const order = store.orders.find((o) => o.order_id === orderId && o.status === 'sending');
  if (!order) return;
  order.status = 'pending';
  order.attempts = Math.max(0, order.attempts - 1);
  order.next_retry_at = null;
  order.last_error = reason;
  order.updated_at = Date.now();
  addLog(orderId, 'paused_disconnected', reason);
}

export function recoverInterruptedSendingOrders() {
  let count = 0;
  const now = Date.now();
  for (const o of store.orders) {
    if (o.status === 'sending') {
      o.status = 'pending';
      o.next_retry_at = null;
      o.updated_at = now;
      count++;
    }
  }
  if (count > 0) saveStore();
  return count;
}

export function retryOrderManually(orderId) {
  const order = store.orders.find((o) => o.order_id === orderId);
  if (!order) return null;
  if (order.status === 'sent' || order.status === 'sending') {
    return order;
  }
  order.status = 'pending';
  order.attempts = 0;
  order.next_retry_at = null;
  order.last_error = null;
  order.updated_at = Date.now();
  addLog(orderId, 'manual_retry', 'تمت جدولة إعادة الإرسال يدوياً');
  return order;
}

export function requeueUnsentOrdersOnReconnect() {
  const now = Date.now();
  let changed = false;
  let readyCount = 0;

  for (const o of store.orders) {
    if (o.status === 'sent') continue;

    if (o.status === 'failed') {
      o.status = 'pending';
      o.attempts = 0;
      o.next_retry_at = null;
      o.last_error = null;
      o.updated_at = now;
      store.logs.unshift({
        id: store.nextLogId++,
        order_id: String(o.order_id),
        event_type: 'reconnect_requeued',
        detail: 'عودة اتصال واتساب: تمت إعادة جدولة الطلب للإرسال الفوري',
        created_at: now,
      });
      changed = true;
      readyCount++;
    } else if (o.status === 'sending') {
      o.status = 'pending';
      o.attempts = Math.max(0, o.attempts - 1);
      o.next_retry_at = null;
      o.updated_at = now;
      changed = true;
      readyCount++;
    } else if (o.status === 'pending') {
      if (o.next_retry_at !== null) {
        o.next_retry_at = null;
        o.updated_at = now;
        changed = true;
      }
      readyCount++;
    }
  }

  if (store.logs.length > 300) {
    store.logs.length = 300;
  }
  if (changed) {
    saveStore();
  }
  return readyCount;
}

export function getOrderByOrderId(orderId) {
  return store.orders.find((o) => o.order_id === String(orderId)) || null;
}

export function getOrderStatusMap() {
  const map = new Map();
  for (const o of store.orders) {
    map.set(o.order_id, {
      status: o.status,
      attempts: o.attempts,
      lastError: o.last_error || '',
      sentAt: o.sent_at || null,
      recipientJid: o.recipient_jid || null,
    });
  }
  return map;
}

export function listOrders({ status = 'all', search = '', limit = 100 } = {}) {
  const q = String(search || '').trim().toLowerCase();
  const filtered = store.orders.filter((o) => {
    if (status && status !== 'all' && o.status !== status) return false;
    if (!q) return true;
    return (
      String(o.order_id).toLowerCase().includes(q) ||
      String(o.customer_name).toLowerCase().includes(q) ||
      String(o.customer_phone).toLowerCase().includes(q)
    );
  });

  return filtered.slice(0, Math.min(250, Math.max(1, limit))).map((o) => ({
    id: o.id,
    orderId: o.order_id,
    customerName: o.customer_name,
    customerPhone: o.customer_phone,
    deliveryAddress: o.delivery_address,
    items: (() => {
      try {
        return JSON.parse(o.items_json || '[]');
      } catch {
        return [];
      }
    })(),
    subtotal: o.subtotal,
    deliveryFee: o.delivery_fee,
    totalAmount: o.total_amount,
    currency: o.currency,
    customerNotes: o.customer_notes,
    paymentMethod: o.payment_method,
    walletName: o.wallet_name,
    transferReference: o.transfer_reference,
    hasReceipt: Boolean(o.payment_receipt_url),
    formattedMessage: o.formatted_message,
    status: o.status,
    attempts: o.attempts,
    maxAttempts: o.max_attempts,
    nextRetryAt: o.next_retry_at,
    lastError: o.last_error,
    whatsappMessageId: o.whatsapp_message_id,
    recipientJid: o.recipient_jid,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    sentAt: o.sent_at,
  }));
}

export function getOrderStats() {
  let total = 0;
  let sent = 0;
  let pending = 0;
  let failed = 0;
  for (const o of store.orders) {
    total++;
    if (o.status === 'sent') sent++;
    else if (o.status === 'failed') failed++;
    else pending++;
  }
  return { total, sent, pending, failed };
}

export function listRecentLogs(limit = 50) {
  return store.logs.slice(0, limit);
}
