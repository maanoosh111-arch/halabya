const DEFAULT_SPREADSHEET_ID = '1lc3syoXJeRRk4BzfE52bShFhLtlfCJmQkND8p9gAEwM';
const CACHE_TTL_MS = 15 * 1000;

let cacheState = {
  fetchedAt: 0,
  categories: [],
  productsInternal: [],
  lastError: null,
};

let inflightSync = null;

export function getSpreadsheetId() {
  return (process.env.GOOGLE_SPREADSHEET_ID || DEFAULT_SPREADSHEET_ID).trim();
}

/**
 * RFC-4180 compliant CSV parser.
 * Handles quoted values, escaped double quotes (""), embedded commas, and CRLF/LF newlines.
 */
export function parseRFC4180Csv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const cleanText = String(text || '').replace(/^\uFEFF/, '');

  for (let i = 0; i < cleanText.length; i++) {
    const ch = cleanText[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < cleanText.length && cleanText[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\r') {
        if (i + 1 < cleanText.length && cleanText[i + 1] === '\n') {
          i++;
        }
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function parseNumeric(raw) {
  if (raw === null || raw === undefined) return NaN;
  const cleaned = String(raw)
    .trim()
    .replace(/,/g, '')
    .replace(/[^\d.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return NaN;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : NaN;
}

function isValidHttpUrl(str) {
  if (!str || typeof str !== 'string') return false;
  const trimmed = str.trim();
  if (!trimmed) return false;
  // Strictly ignore spreadsheet formulas such as =IMAGE(...)
  if (trimmed.startsWith('=')) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function extractImageUrlsFromCell(cellValue) {
  if (!cellValue || typeof cellValue !== 'string') return [];
  const trimmed = cellValue.trim();
  if (!trimmed || trimmed.startsWith('=')) return [];

  const candidates = trimmed
    .split(/[\n\r,;|]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const valid = [];
  for (const part of candidates) {
    if (isValidHttpUrl(part)) {
      valid.push(part);
    } else {
      // Handle whitespace-separated URLs inside a single cell
      const spaceParts = part.split(/\s+/).map((p) => p.trim());
      for (const sp of spaceParts) {
        if (isValidHttpUrl(sp)) valid.push(sp);
      }
    }
  }
  return valid;
}

function generateEnglishSlug(productName, fallbackId, usedSlugs) {
  const latinOnly = String(productName || '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');

  let base = latinOnly;
  if (!base) {
    base = String(fallbackId || 'item')
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '') || 'item';
  }

  let candidate = base;
  let counter = 2;
  while (usedSlugs.has(candidate.toLowerCase())) {
    candidate = `${base}-${counter}`;
    counter++;
  }
  usedSlugs.add(candidate.toLowerCase());
  return candidate;
}

async function discoverTabs(spreadsheetId) {
  const fallbackTabs = [{ name: 'مشويات', gid: '0' }];

  try {
    const res = await fetch(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/htmlview`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HalabiyaStoreSync/1.0)',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return fallbackTabs;
    }

    const html = await res.text();
    const discovered = [];
    const seenGids = new Set();

    // Google Sheets /htmlview embeds tab metadata in items.push({name: "...", pageUrl: "...", gid: "..."})
    const regex = /items\.push\(\{\s*name:\s*"([^"]+)"[\s\S]*?gid:\s*"(\d+)"/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const rawName = match[1];
      const gid = match[2];
      // Decode JS unicode escapes like \u0645 if present
      let name = rawName;
      try {
        name = JSON.parse(`"${rawName.replace(/"/g, '\\"')}"`);
      } catch {
        name = rawName;
      }
      name = name.trim();
      if (name && gid && !seenGids.has(gid)) {
        seenGids.add(gid);
        discovered.push({ name, gid });
      }
    }

    if (discovered.length > 0) {
      return discovered;
    }

    // Secondary fallback regex for sheet-button DOM elements
    const btnRegex = /id="sheet-button-(\d+)"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/g;
    while ((match = btnRegex.exec(html)) !== null) {
      const gid = match[1];
      const name = match[2].trim();
      if (name && gid && !seenGids.has(gid)) {
        seenGids.add(gid);
        discovered.push({ name, gid });
      }
    }

    return discovered.length > 0 ? discovered : fallbackTabs;
  } catch (err) {
    console.warn('[sheets] Tab discovery failed, using default tab fallback:', err.message);
    return fallbackTabs;
  }
}

async function fetchTabCsv(spreadsheetId, tab) {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&gid=${encodeURIComponent(tab.gid)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; HalabiyaStoreSync/1.0)',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`CSV fetch failed for tab "${tab.name}" (${res.status})`);
  }

  return await res.text();
}

function parseTabProducts(csvText, categoryName, tabIndex, usedSlugs) {
  const rows = parseRFC4180Csv(csvText);
  if (rows.length < 2) return [];

  const headerRow = rows[0].map((h) => String(h || '').trim().toLowerCase());
  const findCol = (names, fallbackIdx) => {
    const idx = headerRow.findIndex((h) => names.includes(h));
    return idx !== -1 ? idx : fallbackIdx;
  };

  const colName = findCol(['product name', 'name', 'المنتج', 'اسم المنتج'], 0);
  const colPrice = findCol(['price', 'السعر'], 1);
  const colCost = findCol(['cost', 'التكلفة'], 2);
  const colProfit = findCol(['profit', 'الربح'], 3);
  const colDesc = findCol(['description', 'desc', 'الوصف'], 4);
  const colPrimaryImg = findCol(['primary image', 'image', 'الصورة'], 5);
  const colPrev = findCol(['prev', 'preview'], 6);
  const colExtraStart = findCol(['extra images', 'extra', 'صور إضافية'], 7);

  const products = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((cell) => !String(cell || '').trim())) {
      continue;
    }

    const name = String(row[colName] || '').trim();
    if (!name) continue;

    const rawPrice = parseNumeric(row[colPrice]);
    if (!Number.isFinite(rawPrice) || rawPrice < 0) continue;

    const rawCost = parseNumeric(row[colCost]);
    const rawProfit = parseNumeric(row[colProfit]);

    const price = Math.round(rawPrice * 100) / 100;
    const cost = Number.isFinite(rawCost) ? Math.round(rawCost * 100) / 100 : 0;

    let profit;
    if (Number.isFinite(rawProfit)) {
      profit = Math.round(rawProfit * 100) / 100;
    } else if (Number.isFinite(rawCost)) {
      profit = Math.round((price - cost) * 100) / 100;
    } else {
      profit = price;
    }

    const description = String(row[colDesc] || '').trim();

    // Extract Primary Image (never from Prev, ignore formulas)
    const primaryUrls = colPrimaryImg !== colPrev ? extractImageUrlsFromCell(row[colPrimaryImg]) : [];
    const primaryImage = primaryUrls[0] || '';

    // Extract Extra Images from Extra Images column + all trailing columns, excluding Prev
    const extraImageUrls = [];
    for (let c = colExtraStart; c < row.length; c++) {
      if (c === colPrev) continue;
      const urls = extractImageUrlsFromCell(row[c]);
      for (const u of urls) {
        if (u !== primaryImage && !extraImageUrls.includes(u)) {
          extraImageUrls.push(u);
        }
      }
    }

    // Also include any secondary URLs inside Primary Image cell if multiple were put there
    for (let i = 1; i < primaryUrls.length; i++) {
      const u = primaryUrls[i];
      if (!extraImageUrls.includes(u)) extraImageUrls.push(u);
    }

    const images = [];
    if (primaryImage) images.push(primaryImage);
    for (const u of extraImageUrls) {
      if (!images.includes(u)) images.push(u);
    }

    const id = `p-${tabIndex + 1}-${r}`;
    const slug = generateEnglishSlug(name, id, usedSlugs);

    products.push({
      id,
      slug,
      name,
      category: categoryName,
      price,
      cost,
      profit,
      description,
      primaryImage,
      extraImages: extraImageUrls,
      images,
    });
  }

  return products;
}

