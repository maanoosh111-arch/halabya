const BRAND_LOGO_URL =
  'https://res.cloudinary.com/h74mxqsb/image/upload/v1795436487/95198036-2120-422b-af14-18355e8b50d3-Photoroom_hnnnve.png';
const TOKEN_STORAGE_KEY = 'halabiya_chef_token_v1';

const ordersChannel =
  typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('halabiya_orders_channel')
    : null;

const state = {
  authenticated: false,
  needsPinSetup: false,
  token: localStorage.getItem(TOKEN_STORAGE_KEY) || '',
  activeTab: 'active',
  activeStatusFilter: 'All',
  analyticsPeriod: 'today',
  analyticsSubtab: 'completed-orders',
  orders: [],
  knownOrderIds: new Set(),
  initialOrdersLoaded: false,
  settings: null,
  settingsDirty: false,
  catalog: [],
  selectedArchiveIds: new Set(),
  audioMuted: false,
  audioCtx: null,
  pendingRejectOrderId: null,
  pendingConfirmAction: null,
  pollTimer: null,
  isFetchingOrders: false,
};

function formatPrice(val) {
  const n = Number(val || 0);
  const rounded = Math.round(n * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)} ج.م`;
}

function formatDateAr(iso) {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('ar-EG', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function translatePayment(method) {
  const map = {
    'Vodafone Cash': 'فودافون كاش',
    'Orange Cash': 'أورانج كاش',
    'Etisalat Cash': 'اتصالات كاش',
    COD: 'الدفع عند الاستلام',
  };
  return map[method] || method;
}

function getStatusBadgeInfo(status) {
  switch (status) {
    case 'Pending':
      return { text: 'قيد الانتظار', cls: 'status-pending' };
    case 'In Progress':
      return { text: 'جاري التحضير', cls: 'status-progress' };
    case 'Finished':
      return { text: 'تم التسليم', cls: 'status-finished' };
    case 'Rejected':
      return { text: 'مرفوض', cls: 'status-rejected' };
    default:
      return { text: status, cls: 'status-pending' };
  }
}

function getWhatsappRelayBadgeInfo(waStatus) {
  switch (waStatus) {
    case 'sent':
      return { text: 'واتساب: تم الإرسال ✓', cls: 'status-finished' };
    case 'sending':
      return { text: 'واتساب: جاري الإرسال...', cls: 'status-progress' };
    case 'pending':
      return { text: 'واتساب: في الطابور', cls: 'status-pending' };
    case 'failed':
      return { text: 'واتساب: فشل الإرسال', cls: 'status-rejected' };
    default:
      return { text: 'واتساب: لم يُرسل بعد', cls: 'status-pending' };
  }
}

function showToast(message) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast-item';
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

// =========================================================
// WEB AUDIO API TWO-TONE CHIME
// =========================================================
function unlockAudioContext() {
  if (!state.audioCtx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      state.audioCtx = new AudioCtx();
    }
  }
  if (state.audioCtx && state.audioCtx.state === 'suspended') {
    state.audioCtx.resume().catch(() => {});
  }
}

function playNotificationChime() {
  if (state.audioMuted) return;
  unlockAudioContext();
  if (!state.audioCtx) return;

  try {
    const ctx = state.audioCtx;
    const now = ctx.currentTime;

    const playTone = (freq, startOffset, duration) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + startOffset);
      gain.gain.setValueAtTime(0.001, now + startOffset);
      gain.gain.exponentialRampToValueAtTime(0.22, now + startOffset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + startOffset + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + startOffset);
      osc.stop(now + startOffset + duration + 0.02);
    };

    // Crisp two-tone chime (A5 -> D6)
    playTone(880, 0, 0.16);
    playTone(1174.66, 0.16, 0.28);
  } catch {
    // Ignore audio play restrictions prior to interaction
  }
}

function updateAudioToggleUI() {
  const label = document.getElementById('audio-toggle-label');
  const iconOn = document.getElementById('audio-icon-on');
  const iconOff = document.getElementById('audio-icon-off');
  if (state.audioMuted) {
    label.textContent = 'تنبيه الصوت: مكتوم';
    iconOn.classList.add('hidden');
    iconOff.classList.remove('hidden');
  } else {
    label.textContent = 'تنبيه الصوت: مفعل';
    iconOn.classList.remove('hidden');
    iconOff.classList.add('hidden');
  }
}

// =========================================================
// AUTHENTICATED API HELPER
// =========================================================
async function chefFetch(url, options = {}) {
  const headers = {
    'X-Requested-With': 'XMLHttpRequest',
    ...(options.headers || {}),
  };
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }
  if (options.body && typeof options.body === 'string' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, {
    ...options,
    headers,
    credentials: 'include',
    cache: 'no-store',
  });

  if (res.status === 401) {
    handleUnauthorized();
    throw new Error('انتهت الجلسة، يرجى تسجيل الدخول مرة أخرى.');
  }

  return res;
}

function handleUnauthorized() {
  state.authenticated = false;
  state.token = '';
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  document.getElementById('chef-dashboard-screen').classList.add('hidden');
  document.getElementById('chef-auth-screen').classList.remove('hidden');
}

async function checkAuthStatus() {
  try {
    const res = await fetch('/api/chef/auth/status', {
      headers: state.token ? { Authorization: `Bearer ${state.token}` } : {},
      credentials: 'include',
      cache: 'no-store',
    });
    const data = await res.json();
    state.needsPinSetup = Boolean(data.needsPinSetup);

    if (data.authenticated) {
      enterDashboard();
      return;
    }

    const subtitle = document.getElementById('chef-auth-subtitle');
    const pinLabel = document.getElementById('chef-pin-label');
    const submitBtn = document.getElementById('chef-auth-submit');

    if (state.needsPinSetup) {
      subtitle.textContent = 'الإعداد الأول: اختر رمز دخول سري للوحة الشيف (4 أرقام أو أحرف على الأقل)';
      pinLabel.textContent = 'تعيين رمز الدخول الجديد (PIN)';
      submitBtn.textContent = 'حفظ الرمز والدخول';
    } else {
      subtitle.textContent = 'حلبية للمشويات والمأكولات';
      pinLabel.textContent = 'رمز الدخول السري (PIN)';
      submitBtn.textContent = 'دخول للوحة التحكم';
    }
  } catch {
    // Keep login screen visible
  }
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  unlockAudioContext();
  const pinInput = document.getElementById('chef-pin-input');
  const errEl = document.getElementById('chef-auth-error');
  const pin = pinInput.value.trim();

  errEl.classList.add('hidden');

  try {
    const endpoint = state.needsPinSetup ? '/api/chef/setup-pin' : '/api/chef/auth';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      credentials: 'include',
      body: JSON.stringify({ pin }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'فشل تسجيل الدخول.');
    }

    state.token = data.token || '';
    if (state.token) {
      localStorage.setItem(TOKEN_STORAGE_KEY, state.token);
    }
    state.needsPinSetup = false;
    pinInput.value = '';
    enterDashboard();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

async function enterDashboard() {
  state.authenticated = true;
  document.getElementById('chef-auth-screen').classList.add('hidden');
  document.getElementById('chef-dashboard-screen').classList.remove('hidden');

  await Promise.all([fetchOrdersAndSettings(), fetchAnalytics(), fetchChefCatalog()]);

  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') {
      fetchOrdersAndSettings();
    }
  }, 5000);
}

// =========================================================
// DATA FETCHING & POLLING
// =========================================================
async function fetchOrdersAndSettings() {
  if (!state.authenticated || state.isFetchingOrders) return;
  state.isFetchingOrders = true;
  try {
    const res = await chefFetch('/api/chef/orders');
    if (!res.ok) return;
    const data = await res.json();
    const incomingOrders = Array.isArray(data.orders) ? data.orders : [];

    // Preserve any receiptImage already lazy-loaded into memory
    const cachedReceiptById = new Map();
    for (const prev of state.orders) {
      if (prev.receiptImage) cachedReceiptById.set(prev.id, prev.receiptImage);
    }
    for (const ord of incomingOrders) {
      if (!ord.receiptImage && cachedReceiptById.has(ord.id)) {
        ord.receiptImage = cachedReceiptById.get(ord.id);
      }
    }

    // Detect newly arrived orders for audio chime & toast
    if (state.initialOrdersLoaded) {
      const newlyArrived = incomingOrders.filter((o) => !state.knownOrderIds.has(o.id));
      if (newlyArrived.length > 0) {
        playNotificationChime();
        for (const o of newlyArrived) {
          showToast(`طلب جديد وصل: ${o.orderCode} (${o.customerName})`);
        }
      }
    }

    state.knownOrderIds = new Set(incomingOrders.map((o) => o.id));
    state.initialOrdersLoaded = true;
    state.orders = incomingOrders;

    if (data.settings) {
      state.settings = data.settings;
      syncSettingsUI();
    }

    const waBadge = document.getElementById('chef-header-wa-badge');
    if (waBadge && data.whatsappConnectionStatus) {
      if (data.whatsappConnectionStatus === 'connected') {
        waBadge.textContent = 'واتساب: متصل';
        waBadge.classList.remove('closed');
      } else if (data.whatsappConnectionStatus === 'connecting') {
        waBadge.textContent = 'واتساب: جاري الربط';
        waBadge.classList.add('closed');
      } else {
        waBadge.textContent = 'واتساب: غير متصل';
        waBadge.classList.add('closed');
      }
    }

    renderTabCounts();
    renderActiveOrders();
    renderArchiveTable();
    if (state.activeTab === 'analytics') {
      fetchAnalytics();
    }
  } catch {
    // Ignore transient polling failures
  } finally {
    state.isFetchingOrders = false;
  }
}

function renderTabCounts() {
  const active = state.orders.filter((o) => !o.isArchived);
  const archived = state.orders.filter((o) => o.isArchived);
  document.getElementById('tab-count-active').textContent = String(active.length);
  document.getElementById('tab-count-archive').textContent = String(archived.length);
}

// =========================================================
// TAB 1: ACTIVE ORDERS
// =========================================================
function renderActiveOrders() {
  const activeOrders = state.orders.filter((o) => !o.isArchived);

  const counts = {
    All: activeOrders.length,
    Pending: activeOrders.filter((o) => o.status === 'Pending').length,
    'In Progress': activeOrders.filter((o) => o.status === 'In Progress').length,
    Finished: activeOrders.filter((o) => o.status === 'Finished').length,
    Rejected: activeOrders.filter((o) => o.status === 'Rejected').length,
  };

  document.getElementById('cnt-all').textContent = String(counts.All);
  document.getElementById('cnt-pending').textContent = String(counts.Pending);
  document.getElementById('cnt-progress').textContent = String(counts['In Progress']);
  document.getElementById('cnt-finished').textContent = String(counts.Finished);
  document.getElementById('cnt-rejected').textContent = String(counts.Rejected);

  const filtered =
    state.activeStatusFilter === 'All'
      ? activeOrders
      : activeOrders.filter((o) => o.status === state.activeStatusFilter);

  const grid = document.getElementById('active-orders-grid');
  grid.innerHTML = '';

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'catalog-state-box';
    empty.style.gridColumn = '1 / -1';
    const p = document.createElement('p');
    p.textContent = 'لا توجد طلبات نشطة ضمن هذا التصنيف حالياً.';
    empty.appendChild(p);
    grid.appendChild(empty);
    return;
  }

  for (const o of filtered) {
    grid.appendChild(buildChefOrderCard(o));
  }
}

function buildChefOrderCard(o) {
  const card = document.createElement('article');
  card.className = 'chef-order-card';

  const top = document.createElement('div');
  top.className = 'chef-order-top';
  const left = document.createElement('div');
  const code = document.createElement('strong');
  code.className = 'order-code-label';
  code.dir = 'ltr';
  code.textContent = o.orderCode;
  const time = document.createElement('div');
  time.className = 'order-date-label';
  time.textContent = formatDateAr(o.createdAt);
  left.append(code, time);

  const badgeInfo = getStatusBadgeInfo(o.status);
  const badge = document.createElement('span');
  badge.className = `status-badge ${badgeInfo.cls}`;
  badge.textContent = badgeInfo.text;
  top.append(left, badge);
  card.appendChild(top);

  if (o.status === 'Rejected' && o.rejectionReason) {
    const rej = document.createElement('div');
    rej.className = 'rejection-reason-box';
    const st = document.createElement('strong');
    st.textContent = 'سبب الرفض: ';
    const sp = document.createElement('span');
    sp.textContent = o.rejectionReason;
    rej.append(st, sp);
    card.appendChild(rej);
  }

  const infoGrid = document.createElement('div');
  infoGrid.className = 'chef-order-info-grid';

  const nameDiv = document.createElement('div');
  nameDiv.textContent = 'العميل: ';
  const nameStrong = document.createElement('strong');
  nameStrong.textContent = o.customerName;
  nameDiv.appendChild(nameStrong);

  const phoneDiv = document.createElement('div');
  phoneDiv.textContent = 'الهاتف: ';
  const telLink = document.createElement('a');
  telLink.className = 'tel-link';
  telLink.dir = 'ltr';
  telLink.href = `tel:${o.customerPhone}`;
  telLink.textContent = o.customerPhone;
  phoneDiv.appendChild(telLink);

  const addrDiv = document.createElement('div');
  addrDiv.className = 'full-span';
  addrDiv.textContent = 'العنوان: ';
  const addrStrong = document.createElement('strong');
  addrStrong.textContent = o.deliveryAddress;
  addrDiv.appendChild(addrStrong);

  infoGrid.append(nameDiv, phoneDiv, addrDiv);

  if (o.deliveryNotes) {
    const notesDiv = document.createElement('div');
    notesDiv.className = 'full-span';
    notesDiv.textContent = 'ملاحظات العميل: ';
    const notesStrong = document.createElement('strong');
    notesStrong.textContent = o.deliveryNotes;
    notesDiv.appendChild(notesStrong);
    infoGrid.appendChild(notesDiv);
  }
  card.appendChild(infoGrid);

  // Itemized products
  const itemsBox = document.createElement('div');
  itemsBox.className = 'chef-items-box';
  for (const it of o.items || []) {
    const row = document.createElement('div');
    row.className = 'chef-item-line';
    const l = document.createElement('span');
    l.textContent = `${it.name} × ${it.quantity}`;
    const r = document.createElement('strong');
    r.textContent = formatPrice(it.lineTotal);
    row.append(l, r);
    itemsBox.appendChild(row);
  }
  card.appendChild(itemsBox);

  // Payment verification strip
  const payStrip = document.createElement('div');
  payStrip.className = 'chef-payment-strip';
  const payLeft = document.createElement('div');
  const payTitle = document.createElement('strong');
  payTitle.textContent = translatePayment(o.paymentMethod);
  payLeft.appendChild(payTitle);
  if (o.senderWalletPhone) {
    const walletSpan = document.createElement('div');
    walletSpan.className = 'muted-meta';
    walletSpan.textContent = `محفظة المُحوّل: ${o.senderWalletPhone}`;
    payLeft.appendChild(walletSpan);
  }
  payStrip.appendChild(payLeft);

  if (o.paymentMethod === 'COD') {
    const codBadge = document.createElement('span');
    codBadge.className = 'status-badge status-progress';
    codBadge.textContent = 'دفع عند الاستلام (COD)';
    payStrip.appendChild(codBadge);
  } else if (o.hasReceipt || o.receiptImage) {
    const inspectBtn = document.createElement('button');
    inspectBtn.type = 'button';
    inspectBtn.className = 'btn-secondary-dark';
    inspectBtn.style.height = '34px';
    inspectBtn.style.fontSize = '0.8rem';
    inspectBtn.textContent = 'معاينة الإيصال';
    inspectBtn.addEventListener('click', () => openReceiptModal(o));
    payStrip.appendChild(inspectBtn);
  } else {
    const missingBadge = document.createElement('span');
    missingBadge.className = 'status-badge status-rejected';
    missingBadge.textContent = 'إيصال مفقود';
    payStrip.appendChild(missingBadge);
  }
  card.appendChild(payStrip);

  // Totals
  const totals = document.createElement('div');
  totals.className = 'chef-order-totals';
  const feeSpan = document.createElement('span');
  feeSpan.className = 'muted-meta';
  feeSpan.textContent = `التوصيل: ${formatPrice(o.deliveryFee)}`;
  const grandStrong = document.createElement('strong');
  grandStrong.style.color = 'var(--accent-orange)';
  grandStrong.textContent = `الإجمالي: ${formatPrice(o.grandTotal)}`;
  totals.append(feeSpan, grandStrong);
  card.appendChild(totals);

  // Actions
  const actions = document.createElement('div');
  actions.className = 'chef-order-actions';

  if (o.status === 'Pending') {
    const startBtn = document.createElement('button');
    startBtn.type = 'button';
    startBtn.className = 'btn-primary-orange';
    startBtn.style.height = '38px';
    startBtn.textContent = 'بدء التحضير';
    startBtn.addEventListener('click', () => updateOrderAction(o.id, 'start', '', startBtn));

    const rejBtn = document.createElement('button');
    rejBtn.type = 'button';
    rejBtn.className = 'btn-danger-outline';
    rejBtn.textContent = 'رفض الطلب';
    rejBtn.addEventListener('click', () => openRejectModal(o));

    actions.append(startBtn, rejBtn);
  } else if (o.status === 'In Progress') {
    const finBtn = document.createElement('button');
    finBtn.type = 'button';
    finBtn.className = 'btn-emerald-solid';
    finBtn.textContent = 'تأكيد التسليم والتحصيل';
    finBtn.addEventListener('click', () => updateOrderAction(o.id, 'finish', '', finBtn));

    const rejBtn = document.createElement('button');
    rejBtn.type = 'button';
    rejBtn.className = 'btn-danger-outline';
    rejBtn.textContent = 'رفض الطلب';
    rejBtn.addEventListener('click', () => openRejectModal(o));

    actions.append(finBtn, rejBtn);
  } else if (o.status === 'Finished' || o.status === 'Rejected') {
    const archBtn = document.createElement('button');
    archBtn.type = 'button';
    archBtn.className = 'btn-secondary-dark';
    archBtn.style.height = '38px';
    archBtn.textContent = 'أرشفة الطلب';
    archBtn.addEventListener('click', () => updateOrderAction(o.id, 'archive', '', archBtn));
    actions.appendChild(archBtn);
  }

  const printBtn = document.createElement('button');
  printBtn.type = 'button';
  printBtn.className = 'btn-print-receipt';
  printBtn.textContent = 'طباعة الفاتورة';
  printBtn.addEventListener('click', () => printThermalReceipt(o));
  actions.appendChild(printBtn);

  // WhatsApp notification status & manual send/retry control
  const waRow = document.createElement('div');
  waRow.className = 'chef-wa-strip';
  const waInfo = getWhatsappRelayBadgeInfo(o.whatsappStatus);
  const waLeft = document.createElement('div');
  waLeft.className = 'chef-wa-left';
  const waBadgeEl = document.createElement('span');
  waBadgeEl.className = `status-badge ${waInfo.cls}`;
  waBadgeEl.textContent = waInfo.text;
  waLeft.appendChild(waBadgeEl);
  if (o.whatsappLastError && o.whatsappStatus !== 'sent') {
    const waErr = document.createElement('div');
    waErr.className = 'muted-meta';
    waErr.textContent = o.whatsappLastError;
    waLeft.appendChild(waErr);
  }
  waRow.appendChild(waLeft);

  if (o.whatsappStatus !== 'sent' && o.whatsappStatus !== 'sending') {
    const waBtn = document.createElement('button');
    waBtn.type = 'button';
    waBtn.className = 'btn-wa-relay';
    waBtn.textContent = o.whatsappStatus === 'none' ? 'إرسال للواتساب' : 'إعادة إرسال للواتساب';
    waBtn.addEventListener('click', () => triggerOrderWhatsappRelay(o.id, waBtn));
    waRow.appendChild(waBtn);
  }

  card.appendChild(actions);
  card.appendChild(waRow);
  return card;
}

async function triggerOrderWhatsappRelay(orderId, btnEl) {
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = 'جاري الإرسال...';
  }
  try {
    const res = await chefFetch(`/api/chef/orders/${encodeURIComponent(orderId)}/whatsapp`, {
      method: 'POST',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'تعذر إرسال الطلب إلى الواتساب.');
    showToast(
      data.alreadySent
        ? 'تم إرسال هذا الطلب عبر الواتساب مسبقاً'
        : 'تمت إضافة الطلب إلى طابور الإرسال في أداة الواتساب'
    );
    await fetchOrdersAndSettings();
  } catch (err) {
    showToast(err.message);
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = 'إعادة إرسال للواتساب';
    }
  }
}

async function updateOrderAction(orderId, action, rejectionReason = '', btnEl = null) {
  const prevText = btnEl ? btnEl.textContent : '';
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = 'جاري التنفيذ...';
  }
  try {
    const res = await chefFetch(`/api/chef/orders/${encodeURIComponent(orderId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ action, rejectionReason }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'تعذر تحديث الطلب.');

    if (data.order) {
      const idx = state.orders.findIndex((o) => o.id === orderId);
      if (idx !== -1) {
        const cachedReceipt = state.orders[idx].receiptImage || '';
        state.orders[idx] = {
          ...data.order,
          ...(cachedReceipt ? { receiptImage: cachedReceipt } : {}),
        };
      }
      renderTabCounts();
      renderActiveOrders();
      renderArchiveTable();
    } else {
      void fetchOrdersAndSettings();
    }

    if (ordersChannel) {
      ordersChannel.postMessage({ type: 'ORDER_UPDATED', orderId });
    }
    showToast('تم تحديث حالة الطلب');
  } catch (err) {
    showToast(err.message);
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = prevText;
    }
  }
}

