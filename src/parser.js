// Parses an Amazon search results page (a DOM Document) into plain objects.
// Pure: no network, no globals, so it runs in Firefox and in jsdom tests.

const CAPTCHA_RE = /captchacharacters|validateCaptcha|api-services-support@amazon/i;

const num = (s) => {
  const m = String(s ?? '').replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
};

// "35.1K" / "1.2M" / "35,166" -> number
const abbrev = (s) => {
  const m = String(s ?? '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([KM]?)/i);
  if (!m) return null;
  const mult = { '': 1, K: 1e3, M: 1e6 }[m[2].toUpperCase()];
  return Math.round(parseFloat(m[1]) * mult);
};

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Amazon prints exact totals below ~1000 ("1-48 of 736 results") and rounded
// lower bounds above ("1-48 of over 10,000 results"). A page with a single
// screenful says only "32 results".
export function parseTotal(text) {
  const t = clean(text);
  const m = t.match(/(?:[\d,]+\s*[-–]\s*[\d,]+\s+of\s+)?(over\s+)?([\d,]+)\s+results?/i);
  if (!m) return { total: null, over: false };
  return { total: parseInt(m[2].replace(/,/g, ''), 10), over: !!m[1] };
}

// What Amazon's delivery line says, without deciding what it costs you:
//   free         unconditional "FREE delivery <date>"
//   fee          "$6.53 delivery <date>": a separate charge, always shown
//   conditional  FREE, but only on your first order or above a spend ("on $59 of items")
//   unknown      no message, or just "Delivery <date>"
export function parseDelivery(text) {
  if (!text) return { kind: 'unknown', fee: null, threshold: null };
  const free = /\bFREE\b/i.test(text);
  const fee = text.match(/\$\s*([\d,]+(?:\.\d+)?)\s+delivery/i);
  const threshold = text.match(/\b(?:on|over)\s+\$\s*([\d,]+(?:\.\d+)?)/i);
  const firstOrder = /\bfirst order\b/i.test(text);
  if (!free && fee) return { kind: 'fee', fee: parseFloat(fee[1].replace(/,/g, '')), threshold: null };
  if (free && (firstOrder || threshold)) {
    return { kind: 'conditional', fee: null, threshold: threshold ? parseFloat(threshold[1].replace(/,/g, '')) : null };
  }
  if (free) return { kind: 'free', fee: 0, threshold: null };
  return { kind: 'unknown', fee: null, threshold: null };
}

export function parseCard(c) {
  const asin = c.getAttribute('data-asin');
  const text = clean(c.textContent);
  // Newer cards have two h2s: a brand line, then the product title inside the
  // product link. Older cards have just the title.
  const h2s = [...c.querySelectorAll('h2')];
  const h2 = c.querySelector('a h2') || [...h2s].sort((a, b) => b.textContent.length - a.textContent.length)[0];
  const brandEl = h2s.find((e) => e !== h2 && !e.closest('a'));
  const title = clean(h2?.getAttribute('aria-label') || h2?.textContent).replace(/^Sponsored Ad\s*[–-]\s*/i, '');
  const brand = brandEl ? clean(brandEl.textContent) : null;

  const sponsored =
    !!c.querySelector('.puis-sponsored-label-text, [aria-label^="Sponsored"]') ||
    /^\s*Sponsored/i.test(text) ||
    /^Sponsored Ad/i.test(clean(h2?.textContent));

  const price = num(c.querySelector('.a-price:not(.a-text-price) .a-offscreen')?.textContent);
  // Both the struck-through list price and the per-unit price use `a-text-price`;
  // only the list price is marked data-a-strike.
  const listPrice = num(c.querySelector('.a-price.a-text-price[data-a-strike="true"] .a-offscreen')?.textContent);

  const rating = num(c.querySelector('[aria-label*="out of 5 stars"]')?.getAttribute('aria-label') ||
    c.querySelector('.a-icon-alt')?.textContent);
  const reviews =
    abbrev(c.querySelector('[aria-label$="ratings"], [aria-label$="rating"]')?.getAttribute('aria-label')) ??
    abbrev(c.querySelector('a[href*="customerReviews"] span, [data-csa-c-func-deps*="review"] span')?.textContent);

  const bought = text.match(/([\d.,]+\s*[KM]?\+?)\s+bought in past month/i)?.[1] ?? null;
  // Per-unit price: "(<$3.65>/100 g)", where the price is its own a-text-price node.
  const unitEl = [...c.querySelectorAll('.a-price.a-text-price:not([data-a-strike="true"])')]
    .find((e) => /\/\s*[^)]+\)/.test(e.parentElement?.textContent || ''));
  const unitText = unitEl ? clean(unitEl.parentElement.textContent).match(/\/\s*([^)]+?)\s*\)/)?.[1] : null;
  const unitFallback = unitEl ? null : text.match(/\(\s*[^\d()]{0,3}([\d.,]+)\s*\/\s*([^)]+?)\s*\)/);

  // Delivery: the first primary message that isn't about international orders.
  const msgs = [...c.querySelectorAll('.udm-primary-delivery-message')].map((e) => clean(e.textContent)).filter(Boolean);
  const delivery = msgs.find((m) => !/international/i.test(m)) ?? msgs[0] ?? null;
  const dv = parseDelivery(delivery);
  const left = text.match(/Only (\d+) left in stock/i);

  // Books and media put the format of the price shown in a bold link above it, so the price block
  // reads "Kindle Edition Price, product page$11.99" or "Hardcover Price, product page$46.70" (plain
  // products: just "Price, product page"). Kindle and audiobook prices are digital: $0.00 for Kindle
  // Unlimited / "Free with Audible trial".
  const priceBlock = clean(c.querySelector('.s-price-instructions-style')?.textContent);
  const format = priceBlock.match(/^(.*?)\s*Price, product page/i)?.[1] || null;
  const digital = !!format && /\b(Kindle|Audiobook|Audible)\b/i.test(format);

  return {
    asin,
    title,
    brand,
    sponsored,
    price,
    listPrice,
    rating,
    reviews,
    bought: bought ? abbrev(bought) : null,
    prime: !!c.querySelector('.a-icon-prime, [aria-label*="Prime"]'),
    unitPrice: unitEl ? num(unitEl.querySelector('.a-offscreen')?.textContent)
      : unitFallback ? parseFloat(unitFallback[1].replace(/,/g, '')) : null,
    unit: unitText ?? (unitFallback ? clean(unitFallback[2]) : null),
    format,
    digital,
    delivery,
    deliveryFee: dv.fee,
    deliveryKind: dv.kind,
    deliveryThreshold: dv.threshold,
    badge: clean(c.querySelector('.a-badge-label-inner')?.textContent) || null,
    lowStock: left ? parseInt(left[1], 10) : null,
    image: c.querySelector('img.s-image')?.getAttribute('src') ?? null,
  };
}

export function parseSearchPage(doc, html = '') {
  const raw = html || doc.documentElement?.outerHTML || '';
  const cards = [...doc.querySelectorAll('[data-component-type="s-search-result"]')]
    .filter((c) => c.getAttribute('data-asin'))
    .map(parseCard);

  const blocked = cards.length === 0 && (CAPTCHA_RE.test(raw) || /robot check/i.test(doc.title || ''));

  const bar = doc.querySelector('[data-component-type="s-result-info-bar"]');
  let { total, over } = parseTotal(bar?.textContent);
  if (total == null) {
    // The info bar text is sometimes empty in a fetched (never rendered) document.
    const m = raw.match(/[\d,]+\s*[-–]\s*[\d,]+\s+of\s+(?:over\s+)?[\d,]+\s+results?/i);
    if (m) ({ total, over } = parseTotal(m[0]));
  }
  return { blocked, total, over, cards };
}
