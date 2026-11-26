# حلبية للمشويات والمأكولات — Halabiya Grill Storefront & Operations

A production-ready Arabic RTL restaurant ordering storefront, Chef management dashboard, and WhatsApp relay system.

The entire frontend is built strictly with **HTML5, CSS3, and Vanilla JavaScript (ES6+)** — zero React, zero TypeScript, zero CSS frameworks, and **zero build tools or bundlers required**.

## Project Structure

```text
.
├── public/                        # 100% pure static frontend (ready for static hosting)
│   ├── index.html                 # Customer storefront (/)
│   ├── 887chef999/
│   │   └── index.html             # Protected Chef dashboard (/887chef999)
│   ├── 887med-link999/
│   │   └── index.html             # Protected WhatsApp relay dashboard (/887med-link999)
│   ├── css/
│   │   └── styles.css             # Complete custom CSS3 styling & responsive rules
│   ├── js/
│   │   ├── config.js              # Optional backend API base URL resolver
│   │   ├── storefront.js          # Catalog, product modal, cart, checkout, order tracking
│   │   ├── chef.js                # Chef dashboard, archive, analytics, settings, receipt viewer
│   │   └── med-link.js            # WhatsApp QR pairing, queue monitor, config, webhook info
│   ├── assets/                    # Static media assets
│   └── _redirects                 # Static host routing rules (Cloudflare Pages / Netlify)
├── lib/                           # Backend modules (Node.js ESM JavaScript)
│   ├── db.js                      # Supabase REST / local store persistence
│   ├── sheets.js                  # Google Sheets catalog sync & cache
│   ├── whatsapp-relay.js          # Order-to-WhatsApp queue bridge
│   └── medlink/                   # Baileys WhatsApp Web session, queue worker & router
├── server.js                      # Express API + static file server (port 3000)
├── supabase-schema.sql            # Supabase database tables & indexes
├── .env.example                   # Environment variable template
└── package.json                   # Backend dependencies only (no build step)
```

## Removed Frameworks & Build Tools

- Removed: React, React DOM, Vite, `@vitejs/plugin-react`, Tailwind CSS, `@tailwindcss/vite`, Autoprefixer, TypeScript, `tsx`, `esbuild`, Motion, Lucide React, `@google/genai`, `@types/*`, `vite.config.ts`, `tsconfig.json`, `bun.lock`.
- Frontend runs directly in any modern browser with native HTML5, CSS3, ES6+ modules, Fetch API, DOM APIs, LocalStorage/SessionStorage, History API, and BroadcastChannel.

## Preserved Integrations

- **Supabase** (`lib/db.js`, `supabase-schema.sql`) with local file fallback (`data/store.json`).
- **Google Sheets** (`lib/sheets.js`) live menu sync with stale-while-revalidate caching.
- **WhatsApp Relay (`@whiskeysockets/baileys`)** (`lib/medlink/*`) with QR pairing, queued delivery, receipt media attachment, and automatic reconnect resend.
- **Chef & Relay Security**: Server-side PIN hashing (`scrypt`), signed `HttpOnly` cookie + Bearer tokens, CSRF origin/header validation, and secret admin routes (`/887chef999`, `/887med-link999`).

## Running & Deployment

### Option 1 — Full-Stack Node.js Hosting (Recommended for All Features)

Platforms: Railway, Render, Fly.io, Koyeb, or VPS.

1. Set environment variables from `.env.example`.
2. Install backend dependencies:
   ```bash
   npm install
   ```
3. Start directly (no build command needed):
   ```bash
   npm start
   ```

### Option 2 — Static Frontend (`public/`) + Separate Backend (`server.js`)

Platforms: Cloudflare Pages, Netlify, GitHub Pages, or any static host for `public/`.

1. Deploy `server.js` + `lib/` to a Node.js host with `CORS_ORIGIN=https://your-static-site.pages.dev`.
2. In `public/index.html`, `public/887chef999/index.html`, and `public/887med-link999/index.html`, add `<meta name="halabiya-api-base" content="https://your-backend.example.com" />` inside `<head>`.
3. Upload the `public/` folder directly to your static host — **Build Command:** none (empty), **Build Output Directory:** `public`.
