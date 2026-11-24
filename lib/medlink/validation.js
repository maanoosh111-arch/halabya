import { z } from 'zod';
import { isValidPhoneInput } from './phone.js';

const nonEmptyTrimmed = z.string().trim().min(1);

export const orderItemSchema = z.object({
  name: nonEmptyTrimmed.max(200),
  quantity: z.coerce.number().finite().positive().max(1000),
  price: z.coerce.number().finite().min(0).max(1_000_000),
  notes: z.string().trim().max(300).optional().default(''),
});

export const incomingOrderSchema = z
  .object({
    orderId: z
      .union([z.string(), z.number()])
      .transform((val) => String(val).trim())
      .refine((val) => val.length > 0 && val.length <= 80, {
        message: 'orderId must be a non-empty string up to 80 characters',
      }),
    customerName: nonEmptyTrimmed.max(150),
    customerPhone: nonEmptyTrimmed.max(40),
    deliveryAddress: nonEmptyTrimmed.max(500),
    items: z.array(orderItemSchema).min(1, 'At least one order item is required').max(200),
    subtotal: z.coerce.number().finite().min(0).max(10_000_000),
    deliveryFee: z.coerce.number().finite().min(0).max(1_000_000).optional(),
    deliveryFees: z.coerce.number().finite().min(0).max(1_000_000).optional(),
    totalAmount: z.coerce.number().finite().min(0).max(10_000_000),
    currency: z.string().trim().max(16).optional().default('ج.م'),
    customerNotes: z.string().trim().max(1000).optional().default(''),
    paymentMethod: nonEmptyTrimmed.max(100),
    walletName: z.string().trim().max(120).optional().default(''),
    transferReference: z.string().trim().max(120).optional().default(''),
    paymentReceiptUrl: z
      .string()
      .trim()
      .max(7_000_000)
      .optional()
      .default('')
      .refine(
        (val) => {
          if (!val) return true;
          if (/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(val)) {
            return true;
          }
          if (val.length > 2048) return false;
          try {
            const parsed = new URL(val);
            return parsed.protocol === 'https:' || parsed.protocol === 'http:';
          } catch {
            return false;
          }
        },
        { message: 'paymentReceiptUrl must be an http/https URL or a base64 image data URI' }
      ),
    paymentReceiptBase64: z.string().trim().max(7_000_000).optional().default(''),
  })
  .transform((data) => ({
    orderId: data.orderId,
    customerName: data.customerName,
    customerPhone: data.customerPhone,
    deliveryAddress: data.deliveryAddress,
    items: data.items,
    subtotal: data.subtotal,
    deliveryFee: data.deliveryFee ?? data.deliveryFees ?? 0,
    totalAmount: data.totalAmount,
    currency: data.currency || 'ج.م',
    customerNotes: data.customerNotes ?? '',
    paymentMethod: data.paymentMethod,
    walletName: data.walletName ?? '',
    transferReference: data.transferReference ?? '',
    paymentReceiptUrl: data.paymentReceiptUrl || data.paymentReceiptBase64 || '',
  }));

export const configUpdateSchema = z.object({
  senderNumber: nonEmptyTrimmed
    .max(30)
    .refine(isValidPhoneInput, { message: 'رقم المرسل يجب أن يتكون من 8 إلى 15 رقماً.' }),
  recipientNumber: nonEmptyTrimmed
    .max(30)
    .refine(isValidPhoneInput, { message: 'الرقم المستهدف يجب أن يتكون من 8 إلى 15 رقماً.' }),
  defaultCountryCode: z
    .string()
    .trim()
    .regex(/^\d{1,4}$/, 'كود الدولة يجب أن يكون من 1 إلى 4 أرقام (مثال: 20)')
    .optional()
    .default('20'),
});

export const testMessageSchema = z.object({
  message: z.string().trim().max(500).optional(),
});
