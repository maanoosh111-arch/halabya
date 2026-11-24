import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');

const DEFAULT_SETTINGS = {
  id: 'default',
  isOpen: true,
  openTime: '11:00 ص',
  closeTime: '02:00 ص',
  customerNote: '',
  deliveryFee: 25,
  transferNumber: '0123456789',
  supportNumber: '0 12 3456789',
  profitResetAt: null,
  adminPinHash: null,
  updatedAt: new Date().toISOString(),
};

let memoryStore = {
  settings: { ...DEFAULT_SETTINGS },
  orders: [],
  nextOrderSeq: 1001,
};

const ORDER_LIGHT_COLUMNS = [
  'id',
  'order_code',
  'status',
  'rejection_reason',
  'is_archived',
  'is_deleted_from_archive',
  'is_paid',
  'customer_name',
  'customer_phone',
  'delivery_address',
  'delivery_notes',
  'payment_method',
  'sender_wallet_phone',
  'items',
  'subtotal',
  'delivery_fee',
  'grand_total',
  'total_profit',
  'created_at',
  'updated_at',
  'completed_at',
].join(',');

const SETTINGS_SYNC_TTL_MS = 1500;
const ORDERS_SYNC_TTL_MS = 1500;

let lastSettingsSyncAt = 0;
let lastOrdersSyncAt = 0;
let inflightSettingsSync = null;
let inflightOrdersSync = null;
let localSaveInFlight = null;
let localSavePending = false;

function getSupabaseConfig() {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    ''
  ).trim();
  if (!url || !key) return null;
  return { url, key };
}