// =========================================================
// RECEIPT INSPECTOR & REJECT MODAL & CONFIRM MODAL
// =========================================================
async function openReceiptModal(order) {
  document.getElementById('rm-title').textContent = `إيصال الدفع — ${order.orderCode}`;
  document.getElementById('rm-subtitle').textContent = `${order.customerName} · ${translatePayment(
    order.paymentMethod
  )}`;

  const grid = document.getElementById('rm-meta-grid');
  grid.innerHTML = '';
  const pairs = [
    ['وسيلة الدفع', translatePayment(order.paymentMethod)],
    ['محفظة المُحوّل', order.senderWalletPhone || '—'],
    ['الإجمالي المتوقع', formatPrice(order.grandTotal)],
    ['تاريخ الطلب', formatDateAr(order.createdAt)],
  ];
  for (const [k, v] of pairs) {
    const box = document.createElement('div');
    box.textContent = `${k}: `;
    const st = document.createElement('strong');
    st.textContent = v;
    box.appendChild(st);
    grid.appendChild(box);
  }

  const img = document.getElementById('rm-image');
  const dl = document.getElementById('rm-download-btn');
  img.alt = `إيصال ${order.orderCode}`;

  document.getElementById('receipt-modal').classList.remove('hidden');

  if (!order.receiptImage && order.hasReceipt) {
    img.removeAttribute('src');
    dl.removeAttribute('href');
    try {
      const res = await chefFetch(`/api/chef/orders/${encodeURIComponent(order.id)}/receipt`);
      const data = await res.json();
      if (res.ok && data.receiptImage) {
        order.receiptImage = data.receiptImage;
      } else {
        showToast(data.error || 'تعذر تحميل صورة الإيصال.');
      }
    } catch {
      showToast('تعذر تحميل صورة الإيصال.');
    }
  }

  if (order.receiptImage) {
    img.src = order.receiptImage;
    dl.href = order.receiptImage;
    dl.download = `receipt-${order.orderCode}.png`;
  }
}

