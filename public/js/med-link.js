import { apiUrl, getApiOrigin } from '/js/config.js';

const TOKEN_STORAGE_KEY = 'halabiya_chef_token_v1';

const state = {
  authenticated: false,
  needsPinSetup: false,
  token: localStorage.getItem(TOKEN_STORAGE_KEY) || '',
  activeTab: 'connection',
  orderStatusFilter: 'all',
  orderSearch: '',
  configDirty: false,
  waState: null,
  config: null,
  orders: [],
  stats: { total: 0, sent: 0, pending: 0, failed: 0 },
  logs: [],
  pollTimer: null,
};

function showToast(message) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast-item';
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

function formatDateAr(msOrIso) {
  if (!msOrIso) return '—';
  try {
    return new Intl.DateTimeFormat('ar-EG', {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(msOrIso));
  } catch {
    return String(msOrIso);
  }
}

async function medlinkFetch(url, options = {}) {
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

  const res = await fetch(apiUrl(url), {
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
  document.getElementById('medlink-dashboard-screen').classList.add('hidden');
  document.getElementById('medlink-auth-screen').classList.remove('hidden');
}

async function checkAuthStatus() {
  try {
    const res = await fetch(apiUrl('/api/chef/auth/status'), {
      headers: state.token ? { Authorization: `Bearer ${state.token}` } : {},
      credentials: 'include',
      cache: 'no-store',
    });
    const data = await res.json();
    state.needsPinSetup = Boolean(data.needsPinSetup);

    if (data.authenticated) {
      await enterDashboard();
      return;
    }

    const subtitle = document.getElementById('medlink-auth-subtitle');
    const pinLabel = document.getElementById('medlink-pin-label');
    const submitBtn = document.getElementById('medlink-auth-submit');

    if (state.needsPinSetup) {
      subtitle.textContent = 'الإعداد الأول: اختر رمز دخول سري للوحة الشيف وأداة الواتساب (4 أحرف على الأقل)';
      pinLabel.textContent = 'تعيين رمز الدخول الجديد (PIN)';
      submitBtn.textContent = 'حفظ الرمز والدخول';
    }
  } catch {
    // Keep auth screen visible
  }
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  const pinInput = document.getElementById('medlink-pin-input');
  const errEl = document.getElementById('medlink-auth-error');
  const pin = pinInput.value.trim();
  errEl.classList.add('hidden');

  try {
    const endpoint = state.needsPinSetup ? '/api/chef/setup-pin' : '/api/chef/auth';
    const res = await fetch(apiUrl(endpoint), {
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
    await enterDashboard();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

async function enterDashboard() {
  state.authenticated = true;
  document.getElementById('medlink-auth-screen').classList.add('hidden');
  document.getElementById('medlink-dashboard-screen').classList.remove('hidden');

  populateIntegrationUrls();
  await Promise.all([fetchWhatsappStatus(), fetchOrdersQueue(), fetchConfig()]);

  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    void fetchWhatsappStatus();
    void fetchOrdersQueue();
  }, 3000);
}

function populateIntegrationUrls() {
  const origin = getApiOrigin();
  const webhookEl = document.getElementById('ml-webhook-url');
  const dashEl = document.getElementById('ml-dashboard-url');
  if (webhookEl) webhookEl.value = `${origin}/887med-link999/api/orders`;
  if (dashEl) dashEl.value = `${window.location.origin}/887med-link999`;
}

async function fetchWhatsappStatus() {
  if (!state.authenticated) return;
  try {
    const res = await medlinkFetch('/887med-link999/api/whatsapp/status');
    if (!res.ok) return;
    const data = await res.json();
    state.waState = data;
    if (data.stats) state.stats = data.stats;
    renderWhatsappStatus();
    renderStats();
  } catch {
    // Ignore transient polling failures
  }
}

async function fetchConfig() {
  if (!state.authenticated) return;
  try {
    const res = await medlinkFetch('/887med-link999/api/config');
    if (!res.ok) return;
    const data = await res.json();
    state.config = data;
    renderConfig();
  } catch {
    // Ignore transient errors
  }
}

async function fetchOrdersQueue() {
  if (!state.authenticated) return;
  try {
    const params = new URLSearchParams({
      status: state.orderStatusFilter,
      search: state.orderSearch,
    });
    const res = await medlinkFetch(`/887med-link999/api/orders?${params.toString()}`);
    if (!res.ok) return;
    const data = await res.json();
    state.orders = Array.isArray(data.orders) ? data.orders : [];
    state.logs = Array.isArray(data.logs) ? data.logs : [];
    if (data.stats) state.stats = data.stats;
    renderStats();
    renderOrdersList();
    renderLogs();
  } catch {
    // Ignore transient polling failures
  }
}

function renderWhatsappStatus() {
  const wa = state.waState || {};
  const status = wa.status || 'disconnected';

  const headerBadge = document.getElementById('ml-header-wa-badge');
  const statusPill = document.getElementById('ml-status-pill');
  const detailEl = document.getElementById('ml-status-detail');
  const qrPlaceholder = document.getElementById('ml-qr-placeholder');
  const qrImg = document.getElementById('ml-qr-img');
  const connectedBox = document.getElementById('ml-connected-box');
  const lastErrBox = document.getElementById('ml-last-error-box');
  const connectBtn = document.getElementById('ml-connect-btn');

  if (detailEl) detailEl.textContent = wa.statusDetail || 'غير متصل';

  if (status === 'connected') {
    headerBadge.textContent = 'واتساب: متصل';
    headerBadge.classList.remove('closed');
    statusPill.textContent = 'متصل';
    statusPill.className = 'status-badge status-finished';
    qrPlaceholder.classList.add('hidden');
    qrImg.classList.add('hidden');
    connectedBox.classList.remove('hidden');
    document.getElementById('ml-connected-name').textContent = wa.connectedPushName || 'واتساب المطعم';
    document.getElementById('ml-connected-phone').textContent = wa.connectedPhone ? `+${wa.connectedPhone}` : 'متصل';
    connectBtn.disabled = true;
    connectBtn.textContent = 'الجلسة متصلة حالياً';
  } else if (status === 'connecting') {
    headerBadge.textContent = 'واتساب: جاري الربط';
    headerBadge.classList.add('closed');
    statusPill.textContent = wa.qrDataUrl ? 'بانتظار مسح QR' : 'جاري التشغيل...';
    statusPill.className = 'status-badge status-pending';
    connectedBox.classList.add('hidden');
    if (wa.qrDataUrl) {
      qrPlaceholder.classList.add('hidden');
      qrImg.src = wa.qrDataUrl;
      qrImg.classList.remove('hidden');
    } else {
      qrImg.classList.add('hidden');
      qrPlaceholder.classList.remove('hidden');
    }
    connectBtn.disabled = false;
    connectBtn.textContent = 'إعادة توليد رمز QR';
  } else {
    headerBadge.textContent = 'واتساب: غير متصل';
    headerBadge.classList.add('closed');
    statusPill.textContent = 'غير متصل';
    statusPill.className = 'status-badge status-rejected';
    connectedBox.classList.add('hidden');
    qrImg.classList.add('hidden');
    qrPlaceholder.classList.remove('hidden');
    connectBtn.disabled = false;
    connectBtn.textContent = 'اتصال / توليد رمز QR';
  }

  if (wa.lastError) {
    lastErrBox.textContent = `آخر خطأ: ${wa.lastError}`;
    lastErrBox.classList.remove('hidden');
  } else {
    lastErrBox.classList.add('hidden');
  }
}

function renderStats() {
  const s = state.stats || {};
  document.getElementById('ml-tab-orders-count').textContent = String(s.total || 0);
  document.getElementById('ml-kpi-total').textContent = String(s.total || 0);
  document.getElementById('ml-kpi-sent').textContent = String(s.sent || 0);
  document.getElementById('ml-kpi-pending').textContent = String(s.pending || 0);
  document.getElementById('ml-kpi-failed').textContent = String(s.failed || 0);
}

function renderConfig() {
  const c = state.config;
  if (!c) return;

  const previewEl = document.getElementById('ml-test-recipient-preview');
  if (previewEl) {
    previewEl.textContent = `${c.recipientNumber} (${c.recipientJidPreview || '—'})`;
  }

  const jidLabel = document.getElementById('ml-cfg-recipient-jid');
  if (jidLabel) {
    jidLabel.textContent = `معرف واتساب المستهدف: ${c.recipientJidPreview || '—'}`;
  }

  const sourceEl = document.getElementById('ml-secret-source-label');
  if (sourceEl) {
    if (c.webhookSecretSource === 'env') {
      sourceEl.textContent = 'مُعد عبر متغيرات البيئة (WHATSAPP_RELAY_SECRET / WEBHOOK_SECRET)';
    } else if (c.webhookSecretSource === 'stored') {
      sourceEl.textContent = 'مُعد ومحفوظ بصورة مشفرة داخل الأداة (بالإضافة لجسر الربط الداخلي التلقائي)';
    } else {
      sourceEl.textContent = 'الربط الداخلي من الموقع يعمل تلقائياً (ولم يُولّد مفتاح خارجي بعد)';
    }
  }

  if (state.configDirty) return;
  document.getElementById('ml-cfg-sender').value = c.senderNumber || '';
  document.getElementById('ml-cfg-recipient').value = c.recipientNumber || '';
  document.getElementById('ml-cfg-cc').value = c.defaultCountryCode || '20';
}

function getQueueBadge(status) {
  switch (status) {
    case 'sent':
      return { text: 'تم الإرسال ✓', cls: 'status-finished' };
    case 'sending':
      return { text: 'جاري الإرسال...', cls: 'status-progress' };
    case 'failed':
      return { text: 'فشل الإرسال', cls: 'status-rejected' };
    default:
      return { text: 'في الطابور', cls: 'status-pending' };
  }
}

function renderOrdersList() {
  const container = document.getElementById('ml-orders-list');
  container.innerHTML = '';

  if (state.orders.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'catalog-state-box';
    empty.style.gridColumn = '1 / -1';
    const p = document.createElement('p');
    p.textContent = 'لا توجد إشعارات طلبات في الطابور حالياً.';
    empty.appendChild(p);
    container.appendChild(empty);
    return;
  }

  for (const o of state.orders) {
    const card = document.createElement('article');
    card.className = 'chef-order-card';

    const top = document.createElement('div');
    top.className = 'chef-order-top';
    const left = document.createElement('div');
    const code = document.createElement('strong');
    code.className = 'order-code-label';
    code.dir = 'ltr';
    code.textContent = o.orderId;
    const dt = document.createElement('div');
    dt.className = 'order-date-label';
    dt.textContent = `وصل في: ${formatDateAr(o.createdAt)}${o.sentAt ? ` · أُرسل: ${formatDateAr(o.sentAt)}` : ''}`;
    left.append(code, dt);

    const bInfo = getQueueBadge(o.status);
    const badge = document.createElement('span');
    badge.className = `status-badge ${bInfo.cls}`;
    badge.textContent = bInfo.text;
    top.append(left, badge);
    card.appendChild(top);

    const meta = document.createElement('div');
    meta.className = 'chef-order-info-grid';
    const cName = document.createElement('div');
    cName.textContent = 'العميل: ';
    const cNameB = document.createElement('strong');
    cNameB.textContent = o.customerName;
    cName.appendChild(cNameB);

    const cPhone = document.createElement('div');
    cPhone.textContent = 'الهاتف: ';
    const cPhoneB = document.createElement('strong');
    cPhoneB.dir = 'ltr';
    cPhoneB.textContent = o.customerPhone;
    cPhone.appendChild(cPhoneB);

    const payInfo = document.createElement('div');
    payInfo.className = 'full-span';
    payInfo.textContent = `الدفع: ${o.paymentMethod} · الإجمالي: ${o.totalAmount} ${o.currency || 'ج.م'} · المحاولات: ${o.attempts}/${o.maxAttempts}`;

    const receiptBadge = document.createElement('div');
    receiptBadge.className = 'full-span';
    receiptBadge.textContent = o.hasReceipt
      ? '📎 مرفق صورة إيصال حقيقية جاهزة للإرسال على واتساب'
      : '💵 طلب بدون صورة إيصال (دفع عند الاستلام)';

    meta.append(cName, cPhone, payInfo, receiptBadge);
    card.appendChild(meta);

    if (o.lastError) {
      const errBox = document.createElement('div');
      errBox.className = 'rejection-reason-box';
      errBox.textContent = `سبب التأخير/الفشل: ${o.lastError}`;
      card.appendChild(errBox);
    }

    const pre = document.createElement('pre');
    pre.className = 'ml-message-preview';
    pre.textContent = o.formattedMessage || '';
    card.appendChild(pre);

    if (o.status !== 'sent' && o.status !== 'sending') {
      const actions = document.createElement('div');
      actions.className = 'chef-order-actions';
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'btn-primary-orange';
      retryBtn.style.height = '36px';
      retryBtn.textContent = 'إعادة الإرسال الآن';
      retryBtn.addEventListener('click', () => handleRetryOrder(o.orderId));
      actions.appendChild(retryBtn);
      card.appendChild(actions);
    }

    container.appendChild(card);
  }
}

function renderLogs() {
  const container = document.getElementById('ml-logs-list');
  container.innerHTML = '';
  if (state.logs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'table-empty-msg';
    empty.textContent = 'لا توجد أحداث مسجلة بعد.';
    container.appendChild(empty);
    return;
  }

  for (const log of state.logs.slice(0, 20)) {
    const row = document.createElement('div');
    row.className = 'ml-log-row';
    const left = document.createElement('div');
    const code = document.createElement('strong');
    code.dir = 'ltr';
    code.textContent = log.order_id;
    const detail = document.createElement('span');
    detail.textContent = ` — ${log.detail}`;
    left.append(code, detail);

    const time = document.createElement('span');
    time.className = 'muted-meta';
    time.textContent = formatDateAr(log.created_at);
    row.append(left, time);
    container.appendChild(row);
  }
}

async function handleRetryOrder(orderId) {
  try {
    const res = await medlinkFetch(`/887med-link999/api/orders/${encodeURIComponent(orderId)}/retry`, {
      method: 'POST',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'تعذر جدولة إعادة الإرسال.');
    showToast(`تمت إعادة جدولة إرسال الطلب ${orderId}`);
    await fetchOrdersQueue();
  } catch (err) {
    showToast(err.message);
  }
}

function bindEvents() {
  document.getElementById('medlink-login-form').addEventListener('submit', handleLoginSubmit);
  document.getElementById('medlink-toggle-pin-btn').addEventListener('click', () => {
    const inp = document.getElementById('medlink-pin-input');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  document.getElementById('ml-logout-btn').addEventListener('click', async () => {
    await fetch(apiUrl('/api/chef/logout'), { method: 'POST', credentials: 'include' }).catch(() => {});
    handleUnauthorized();
  });

  // Main Tabs
  document.querySelectorAll('#ml-main-tabs .category-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeTab = btn.dataset.tab;
      document
        .querySelectorAll('#ml-main-tabs .category-pill')
        .forEach((b) => b.classList.toggle('active', b === btn));
      document
        .querySelectorAll('.chef-tab-panel')
        .forEach((panel) => panel.classList.toggle('hidden', panel.id !== `ml-panel-${state.activeTab}`));

      if (state.activeTab === 'orders') void fetchOrdersQueue();
      if (state.activeTab === 'config') void fetchConfig();
    });
  });

  // Connect / Disconnect / Test
  document.getElementById('ml-connect-btn').addEventListener('click', async () => {
    try {
      const res = await medlinkFetch('/887med-link999/api/whatsapp/connect', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'تعذر بدء اتصال الواتساب.');
      state.waState = data;
      renderWhatsappStatus();
      showToast('جاري تجهيز رمز QR...');
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById('ml-disconnect-btn').addEventListener('click', async () => {
    try {
      const res = await medlinkFetch('/887med-link999/api/whatsapp/disconnect', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'تعذر قطع الاتصال.');
      state.waState = data;
      renderWhatsappStatus();
      showToast('تم قطع الاتصال ومسح الجلسة');
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById('ml-test-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('ml-test-send-btn');
    const msg = document.getElementById('ml-test-message').value.trim();
    btn.disabled = true;
    btn.textContent = 'جاري الإرسال...';
    try {
      const res = await medlinkFetch('/887med-link999/api/whatsapp/test', {
        method: 'POST',
        body: JSON.stringify({ message: msg || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'فشل إرسال رسالة الاختبار.');
      showToast(`تم إرسال رسالة الاختبار إلى ${data.recipient}`);
      document.getElementById('ml-test-message').value = '';
    } catch (err) {
      showToast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'إرسال رسالة اختبار الآن';
    }
  });

  // Queue filters & search
  document.querySelectorAll('#ml-order-filters .filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.orderStatusFilter = btn.dataset.status || 'all';
      document
        .querySelectorAll('#ml-order-filters .filter-chip')
        .forEach((b) => b.classList.toggle('active', b === btn));
      void fetchOrdersQueue();
    });
  });

  document.getElementById('ml-order-search').addEventListener('input', (e) => {
    state.orderSearch = e.target.value.trim();
    void fetchOrdersQueue();
  });

  // Config form dirty tracking & save
  ['ml-cfg-sender', 'ml-cfg-recipient', 'ml-cfg-cc'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      state.configDirty = true;
    });
  });

  document.getElementById('ml-config-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const saveBtn = document.getElementById('ml-cfg-save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'جاري الحفظ...';
    try {
      const payload = {
        senderNumber: document.getElementById('ml-cfg-sender').value.trim(),
        recipientNumber: document.getElementById('ml-cfg-recipient').value.trim(),
        defaultCountryCode: document.getElementById('ml-cfg-cc').value.trim() || '20',
      };
      const res = await medlinkFetch('/887med-link999/api/config', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'تعذر حفظ الإعدادات.');
      state.config = data;
      state.configDirty = false;
      renderConfig();
      showToast('تم حفظ إعدادات أرقام الواتساب بنجاح');
    } catch (err) {
      showToast(err.message);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'حفظ إعدادات الأرقام';
    }
  });

  // Generate webhook secret
  document.getElementById('ml-generate-secret-btn').addEventListener('click', async () => {
    try {
      const res = await medlinkFetch('/887med-link999/api/config/webhook-secret', {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'تعذر توليد المفتاح.');
      document.getElementById('ml-secret-value').value = data.secret;
      document.getElementById('ml-secret-reveal-box').classList.remove('hidden');
      if (state.config) {
        state.config.webhookSecretSource = data.webhookSecretSource;
        renderConfig();
      }
      showToast('تم توليد Webhook Secret جديد');
    } catch (err) {
      showToast(err.message);
    }
  });

  const bindCopy = (btnId, inputId, toastMsg) => {
    const btn = document.getElementById(btnId);
    const inp = document.getElementById(inputId);
    if (!btn || !inp) return;
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(inp.value);
        showToast(toastMsg);
      } catch {
        inp.select();
      }
    });
  };
  bindCopy('ml-secret-copy-btn', 'ml-secret-value', 'تم نسخ المفتاح');
  bindCopy('ml-copy-webhook-btn', 'ml-webhook-url', 'تم نسخ رابط الـ Webhook');
  bindCopy('ml-copy-dashboard-btn', 'ml-dashboard-url', 'تم نسخ رابط الأداة');
}

document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  void checkAuthStatus();
});