async function supabaseRequest(cfg, endpoint, options = {}) {
  const isJwt = cfg.key.startsWith('eyJ');
  const headers = {
    apikey: cfg.key,
    ...(isJwt ? { Authorization: `Bearer ${cfg.key}` } : {}),
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  const res = await fetch(`${cfg.url}/rest/v1/${endpoint}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase REST error ${res.status}: ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function dbRowToSettings(row) {
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    id: row.id || 'default',
    isOpen: row.is_open !== undefined ? Boolean(row.is_open) : true,
    openTime: row.open_time || '11:00 ص',
    closeTime: row.close_time || '02:00 ص',
    customerNote: row.customer_note || '',
    deliveryFee: Number.isFinite(Number(row.delivery_fee)) ? Number(row.delivery_fee) : 25,
    transferNumber: row.transfer_number || '0123456789',
    supportNumber:
      row.support_number !== undefined && row.support_number !== null && row.support_number !== ''
        ? String(row.support_number)
        : memoryStore.settings.supportNumber || '0 12 3456789',
    profitResetAt: row.profit_reset_at || null,
    adminPinHash: row.admin_pin_hash || null,
    updatedAt: row.updated_at || new Date().toISOString(),
  };
}

function settingsToDbRow(s, { includeSupportNumber = true } = {}) {
  const row = {
    id: 'default',
    is_open: Boolean(s.isOpen),
    open_time: String(s.openTime || '11:00 ص'),
    close_time: String(s.closeTime || '02:00 ص'),
    customer_note: String(s.customerNote || ''),
    delivery_fee: Number(s.deliveryFee || 0),
    transfer_number: String(s.transferNumber || '0123456789'),
    profit_reset_at: s.profitResetAt || null,
    admin_pin_hash: s.adminPinHash || null,
    updated_at: s.updatedAt || new Date().toISOString(),
  };
  if (includeSupportNumber) {
    row.support_number = String(s.supportNumber || '0 12 3456789');
  }
  return row;
}

function dbRowToOrder(row, cachedReceiptImage = undefined) {
  const resolvedReceipt =
    row.receipt_image !== undefined
      ? row.receipt_image || ''
      : cachedReceiptImage !== undefined
        ? cachedReceiptImage
        : '';

  return {
    id: row.id,
    orderCode: row.order_code,
    status: row.status || 'Pending',
    rejectionReason: row.rejection_reason || '',
    isArchived: Boolean(row.is_archived),
    isDeletedFromArchive: Boolean(row.is_deleted_from_archive),
    isPaid: Boolean(row.is_paid),
    customerName: row.customer_name || '',
    customerPhone: row.customer_phone || '',
    deliveryAddress: row.delivery_address || '',
    deliveryNotes: row.delivery_notes || '',
    paymentMethod: row.payment_method || 'COD',
    senderWalletPhone: row.sender_wallet_phone || '',
    receiptImage: resolvedReceipt,
    items: Array.isArray(row.items) ? row.items : [],
    subtotal: Number(row.subtotal || 0),
    deliveryFee: Number(row.delivery_fee || 0),
    grandTotal: Number(row.grand_total || 0),
    totalProfit: Number(row.total_profit || 0),
    createdAt: row.created_at || new Date().toISOString(),
    updatedAt: row.updated_at || new Date().toISOString(),
    completedAt: row.completed_at || null,
  };
}

function orderToDbRow(o) {
  return {
    id: o.id,
    order_code: o.orderCode,
    status: o.status,
    rejection_reason: o.rejectionReason || '',
    is_archived: Boolean(o.isArchived),
    is_deleted_from_archive: Boolean(o.isDeletedFromArchive),
    is_paid: Boolean(o.isPaid),
    customer_name: o.customerName,
    customer_phone: o.customerPhone,
    delivery_address: o.deliveryAddress,
    delivery_notes: o.deliveryNotes || '',
    payment_method: o.paymentMethod,
    sender_wallet_phone: o.senderWalletPhone || '',
    receipt_image: o.receiptImage || '',
    items: o.items || [],
    subtotal: Number(o.subtotal || 0),
    delivery_fee: Number(o.deliveryFee || 0),
    grand_total: Number(o.grandTotal || 0),
    total_profit: Number(o.totalProfit || 0),
    created_at: o.createdAt,
    updated_at: o.updatedAt,
    completed_at: o.completedAt || null,
  };
}

function patchToDbRow(patch, updatedAt) {
  const row = { updated_at: updatedAt };
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.rejectionReason !== undefined) row.rejection_reason = patch.rejectionReason || '';
  if (patch.isArchived !== undefined) row.is_archived = Boolean(patch.isArchived);
  if (patch.isDeletedFromArchive !== undefined) {
    row.is_deleted_from_archive = Boolean(patch.isDeletedFromArchive);
  }
  if (patch.isPaid !== undefined) row.is_paid = Boolean(patch.isPaid);
  if (patch.completedAt !== undefined) row.completed_at = patch.completedAt || null;
  if (patch.receiptImage !== undefined) row.receipt_image = patch.receiptImage || '';
  return row;
}

function ensureLocalDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadLocalStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      memoryStore = {
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
        orders: Array.isArray(parsed.orders) ? parsed.orders : [],
        nextOrderSeq: Number.isFinite(Number(parsed.nextOrderSeq)) ? Number(parsed.nextOrderSeq) : 1001,
      };
    } else {
      saveLocalStoreSync();
    }
  } catch (err) {
    console.error('[db] Failed loading local store:', err.message);
  }
}

function saveLocalStoreSync() {
  try {
    ensureLocalDir();
    const tmpFile = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(memoryStore), 'utf-8');
    fs.renameSync(tmpFile, DATA_FILE);
  } catch (err) {
    console.error('[db] Failed saving local store:', err.message);
  }
}

function scheduleLocalSave() {
  localSavePending = true;
  if (localSaveInFlight) return;
  localSaveInFlight = (async () => {
    while (localSavePending) {
      localSavePending = false;
      try {
        await fs.promises.mkdir(DATA_DIR, { recursive: true });
        const tmpFile = `${DATA_FILE}.tmp`;
        await fs.promises.writeFile(tmpFile, JSON.stringify(memoryStore), 'utf-8');
        await fs.promises.rename(tmpFile, DATA_FILE);
      } catch (err) {
        console.error('[db] Failed saving local store:', err.message);
      }
    }
    localSaveInFlight = null;
  })();
}

function computeNextSeq(orders) {
  let maxSeq = 1000;
  for (const o of orders) {
    const match = String(o.orderCode || '').match(/ORD-(\d+)/i);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxSeq) maxSeq = num;
    }
  }
  return maxSeq + 1;
}

async function syncSettingsFromSupabase({ force = false } = {}) {
  const cfg = getSupabaseConfig();
  if (!cfg) return;

  const now = Date.now();
  if (!force && lastSettingsSyncAt > 0 && now - lastSettingsSyncAt < SETTINGS_SYNC_TTL_MS) {
    return;
  }

  if (inflightSettingsSync) {
    return inflightSettingsSync;
  }

  inflightSettingsSync = (async () => {
    try {
      const settingsRows = await supabaseRequest(cfg, 'store_settings?id=eq.default&select=*');
      if (Array.isArray(settingsRows) && settingsRows.length > 0) {
        memoryStore.settings = dbRowToSettings(settingsRows[0]);
        lastSettingsSyncAt = Date.now();
        scheduleLocalSave();
      }
    } catch (err) {
      console.warn('[db] Supabase settings refresh warning:', err.message);
    } finally {
      inflightSettingsSync = null;
    }
  })();

  return inflightSettingsSync;
}

async function syncOrdersFromSupabase({ force = false } = {}) {
  const cfg = getSupabaseConfig();
  if (!cfg) return;

  const now = Date.now();
  if (!force && lastOrdersSyncAt > 0 && now - lastOrdersSyncAt < ORDERS_SYNC_TTL_MS) {
    return;
  }

  if (inflightOrdersSync) {
    return inflightOrdersSync;
  }

  inflightOrdersSync = (async () => {
    try {
      const existingMap = new Map(memoryStore.orders.map((o) => [o.id, o]));
      const orderRows = await supabaseRequest(
        cfg,
        `orders?select=${ORDER_LIGHT_COLUMNS}&order=created_at.desc`
      );
      if (!Array.isArray(orderRows)) return;

      const missingReceiptIds = [];
      for (const row of orderRows) {
        const cached = existingMap.get(row.id);
        if (!cached && row.payment_method && row.payment_method !== 'COD') {
          missingReceiptIds.push(row.id);
        }
      }

      const fetchedReceipts = new Map();
      if (missingReceiptIds.length > 0) {
        try {
          const inClause = missingReceiptIds
            .map((id) => `"${String(id).replace(/"/g, '')}"`)
            .join(',');
          const receiptRows = await supabaseRequest(
            cfg,
            `orders?id=in.(${inClause})&select=id,receipt_image`
          );
          if (Array.isArray(receiptRows)) {
            for (const rr of receiptRows) {
              fetchedReceipts.set(rr.id, rr.receipt_image || '');
            }
          }
        } catch (receiptErr) {
          console.warn('[db] Receipt hydration warning:', receiptErr.message);
        }
      }

      memoryStore.orders = orderRows.map((row) => {
        const cached = existingMap.get(row.id);
        const receipt = fetchedReceipts.has(row.id)
          ? fetchedReceipts.get(row.id)
          : cached
            ? cached.receiptImage || ''
            : '';
        return dbRowToOrder(row, receipt);
      });
      memoryStore.nextOrderSeq = computeNextSeq(memoryStore.orders);
      lastOrdersSyncAt = Date.now();
      scheduleLocalSave();
    } catch (err) {
      console.warn('[db] Supabase orders refresh warning:', err.message);
    } finally {
      inflightOrdersSync = null;
    }
  })();

  return inflightOrdersSync;
}