function closeReceiptModal() {
  document.getElementById('receipt-modal').classList.add('hidden');
}

function openRejectModal(order) {
  state.pendingRejectOrderId = order.id;
  document.getElementById('reject-order-code').textContent = order.orderCode;
  document.getElementById('reject-reason-input').value = '';
  document.getElementById('reject-modal').classList.remove('hidden');
  document.getElementById('reject-reason-input').focus();
}

function closeRejectModal() {
  state.pendingRejectOrderId = null;
  document.getElementById('reject-modal').classList.add('hidden');
}

function openConfirmModal(title, desc, onConfirm) {
  document.getElementById('confirm-modal-title').textContent = title;
  document.getElementById('confirm-modal-desc').textContent = desc;
  state.pendingConfirmAction = onConfirm;
  document.getElementById('confirm-modal').classList.remove('hidden');
}

function closeConfirmModal() {
  state.pendingConfirmAction = null;
  document.getElementById('confirm-modal').classList.add('hidden');
}

// =========================================================
// 80MM THERMAL RECEIPT PRINTING
// =========================================================
function printThermalReceipt(order) {
  const container = document.getElementById('printable-receipt-container');
  container.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'thermal-head';
  const h2 = document.createElement('h2');
  h2.textContent = 'حلبية للمشويات والمأكولات';
  const sub = document.createElement('div');
  sub.textContent = `رقم الطلب: ${order.orderCode}`;
  const dt = document.createElement('div');
  dt.textContent = formatDateAr(order.createdAt);
  head.append(h2, sub, dt);

  const cust = document.createElement('div');
  cust.className = 'thermal-section';
  const c1 = document.createElement('div');
  c1.textContent = `العميل: ${order.customerName}`;
  const c2 = document.createElement('div');
  c2.textContent = `الهاتف: ${order.customerPhone}`;
  const c3 = document.createElement('div');
  c3.textContent = `العنوان: ${order.deliveryAddress}`;
  const c4 = document.createElement('div');
  c4.textContent = `الدفع: ${translatePayment(order.paymentMethod)}${
    order.senderWalletPhone ? ' (' + order.senderWalletPhone + ')' : ''
  }`;
  cust.append(c1, c2, c3, c4);
  if (order.deliveryNotes) {
    const c5 = document.createElement('div');
    c5.textContent = `ملاحظات: ${order.deliveryNotes}`;
    cust.appendChild(c5);
  }

  const table = document.createElement('table');
  table.className = 'thermal-table';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>الصنف</th><th>الكمية</th><th>الإجمالي</th></tr>';
  const tbody = document.createElement('tbody');
  for (const it of order.items || []) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    td1.textContent = it.name;
    const td2 = document.createElement('td');
    td2.textContent = String(it.quantity);
    const td3 = document.createElement('td');
    td3.textContent = formatPrice(it.lineTotal);
    tr.append(td1, td2, td3);
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);

  const totals = document.createElement('div');
  totals.className = 'thermal-totals';
  const t1 = document.createElement('div');
  t1.textContent = `المجموع الفرعي: ${formatPrice(order.subtotal)}`;
  const t2 = document.createElement('div');
  t2.textContent = `رسوم التوصيل: ${formatPrice(order.deliveryFee)}`;
  const t3 = document.createElement('div');
  t3.className = 'thermal-grand';
  t3.textContent = `الإجمالي النهائي: ${formatPrice(order.grandTotal)}`;
  totals.append(t1, t2, t3);

  const foot = document.createElement('div');
  foot.className = 'thermal-foot';
  const f1 = document.createElement('div');
  const supportNum = (state.settings && state.settings.supportNumber) || '0 12 3456789';
  f1.textContent = `خدمة العملاء والشكاوى: ${supportNum}`;
  const f2 = document.createElement('div');
  f2.textContent = 'شكراً لطلبكم من حلبية';
  foot.append(f1, f2);

  container.append(head, cust, table, totals, foot);
  window.print();
}

