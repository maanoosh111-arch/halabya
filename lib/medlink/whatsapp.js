import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import { getFlag, setFlag } from './store.js';
import { fetchValidatedReceiptImage } from './media.js';
import { maskPhone } from './phone.js';

let cachedBaileys = null;
async function loadBaileys() {
  if (!cachedBaileys) {
    const mod = await import('@whiskeysockets/baileys');
    cachedBaileys = {
      makeWASocket: mod.default?.default || mod.makeWASocket || mod.default,
      useMultiFileAuthState: mod.useMultiFileAuthState,
      fetchLatestBaileysVersion: mod.fetchLatestBaileysVersion,
      DisconnectReason: mod.DisconnectReason,
      Browsers: mod.Browsers,
    };
  }
  return cachedBaileys;
}

const SESSION_DIR_NAME = 'session-halabiya-medlink-relay';

function pickWritableDir(candidates) {
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.write-test-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
      return dir;
    } catch {
      // Try next directory
    }
  }
  return os.tmpdir();
}

function resolveAuthDataPath() {
  return pickWritableDir([
    path.resolve(process.cwd(), '.baileys_auth'),
    path.join(os.tmpdir(), 'halabiya-baileys-auth'),
  ]);
}

function getSessionDir(authDataPath) {
  return path.join(authDataPath, SESSION_DIR_NAME);
}