export async function initDatabase() {
  loadLocalStore();
  const cfg = getSupabaseConfig();
  if (!cfg) {
    console.log('[db] Supabase env vars not configured; using persistent local store (data/store.json).');
    return;
  }

  try {
    const settingsRows = await supabaseRequest(cfg, 'store_settings?id=eq.default&select=*');
    if (Array.isArray(settingsRows) && settingsRows.length > 0) {
      memoryStore.settings = dbRowToSettings(settingsRows[0]);
    } else {
      await supabaseRequest(cfg, 'store_settings', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify(settingsToDbRow(memoryStore.settings)),
      });
    }
    lastSettingsSyncAt = Date.now();

    await syncOrdersFromSupabase({ force: true });
    console.log(`[db] Synchronized with Supabase (${memoryStore.orders.length} orders).`);
  } catch (err) {
    console.warn('[db] Supabase startup sync failed, falling back to local store:', err.message);
  }
}

export async function checkDatabaseConnection() {
  const cfg = getSupabaseConfig();
  if (!cfg) {
    return {
      mode: 'local',
      configured: false,
      connected: false,
      storeSettingsOk: false,
      ordersOk: false,
    };
  }

  let storeSettingsOk = false;
  let ordersOk = false;
  let status = null;
  let reason = null;

  try {
    await supabaseRequest(cfg, 'store_settings?select=id&limit=1');
    storeSettingsOk = true;
  } catch (err) {
    reason = err.message;
    const m = String(err.message || '').match(/error (\d+)/);
    if (m) status = Number(m[1]);
  }

  try {
    await supabaseRequest(cfg, 'orders?select=id&limit=1');
    ordersOk = true;
  } catch (err) {
    if (!reason) reason = err.message;
    const m = String(err.message || '').match(/error (\d+)/);
    if (!status && m) status = Number(m[1]);
  }

  const keyFormat = cfg.key.startsWith('eyJ')
    ? 'jwt'
    : cfg.key.startsWith('sb_secret_')
      ? 'sb_secret'
      : cfg.key.startsWith('sb_publishable_')
        ? 'sb_publishable'
        : 'unknown';
  const urlValid = /^https:\/\/[a-z0-9-]+\.supabase\.(co|in|net)$/i.test(cfg.url);

  let supportNumberColumnOk = false;
  if (storeSettingsOk) {
    try {
      await supabaseRequest(cfg, 'store_settings?select=support_number&limit=1');
      supportNumberColumnOk = true;
    } catch {
      supportNumberColumnOk = false;
    }
  }

  return {
    mode: storeSettingsOk && ordersOk ? 'supabase' : 'local-fallback',
    configured: true,
    connected: storeSettingsOk && ordersOk,
    storeSettingsOk,
    ordersOk,
    supportNumberColumnOk,
    httpStatus: status,
    keyFormat,
    urlValid,
    issue: reason ? String(reason).slice(0, 350) : null,
  };
}