// =========================================================
// TAB 2: ARCHIVED ORDERS
// =========================================================
function renderArchiveTable() {
  const archived = state.orders.filter((o) => o.isArchived);
  const tbody = document.getElementById('archive-table-body');
  const emptyEl = document.getElementById('archive-empty-msg');
  const selectAll = document.getElementById('archive-select-all');

  tbody.innerHTML = '';

  // Prune stale selections
  const archivedIds = new Set(archived.map((o) => o.id));
  for (const id of [...state.selectedArchiveIds]) {
    if (!archivedIds.has(id)) state.selectedArchiveIds.delete(id);
  }

  updateArchiveSelectionUI(archived.length);

  if (archived.length === 0) {
    emptyEl.classList.remove('hidden');
    selectAll.checked = false;
    return;
  }

  emptyEl.classList.add('hidden');
  selectAll.checked = state.selectedArchiveIds.size === archived.length;

  for (const o of archived) {
    const tr = document.createElement('tr');

    const tdCheck = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.selectedArchiveIds.has(o.id);
    cb.addEventListener('change', () => {
      if (cb.checked) state.selectedArchiveIds.add(o.id);
      else state.selectedArchiveIds.delete(o.id);
      updateArchiveSelectionUI(archived.length);
    });
    tdCheck.appendChild(cb);

    const tdCode = document.createElement('td');
    tdCode.dir = 'ltr';
    tdCode.textContent = o.orderCode;

    const tdCust = document.createElement('td');
    tdCust.textContent = `${o.customerName} (${o.customerPhone})`;

    const tdStatus = document.createElement('td');
    const bInfo = getStatusBadgeInfo(o.status);
    const badge = document.createElement('span');
    badge.className = `status-badge ${bInfo.cls}`;
    badge.textContent = bInfo.text;
    tdStatus.appendChild(badge);

    const tdPay = document.createElement('td');
    tdPay.textContent =
      translatePayment(o.paymentMethod) +
      (o.senderWalletPhone ? ` · ${o.senderWalletPhone}` : '');

    const tdTotal = document.createElement('td');
    tdTotal.textContent = formatPrice(o.grandTotal);

    const tdDate = document.createElement('td');
    tdDate.textContent = formatDateAr(o.createdAt);

    const tdActions = document.createElement('td');
    const actWrap = document.createElement('div');
    actWrap.style.display = 'flex';
    actWrap.style.gap = '6px';

    if (o.hasReceipt || o.receiptImage) {
      const rBtn = document.createElement('button');
      rBtn.type = 'button';
      rBtn.className = 'btn-copy-small';
      rBtn.textContent = 'الإيصال';
      rBtn.addEventListener('click', () => openReceiptModal(o));
      actWrap.appendChild(rBtn);
    }

    const pBtn = document.createElement('button');
    pBtn.type = 'button';
    pBtn.className = 'btn-copy-small';
    pBtn.textContent = 'طباعة';
    pBtn.addEventListener('click', () => printThermalReceipt(o));
    actWrap.appendChild(pBtn);

    const dBtn = document.createElement('button');
    dBtn.type = 'button';
    dBtn.className = 'btn-danger-outline';
    dBtn.style.height = '32px';
    dBtn.style.paddingInline = '10px';
    dBtn.textContent = 'حذف';
    dBtn.addEventListener('click', () => {
      openConfirmModal(
        `حذف الطلب ${o.orderCode} نهائياً؟`,
        'سيتم إزالة هذا الطلب نهائياً من الأرشيف ومن صفحة "طلباتي" لدى العميل.',
        () => permanentlyDeleteOrders([o.id])
      );
    });
    actWrap.appendChild(dBtn);
    tdActions.appendChild(actWrap);

    tr.append(tdCheck, tdCode, tdCust, tdStatus, tdPay, tdTotal, tdDate, tdActions);
    tbody.appendChild(tr);
  }
}

