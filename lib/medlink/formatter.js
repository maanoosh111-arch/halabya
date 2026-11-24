function formatMoney(amount, currency) {
  const n = Number(amount || 0);
  const formatted = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return `${formatted} ${currency}`.trim();
}

export function formatArabicOrderMessage(order) {
  const currency = order.currency || 'ج.م';

  const itemLines = (order.items || []).map((item) => {
    const lineTotal = Number(item.price || 0) * Number(item.quantity || 1);
    const base = `• ${item.quantity} × ${item.name} — ${formatMoney(lineTotal, currency)}`;
    const noteSuffix = item.notes && item.notes.trim() ? ` (${item.notes.trim()})` : '';
    return `${base}${noteSuffix}`;
  });

  if (Number(order.subtotal || 0) > 0) {
    itemLines.push(`المجموع الفرعي: ${formatMoney(order.subtotal, currency)}`);
  }

  if (Number(order.deliveryFee || 0) > 0) {
    itemLines.push(`رسوم التوصيل: ${formatMoney(order.deliveryFee, currency)}`);
  }

  const paymentLines = [`طريقة الدفع: ${order.paymentMethod}`];

  if (order.walletName && order.walletName.trim()) {
    paymentLines.push(`المحفظة: ${order.walletName.trim()}`);
  }

  if (order.transferReference && order.transferReference.trim()) {
    paymentLines.push(`رقم التحويل: ${order.transferReference.trim()}`);
  }

  const sections = [
    'طلب جديد 🔔',
    '',
    `رقم الطلب: #${order.orderId}`,
    '',
    '👤 بيانات العميل:',
    `الاسم: ${order.customerName}`,
    `رقم الهاتف: ${order.customerPhone}`,
    `العنوان: ${order.deliveryAddress}`,
    '',
    '🛒 تفاصيل الطلب:',
    ...itemLines,
    '',
    '💰 تفاصيل الدفع:',
    ...paymentLines,
    '',
    `الإجمالي: ${formatMoney(order.totalAmount, currency)}`,
  ];

  if (order.customerNotes && order.customerNotes.trim()) {
    sections.push('', '📝 ملاحظات العميل:', order.customerNotes.trim());
  }

  return sections.join('\n');
}