export async function getSettings() {
  await syncSettingsFromSupabase();
  return { ...memoryStore.settings };
}

export function getPublicSettingsSync() {
  const s = memoryStore.settings;
  return {
    isOpen: Boolean(s.isOpen),
    openTime: s.openTime,
    closeTime: s.closeTime,
    customerNote: s.customerNote,
    deliveryFee: Number(s.deliveryFee || 0),
    transferNumber: s.transferNumber || '0123456789',
    supportNumber: s.supportNumber || '0 12 3456789',
  };
}

export async function getPublicSettings() {
  await syncSettingsFromSupabase();
  return getPublicSettingsSync();
}

export async function updateSettings(patch) {
  const updated = {
    ...memoryStore.settings,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  memoryStore.settings = updated;
  lastSettingsSyncAt = Date.now();
  scheduleLocalSave();

  const cfg = getSupabaseConfig();
  if (cfg) {
    try {
      await supabaseRequest(cfg, 'store_settings', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(settingsToDbRow(updated, { includeSupportNumber: true })),
      });
    } catch (err) {
      if (String(err.message || '').includes('support_number')) {
        console.warn('[db] support_number column missing in Supabase store_settings; syncing remaining fields.');
        try {
          await supabaseRequest(cfg, 'store_settings', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
            body: JSON.stringify(settingsToDbRow(updated, { includeSupportNumber: false })),
          });
        } catch (fallbackErr) {
          console.warn('[db] Supabase settings sync failed:', fallbackErr.message);
        }
      } else {
        console.warn('[db] Supabase settings sync failed:', err.message);
      }
    }
  }

  return { ...updated };
}

export async function createOrder(orderInput) {
  const now = new Date().toISOString();
  const seq = Math.max(memoryStore.nextOrderSeq, computeNextSeq(memoryStore.orders));
  memoryStore.nextOrderSeq = seq + 1;

  const order = {
    id: crypto.randomUUID(),
    orderCode: `ORD-${seq}`,
    status: 'Pending',
    rejectionReason: '',
    isArchived: false,
    isDeletedFromArchive: false,
    isPaid: false,
    customerName: orderInput.customerName,
    customerPhone: orderInput.customerPhone,
    deliveryAddress: orderInput.deliveryAddress,
    deliveryNotes: orderInput.deliveryNotes || '',
    paymentMethod: orderInput.paymentMethod,
    senderWalletPhone: orderInput.senderWalletPhone || '',
    receiptImage: orderInput.receiptImage || '',
    items: orderInput.items,
    subtotal: orderInput.subtotal,
    deliveryFee: orderInput.deliveryFee,
    grandTotal: orderInput.grandTotal,
    totalProfit: orderInput.totalProfit,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };

  memoryStore.orders.unshift(order);
  lastOrdersSyncAt = Date.now();
  scheduleLocalSave();

  const cfg = getSupabaseConfig();
  if (cfg) {
    try {
      await supabaseRequest(cfg, 'orders', {
        method: 'POST',
        body: JSON.stringify(orderToDbRow(order)),
      });
    } catch (err) {
      console.warn('[db] Supabase order insert failed:', err.message);
    }
  }

  return order;
}

