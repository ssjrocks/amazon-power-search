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

export function parseCard(c) {
  const asin = c.getAttribute('data-asin');
  const text = clean(c.textContent);
  const h2 = c.querySelector('h2');
  const title = clean(h2?.getAttribute('aria-label') || h2?.textContent).replace(/^Sponsored Ad\s*[–-]\s*/i, '');

  const sponsored =
    !!c.querySelector('.puis-sponsored-label-text, [aria-label^="Sponsored"]') ||
    /^\s*Sponsored/i.test(text) ||
    /^Sponsored Ad/i.test(clean(h2?.textContent));

  const price = num(c.querySelector('.a-price:not(.a-text-price) .a-offscreen')?.textContent);
  const listPrice = num(c.querySelector('.a-price.a-text-price .a-offscreen')?.textContent);

  const rating = num(c.querySelector('[aria-label*="out of 5 stars"]')?.getAttribute('aria-label') ||
    c.querySelector('.a-icon-alt')?.textContent);
  const reviews =
    abbrev(c.querySelector('[aria-label$="ratings"], [aria-label$="rating"]')?.getAttribute('aria-label')) ??
    abbrev(c.querySelector('a[href*="customerReviews"] span, [data-csa-c-func-deps*="review"] span')?.textContent);

  const bought = text.match(/([\d.,]+\s*[KM]?\+?)\s+bought in past month/i)?.[1] ?? null;
  const unit = text.match(/\(\s*[^\d()]{0,3}([\d.,]+)\s*\/\s*([^)]+?)\s*\)/);

  return {
    asin,
    title,
    sponsored,
    price,
    listPrice,
    rating,
    reviews,
    bought: bought ? abbrev(bought) : null,
    prime: !!c.querySelector('.a-icon-prime, [aria-label*="Prime"]'),
    unitPrice: unit ? parseFloat(unit[1].replace(/,/g, '')) : null,
    unit: unit ? clean(unit[2]) : null,
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