function removeSessionDir(authDataPath) {
  try {
    fs.rmSync(getSessionDir(authDataPath), { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

function extractPhoneFromUserId(userId) {
  const raw = String(userId || '').trim();
  if (!raw) return null;
  const userPart = raw.split('@')[0] || '';
  const phone = userPart.split(':')[0] || '';
  return phone || null;
}

class WhatsAppService extends EventEmitter {
  constructor() {
    super();
    this.sock = null;
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
    this.reconnectTimer = null;
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
    return this.status === 'connected' && this.sock !== null;
  }

  clearTimers() {
    if (this.syncWatchdog) {
      clearTimeout(this.syncWatchdog);
      this.syncWatchdog = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
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
    if (this.sock && (this.status === 'connecting' || this.status === 'connected')) return;

    this.clearTimers();
    const epoch = ++this.connectionEpoch;
    this.initializing = true;
    this.manualDisconnecting = false;
    setFlag('whatsappManualDisconnect', false);

    this.setState({
      status: 'connecting',
      statusDetail: 'جاري الاتصال بخادم واتساب وتجهيز رمز QR...',
      qrDataUrl: null,
      connectedPhone: null,
      connectedPushName: null,
      lastError: null,
    });

    try {
      const {
        makeWASocket,
        useMultiFileAuthState,
        fetchLatestBaileysVersion,
        DisconnectReason,
        Browsers,
      } = await loadBaileys();
      if (epoch !== this.connectionEpoch || this.manualDisconnecting) return;

      const authDataPath = resolveAuthDataPath();
      const sessionDir = getSessionDir(authDataPath);

      if (resetSession) {
        setFlag('whatsappAuthenticated', false);
        removeSessionDir(authDataPath);
      }
      fs.mkdirSync(sessionDir, { recursive: true });

      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
      if (epoch !== this.connectionEpoch || this.manualDisconnecting) return;

      let version;
      try {
        const fetched = await Promise.race([
          fetchLatestBaileysVersion(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('version fetch timeout')), 6000)
          ),
        ]);
        version = fetched?.version;
      } catch {
        version = undefined;
      }
      if (epoch !== this.connectionEpoch || this.manualDisconnecting) return;

      const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 30_000,
        qrTimeout: 45_000,
      });

      this.sock = sock;

      this.syncWatchdog = setTimeout(() => {
        if (epoch === this.connectionEpoch && this.status === 'connecting' && !this.qrDataUrl) {
          void this.handleSessionInvalidated(
            authDataPath,
            'انتهت مهلة الاتصال بخادم واتساب. اضغط «اتصال / توليد رمز QR» للمحاولة مجدداً.',
            null,
            false
          );
        }
      }, 35_000);

      sock.ev.on('creds.update', async () => {
        if (epoch !== this.connectionEpoch || this.manualDisconnecting) return;
        await saveCreds().catch(() => {});
      });

      sock.ev.on('connection.update', async (update) => {
        if (epoch !== this.connectionEpoch || this.sock !== sock) return;

        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          if (this.syncWatchdog) {
            clearTimeout(this.syncWatchdog);
            this.syncWatchdog = null;
          }
          try {
            const dataUrl = await QRCode.toDataURL(qr, {
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
        }

        if (connection === 'open') {
          this.clearTimers();
          setFlag('whatsappAuthenticated', true);
          const phone = extractPhoneFromUserId(sock.user?.id);
          const pushName = sock.user?.name || null;
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
          return;
        }

        if (connection === 'close') {
          this.clearTimers();
          if (this.manualDisconnecting) return;

          const errObj = lastDisconnect?.error;
          const statusCode = errObj?.output?.statusCode ?? errObj?.statusCode;
          const errMsg = errObj instanceof Error ? errObj.message : String(errObj || '');

          if (statusCode === DisconnectReason.loggedOut) {
            setFlag('whatsappManualDisconnect', true);
            await this.handleSessionInvalidated(
              authDataPath,
              'تم تسجيل الخروج من واتساب. اضغط «اتصال / توليد رمز QR» لإعادة الربط.',
              null,
              true
            );
            return;
          }

          // After initial QR scan, WhatsApp requires a seamless reconnect (515 restartRequired)
          if (
            statusCode === DisconnectReason.restartRequired ||
            (getFlag('whatsappAuthenticated') && statusCode !== DisconnectReason.badSession)
          ) {
            this.safeCloseSocket();
            this.setState({
              status: 'connecting',
              statusDetail: 'تم التحقق من الجلسة، جاري إكمال الاتصال بواتساب...',
              qrDataUrl: null,
              lastError: null,
            });
            this.reconnectTimer = setTimeout(() => {
              if (epoch === this.connectionEpoch && !this.manualDisconnecting) {
                this.initializing = false;
                void this.initialize({ resetSession: false });
              }
            }, 800);
            return;
          }

          await this.handleSessionInvalidated(
            authDataPath,
            'تعذر إتمام الربط مع واتساب. اضغط «اتصال / توليد رمز QR» للمحاولة مجدداً.',
            errMsg || null,
            false
          );
        }
      });
    } catch (err) {
      if (epoch !== this.connectionEpoch || this.manualDisconnecting) return;
      this.clearTimers();
      const message = err instanceof Error ? err.message : 'تعذر بدء الاتصال بواتساب.';
      setFlag('whatsappAuthenticated', false);
      this.setState({
        status: 'disconnected',
        statusDetail: 'فشل بدء جلسة واتساب.',
        qrDataUrl: null,
        connectedPhone: null,
        connectedPushName: null,
        lastError: message,
      });
      this.safeCloseSocket();
    } finally {
      this.initializing = false;
    }
  }

  safeCloseSocket() {
    this.clearTimers();
    if (!this.sock) return;
    const target = this.sock;
    this.sock = null;
    try {
      target.ev?.removeAllListeners?.();
      target.end?.(undefined);
    } catch {
      // Ignore cleanup errors
    }
  }

  async handleSessionInvalidated(authDataPath, statusDetail, lastError, purgeSession = false) {
    this.clearTimers();
    this.connectionEpoch++;
    if (purgeSession) {
      setFlag('whatsappAuthenticated', false);
      removeSessionDir(authDataPath);
    }
    this.setState({
      status: 'disconnected',
      statusDetail,
      qrDataUrl: null,
      connectedPhone: null,
      connectedPushName: null,
      lastError,
    });
    this.safeCloseSocket();
  }

  async shutdown() {
    this.connectionEpoch++;
    this.clearTimers();
    this.safeCloseSocket();
  }

  async waitForInitSettle(maxMs = 1500) {
    const start = Date.now();
    while (this.initializing && Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 80));
    }
    this.initializing = false;
  }

  async connectFresh(resetSession = true) {
    if (this.destroying) return;
    this.destroying = true;
    this.connectionEpoch++;
    try {
      this.safeCloseSocket();
      await this.waitForInitSettle(400);
      const authDataPath = resolveAuthDataPath();
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
    this.clearTimers();

    try {
      setFlag('whatsappAuthenticated', false);
      setFlag('whatsappManualDisconnect', true);
      if (this.sock) {
        try {
          await Promise.race([
            this.sock.logout(),
            new Promise((resolve) => setTimeout(resolve, 2500)),
          ]);
        } catch {
          // Ignore logout errors
        }
        this.safeCloseSocket();
      }
      await this.waitForInitSettle();
      const authDataPath = resolveAuthDataPath();
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

  async resolveTargetJid(recipientJid, requireOnWhatsApp = false) {
    const digits = String(recipientJid || '')
      .replace(/@(c\.us|s\.whatsapp\.net)$/i, '')
      .replace(/\D/g, '');
    if (!digits) {
      throw new Error('رقم الواتساب المستهدف غير صالح.');
    }

    if (typeof this.sock?.onWhatsApp === 'function') {
      try {
        const lookup = await this.sock.onWhatsApp(digits);
        const first = Array.isArray(lookup) ? lookup[0] : null;
        if (first && first.exists === false && requireOnWhatsApp) {
          throw new Error(`الرقم المستهدف (${digits}) غير مسجل على واتساب.`);
        }
        if (first?.jid) {
          return first.jid;
        }
      } catch (err) {
        if (requireOnWhatsApp && err instanceof Error && err.message.includes('غير مسجل')) {
          throw err;
        }
      }
    }

    return `${digits}@s.whatsapp.net`;
  }

  async sendText(recipientJid, text) {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('عميل الواتساب غير متصل حالياً.');
    }
    const targetJid = await this.resolveTargetJid(recipientJid, false);
    const sent = await this.sock.sendMessage(targetJid, { text: String(text || '') });
    const messageId = sent?.key?.id;
    if (!messageId) {
      throw new Error('لم يرد واتساب بتأكيد إرسال الرسالة.');
    }
    return { messageId, resolvedJid: targetJid };
  }

  async sendOrderMessage(recipientJid, formattedMessage, paymentReceiptUrl) {
    if (!this.sock || this.status !== 'connected') {
      throw new Error('عميل الواتساب غير متصل حالياً.');
    }
    const targetJid = await this.resolveTargetJid(recipientJid, true);

    if (paymentReceiptUrl && paymentReceiptUrl.trim()) {
      const receipt = await fetchValidatedReceiptImage(paymentReceiptUrl.trim());
      const buffer = Buffer.from(receipt.base64, 'base64');
      const sent = await this.sock.sendMessage(targetJid, {
        image: buffer,
        mimetype: receipt.mimeType,
        fileName: receipt.filename,
        caption: formattedMessage,
      });
      const messageId = sent?.key?.id;
      if (!messageId) {
        throw new Error('لم يرد واتساب بتأكيد إرسال صورة الإيصال.');
      }
      return { messageId, resolvedJid: targetJid };
    }

    const sent = await this.sock.sendMessage(targetJid, { text: formattedMessage });
    const messageId = sent?.key?.id;
    if (!messageId) {
      throw new Error('لم يرد واتساب بتأكيد إرسال رسالة الطلب.');
    }
    return { messageId, resolvedJid: targetJid };
  }
}

export const whatsappService = new WhatsAppService();