function updateArchiveSelectionUI(totalArchived) {
  const cnt = state.selectedArchiveIds.size;
  document.getElementById('selected-archive-count').textContent = String(cnt);
  document.getElementById('archive-delete-selected-btn').disabled = cnt === 0;
  document.getElementById('archive-select-all').checked =
    totalArchived > 0 && cnt === totalArchived;
}

async function permanentlyDeleteOrders(ids, clearAllArchive = false) {
  try {
    const res = await chefFetch('/api/chef/orders/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ ids, clearAllArchive }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'تعذر الحذف.');
    state.selectedArchiveIds.clear();
    if (ordersChannel) {
      ordersChannel.postMessage({ type: 'ORDER_DELETED' });
    }
    showToast(`تم حذف ${data.deletedCount} طلب نهائياً`);
    await fetchOrdersAndSettings();
  } catch (err) {
    showToast(err.message);
  }
}

// =========================================================
// TAB 3: SALES & PROFITS ANALYTICS
// =========================================================
async function fetchAnalytics() {
  if (!state.authenticated) return;
  try {
    const res = await chefFetch(
      `/api/chef/analytics?period=${encodeURIComponent(state.analyticsPeriod)}`
    );
    if (!res.ok) return;
    const data = await res.json();
    renderAnalytics(data);
  } catch {
    // Ignore transient analytics error
  }
}

function renderAnalytics(data) {
  const k = data.kpis || {};
  document.getElementById('kpi-revenue').textContent = formatPrice(k.totalSalesRevenue || 0);
  document.getElementById('kpi-profit').textContent = formatPrice(k.totalNetProfit || 0);
  document.getElementById('kpi-margin').textContent = `${k.profitMarginPercent || 0}%`;
  document.getElementById('kpi-orders-count').textContent = String(k.completedOrdersCount || 0);
  document.getElementById('kpi-items-sold').textContent = String(k.totalItemsSold || 0);

  const resetInfo = document.getElementById('analytics-reset-info');
  resetInfo.textContent = data.profitResetAt
    ? `تم تصفير العداد في: ${formatDateAr(data.profitResetAt)}`
    : '';

  // Completed Orders Table
  const ordersBody = document.getElementById('analytics-orders-body');
  const ordersEmpty = document.getElementById('analytics-orders-empty');
  const completed = data.completedOrders || [];
  ordersBody.innerHTML = '';

  if (completed.length === 0) {
    ordersEmpty.classList.remove('hidden');
  } else {
    ordersEmpty.classList.add('hidden');
    for (const o of completed) {
      const tr = document.createElement('tr');
      const tdCode = document.createElement('td');
      tdCode.dir = 'ltr';
      tdCode.textContent = o.orderCode;

      const tdCust = document.createElement('td');
      tdCust.textContent = `${o.customerName} (${o.customerPhone})`;

      const tdItems = document.createElement('td');
      tdItems.textContent = (o.items || []).map((i) => `${i.name} ×${i.quantity}`).join('، ');

      const tdPay = document.createElement('td');
      tdPay.textContent =
        translatePayment(o.paymentMethod) +
        (o.senderWalletPhone ? ` · ${o.senderWalletPhone}` : '');

      const tdTotal = document.createElement('td');
      tdTotal.textContent = formatPrice(o.grandTotal);

      const tdDate = document.createElement('td');
      tdDate.textContent = formatDateAr(o.completedAt || o.updatedAt || o.createdAt);

      const tdPrint = document.createElement('td');
      const pBtn = document.createElement('button');
      pBtn.type = 'button';
      pBtn.className = 'btn-copy-small';
      pBtn.textContent = 'طباعة';
      pBtn.addEventListener('click', () => printThermalReceipt(o));
      tdPrint.appendChild(pBtn);

      tr.append(tdCode, tdCust, tdItems, tdPay, tdTotal, tdDate, tdPrint);
      ordersBody.appendChild(tr);
    }
  }

  // Sold Products Log Table
  const prodBody = document.getElementById('analytics-products-body');
  const prodFoot = document.getElementById('analytics-products-foot');
  const prodEmpty = document.getElementById('analytics-products-empty');
  const log = data.soldProductsLog || [];
  prodBody.innerHTML = '';
  prodFoot.innerHTML = '';

  if (log.length === 0) {
    prodEmpty.classList.remove('hidden');
  } else {
    prodEmpty.classList.add('hidden');
    let sumQty = 0;
    let sumLineTotal = 0;
    let sumLineProfit = 0;

    for (const row of log) {
      sumQty += Number(row.quantity || 0);
      sumLineTotal += Number(row.lineTotal || 0);
      sumLineProfit += Number(row.lineProfit || 0);

      const tr = document.createElement('tr');
      const cells = [
        row.productName,
        row.category,
        String(row.quantity),
        formatPrice(row.unitPrice),
        formatPrice(row.lineTotal),
        formatPrice(row.unitProfit),
        formatPrice(row.lineProfit),
        row.orderCode,
        formatDateAr(row.saleDate),
      ];
      for (const txt of cells) {
        const td = document.createElement('td');
        td.textContent = txt;
        tr.appendChild(td);
      }
      prodBody.appendChild(tr);
    }

    const footTr = document.createElement('tr');
    footTr.innerHTML = `
      <td colspan="2">الإجمالي الكلي</td>
      <td>${sumQty}</td>
      <td>—</td>
      <td>${formatPrice(sumLineTotal)}</td>
      <td>—</td>
      <td>${formatPrice(sumLineProfit)}</td>
      <td colspan="2"></td>
    `;
    prodFoot.appendChild(footTr);
  }
}

// =========================================================
// TAB 4: STORE SETTINGS & CATALOG PREVIEW
// =========================================================
function syncSettingsUI() {
  if (!state.settings) return;
  const s = state.settings;

  const headerBadge = document.getElementById('chef-header-store-badge');
  const liveBadge = document.getElementById('settings-live-badge');
  headerBadge.textContent = s.isOpen ? 'المتجر مفتوح' : 'المتجر مغلق';
  headerBadge.classList.toggle('closed', !s.isOpen);

  liveBadge.textContent = s.isOpen ? 'مفتوح حالياً' : 'مغلق حالياً';
  liveBadge.className = `status-badge ${s.isOpen ? 'status-finished' : 'status-rejected'}`;

  // Do NOT overwrite unsaved admin edits while typing
  if (state.settingsDirty) return;

  document.getElementById('set-is-open').checked = Boolean(s.isOpen);
  document.getElementById('set-open-time').value = s.openTime || '11:00 ص';
  document.getElementById('set-close-time').value = s.closeTime || '02:00 ص';
  document.getElementById('set-delivery-fee').value = String(s.deliveryFee ?? 25);
  document.getElementById('set-transfer-number').value = s.transferNumber || '0123456789';
  document.getElementById('set-support-number').value = s.supportNumber || '0 12 3456789';
  document.getElementById('set-customer-note').value = s.customerNote || '';
}

async function handleSaveSettings(e) {
  e.preventDefault();
  const saveBtn = document.getElementById('save-settings-btn');
  const payload = {
    isOpen: document.getElementById('set-is-open').checked,
    openTime: document.getElementById('set-open-time').value.trim(),
    closeTime: document.getElementById('set-close-time').value.trim(),
    deliveryFee: Number(document.getElementById('set-delivery-fee').value || 0),
    transferNumber: document.getElementById('set-transfer-number').value.trim(),
    supportNumber: document.getElementById('set-support-number').value.trim(),
    customerNote: document.getElementById('set-customer-note').value.trim(),
  };

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'جاري الحفظ...';
  }

  try {
    const res = await chefFetch('/api/chef/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'تعذر حفظ الإعدادات.');
    state.settings = data.settings;
    state.settingsDirty = false;
    syncSettingsUI();
    const clearedCount = Number(data.clearedArchiveCount || 0);
    if (clearedCount > 0) {
      state.orders = state.orders.filter((o) => !o.isArchived);
      state.selectedArchiveIds.clear();
      renderTabCounts();
      renderArchiveTable();
      if (ordersChannel) {
        ordersChannel.postMessage({ type: 'ORDER_DELETED' });
      }
      showToast(`تم إغلاق استقبال الطلبات ومسح ${clearedCount} طلب من الأرشيف تلقائياً`);
    } else {
      showToast('تم حفظ الإعدادات وتطبيقها فوراً على المتجر');
    }
    if (ordersChannel) {
      ordersChannel.postMessage({ type: 'SETTINGS_UPDATED' });
    }
  } catch (err) {
    showToast(err.message);
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'حفظ الإعدادات وتطبيقها فوراً';
    }
  }
}

