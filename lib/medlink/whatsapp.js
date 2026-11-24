import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import QRCode from 'qrcode';
import { getFlag, setFlag } from './store.js';
import { fetchValidatedReceiptImage } from './media.js';
import { maskPhone } from './phone.js';

const require = createRequire(import.meta.url);

let cachedWwjs = null;
async function loadWwjs() {
  if (!cachedWwjs) {
    const mod = await import('whatsapp-web.js');
    cachedWwjs = mod.default ?? mod;
  }
  return cachedWwjs;
}

function resolveChromiumExecutablePath() {
  const envPath = String(process.env.PUPPETEER_EXECUTABLE_PATH || '').trim();
  if (envPath && fs.existsSync(envPath)) return envPath;

  try {
    const puppeteer = require('puppeteer');
    const detected = puppeteer.executablePath();
    if (detected && fs.existsSync(detected)) return detected;
  } catch {
    // Fallback below
  }

  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

const SESSION_CLIENT_ID = 'halabiya-medlink-relay';

function getSessionDir(authDataPath) {
  return path.join(authDataPath, `session-${SESSION_CLIENT_ID}`);
}

function clearBrowserServiceWorkerCache(sessionDir) {
  const staleDirs = [
    path.join(sessionDir, 'Default', 'Service Worker'),
    path.join(sessionDir, 'Default', 'Cache'),
    path.join(sessionDir, 'Default', 'Code Cache'),
  ];
  for (const dir of staleDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
}

function removeSessionDir(authDataPath) {
  try {
    fs.rmSync(getSessionDir(authDataPath), { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

async function cleanStaleChromiumLock(authDataPath) {
  const sessionDir = getSessionDir(authDataPath);
  const lockPath = path.join(sessionDir, 'SingletonLock');
  try {
    const target = fs.readlinkSync(lockPath);
    const match = target.match(/-(\d+)$/);
    if (match) {
      const pid = Number(match[1]);
      if (pid > 0 && pid !== process.pid) {
        let isOurChrome = false;
        try {
          const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
          isOurChrome = cmdline.includes(`session-${SESSION_CLIENT_ID}`);
        } catch {
          isOurChrome = false;
        }
        if (isOurChrome) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            // already exited
          }
          for (let i = 0; i < 15; i++) {
            await new Promise((r) => setTimeout(r, 100));
            try {
              process.kill(pid, 0);
            } catch {
              isOurChrome = false;
              break;
            }
          }
          if (isOurChrome) {
            try {
              process.kill(pid, 'SIGKILL');
              await new Promise((r) => setTimeout(r, 250));
            } catch {
              // ignore
            }
          }
        }
      }
    }
  } catch {
    // No lock symlink
  }

  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      fs.rmSync(path.join(sessionDir, name), { force: true });
    } catch {
      // Ignore
    }
  }
}

class WhatsAppService extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.status = 'disconnected';
    this.statusDetail = 'غير متصل — اضغط «اتصال / توليد رمز QR» لربط واتساب المطعم.';
    this.qrDataUrl = null;
    this.connectedPhone = null;
    this.connectedPushName = null;
    this.lastError = null;
    this.updatedAt = Date.now();
    this.initializing = false;
    this.destroying = false;
    this.manualDisconnecting = false;
    this.connectionEpoch = 0;
    this.syncWatchdog = null;
    this.cleanupTimer = null;
  }

  getPublicState() {
    return {
      status: this.status,
      statusDetail: this.statusDetail,
      qrDataUrl: this.qrDataUrl,
      connectedPhone: this.connectedPhone,
      connectedPushName: this.connectedPushName,
      lastError: this.lastError,
      updatedAt: this.updatedAt,
    };
  }

  isConnected() {
    return this.status === 'connected' && this.client !== null;
  }

  clearWatchdog() {
    if (this.syncWatchdog) {
      clearTimeout(this.syncWatchdog);
      this.syncWatchdog = null;
    }
  }

  setState(patch) {
    if (patch.status !== undefined) this.status = patch.status;
    if (patch.statusDetail !== undefined) this.statusDetail = patch.statusDetail;
    if (patch.qrDataUrl !== undefined) this.qrDataUrl = patch.qrDataUrl;
    if (patch.connectedPhone !== undefined) this.connectedPhone = patch.connectedPhone;
    if (patch.connectedPushName !== undefined) this.connectedPushName = patch.connectedPushName;
    if (patch.lastError !== undefined) this.lastError = patch.lastError;
    this.updatedAt = Date.now();
  }

  async initializeIfSavedSession() {
    if (getFlag('whatsappManualDisconnect') || !getFlag('whatsappAuthenticated')) {
      return;
    }
    await this.initialize({ resetSession: false });
  }

  async initialize({ resetSession = false } = {}) {
    if (this.initializing || this.destroying) return;
    if (this.client && (this.status === 'connecting' || this.status === 'connected')) return;

    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    const epoch = ++this.connectionEpoch;
    this.initializing = true;
    this.manualDisconnecting = false;
    setFlag('whatsappManualDisconnect', false);

    this.setState({
      status: 'connecting',
      statusDetail: 'جاري تشغيل متصفح واتساب ويب وتجهيز رمز QR...',
      qrDataUrl: null,
      connectedPhone: null,
      connectedPushName: null,
      lastError: null,
    });

    try {
      const { Client, LocalAuth } = await loadWwjs();
      if (epoch !== this.connectionEpoch || this.manualDisconnecting) return;

      const authDataPath = path.resolve(process.cwd(), '.wwebjs_auth');
      await cleanStaleChromiumLock(authDataPath);
      if (epoch !== this.connectionEpoch || this.manualDisconnecting) return;

      if (resetSession || !getFlag('whatsappAuthenticated')) {
        setFlag('whatsappAuthenticated', false);
        removeSessionDir(authDataPath);
      } else {
        clearBrowserServiceWorkerCache(getSessionDir(authDataPath));
      }

      const executablePath = resolveChromiumExecutablePath();
      const webVersion = String(
        process.env.WHATSAPP_WEB_VERSION || '2.3000.1048260127-alpha'
      ).trim();

      const client = new Client({
        authStrategy: new LocalAuth({
          clientId: SESSION_CLIENT_ID,
          dataPath: authDataPath,
        }),
        qrMaxRetries: 0,
        authTimeoutMs: 45_000,
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        webVersion,
        webVersionCache: {
          type: 'remote',
          remotePath:
            'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html',
        },
        puppeteer: {
          headless: true,
          ...(executablePath ? { executablePath } : {}),
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
          ],
        },
      });

      this.attachEventHandlers(client, authDataPath, epoch);
      this.client = client;

      this.clearWatchdog();
      this.syncWatchdog = setTimeout(() => {
        if (epoch === this.connectionEpoch && this.status === 'connecting' && !this.qrDataUrl) {
          void this.handleSessionInvalidated(
            authDataPath,
            'انتهت مهلة الاتصال بواتساب ويب. اضغط «اتصال / توليد رمز QR» للمحاولة مجدداً.',
            null
          );
        }
      }, 50_000);

      await client.initialize();
      if (epoch !== this.connectionEpoch || this.manualDisconnecting) {
        await client.destroy().catch(() => {});
      }
    } catch (err) {
      if (epoch !== this.connectionEpoch || this.manualDisconnecting) return;
      this.clearWatchdog();
      const message = err instanceof Error ? err.message : 'تعذر تشغيل عميل واتساب ويب.';
      setFlag('whatsappAuthenticated', false);
      this.setState({
        status: 'disconnected',
        statusDetail: 'فشل تشغيل جلسة واتساب ويب.',
        qrDataUrl: null,
        connectedPhone: null,
        connectedPushName: null,
        lastError: message,
      });
      await this.safeDestroyClient();
    } finally {
      this.initializing = false;
    }
  }

  async handleSessionInvalidated(authDataPath, statusDetail, lastError) {
    this.clearWatchdog();
    this.connectionEpoch++;
    setFlag('whatsappAuthenticated', false);
    this.setState({
      status: 'disconnected',
      statusDetail,
      qrDataUrl: null,
      connectedPhone: null,
      connectedPushName: null,
      lastError,
    });
    await this.safeDestroyClient();
    removeSessionDir(authDataPath);
  }

  attachEventHandlers(client, authDataPath, epoch) {
    client.on('qr', async (qrString) => {
      if (epoch !== this.connectionEpoch || this.manualDisconnecting || this.client !== client) {
        return;
      }
      this.clearWatchdog();
      try {
        const dataUrl = await QRCode.toDataURL(qrString, {
          width: 300,
          margin: 2,
          color: { dark: '#0a0b0d', light: '#ffffff' },
        });
        this.setState({
          status: 'connecting',
          statusDetail: 'امسح رمز QR من تطبيق واتساب (الأجهزة المرتبطة).',
          qrDataUrl: dataUrl,
          lastError: null,
        });
      } catch (err) {
        this.setState({
          lastError: err instanceof Error ? err.message : 'تعذر إنشاء صورة QR',
        });
      }
    });

    client.on('authenticated', () => {
      if (epoch !== this.connectionEpoch || this.manualDisconnecting || this.client !== client) {
        return;
      }
      this.clearWatchdog();
      setFlag('whatsappAuthenticated', true);
      this.setState({
        status: 'connecting',
        statusDetail: 'تم التحقق من الجلسة، جاري مزامنة المحادثات...',
        qrDataUrl: null,
        lastError: null,
      });
    });

    client.on('auth_failure', (msg) => {
      if (epoch !== this.connectionEpoch || this.client !== client) return;
      if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
      this.cleanupTimer = setTimeout(() => {
        if (epoch !== this.connectionEpoch) return;
        void this.handleSessionInvalidated(
          authDataPath,
          'فشل توثيق الجلسة. اضغط «اتصال / توليد رمز QR» لمسح رمز جديد.',
          msg || 'Authentication failure'
        );
      }, 400);
    });

    client.on('ready', () => {
      if (epoch !== this.connectionEpoch || this.manualDisconnecting || this.client !== client) {
        return;
      }
      this.clearWatchdog();
      setFlag('whatsappAuthenticated', true);
      const info = client.info;
      const phone = info?.wid?.user || null;
      const pushName = info?.pushname || null;
      this.setState({
        status: 'connected',
        statusDetail: 'متصل وجاهز لإرسال إشعارات الطلبات وصور الإيصالات تلقائياً.',
        qrDataUrl: null,
        connectedPhone: phone,
        connectedPushName: pushName,
        lastError: null,
      });
      console.log('[medlink-wa] Ready:', phone ? maskPhone(phone) : 'connected');
      this.emit('ready');
    });

    client.on('disconnected', (reason) => {
      if (epoch !== this.connectionEpoch || this.client !== client) return;
      this.clearWatchdog();
      setFlag('whatsappAuthenticated', false);
      setFlag('whatsappManualDisconnect', true);
      this.setState({
        status: 'disconnected',
        statusDetail: `تم قطع الاتصال (${reason || 'تم إلغاء الربط'}).`,
        qrDataUrl: null,
        connectedPhone: null,
        connectedPushName: null,
        lastError: null,
      });
      if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
      this.cleanupTimer = setTimeout(() => {
        void this.handleSessionInvalidated(
          authDataPath,
          `تم قطع الاتصال (${reason || 'تم إلغاء الربط'}).`,
          null
        );
      }, 700);
    });
  }

  async safeDestroyClient(maxWaitMs = 4000) {
    this.clearWatchdog();
    if (!this.client) return;
    const target = this.client;
    this.client = null;
    try {
      await Promise.race([
        target.destroy(),
        new Promise((resolve) => setTimeout(resolve, maxWaitMs)),
      ]);
    } catch {
      // Ignore cleanup errors
    }
  }

  async shutdown() {
    this.connectionEpoch++;
    this.clearWatchdog();
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    await this.safeDestroyClient();
  }

  async waitForInitSettle(maxMs = 2500) {
    const start = Date.now();
    while (this.initializing && Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
    this.initializing = false;
  }

  async connectFresh(resetSession = true) {
    if (this.destroying) return;
    this.destroying = true;
    this.connectionEpoch++;
    try {
      await this.safeDestroyClient(600);
      await this.waitForInitSettle(400);
      const authDataPath = path.resolve(process.cwd(), '.wwebjs_auth');
      await cleanStaleChromiumLock(authDataPath);
      if (resetSession) {
        setFlag('whatsappAuthenticated', false);
        removeSessionDir(authDataPath);
      }
      setFlag('whatsappManualDisconnect', false);
      this.setState({
        status: 'connecting',
        statusDetail: 'جاري تجهيز رمز QR جديد لربط الواتساب...',
        qrDataUrl: null,
        connectedPhone: null,
        connectedPushName: null,
        lastError: null,
      });
    } finally {
      this.destroying = false;
    }
    await this.initialize({ resetSession });
  }

  async disconnectAndClearSession() {
    if (this.destroying) return;
    this.destroying = true;
    this.manualDisconnecting = true;
    this.connectionEpoch++;
    this.clearWatchdog();
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    try {
      setFlag('whatsappAuthenticated', false);
      setFlag('whatsappManualDisconnect', true);
      if (this.client) {
        try {
          await Promise.race([
            this.client.logout(),
            new Promise((resolve) => setTimeout(resolve, 3500)),
          ]);
        } catch {
          // Ignore logout errors
        }
        await this.safeDestroyClient();
      }
      await this.waitForInitSettle();
      const authDataPath = path.resolve(process.cwd(), '.wwebjs_auth');
      await cleanStaleChromiumLock(authDataPath);
      removeSessionDir(authDataPath);
      this.setState({
        status: 'disconnected',
        statusDetail: 'تم قطع الاتصال ومسح الجلسة بنجاح.',
        qrDataUrl: null,
        connectedPhone: null,
        connectedPushName: null,
        lastError: null,
      });
    } finally {
      this.manualDisconnecting = false;
      this.destroying = false;
    }
  }

  async sendText(recipientJid, text) {
    if (!this.client || this.status !== 'connected') {
      throw new Error('عميل الواتساب غير متصل حالياً.');
    }
    const numberId = await this.client.getNumberId(recipientJid.replace('@c.us', ''));
    const targetJid = numberId?._serialized || recipientJid;
    const sent = await this.client.sendMessage(targetJid, text);
    const messageId = sent?.id?._serialized;
    if (!messageId) {
      throw new Error('لم يرد واتساب بتأكيد إرسال الرسالة.');
    }
    return { messageId, resolvedJid: targetJid };
  }

  async sendOrderMessage(recipientJid, formattedMessage, paymentReceiptUrl) {
    if (!this.client || this.status !== 'connected') {
      throw new Error('عميل الواتساب غير متصل حالياً.');
    }
    const digits = recipientJid.replace('@c.us', '');
    const numberId = await this.client.getNumberId(digits);
    if (!numberId) {
      throw new Error(`الرقم المستهدف (${digits}) غير مسجل على واتساب.`);
    }
    const targetJid = numberId._serialized;

    if (paymentReceiptUrl && paymentReceiptUrl.trim()) {
      const { MessageMedia } = await loadWwjs();
      const receipt = await fetchValidatedReceiptImage(paymentReceiptUrl.trim());
      const media = new MessageMedia(receipt.mimeType, receipt.base64, receipt.filename);
      const sent = await this.client.sendMessage(targetJid, media, {
        caption: formattedMessage,
      });
      const messageId = sent?.id?._serialized;
      if (!messageId) {
        throw new Error('لم يرد واتساب بتأكيد إرسال صورة الإيصال.');
      }
      return { messageId, resolvedJid: targetJid };
    }

    const sent = await this.client.sendMessage(targetJid, formattedMessage);
    const messageId = sent?.id?._serialized;
    if (!messageId) {
      throw new Error('لم يرد واتساب بتأكيد إرسال رسالة الطلب.');
    }
    return { messageId, resolvedJid: targetJid };
  }
}

export const whatsappService = new WhatsAppService();
