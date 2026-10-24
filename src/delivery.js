// What an item costs you delivered, when it is the only thing in your cart.
//
// Amazon's list prices leave delivery out. Messages come in four kinds (see
// parseDelivery in parser.js):
//   free         unconditional free delivery            -> costs 0
//   fee          a listed charge ("$6.53 delivery")     -> costs that, always
//   conditional  free on a first order / above a spend  -> costs the standard fee
//   unknown      no message                             -> if the item is under the free-delivery threshold
// For conditional and unknown items the standard fee is charged unless the price reaches the
// free-delivery threshold (taken from the message when it names one, else your setting).

export const DEFAULT_DELIVERY = { fee: 8, threshold: 59 };

export function deliveryCost(item, settings = DEFAULT_DELIVERY) {
  if (item.price == null) return { cost: null, note: 'none' };
  if (item.deliveryKind === 'free') return { cost: 0, note: 'free' };
  if (item.deliveryKind === 'fee' && item.deliveryFee != null) return { cost: item.deliveryFee, note: 'listed' };
  const threshold = item.deliveryThreshold ?? settings.threshold;
  return item.price >= threshold ? { cost: 0, note: 'over' } : { cost: settings.fee, note: 'est' };
}

const round2 = (n) => Math.round(n * 100) / 100;

// Copies of the items with deliveryCost, deliveryNote and total (price + delivery) filled in.
export function withDelivery(items, settings = DEFAULT_DELIVERY) {
  return items.map((it) => {
    const { cost, note } = deliveryCost(it, settings);
    return { ...it, deliveryCost: cost, deliveryNote: note, total: cost == null ? null : round2(it.price + cost) };
  });
}

// "free", "+$6.53", "+$8.00 est.", "free over $59"
export function deliveryLabel(it, settings = DEFAULT_DELIVERY) {
  const m = (n) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
  const fee = (n) => `$${n.toFixed(2)}`;
  switch (it.deliveryNote) {
    case 'free': return 'free';
    case 'listed': return `+${fee(it.deliveryCost)}`;
    case 'over': return `free over ${m(it.deliveryThreshold ?? settings.threshold)}`;
    case 'est': return `+${fee(it.deliveryCost)} est.`;
    default: return '';
  }
}
