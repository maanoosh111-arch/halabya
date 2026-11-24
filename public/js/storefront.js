const BRAND_LOGO_URL =
  'https://res.cloudinary.com/h74mxqsb/image/upload/v1795436487/95198036-2120-422b-af14-18355e8b50d3-Photoroom_hnnnve.png';
const CART_STORAGE_KEY = 'halabiya_cart_v1';
const ORDER_CODES_KEY = 'halabiya_order_codes_v1';
const CUSTOMER_PHONE_KEY = 'halabiya_customer_phone_v1';
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;

const ordersChannel =
  typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('halabiya_orders_channel')
    : null;

const state = {
  settings: {
    isOpen: true,
    openTime: '11:00 ص',
    closeTime: '02:00 ص',
    customerNote: '',
    deliveryFee: 25,
    transferNumber: '0123456789',
    supportNumber: '0 12 3456789',
  },
  categories: [],
  products: [],
  activeCategory: 'All',
  searchQuery: '',
  cart: loadCart(),
  orderCodes: loadOrderCodes(),
  lookupPhone: localStorage.getItem(CUSTOMER_PHONE_KEY) || '',
  newlyPlacedCode: null,
  modalProduct: null,
  modalImageIndex: 0,
  modalQty: 1,
  drawerStep: 'cart',
  selectedPaymentMethod: 'Vodafone Cash',
  receiptDataUrl: '',
  lastSuccessOrder: null,
  isSubmittingOrder: false,
  catalogLoading: true,
  catalogError: null,
};

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPrice(val) {
  const n = Number(val || 0);
  const rounded = Math.round(n * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)} ج.م`;
}

function formatDateAr(iso) {
  try {
    return new Intl.DateTimeFormat('ar-EG', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return iso || '';
  }
}

function loadCart() {
  try {
    const raw = localStorage.getItem(CART_STORAGE_KEY);
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCart() {
  localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(state.cart));
  updateCartBadge();
}

function loadOrderCodes() {
  try {
    const raw = localStorage.getItem(ORDER_CODES_KEY);
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveOrderCode(code) {
  if (!code) return;
  if (!state.orderCodes.includes(code)) {
    state.orderCodes.unshift(code);
    localStorage.setItem(ORDER_CODES_KEY, JSON.stringify(state.orderCodes));
  }
}

function showToast(message) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast-item';
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 3200);
}

async function copyText(text, btnEl, defaultLabel) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  if (btnEl) {
    const prev = defaultLabel || btnEl.textContent;
    btnEl.textContent = 'تم النسخ ✓';
    setTimeout(() => {
      btnEl.textContent = prev;
    }, 1800);
  }
  showToast('تم النسخ إلى الحافظة');
}

// =========================================================
// SETTINGS POLLING & STORE OPEN/CLOSED STATE
// =========================================================
function cleanPhoneDigits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function formatWhatsAppUrl(phone) {
  const digits = cleanPhoneDigits(phone);
  if (!digits) return 'https://wa.me/20123456789';
  if (digits.startsWith('0')) return `https://wa.me/2${digits}`;
  return `https://wa.me/${digits}`;
}

