import dns from 'node:dns/promises';
import net from 'node:net';

export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024; // 5 MB
const DOWNLOAD_TIMEOUT_MS = 15_000;
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

function isBlockedIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedIp(ip) {
  const normalized = String(ip || '').toLowerCase();
  if (net.isIPv4(normalized)) {
    return isBlockedIpv4(normalized);
  }
  if (net.isIPv6(normalized)) {
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('::ffff:')) {
      const v4Part = normalized.slice(7);
      if (net.isIPv4(v4Part)) return isBlockedIpv4(v4Part);
    }
    if (
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    ) {
      return true;
    }
    return false;
  }
  return true;
}

function detectImageMimeFromMagicBytes(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return 'image/gif';
  }
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

function extensionForMime(mime) {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'bin';
  }
}

export function isDataImageUrl(value) {
  return /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(String(value || '').trim());
}

export function parseValidatedDataImage(rawDataUrl) {
  const match = String(rawDataUrl || '')
    .trim()
    .match(/^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    throw new Error('صورة الإيصال يجب أن تكون بصيغة base64 صالحة (JPEG/PNG/WebP/GIF).');
  }

  const cleanBase64 = match[2].replace(/\s+/g, '');
  const estimatedBytes = Math.floor((cleanBase64.length * 3) / 4);
  if (estimatedBytes > MAX_RECEIPT_BYTES) {
    throw new Error('صورة الإيصال تتجاوز الحد الأقصى المسموح (5 ميجابايت).');
  }

  const buffer = Buffer.from(cleanBase64, 'base64');
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_RECEIPT_BYTES) {
    throw new Error('حجم صورة الإيصال غير صالح أو يتجاوز 5 ميجابايت.');
  }

  const detectedMime = detectImageMimeFromMagicBytes(buffer);
  if (!detectedMime || !ALLOWED_MIME_TYPES.has(detectedMime)) {
    throw new Error('بيانات صورة الإيصال ليست صورة صالحة.');
  }

  return {
    mimeType: detectedMime,
    base64: buffer.toString('base64'),
    filename: `payment-receipt.${extensionForMime(detectedMime)}`,
    byteSize: buffer.byteLength,
  };
}

async function validatePublicReceiptUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('رابط صورة الإيصال غير صالح.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('رابط صورة الإيصال يجب أن يبدأ بـ http أو https.');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  ) {
    throw new Error('عنوان رابط الإيصال غير مسموح به.');
  }

  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new Error('عنوان IP الخاص برابط الإيصال غير مسموح به.');
    }
    return parsed;
  }

  const records = await dns.lookup(hostname, { all: true });
  if (!records || records.length === 0) {
    throw new Error('تعذر الوصول لنطاق رابط الإيصال.');
  }
  for (const record of records) {
    if (isBlockedIp(record.address)) {
      throw new Error('نطاق رابط الإيصال يشير إلى عنوان داخلي غير مسموح به.');
    }
  }

  return parsed;
}

export async function validateReceiptInputSafety(rawReceiptInput) {
  const trimmed = String(rawReceiptInput || '').trim();
  if (!trimmed) return;
  if (isDataImageUrl(trimmed)) {
    parseValidatedDataImage(trimmed);
    return;
  }
  await validatePublicReceiptUrl(trimmed);
}

export async function fetchValidatedReceiptImage(rawReceiptInput) {
  const trimmed = String(rawReceiptInput || '').trim();
  if (isDataImageUrl(trimmed)) {
    return parseValidatedDataImage(trimmed);
  }

  let currentUrl = (await validatePublicReceiptUrl(trimmed)).toString();
  let response = null;

  for (let redirects = 0; redirects < 4; redirects++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      response = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'image/jpeg,image/png,image/webp,image/gif,*/*;q=0.5',
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('إعادة توجيه غير مكتملة لرابط الإيصال.');
      const nextUrl = new URL(location, currentUrl).toString();
      currentUrl = (await validatePublicReceiptUrl(nextUrl)).toString();
      continue;
    }
    break;
  }

  if (!response || !response.ok) {
    throw new Error(`فشل تنزيل صورة الإيصال (HTTP ${response ? response.status : 'unknown'})`);
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_RECEIPT_BYTES) {
    throw new Error('حجم صورة الإيصال يتجاوز 5 ميجابايت.');
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength > MAX_RECEIPT_BYTES) {
    throw new Error('حجم صورة الإيصال غير صالح أو يتجاوز 5 ميجابايت.');
  }

  const buffer = Buffer.from(arrayBuffer);
  const detectedMime = detectImageMimeFromMagicBytes(buffer);
  if (!detectedMime || !ALLOWED_MIME_TYPES.has(detectedMime)) {
    throw new Error('الملف الذي تم تنزيله من رابط الإيصال ليس صورة صالحة.');
  }

  return {
    mimeType: detectedMime,
    base64: buffer.toString('base64'),
    filename: `payment-receipt.${extensionForMime(detectedMime)}`,
    byteSize: buffer.byteLength,
  };
}