async function fetchChefCatalog(fresh = false) {
  if (!state.authenticated) return;
  try {
    const res = await chefFetch(`/api/chef/catalog${fresh ? '?fresh=1' : ''}`);
    if (!res.ok) return;
    const data = await res.json();
    state.catalog = Array.isArray(data.products) ? data.products : [];
    renderChefCatalogTable();
    if (fresh) showToast('تم تحديث الكتالوج من Google Sheets');
  } catch {
    showToast('تعذر تحديث الكتالوج');
  }
}

function renderChefCatalogTable() {
  const tbody = document.getElementById('chef-catalog-body');
  tbody.innerHTML = '';

  if (state.catalog.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'table-empty-msg';
    td.textContent = 'لا توجد منتجات في Google Sheets حالياً.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const p of state.catalog) {
    const tr = document.createElement('tr');
    const tdImg = document.createElement('td');
    const img = document.createElement('img');
    img.className = 'catalog-thumb-sm';
    img.src = p.primaryImage || BRAND_LOGO_URL;
    img.alt = p.name;
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => {
      img.src = BRAND_LOGO_URL;
    };
    tdImg.appendChild(img);

    const cells = [
      p.name,
      p.category,
      formatPrice(p.price),
      formatPrice(p.cost),
      formatPrice(p.profit),
      p.description || '—',
    ];
    tr.appendChild(tdImg);
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

// =========================================================
// EVENT BINDINGS & INIT
// =========================================================
function bindEvents() {
  // Unlock Web Audio on first user interaction
  ['click', 'keydown', 'touchstart'].forEach((ev) => {
    document.addEventListener(ev, unlockAudioContext, { once: true, passive: true });
  });

  // Auth
  document.getElementById('chef-login-form').addEventListener('submit', handleLoginSubmit);
  document.getElementById('toggle-pin-vis-btn').addEventListener('click', () => {
    const inp = document.getElementById('chef-pin-input');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });
  document.getElementById('chef-logout-btn').addEventListener('click', async () => {
    await fetch('/api/chef/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
    handleUnauthorized();
  });

  // Audio toggle
  document.getElementById('audio-toggle-btn').addEventListener('click', () => {
    state.audioMuted = !state.audioMuted;
    updateAudioToggleUI();
    if (!state.audioMuted) {
      playNotificationChime();
      showToast('تم تفعيل صوت تنبيه الطلبات');
    }
  });

  // Main tabs
  document.querySelectorAll('#chef-main-tabs .category-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeTab = btn.dataset.tab;
      document
        .querySelectorAll('#chef-main-tabs .category-pill')
        .forEach((b) => b.classList.toggle('active', b === btn));

      document
        .querySelectorAll('.chef-tab-panel')
        .forEach((panel) => panel.classList.toggle('hidden', panel.id !== `tab-panel-${state.activeTab}`));

      if (state.activeTab === 'analytics') {
        fetchAnalytics();
      } else if (state.activeTab === 'settings') {
        fetchChefCatalog(false);
      }
    });
  });

  // Active status filters
  document.querySelectorAll('#active-status-filters .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeStatusFilter = btn.dataset.status;
      document
        .querySelectorAll('#active-status-filters .filter-chip')
        .forEach((b) => b.classList.toggle('active', b === btn));
      renderActiveOrders();
    });
  });

  // Archive checkboxes & bulk delete
  document.getElementById('archive-select-all').addEventListener('change', (e) => {
    const archived = state.orders.filter((o) => o.isArchived);
    if (e.target.checked) {
      archived.forEach((o) => state.selectedArchiveIds.add(o.id));
    } else {
      state.selectedArchiveIds.clear();
    }
    renderArchiveTable();
  });

  document.getElementById('archive-delete-selected-btn').addEventListener('click', () => {
    const ids = [...state.selectedArchiveIds];
    if (ids.length === 0) return;
    openConfirmModal(
      `حذف ${ids.length} طلب محدد نهائياً؟`,
      'لا يمكن التراجع عن هذا الإجراء وسيتم إزالة الطلبات من الأرشيف ومن سجل العملاء.',
      () => permanentlyDeleteOrders(ids)
    );
  });

  document.getElementById('archive-clear-all-btn').addEventListener('click', () => {
    const archived = state.orders.filter((o) => o.isArchived);
    if (archived.length === 0) return;
    openConfirmModal(
      'مسح الأرشيف بالكامل؟',
      `سيتم حذف جميع الطلبات المؤرشفة (${archived.length}) نهائياً من الأرشيف ومن سجل العملاء.`,
      () => permanentlyDeleteOrders([], true)
    );
  });

  // Analytics period & subtabs & reset
  document.querySelectorAll('#analytics-period-filters .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.analyticsPeriod = btn.dataset.period;
      document
        .querySelectorAll('#analytics-period-filters .filter-chip')
        .forEach((b) => b.classList.toggle('active', b === btn));
      fetchAnalytics();
    });
  });

  document.querySelectorAll('#analytics-subtabs .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.analyticsSubtab = btn.dataset.subtab;
      document
        .querySelectorAll('#analytics-subtabs .filter-chip')
        .forEach((b) => b.classList.toggle('active', b === btn));
      document
        .getElementById('subtab-completed-orders')
        .classList.toggle('hidden', state.analyticsSubtab !== 'completed-orders');
      document
        .getElementById('subtab-sold-products')
        .classList.toggle('hidden', state.analyticsSubtab !== 'sold-products');
    });
  });

  document.getElementById('reset-profits-btn').addEventListener('click', () => {
    openConfirmModal(
      'تصفير عداد المبيعات والأرباح؟',
      'سيتم بدء احتساب المبيعات والأرباح من هذه اللحظة دون حذف الطلبات المؤرشفة.',
      async () => {
        const res = await chefFetch('/api/chef/sales-profits/reset', { method: 'POST' });
        if (res.ok) {
          showToast('تم تصفير عداد المبيعات والأرباح');
          await fetchAnalytics();
        }
      }
    );
  });

  // Settings form dirty tracking (prevents 4s polling overwrite while admin is typing)
  const settingsForm = document.getElementById('chef-settings-form');
  [
    'set-is-open',
    'set-open-time',
    'set-close-time',
    'set-delivery-fee',
    'set-transfer-number',
    'set-support-number',
    'set-customer-note',
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      state.settingsDirty = true;
    });
    el.addEventListener('change', () => {
      state.settingsDirty = true;
    });
  });
  settingsForm.addEventListener('submit', handleSaveSettings);

  document.getElementById('chef-refresh-sheets-btn').addEventListener('click', () => {
    fetchChefCatalog(true);
  });

  // Modals
  document.getElementById('rm-close-btn').addEventListener('click', closeReceiptModal);
  document.getElementById('rm-close-btn-2').addEventListener('click', closeReceiptModal);
  document.getElementById('receipt-modal').addEventListener('click', (e) => {
    if (e.target.id === 'receipt-modal') closeReceiptModal();
  });

  document.getElementById('reject-cancel-btn').addEventListener('click', closeRejectModal);
  document.getElementById('reject-modal').addEventListener('click', (e) => {
    if (e.target.id === 'reject-modal') closeRejectModal();
  });
  document.getElementById('reject-order-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const reason = document.getElementById('reject-reason-input').value.trim();
    if (!reason || !state.pendingRejectOrderId) return;
    const id = state.pendingRejectOrderId;
    closeRejectModal();
    await updateOrderAction(id, 'reject', reason);
  });

  document.getElementById('confirm-modal-no').addEventListener('click', closeConfirmModal);
  document.getElementById('confirm-modal').addEventListener('click', (e) => {
    if (e.target.id === 'confirm-modal') closeConfirmModal();
  });
  document.getElementById('confirm-modal-yes').addEventListener('click', async () => {
    const fn = state.pendingConfirmAction;
    closeConfirmModal();
    if (fn) await fn();
  });

  if (ordersChannel) {
    ordersChannel.onmessage = () => {
      if (state.authenticated) fetchOrdersAndSettings();
    };
  }

  window.addEventListener('focus', () => {
    if (state.authenticated) fetchOrdersAndSettings();
  });
  document.addEventListener('visibilitychange', () => {
    if (state.authenticated && document.visibilityState === 'visible') {
      fetchOrdersAndSettings();
    }
  });
}

updateAudioToggleUI();
bindEvents();
checkAuthStatus();