export async function listAllOrdersInternal() {
  await syncOrdersFromSupabase();
  return memoryStore.orders.filter((o) => !o.isDeletedFromArchive);
}

export async function getOrderReceiptById(id) {
  const existing = memoryStore.orders.find((o) => o.id === id);
  if (existing && existing.receiptImage) {
    return existing.receiptImage;
  }

  const cfg = getSupabaseConfig();
  if (cfg) {
    try {
      const rows = await supabaseRequest(
        cfg,
        `orders?id=eq.${encodeURIComponent(id)}&select=id,receipt_image`
      );
      if (Array.isArray(rows) && rows.length > 0) {
        const img = rows[0].receipt_image || '';
        if (existing && img) {
          existing.receiptImage = img;
          scheduleLocalSave();
        }
        return img;
      }
    } catch (err) {
      console.warn('[db] Failed loading single order receipt:', err.message);
    }
  }

  return existing ? existing.receiptImage || '' : '';
}

export async function listPublicOrders({ codes = [], phone = '' } = {}) {
  await syncOrdersFromSupabase();
  const codeSet = new Set(codes.map((c) => String(c).trim().toUpperCase()).filter(Boolean));
  const normalizedPhone = String(phone || '').replace(/\s+/g, '');

  const visible = memoryStore.orders.filter((o) => {
    if (o.isDeletedFromArchive) return false;
    if (codeSet.size > 0 && codeSet.has(String(o.orderCode).toUpperCase())) return true;
    if (normalizedPhone && String(o.customerPhone).replace(/\s+/g, '') === normalizedPhone) return true;
    return false;
  });

  return visible.map(toPublicOrder);
}

export function toPublicOrder(order) {
  return {
    id: order.id,
    orderCode: order.orderCode,
    status: order.status,
    rejectionReason: order.rejectionReason || '',
    isArchived: Boolean(order.isArchived),
    isPaid: Boolean(order.isPaid),
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    deliveryAddress: order.deliveryAddress,
    deliveryNotes: order.deliveryNotes || '',
    paymentMethod: order.paymentMethod,
    senderWalletPhone: order.senderWalletPhone || '',
    items: (order.items || []).map((it) => ({
      productId: it.productId,
      slug: it.slug,
      name: it.name,
      category: it.category,
      unitPrice: it.unitPrice,
      quantity: it.quantity,
      lineTotal: it.lineTotal,
    })),
    subtotal: order.subtotal,
    deliveryFee: order.deliveryFee,
    grandTotal: order.grandTotal,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    completedAt: order.completedAt,
  };
}

export async function updateOrderById(id, patch) {
  const idx = memoryStore.orders.findIndex((o) => o.id === id);
  if (idx === -1) return null;

  const updated = {
    ...memoryStore.orders[idx],
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  memoryStore.orders[idx] = updated;
  lastOrdersSyncAt = Date.now();
  scheduleLocalSave();

  const cfg = getSupabaseConfig();
  if (cfg) {
    try {
      await supabaseRequest(cfg, `orders?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patchToDbRow(patch, updated.updatedAt)),
      });
    } catch (err) {
      console.warn('[db] Supabase order update failed:', err.message);
    }
  }

  return updated;
}

export async function softDeleteArchivedOrders(ids) {
  const idSet = new Set(ids);
  const now = new Date().toISOString();
  let count = 0;

  for (let i = 0; i < memoryStore.orders.length; i++) {
    const o = memoryStore.orders[i];
    if (idSet.has(o.id) && !o.isDeletedFromArchive) {
      memoryStore.orders[i] = {
        ...o,
        isDeletedFromArchive: true,
        updatedAt: now,
      };
      count++;
    }
  }

  if (count > 0) {
    lastOrdersSyncAt = Date.now();
    scheduleLocalSave();
    const cfg = getSupabaseConfig();
    if (cfg) {
      try {
        const inClause = ids.map((id) => `"${String(id).replace(/"/g, '')}"`).join(',');
        await supabaseRequest(cfg, `orders?id=in.(${inClause})`, {
          method: 'PATCH',
          body: JSON.stringify({
            is_deleted_from_archive: true,
            updated_at: now,
          }),
        });
      } catch (err) {
        console.warn('[db] Supabase bulk delete sync failed:', err.message);
      }
    }
  }

  return count;
}
