import {
  claimOrderForSending,
  getAppConfig,
  getNextDueOrder,
  markOrderRetryOrFail,
  markOrderSent,
  recoverInterruptedSendingOrders,
  releaseOrderWithoutAttemptPenalty,
  requeueUnsentOrdersOnReconnect,
} from './store.js';
import { toWhatsAppJid } from './phone.js';
import { whatsappService } from './whatsapp.js';

const RETRY_DELAYS_MS = [10_000, 30_000, 90_000, 270_000];
const POLL_INTERVAL_MS = 2500;
const BURST_GAP_MS = 300;

function isDisconnectLikeError(errMessage) {
  const msg = String(errMessage || '').toLowerCase();
  return (
    msg.includes('غير متصل') ||
    msg.includes('connection closed') ||
    msg.includes('stream errored') ||
    msg.includes('timed out') ||
    msg.includes('socket') ||
    msg.includes('econnreset')
  );
}

class NotificationQueueWorker {
  constructor() {
    this.timer = null;
    this.processing = false;
    this.retriggerRequested = false;
  }

  start() {
    const recovered = recoverInterruptedSendingOrders();
    if (recovered > 0) {
      console.warn(`[medlink-queue] Recovered ${recovered} interrupted sending order(s).`);
    }

    whatsappService.on('ready', () => {
      const readyCount = requeueUnsentOrdersOnReconnect();
      if (readyCount > 0) {
        console.log(`[medlink-queue] WhatsApp connected; dispatching ${readyCount} unsent order(s).`);
      }
      void this.trigger();
    });

    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.trigger();
      }, POLL_INTERVAL_MS);
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async trigger() {
    if (this.processing) {
      this.retriggerRequested = true;
      return;
    }
    if (!whatsappService.isConnected()) return;

    this.processing = true;
    try {
      do {
        this.retriggerRequested = false;
        while (whatsappService.isConnected()) {
          const nextOrder = getNextDueOrder(Date.now());
          if (!nextOrder) break;

          const claimed = claimOrderForSending(nextOrder.order_id);
          if (!claimed) continue;

          const attemptNumber = nextOrder.attempts;
          try {
            const config = getAppConfig();
            const recipientJid = toWhatsAppJid(config.recipientNumber, config.defaultCountryCode);
            const result = await whatsappService.sendOrderMessage(
              recipientJid,
              nextOrder.formatted_message,
              nextOrder.payment_receipt_url
            );
            markOrderSent(nextOrder.order_id, result.messageId, result.resolvedJid);
            if (getNextDueOrder(Date.now()) && whatsappService.isConnected()) {
              await new Promise((r) => setTimeout(r, BURST_GAP_MS));
            }
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'خطأ غير معروف أثناء الإرسال';
            if (!whatsappService.isConnected() || isDisconnectLikeError(errorMessage)) {
              releaseOrderWithoutAttemptPenalty(
                nextOrder.order_id,
                'انقطع اتصال واتساب قبل اكتمال الإرسال؛ سيتم الإرسال فوراً عند عودة الاتصال'
              );
              break;
            }

            if (attemptNumber >= nextOrder.max_attempts) {
              markOrderRetryOrFail(nextOrder.order_id, 'failed', null, errorMessage);
            } else {
              const backoffMs =
                RETRY_DELAYS_MS[Math.min(attemptNumber - 1, RETRY_DELAYS_MS.length - 1)];
              markOrderRetryOrFail(
                nextOrder.order_id,
                'pending',
                Date.now() + backoffMs,
                errorMessage
              );
            }
          }
        }
      } while (this.retriggerRequested && whatsappService.isConnected());
    } finally {
      this.processing = false;
    }
  }
}

export const queueWorker = new NotificationQueueWorker();