async function fetchSettings() {
  try {
    const res = await fetch('/api/settings', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    state.settings = {
      isOpen: Boolean(data.isOpen),
      openTime: data.openTime || '11:00 ص',
      closeTime: data.closeTime || '02:00 ص',
      customerNote: data.customerNote || '',
      deliveryFee: Number(data.deliveryFee ?? 25),
      transferNumber: data.transferNumber || '0123456789',
      supportNumber: data.supportNumber || '0 12 3456789',
    };
    applyStoreStatusUI();
    renderCartAndCheckoutTotals();
  } catch {
    // Ignore transient network errors during polling
  }
}

function applyStoreStatusUI() {
  const { isOpen, openTime, closeTime, customerNote, deliveryFee, transferNumber, supportNumber } =
    state.settings;

  const alertBar = document.getElementById('closed-store-alert');
  const alertText = document.getElementById('closed-alert-text');
  const closedPanel = document.getElementById('store-closed-panel');
  const catNav = document.getElementById('category-nav-bar');
  const catalogSec = document.getElementById('catalog-section');
  const openTimeEl = document.getElementById('closed-open-time');
  const closeTimeEl = document.getElementById('closed-close-time');
  const noteWrap = document.getElementById('closed-admin-note-wrap');
  const noteText = document.getElementById('closed-admin-note-text');
  const footerDelivery = document.getElementById('footer-delivery-tag');
  const coTransferNum = document.getElementById('co-transfer-number');
  const proceedBtn = document.getElementById('proceed-checkout-btn');
  const submitBtn = document.getElementById('submit-order-btn');

  const supportDisplay = supportNumber || '0 12 3456789';
  const supportDigits = cleanPhoneDigits(supportDisplay) || '0123456789';
  const supportWaUrl = formatWhatsAppUrl(supportDisplay);

  const footerSupportDisplay = document.getElementById('footer-support-display');
  const footerSupportCopy = document.getElementById('footer-support-copy');
  const footerSupportWa = document.getElementById('footer-support-whatsapp');
  const successSupportDisplay = document.getElementById('success-support-display');
  const successSupportCopy = document.getElementById('success-support-copy');
  const successSupportWa = document.getElementById('success-support-whatsapp');

  if (footerSupportDisplay) footerSupportDisplay.textContent = supportDisplay;
  if (footerSupportCopy) footerSupportCopy.dataset.copy = supportDigits;
  if (footerSupportWa) footerSupportWa.href = supportWaUrl;
  if (successSupportDisplay) successSupportDisplay.textContent = supportDisplay;
  if (successSupportCopy) successSupportCopy.dataset.copy = supportDigits;
  if (successSupportWa) successSupportWa.href = supportWaUrl;

  if (footerDelivery) {
    footerDelivery.textContent = `رسوم التوصيل: ${formatPrice(deliveryFee)}`;
  }
  if (coTransferNum) {
    coTransferNum.textContent = transferNumber;
  }

  if (!isOpen) {
    alertBar.classList.remove('hidden');
    alertText.textContent = `المتجر مغلق حالياً — يفتح في ${openTime}`;
    closedPanel.classList.remove('hidden');
    catNav.classList.add('hidden');
    catalogSec.classList.add('hidden');
    openTimeEl.textContent = openTime;
    closeTimeEl.textContent = closeTime;

    if (customerNote) {
      noteWrap.classList.remove('hidden');
      noteText.textContent = customerNote;
    } else {
      noteWrap.classList.add('hidden');
    }

    if (proceedBtn) proceedBtn.disabled = true;
    if (submitBtn) submitBtn.disabled = true;
  } else {
    alertBar.classList.add('hidden');
    closedPanel.classList.add('hidden');
    catNav.classList.remove('hidden');
    catalogSec.classList.remove('hidden');
    if (proceedBtn) proceedBtn.disabled = false;
    updateCheckoutSubmitState();
  }
}

// =========================================================
// CATALOG SYNC & RENDERING
// =========================================================
async function fetchCatalog({ fresh = false } = {}) {
  const refreshBtn = document.getElementById('refresh-catalog-btn');
  if (refreshBtn && fresh) refreshBtn.classList.add('spinning');

  if (state.products.length === 0) {
    state.catalogLoading = true;
    renderCatalogState();
  }

  try {
    const res = await fetch(`/api/products${fresh ? '?fresh=1' : ''}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('فشل تحميل المنتجات');
    const data = await res.json();
    state.categories = Array.isArray(data.categories) ? data.categories : [];
    state.products = Array.isArray(data.products) ? data.products : [];
    state.catalogError = data.error || null;
  } catch (err) {
    state.catalogError = err.message || 'تعذر الاتصال بالسيرفر';
  } finally {
    state.catalogLoading = false;
    if (refreshBtn) refreshBtn.classList.remove('spinning');
    renderCategoryPills();
    renderProductsGrid();
    syncProductFromPath();
  }
}

function getFilteredProducts() {
  const q = state.searchQuery.trim().toLowerCase();
  return state.products.filter((p) => {
    const matchesCat = state.activeCategory === 'All' || p.category === state.activeCategory;
    if (!matchesCat) return false;
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q)
    );
  });
}

function renderCategoryPills() {
  const container = document.getElementById('category-pills');
  if (!container) return;
  container.innerHTML = '';

  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = `category-pill ${state.activeCategory === 'All' ? 'active' : ''}`;
  const allLabel = document.createElement('span');
  allLabel.textContent = 'الكل';
  const allCount = document.createElement('span');
  allCount.className = 'pill-count';
  allCount.textContent = String(state.products.length);
  allBtn.append(allLabel, allCount);
  allBtn.addEventListener('click', () => {
    state.activeCategory = 'All';
    renderCategoryPills();
    renderProductsGrid();
  });
  container.appendChild(allBtn);

  for (const cat of state.categories) {
    const count = state.products.filter((p) => p.category === cat).length;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `category-pill ${state.activeCategory === cat ? 'active' : ''}`;
    const label = document.createElement('span');
    label.textContent = cat;
    const cnt = document.createElement('span');
    cnt.className = 'pill-count';
    cnt.textContent = String(count);
    btn.append(label, cnt);
    btn.addEventListener('click', () => {
      state.activeCategory = cat;
      renderCategoryPills();
      renderProductsGrid();
    });
    container.appendChild(btn);
  }
}

function renderCatalogState() {
  const loadingEl = document.getElementById('catalog-loading');
  const emptyEl = document.getElementById('catalog-empty');
  const gridEl = document.getElementById('products-grid');

  if (state.catalogLoading) {
    loadingEl.classList.remove('hidden');
    emptyEl.classList.add('hidden');
    gridEl.classList.add('hidden');
    return false;
  }
  loadingEl.classList.add('hidden');
  return true;
}

function renderProductsGrid() {
  if (!renderCatalogState()) return;

  const filtered = getFilteredProducts();
  const gridEl = document.getElementById('products-grid');
  const emptyEl = document.getElementById('catalog-empty');
  const emptyTitle = document.getElementById('empty-state-title');
  const emptyDesc = document.getElementById('empty-state-desc');
  const activeCatLabel = document.getElementById('active-category-label');
  const activeCatCount = document.getElementById('active-category-count');
  const totalMeta = document.getElementById('catalog-total-meta');

  activeCatLabel.textContent = state.activeCategory === 'All' ? 'جميع الأصناف' : state.activeCategory;
  activeCatCount.textContent = `(${filtered.length})`;
  totalMeta.textContent = `${state.products.length} صنف متاح`;

  gridEl.innerHTML = '';

  if (filtered.length === 0) {
    gridEl.classList.add('hidden');
    emptyEl.classList.remove('hidden');
    if (state.products.length === 0) {
      emptyTitle.textContent = 'القائمة فارغة حالياً';
      emptyDesc.textContent =
        state.catalogError || 'لم يتم العثور على أصناف في جدول Google Sheets.';
    } else {
      emptyTitle.textContent = 'لا توجد نتائج مطابقة';
      emptyDesc.textContent = 'جرب البحث بكلمة أخرى أو اختر تصنيفاً مختلفاً.';
    }
    return;
  }

  emptyEl.classList.add('hidden');
  gridEl.classList.remove('hidden');

  const frag = document.createDocumentFragment();
  for (const product of filtered) {
    frag.appendChild(buildProductCard(product));
  }
  gridEl.appendChild(frag);
}

function buildProductCard(product) {
  const card = document.createElement('article');
  card.className = 'product-card';
  card.setAttribute('tabindex', '0');

  const images = Array.isArray(product.images) ? product.images : [];
  let slideIdx = 0;

  // Media Container (4:3)
  const mediaBox = document.createElement('div');
  mediaBox.className = 'card-media-box';

  const imgEl = document.createElement('img');
  imgEl.className = 'card-slide-img';
  imgEl.loading = 'lazy';
  imgEl.alt = product.name;
  imgEl.referrerPolicy = 'no-referrer';

  const fallbackEl = document.createElement('div');
  fallbackEl.className = 'img-fallback-box';
  const fbImg = document.createElement('img');
  fbImg.src = BRAND_LOGO_URL;
  fbImg.alt = 'حلبية';
  fbImg.referrerPolicy = 'no-referrer';
  fallbackEl.appendChild(fbImg);

  const showSlide = (idx) => {
    if (images.length === 0) {
      imgEl.classList.add('hidden');
      fallbackEl.classList.remove('hidden');
      return;
    }
    slideIdx = (idx + images.length) % images.length;
    imgEl.classList.remove('hidden');
    fallbackEl.classList.add('hidden');
    imgEl.src = images[slideIdx];
    const dots = mediaBox.querySelectorAll('.card-dot');
    dots.forEach((d, i) => d.classList.toggle('active', i === slideIdx));
  };

  imgEl.addEventListener('error', () => {
    imgEl.classList.add('hidden');
    fallbackEl.classList.remove('hidden');
  });

  mediaBox.append(imgEl, fallbackEl);
  showSlide(0);

  if (images.length > 1) {
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'gallery-arrow gallery-arrow-prev';
    prevBtn.setAttribute('aria-label', 'الصورة السابقة');
    prevBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="9 18 15 12 9 6"></polyline></svg>';
    prevBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showSlide(slideIdx - 1);
    });

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'gallery-arrow gallery-arrow-next';
    nextBtn.setAttribute('aria-label', 'الصورة التالية');
    nextBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="15 18 9 12 15 6"></polyline></svg>';
    nextBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showSlide(slideIdx + 1);
    });

    const dotsWrap = document.createElement('div');
    dotsWrap.className = 'card-dots';
    images.forEach((_, idx) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = `card-dot ${idx === 0 ? 'active' : ''}`;
      dot.setAttribute('aria-label', `صورة ${idx + 1}`);
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        showSlide(idx);
      });
      dotsWrap.appendChild(dot);
    });

    // Touch Swipe
    let touchStartX = 0;
    mediaBox.addEventListener(
      'touchstart',
      (e) => {
        touchStartX = e.changedTouches[0].clientX;
      },
      { passive: true }
    );
    mediaBox.addEventListener(
      'touchend',
      (e) => {
        const diff = e.changedTouches[0].clientX - touchStartX;
        if (Math.abs(diff) > 35) {
          showSlide(diff > 0 ? slideIdx - 1 : slideIdx + 1);
        }
      },
      { passive: true }
    );

    mediaBox.append(prevBtn, nextBtn, dotsWrap);
  }

  // Body
  const body = document.createElement('div');
  body.className = 'card-body';

  const catTag = document.createElement('span');
  catTag.className = 'card-category-text';
  catTag.textContent = product.category;

  const title = document.createElement('h2');
  title.className = 'card-title';
  title.textContent = product.name;

  const desc = document.createElement('p');
  desc.className = 'card-desc';
  desc.textContent = product.description || 'محضر طازجاً على الفحم يومياً';

  const footerRow = document.createElement('div');
  footerRow.className = 'card-footer-row';

  const priceStack = document.createElement('div');
  priceStack.className = 'card-price-stack';
  const priceLabel = document.createElement('span');
  priceLabel.className = 'card-price-label';
  priceLabel.textContent = 'السعر';
  const priceVal = document.createElement('strong');
  priceVal.className = 'card-price-value';
  priceVal.textContent = formatPrice(product.price);
  priceStack.append(priceLabel, priceVal);

  const actionsGroup = document.createElement('div');
  actionsGroup.className = 'card-actions-group';

  const buyBtn = document.createElement('button');
  buyBtn.type = 'button';
  buyBtn.className = 'btn-card-buy';
  buyBtn.textContent = 'اشتري الآن';
  buyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    addToCart(product, 1);
    openCartDrawer('checkout');
  });

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn-card-add';
  addBtn.setAttribute('aria-label', `أضف ${product.name} للسلة`);
  addBtn.textContent = '+';
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    addToCart(product, 1);
    addBtn.classList.add('added');
    addBtn.textContent = 'تمت الإضافة ✓';
    setTimeout(() => {
      addBtn.classList.remove('added');
      addBtn.textContent = '+';
    }, 1200);
  });

  actionsGroup.append(buyBtn, addBtn);
  footerRow.append(priceStack, actionsGroup);
  body.append(catTag, title, desc, footerRow);
  card.append(mediaBox, body);

  card.addEventListener('click', () => openProductModal(product, { pushUrl: true }));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openProductModal(product, { pushUrl: true });
  });

  return card;
}

// =========================================================
// PRODUCT DETAIL MODAL & SHAREABLE URLS / HISTORY API
// =========================================================
function openProductModal(product, { pushUrl = true } = {}) {
  state.modalProduct = product;
  state.modalImageIndex = 0;
  state.modalQty = 1;

  const modal = document.getElementById('product-modal');
  document.getElementById('pm-category').textContent = product.category;
  document.getElementById('pm-title').textContent = product.name;
  document.getElementById('pm-description').textContent =
    product.description || 'محضر طازجاً على الفحم يومياً';
  document.getElementById('pm-unit-price').textContent = formatPrice(product.price);

  const shareUrl = `${window.location.origin}/${product.slug}`;
  document.getElementById('pm-share-url').value = shareUrl;

  updateModalQuantityUI();
  renderModalGallery();

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  if (pushUrl) {
    const targetPath = `/${product.slug}`;
    if (window.location.pathname !== targetPath) {
      history.pushState({ productSlug: product.slug }, '', targetPath);
    }
  }
}

function closeProductModal({ updateUrl = true } = {}) {
  const modal = document.getElementById('product-modal');
  if (modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  state.modalProduct = null;
  document.body.style.overflow = '';

  if (updateUrl && window.location.pathname !== '/') {
    history.pushState({}, '', '/');
  }
}

function renderModalGallery() {
  const p = state.modalProduct;
  if (!p) return;
  const images = Array.isArray(p.images) ? p.images : [];
  const mainImg = document.getElementById('pm-main-img');
  const fallback = document.getElementById('pm-img-fallback');
  const prevBtn = document.getElementById('pm-prev-img');
  const nextBtn = document.getElementById('pm-next-img');
  const strip = document.getElementById('pm-thumbs-strip');

  if (images.length === 0) {
    mainImg.classList.add('hidden');
    fallback.classList.remove('hidden');
    prevBtn.classList.add('hidden');
    nextBtn.classList.add('hidden');
    strip.innerHTML = '';
    return;
  }

  state.modalImageIndex = (state.modalImageIndex + images.length) % images.length;
  mainImg.classList.remove('hidden');
  fallback.classList.add('hidden');
  mainImg.src = images[state.modalImageIndex];
  mainImg.alt = p.name;
  mainImg.onerror = () => {
    mainImg.classList.add('hidden');
    fallback.classList.remove('hidden');
  };

  if (images.length > 1) {
    prevBtn.classList.remove('hidden');
    nextBtn.classList.remove('hidden');
    strip.innerHTML = '';
    images.forEach((src, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `pm-thumb-btn ${i === state.modalImageIndex ? 'active' : ''}`;
      const im = document.createElement('img');
      im.src = src;
      im.alt = `${p.name} ${i + 1}`;
      im.referrerPolicy = 'no-referrer';
      btn.appendChild(im);
      btn.addEventListener('click', () => {
        state.modalImageIndex = i;
        renderModalGallery();
      });
      strip.appendChild(btn);
    });
  } else {
    prevBtn.classList.add('hidden');
    nextBtn.classList.add('hidden');
    strip.innerHTML = '';
  }
}

function updateModalQuantityUI() {
  if (!state.modalProduct) return;
  document.getElementById('pm-qty-val').textContent = String(state.modalQty);
  document.getElementById('pm-line-total').textContent = formatPrice(
    state.modalProduct.price * state.modalQty
  );
}

function syncProductFromPath() {
  const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
  if (!path || path === 'chef') return;
  const matched = state.products.find(
    (p) => p.slug.toLowerCase() === path.toLowerCase() || p.id === path
  );
  if (matched) {
    openProductModal(matched, { pushUrl: false });
  }
}

// =========================================================
// CART & 3-STEP CHECKOUT DRAWER
// =========================================================
function addToCart(product, qty = 1) {
  const existing = state.cart.find((item) => item.productId === product.id);
  if (existing) {
    existing.quantity = Math.min(99, existing.quantity + qty);
  } else {
    state.cart.push({
      productId: product.id,
      slug: product.slug,
      name: product.name,
      category: product.category,
      description: product.description,
      unitPrice: product.price,
      image: product.primaryImage || (product.images && product.images[0]) || '',
      quantity: qty,
    });
  }
  saveCart();
  showToast(`تمت إضافة "${product.name}" للسلة`);
}

function updateCartBadge() {
  const badge = document.getElementById('cart-badge');
  const totalQty = state.cart.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  if (badge) badge.textContent = String(totalQty);
}

function getCartTotals() {
  const subtotal =
    Math.round(
      state.cart.reduce((s, item) => s + Number(item.unitPrice) * Number(item.quantity), 0) * 100
    ) / 100;
  const deliveryFee = state.cart.length > 0 ? Number(state.settings.deliveryFee || 0) : 0;
  const grandTotal = Math.round((subtotal + deliveryFee) * 100) / 100;
  return { subtotal, deliveryFee, grandTotal };
}

function openCartDrawer(step = 'cart') {
  const backdrop = document.getElementById('cart-drawer-backdrop');
  backdrop.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  setDrawerStep(step);
  fetchSettings();
}

function closeCartDrawer() {
  document.getElementById('cart-drawer-backdrop').classList.add('hidden');
  document.body.style.overflow = '';
}

function setDrawerStep(step) {
  state.drawerStep = step;
  const cartStep = document.getElementById('drawer-step-cart');
  const coStep = document.getElementById('drawer-step-checkout');
  const sucStep = document.getElementById('drawer-step-success');
  const title = document.getElementById('drawer-title');

  cartStep.classList.add('hidden');
  coStep.classList.add('hidden');
  sucStep.classList.add('hidden');

  if (step === 'cart') {
    title.textContent = 'سلة الطلبات';
    cartStep.classList.remove('hidden');
    renderCartItems();
  } else if (step === 'checkout') {
    if (state.cart.length === 0) {
      setDrawerStep('cart');
      return;
    }
    title.textContent = 'إتمام الطلب والدفع';
    coStep.classList.remove('hidden');
    updatePaymentMethodUI();
    renderCartAndCheckoutTotals();
    updateCheckoutSubmitState();
  } else if (step === 'success') {
    title.textContent = 'تم تأكيد الطلب';
    sucStep.classList.remove('hidden');
  }
}

function renderCartItems() {
  const emptyView = document.getElementById('cart-empty-view');
  const filledView = document.getElementById('cart-filled-view');
  const listEl = document.getElementById('cart-items-list');
  const countLabel = document.getElementById('cart-items-count-label');

  if (state.cart.length === 0) {
    emptyView.classList.remove('hidden');
    filledView.classList.add('hidden');
    return;
  }

  emptyView.classList.add('hidden');
  filledView.classList.remove('hidden');

  const totalCount = state.cart.reduce((s, i) => s + i.quantity, 0);
  countLabel.textContent = `${totalCount} أصناف في السلة`;
  listEl.innerHTML = '';

  for (const item of state.cart) {
    const row = document.createElement('div');
    row.className = 'cart-item-row';

    const thumb = document.createElement('img');
    thumb.className = 'cart-item-thumb';
    thumb.src = item.image || BRAND_LOGO_URL;
    thumb.alt = item.name;
    thumb.referrerPolicy = 'no-referrer';
    thumb.onerror = () => {
      thumb.src = BRAND_LOGO_URL;
    };

    const info = document.createElement('div');
    info.className = 'cart-item-info';

    const top = document.createElement('div');
    top.className = 'cart-item-top';
    const nameEl = document.createElement('strong');
    nameEl.className = 'cart-item-name';
    nameEl.textContent = item.name;

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-remove-item';
    delBtn.setAttribute('aria-label', `حذف ${item.name}`);
    delBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path></svg>';
    delBtn.addEventListener('click', () => {
      state.cart = state.cart.filter((c) => c.productId !== item.productId);
      saveCart();
      renderCartItems();
    });
    top.append(nameEl, delBtn);

    const meta = document.createElement('div');
    meta.className = 'cart-item-meta';
    meta.textContent = `${item.category}${item.description ? ' · ' + item.description : ''}`;

    const bottom = document.createElement('div');
    bottom.className = 'cart-item-bottom';

    const stepper = document.createElement('div');
    stepper.className = 'qty-stepper';
    const minus = document.createElement('button');
    minus.type = 'button';
    minus.className = 'qty-btn';
    minus.textContent = '−';
    minus.addEventListener('click', () => {
      if (item.quantity > 1) {
        item.quantity--;
      } else {
        state.cart = state.cart.filter((c) => c.productId !== item.productId);
      }
      saveCart();
      renderCartItems();
    });

    const val = document.createElement('span');
    val.className = 'qty-val';
    val.textContent = String(item.quantity);

    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'qty-btn';
    plus.textContent = '+';
    plus.addEventListener('click', () => {
      item.quantity = Math.min(99, item.quantity + 1);
      saveCart();
      renderCartItems();
    });

    stepper.append(minus, val, plus);

    const lineTotal = document.createElement('strong');
    lineTotal.className = 'cart-item-line-total';
    lineTotal.textContent = formatPrice(item.unitPrice * item.quantity);

    bottom.append(stepper, lineTotal);
    info.append(top, meta, bottom);
    row.append(thumb, info);
    listEl.appendChild(row);
  }

  renderCartAndCheckoutTotals();
}

function renderCartAndCheckoutTotals() {
  const { subtotal, deliveryFee, grandTotal } = getCartTotals();

  const els = {
    'cart-subtotal': formatPrice(subtotal),
    'cart-delivery-fee': formatPrice(deliveryFee),
    'cart-grand-total': formatPrice(grandTotal),
    'co-subtotal': formatPrice(subtotal),
    'co-delivery-fee': formatPrice(deliveryFee),
    'co-grand-total': formatPrice(grandTotal),
    'co-transfer-amount': formatPrice(grandTotal),
    'co-cod-total': formatPrice(grandTotal),
  };

  for (const [id, text] of Object.entries(els)) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  const coTransferNum = document.getElementById('co-transfer-number');
  if (coTransferNum) coTransferNum.textContent = state.settings.transferNumber;
}

function updatePaymentMethodUI() {
  const cards = document.querySelectorAll('#payment-methods-grid .payment-option-card');
  cards.forEach((c) => c.classList.toggle('active', c.dataset.method === state.selectedPaymentMethod));

  const isCod = state.selectedPaymentMethod === 'COD';
  document.getElementById('electronic-pay-box').classList.toggle('hidden', isCod);
  document.getElementById('cod-pay-box').classList.toggle('hidden', !isCod);
  const walletInput = document.getElementById('co-wallet-phone');
  if (walletInput) walletInput.required = !isCod;
  updateCheckoutSubmitState();
}

function compressImageToDataUrl(dataUrl, maxDim = 1600, quality = 0.84) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = Math.min(maxDim / width, maxDim / height);
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function handleReceiptFileChange(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showCheckoutError('يرجى اختيار ملف صورة صالح.');
    return;
  }
  if (file.size > MAX_RECEIPT_BYTES) {
    showCheckoutError('حجم الصورة يجب ألا يتجاوز 8 ميجابايت.');
    return;
  }

  const supportedRelayTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  const needsOptimization = file.size > 3.5 * 1024 * 1024 || !supportedRelayTypes.has(file.type.toLowerCase());

  const reader = new FileReader();
  reader.onload = async () => {
    let dataUrl = String(reader.result || '');
    if (needsOptimization && dataUrl.startsWith('data:image/')) {
      dataUrl = await compressImageToDataUrl(dataUrl, 1600, 0.84);
    }
    state.receiptDataUrl = dataUrl;
    document.getElementById('receipt-preview-img').src = state.receiptDataUrl;
    document.getElementById('receipt-preview-wrap').classList.remove('hidden');
    document.getElementById('receipt-upload-zone').classList.add('hidden');
    hideCheckoutError();
    updateCheckoutSubmitState();
  };
  reader.readAsDataURL(file);
}

function clearReceiptImage() {
  state.receiptDataUrl = '';
  document.getElementById('co-receipt-file').value = '';
  document.getElementById('receipt-preview-img').src = '';
  document.getElementById('receipt-preview-wrap').classList.add('hidden');
  document.getElementById('receipt-upload-zone').classList.remove('hidden');
  updateCheckoutSubmitState();
}

function getCheckoutValidationError() {
  if (!state.settings.isOpen) {
    return 'المتجر مغلق حالياً ولا يمكن إرسال الطلب.';
  }
  if (!state.cart || state.cart.length === 0) {
    return 'سلة الطلبات فارغة.';
  }

  const customerName = document.getElementById('co-name').value.trim();
  const customerPhone = document.getElementById('co-phone').value.trim();
  const deliveryAddress = document.getElementById('co-address').value.trim();
  const senderWalletPhone = document.getElementById('co-wallet-phone').value.trim();
  const paymentMethod = state.selectedPaymentMethod;

  if (!customerName || customerName.length < 2) {
    return 'يرجى إدخال الاسم بالكامل.';
  }
  if (!customerPhone || customerPhone.replace(/\D/g, '').length < 8) {
    return 'يرجى إدخال رقم هاتف صحيح.';
  }
  if (!deliveryAddress || deliveryAddress.length < 5) {
    return 'يرجى إدخال عنوان التوصيل بالتفصيل.';
  }

  if (paymentMethod !== 'COD') {
    if (!senderWalletPhone || senderWalletPhone.replace(/\D/g, '').length < 8) {
      return 'يرجى إدخال رقم المحفظة المُحوّل منه.';
    }
    if (!state.receiptDataUrl || !state.receiptDataUrl.startsWith('data:image/')) {
      return 'يرجى إرفاق صورة إيصال التحويل لإتمام الطلب.';
    }
  }

  return null;
}

function updateCheckoutSubmitState() {
  const submitBtn = document.getElementById('submit-order-btn');
  if (!submitBtn) return;
  const err = getCheckoutValidationError();
  submitBtn.disabled = Boolean(err) || state.isSubmittingOrder;
}

function showCheckoutError(msg) {
  const el = document.getElementById('checkout-error-msg');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideCheckoutError() {
  document.getElementById('checkout-error-msg').classList.add('hidden');
}

async function handleCheckoutSubmit(e) {
  e.preventDefault();
  if (state.isSubmittingOrder) return;
  hideCheckoutError();

  const validationError = getCheckoutValidationError();
  if (validationError) {
    showCheckoutError(validationError);
    updateCheckoutSubmitState();
    return;
  }

  const customerName = document.getElementById('co-name').value.trim();
  const customerPhone = document.getElementById('co-phone').value.trim();
  const deliveryAddress = document.getElementById('co-address').value.trim();
  const deliveryNotes = document.getElementById('co-notes').value.trim();
  const senderWalletPhone = document.getElementById('co-wallet-phone').value.trim();
  const paymentMethod = state.selectedPaymentMethod;

  const submitBtn = document.getElementById('submit-order-btn');
  state.isSubmittingOrder = true;
  submitBtn.disabled = true;
  submitBtn.textContent = 'جاري إرسال الطلب...';

  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName,
        customerPhone,
        deliveryAddress,
        deliveryNotes,
        paymentMethod,
        senderWalletPhone: paymentMethod !== 'COD' ? senderWalletPhone : '',
        receiptImage: paymentMethod !== 'COD' ? state.receiptDataUrl : '',
        items: state.cart.map((c) => ({
          productId: c.productId,
          slug: c.slug,
          quantity: c.quantity,
        })),
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'تعذر إرسال الطلب.');
    }

    const order = data.order;
    state.lastSuccessOrder = order;
    state.newlyPlacedCode = order.orderCode;
    saveOrderCode(order.orderCode);
    localStorage.setItem(CUSTOMER_PHONE_KEY, customerPhone);
    state.lookupPhone = customerPhone;

    // Clear cart & receipt
    state.cart = [];
    saveCart();
    clearReceiptImage();
    document.getElementById('checkout-form').reset();

    // Render Success Card
    document.getElementById('success-order-code').textContent = order.orderCode;
    const summaryEl = document.getElementById('success-summary-details');
    summaryEl.innerHTML = '';

    const rows = [
      ['وسيلة الدفع', translatePayment(order.paymentMethod)],
      ['عنوان التوصيل', order.deliveryAddress],
      ['رسوم التوصيل', formatPrice(order.deliveryFee)],
      ['الإجمالي النهائي', formatPrice(order.grandTotal)],
    ];
    for (const [k, v] of rows) {
      const line = document.createElement('div');
      line.className = 'invoice-row';
      const span = document.createElement('span');
      span.textContent = k;
      const strong = document.createElement('strong');
      strong.textContent = v;
      line.append(span, strong);
      summaryEl.appendChild(line);
    }

    if (ordersChannel) {
      ordersChannel.postMessage({ type: 'ORDER_CREATED', orderCode: order.orderCode });
    }

    setDrawerStep('success');
  } catch (err) {
    showCheckoutError(err.message || 'حدث خطأ أثناء إرسال الطلب.');
  } finally {
    state.isSubmittingOrder = false;
    submitBtn.textContent = 'تأكيد وإرسال الطلب';
    updateCheckoutSubmitState();
  }
}

// =========================================================
// MY ORDERS MODAL & 4S POLLING
// =========================================================
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

async function fetchMyOrders() {
  const codes = state.orderCodes.join(',');
  const phone = state.lookupPhone.trim();
  if (!codes && !phone) {
    renderMyOrdersList([]);
    return;
  }

  try {
    const qs = new URLSearchParams();
    if (codes) qs.set('codes', codes);
    if (phone) qs.set('phone', phone);
    const res = await fetch(`/api/orders?${qs.toString()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    renderMyOrdersList(Array.isArray(data.orders) ? data.orders : []);
  } catch {
    // Ignore polling failures
  }
}

function renderMyOrdersList(orders) {
  const listEl = document.getElementById('my-orders-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  if (orders.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'table-empty-msg';
    empty.textContent = 'لا توجد طلبات مسجلة حالياً. يمكنك البحث برقم هاتفك لاسترجاع طلباتك.';
    listEl.appendChild(empty);
    return;
  }

  for (const o of orders) {
    const card = document.createElement('div');
    const isNew = state.newlyPlacedCode && o.orderCode === state.newlyPlacedCode;
    card.className = `order-track-card ${isNew ? 'is-new' : ''}`;

    const head = document.createElement('div');
    head.className = 'order-card-head';

    const leftHead = document.createElement('div');
    const codeEl = document.createElement('div');
    codeEl.className = 'order-code-label';
    codeEl.dir = 'ltr';
    codeEl.textContent = o.orderCode + (o.isArchived ? ' (مؤرشف)' : '');
    const dateEl = document.createElement('div');
    dateEl.className = 'order-date-label';
    dateEl.textContent = formatDateAr(o.createdAt);
    leftHead.append(codeEl, dateEl);

    const badgeInfo = getStatusBadgeInfo(o.status);
    const badge = document.createElement('span');
    badge.className = `status-badge ${badgeInfo.cls}`;
    badge.textContent = badgeInfo.text;

    head.append(leftHead, badge);
    card.appendChild(head);

    if (o.status === 'Rejected' && o.rejectionReason) {
      const rejBox = document.createElement('div');
      rejBox.className = 'rejection-reason-box';
      const strong = document.createElement('strong');
      strong.textContent = 'سبب الرفض: ';
      const txt = document.createElement('span');
      txt.textContent = o.rejectionReason;
      rejBox.append(strong, txt);
      card.appendChild(rejBox);
    }

    const itemsBox = document.createElement('div');
    itemsBox.className = 'order-items-mini';
    for (const it of o.items || []) {
      const row = document.createElement('div');
      row.className = 'order-item-mini-row';
      const left = document.createElement('span');
      left.textContent = `${it.name} × ${it.quantity}`;
      const right = document.createElement('strong');
      right.textContent = formatPrice(it.lineTotal);
      row.append(left, right);
      itemsBox.appendChild(row);
    }
    card.appendChild(itemsBox);

    const meta = document.createElement('div');
    meta.className = 'order-meta-grid';
    const metaPairs = [
      ['وسيلة الدفع', translatePayment(o.paymentMethod)],
      ...(o.senderWalletPhone ? [['رقم المحفظة', o.senderWalletPhone]] : []),
      ['عنوان التوصيل', o.deliveryAddress],
      ['رسوم التوصيل', formatPrice(o.deliveryFee)],
      ['الإجمالي النهائي', formatPrice(o.grandTotal)],
    ];
    for (const [k, v] of metaPairs) {
      const box = document.createElement('div');
      box.textContent = `${k}: `;
      const st = document.createElement('strong');
      st.textContent = v;
      box.appendChild(st);
      meta.appendChild(box);
    }
    card.appendChild(meta);
    listEl.appendChild(card);
  }
}

function openOrdersModal() {
  const modal = document.getElementById('orders-modal');
  const phoneInput = document.getElementById('orders-lookup-phone');
  if (phoneInput && state.lookupPhone) {
    phoneInput.value = state.lookupPhone;
  }
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  fetchMyOrders();
}

function closeOrdersModal() {
  document.getElementById('orders-modal').classList.add('hidden');
  document.body.style.overflow = '';
}

// =========================================================
// EVENT BINDINGS & INITIALIZATION
// =========================================================
function bindEvents() {
  // Brand reset
  document.getElementById('brand-reset-btn').addEventListener('click', () => {
    state.activeCategory = 'All';
    state.searchQuery = '';
    document.getElementById('search-input').value = '';
    document.getElementById('clear-search-btn').classList.add('hidden');
    closeProductModal();
    closeCartDrawer();
    closeOrdersModal();
    renderCategoryPills();
    renderProductsGrid();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // Search
  const searchInput = document.getElementById('search-input');
  const clearSearchBtn = document.getElementById('clear-search-btn');
  searchInput.addEventListener('input', () => {
    state.searchQuery = searchInput.value;
    clearSearchBtn.classList.toggle('hidden', !state.searchQuery);
    renderProductsGrid();
  });
  clearSearchBtn.addEventListener('click', () => {
    state.searchQuery = '';
    searchInput.value = '';
    clearSearchBtn.classList.add('hidden');
    renderProductsGrid();
    searchInput.focus();
  });

  // Refresh catalog buttons
  document.getElementById('refresh-catalog-btn').addEventListener('click', () => {
    fetchCatalog({ fresh: true });
  });
  document.getElementById('empty-refresh-btn').addEventListener('click', () => {
    fetchCatalog({ fresh: true });
  });

  // Product modal controls
  document.getElementById('pm-close-btn').addEventListener('click', () => closeProductModal());
  document.getElementById('product-modal').addEventListener('click', (e) => {
    if (e.target.id === 'product-modal') closeProductModal();
  });
  document.getElementById('pm-prev-img').addEventListener('click', () => {
    state.modalImageIndex--;
    renderModalGallery();
  });
  document.getElementById('pm-next-img').addEventListener('click', () => {
    state.modalImageIndex++;
    renderModalGallery();
  });
  document.getElementById('pm-qty-minus').addEventListener('click', () => {
    state.modalQty = Math.max(1, state.modalQty - 1);
    updateModalQuantityUI();
  });
  document.getElementById('pm-qty-plus').addEventListener('click', () => {
    state.modalQty = Math.min(99, state.modalQty + 1);
    updateModalQuantityUI();
  });
  document.getElementById('pm-add-cart-btn').addEventListener('click', () => {
    if (!state.modalProduct) return;
    addToCart(state.modalProduct, state.modalQty);
    closeProductModal();
  });
  document.getElementById('pm-buy-now-btn').addEventListener('click', () => {
    if (!state.modalProduct) return;
    addToCart(state.modalProduct, state.modalQty);
    closeProductModal();
    openCartDrawer('checkout');
  });
  document.getElementById('pm-copy-url-btn').addEventListener('click', (e) => {
    const url = document.getElementById('pm-share-url').value;
    copyText(url, e.currentTarget, 'نسخ الرابط');
  });

  // History popstate
  window.addEventListener('popstate', () => {
    const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
    if (!path) {
      closeProductModal({ updateUrl: false });
    } else {
      syncProductFromPath();
    }
  });

  // Cart & Drawer controls
  document.getElementById('open-cart-btn').addEventListener('click', () => openCartDrawer('cart'));
  document.getElementById('close-cart-btn').addEventListener('click', closeCartDrawer);
  document.getElementById('cart-browse-btn').addEventListener('click', closeCartDrawer);
  document.getElementById('cart-drawer-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'cart-drawer-backdrop') closeCartDrawer();
  });
  document.getElementById('clear-cart-btn').addEventListener('click', () => {
    state.cart = [];
    saveCart();
    renderCartItems();
  });
  document.getElementById('proceed-checkout-btn').addEventListener('click', () => {
    setDrawerStep('checkout');
  });
  document.getElementById('back-to-cart-btn').addEventListener('click', () => {
    setDrawerStep('cart');
  });

  // Payment method options
  document.querySelectorAll('#payment-methods-grid .payment-option-card').forEach((card) => {
    card.addEventListener('click', () => {
      state.selectedPaymentMethod = card.dataset.method;
      updatePaymentMethodUI();
    });
  });

  document.getElementById('co-copy-transfer-btn').addEventListener('click', (e) => {
    copyText(state.settings.transferNumber, e.currentTarget, 'نسخ الرقم');
  });

  document.getElementById('co-receipt-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) handleReceiptFileChange(file);
  });

  document.getElementById('remove-receipt-btn').addEventListener('click', clearReceiptImage);
  ['co-name', 'co-phone', 'co-address', 'co-wallet-phone'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => {
      hideCheckoutError();
      updateCheckoutSubmitState();
    });
  });
  document.getElementById('checkout-form').addEventListener('submit', handleCheckoutSubmit);

  // Success buttons
  document.getElementById('track-in-orders-btn').addEventListener('click', () => {
    closeCartDrawer();
    openOrdersModal();
  });
  document.getElementById('continue-shopping-btn').addEventListener('click', closeCartDrawer);

  // My Orders Modal
  document.getElementById('my-orders-btn').addEventListener('click', openOrdersModal);
  document.getElementById('close-orders-modal-btn').addEventListener('click', closeOrdersModal);
  document.getElementById('orders-modal').addEventListener('click', (e) => {
    if (e.target.id === 'orders-modal') closeOrdersModal();
  });
  document.getElementById('orders-phone-lookup-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const val = document.getElementById('orders-lookup-phone').value.trim();
    state.lookupPhone = val;
    localStorage.setItem(CUSTOMER_PHONE_KEY, val);
    fetchMyOrders();
  });

  // Support copy buttons (footer + success)
  document.querySelectorAll('.btn-copy-support').forEach((btn) => {
    btn.addEventListener('click', () => {
      const digits = btn.dataset.copy || cleanPhoneDigits(state.settings.supportNumber) || '0123456789';
      copyText(digits, btn, btn.textContent);
    });
  });

  // Immediate refresh when user returns to tab/window
  window.addEventListener('focus', () => {
    fetchSettings();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      fetchSettings();
    }
  });

  // BroadcastChannel updates
  if (ordersChannel) {
    ordersChannel.onmessage = () => {
      fetchMyOrders();
      fetchSettings();
    };
  }
}

async function init() {
  updateCartBadge();
  bindEvents();
  await Promise.all([fetchSettings(), fetchCatalog()]);

  setInterval(fetchSettings, 5000);
  setInterval(fetchMyOrders, 4000);
}

init();
