/**
 * Normalizes a human-entered phone number (e.g. "010 15678913", "+201204457813")
 * into digits-only international format suitable for WhatsApp Web JIDs.
 */
export function normalizeWhatsAppDigits(rawInput, defaultCountryCode = '20') {
  const trimmed = String(rawInput || '').trim();
  const hasPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/\D/g, '');
  const cleanCountry = String(defaultCountryCode || '20').replace(/\D/g, '') || '20';

  if (!digits) return '';

  if (digits.startsWith('00')) {
    return digits.slice(2);
  }
  if (hasPlus) {
    return digits;
  }
  if (digits.startsWith('0')) {
    return `${cleanCountry}${digits.slice(1)}`;
  }
  return digits;
}

export function toWhatsAppJid(rawInput, defaultCountryCode = '20') {
  const digits = normalizeWhatsAppDigits(rawInput, defaultCountryCode);
  if (!digits) {
    throw new Error('رقم الواتساب غير صالح.');
  }
  return `${digits}@c.us`;
}

export function isValidPhoneInput(rawInput) {
  const digits = String(rawInput || '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15;
}

export function maskPhone(phone) {
  const clean = String(phone || '').trim();
  if (clean.length <= 4) return '****';
  return `${clean.slice(0, 3)}****${clean.slice(-2)}`;
}