export async function syncCatalog({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && cacheState.fetchedAt > 0 && now - cacheState.fetchedAt < CACHE_TTL_MS) {
    return cacheState;
  }

  if (inflightSync) {
    return inflightSync;
  }

  inflightSync = (async () => {
    const spreadsheetId = getSpreadsheetId();
    try {
      const tabs = await discoverTabs(spreadsheetId);
      const usedSlugs = new Set();
      const allProducts = [];
      const categories = [];

      const results = await Promise.allSettled(
        tabs.map(async (tab, idx) => {
          const csv = await fetchTabCsv(spreadsheetId, tab);
          return { tab, idx, csv };
        })
      );

      for (const res of results) {
        if (res.status === 'fulfilled') {
          const { tab, idx, csv } = res.value;
          const tabProducts = parseTabProducts(csv, tab.name, idx, usedSlugs);
          if (!categories.includes(tab.name)) {
            categories.push(tab.name);
          }
          allProducts.push(...tabProducts);
        }
      }

      cacheState = {
        fetchedAt: Date.now(),
        categories,
        productsInternal: allProducts,
        lastError: null,
      };
      return cacheState;
    } catch (err) {
      console.error('[sheets] Catalog sync error:', err);
      cacheState = {
        ...cacheState,
        lastError: err.message || 'Failed to sync catalog',
      };
      return cacheState;
    } finally {
      inflightSync = null;
    }
  })();

  return inflightSync;
}

export function toPublicProduct(product) {
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    category: product.category,
    price: product.price,
    description: product.description,
    primaryImage: product.primaryImage,
    extraImages: product.extraImages,
    images: product.images,
  };
}

export async function getPublicCatalog({ fresh = false } = {}) {
  const state = await syncCatalog({ fresh });
  return {
    categories: state.categories,
    products: state.productsInternal.map(toPublicProduct),
    fetchedAt: state.fetchedAt,
    error: state.lastError,
  };
}

export async function getInternalCatalog({ fresh = false } = {}) {
  const state = await syncCatalog({ fresh });
  return {
    categories: state.categories,
    products: state.productsInternal,
    fetchedAt: state.fetchedAt,
    error: state.lastError,
  };
}
