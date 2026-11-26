// Runtime backend API base URL configuration.
// Default '' (same-origin) works automatically when served by server.js.
// For split deployment (static frontend on Cloudflare Pages/Netlify + Node backend elsewhere),
// set <meta name="halabiya-api-base" content="https://your-backend.example.com" /> in HTML
// or define window.__HALABIYA_API_BASE__ before loading scripts.
function resolveApiBaseUrl() {
  if (typeof window !== 'undefined' && typeof window.__HALABIYA_API_BASE__ === 'string') {
    const val = window.__HALABIYA_API_BASE__.trim();
    if (val) return val.replace(/\/+$/, '');
  }
  if (typeof document !== 'undefined') {
    const meta = document.querySelector('meta[name="halabiya-api-base"]');
    const content = meta ? String(meta.getAttribute('content') || '').trim() : '';
    if (content) return content.replace(/\/+$/, '');
  }
  return '';
}

export const API_BASE_URL = resolveApiBaseUrl();

export function apiUrl(path) {
  const cleanPath = String(path || '').startsWith('/') ? String(path) : `/${String(path || '')}`;
  return API_BASE_URL ? `${API_BASE_URL}${cleanPath}` : cleanPath;
}

export function getApiOrigin() {
  if (API_BASE_URL) return API_BASE_URL;
  return typeof window !== 'undefined' ? window.location.origin : '';
}
