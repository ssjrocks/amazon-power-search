import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parseSearchPage, parseTotal, parseDelivery } from '../src/parser.js';
import { withDelivery, deliveryLabel, deliveryCost } from '../src/delivery.js';
import { applyFilters, sortItems, bayes, normaliseUnit } from '../src/filter.js';

// Synthetic fixture modelled on amazon.com.au markup observed 2026-10-24.
// Selectors that matter: data-component-type, data-asin, .a-price .a-offscreen,
// aria-labels for stars and ratings, and the "Sponsored" label.
const card = ({ asin, title, price, list, stars, ratings, sponsored, prime, extra = '' }) => `
<div role="listitem" data-asin="${asin}" data-component-type="s-search-result">
  ${sponsored ? '<span class="puis-sponsored-label-text">Sponsored</span>' : ''}
  <img class="s-image" src="https://img/${asin}.jpg">
  <h2 aria-label="${sponsored ? 'Sponsored Ad – ' : ''}${title}"><span>${title}</span></h2>
  ${stars ? `<span aria-label="${stars} out of 5 stars, rating details"></span>` : ''}
  ${ratings ? `<a aria-label="${ratings} ratings"><span>(35.1K)</span></a>` : ''}
  <span class="a-size-base">50+ bought in past month</span>
  ${price ? `<span class="a-price"><span class="a-offscreen">$${price}</span></span>` : ''}
  ${list ? `<span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">$${list}</span></span>` : ''}
  ${prime ? '<i class="a-icon a-icon-prime"></i>' : ''}
  ${extra}
</div>`;

const page = (bar, cards) => `<html><head><title>Amazon.com.au : x</title></head><body>
<div data-component-type="s-result-info-bar"><span>${bar}</span></div>
<div data-asin="" data-component-type="s-ads-metrics"></div>
${cards.join('')}</body></html>`;
const doc = (html) => new JSDOM(html).window.document;

test('parseTotal reads exact, rounded and single-screen forms', () => {
  assert.deepEqual(parseTotal('1-48 of 736 results for "x"'), { total: 736, over: false });
  assert.deepEqual(parseTotal('1-48 of over 70,000 results'), { total: 70000, over: true });
  assert.deepEqual(parseTotal('32 results for "x"'), { total: 32, over: false });
  assert.deepEqual(parseTotal('nothing here'), { total: null, over: false });
});

test('parses fields from a normal and a sponsored card', () => {
  const html = page('1-48 of 736 results', [
    card({ asin: 'B1', title: 'Cable 2m', price: '12.99', list: '19.99', stars: '4.7', ratings: '35,166', prime: true,
      extra: '<span>($6.50/metre)</span>' }),
    card({ asin: 'B2', title: 'Ad Cable', price: '5.00', sponsored: true }),
  ]);
  const r = parseSearchPage(doc(html), html);
  assert.equal(r.total, 736);
  assert.equal(r.over, false);
  assert.equal(r.blocked, false);
  assert.equal(r.cards.length, 2); // the empty ad-metrics div is ignored
  const [a, b] = r.cards;
  assert.equal(a.asin, 'B1');
  assert.equal(a.price, 12.99);
  assert.equal(a.listPrice, 19.99);
  assert.equal(a.rating, 4.7);
  assert.equal(a.reviews, 35166);
  assert.equal(a.bought, 50);
  assert.equal(a.prime, true);
  assert.equal(a.unitPrice, 6.5);
  assert.equal(a.unit, 'metre');
  assert.equal(a.sponsored, false);
  assert.equal(b.sponsored, true);
  assert.equal(b.title, 'Ad Cable');
});

test('takes the product title, not the brand line, when a card has two h2s', () => {
  const html = page('1-48 of 700 results', [`
<div role="listitem" data-asin="B9" data-component-type="s-search-result">
  <div class="a-row a-color-secondary"><h2 class="a-size-mini"><span>Waveshare</span></h2></div>
  <a class="a-link-normal" href="/dp/B9"><h2 aria-label="3.5inch Touch Display Module for Raspberry Pi Pico"><span>3.5inch Touch Display Module for Raspberry Pi Pico</span></h2></a>
  <span class="a-price"><span class="a-offscreen">$16.80</span></span>
</div>`]);
  const c = parseSearchPage(doc(html), html).cards[0];
  assert.equal(c.title, '3.5inch Touch Display Module for Raspberry Pi Pico');
  assert.equal(c.brand, 'Waveshare');
});

test('a card without a price has price null', () => {
  const html = page('1 result', [card({ asin: 'B3', title: 'See options' })]);
  assert.equal(parseSearchPage(doc(html), html).cards[0].price, null);
});

test('detects the CAPTCHA page', () => {
  const html = '<html><head><title>Robot Check</title></head><body><form action="/errors/validateCaptcha"><input name="captchacharacters"></form></body></html>';
  const r = parseSearchPage(doc(html), html);
  assert.equal(r.blocked, true);
  assert.equal(r.cards.length, 0);
});

test('an empty results page is not a block', () => {
  const html = '<html><head><title>Amazon</title></head><body>No results for your search.</body></html>';
  assert.equal(parseSearchPage(doc(html), html).blocked, false);
});

test('filters and sorts', () => {
  const items = [
    { asin: 'a', title: 'Braided cable 2m', price: 10, rating: 4.5, reviews: 1000, prime: true },
    { asin: 'b', title: 'Cable adapter', price: 3, rating: 3.9, reviews: 20 },
    { asin: 'c', title: 'Braided cable 1m', price: 8, rating: 5, reviews: 2, sponsored: true },
    { asin: 'd', title: 'Braided cable 3m', price: null, rating: 4.9, reviews: 500 },
  ];
  const ids = (xs) => xs.map((x) => x.asin).join('');
  assert.equal(ids(applyFilters(items, { hideSponsored: true, hideNoPrice: true })), 'ab');
  assert.equal(ids(applyFilters(items, { include: 'braided', exclude: 'adapter' })), 'acd');
  assert.equal(ids(applyFilters(items, { minRating: 4.6 })), 'cd');
  assert.equal(ids(applyFilters(items, { primeOnly: true })), 'a');
  assert.equal(ids(sortItems(items, 'price', 'asc')), 'bcad'); // no-price last
  assert.equal(ids(sortItems(items, 'price', 'desc')), 'acbd');
  assert.ok(bayes(5, 2) < bayes(4.6, 3000)); // 3 reviews don't beat 3000
  assert.equal(ids(sortItems(items, 'title')), 'cadb');
  assert.equal(ids(sortItems(items, 'reviews')), 'adbc'); // default direction: most first
  assert.equal(ids(sortItems(items, 'reviews', 'asc')), 'cbda');
});

test('real amazon.com.au cards: brand line is not the title, sponsored and price/rating parsed', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('./fixtures/waveshare.html', import.meta.url), 'utf8');
  const r = parseSearchPage(doc(html), html);
  assert.deepEqual({ total: r.total, over: r.over, n: r.cards.length }, { total: 6000, over: true, n: 2 });
  const [ad, org] = r.cards;
  assert.equal(ad.title, '3.5inch Touch Display Module for Raspberry Pi Pico 65K Colors 480×320 Pixels SPI Interface');
  assert.equal(ad.brand, 'Waveshare');
  assert.equal(ad.sponsored, true);
  assert.equal(ad.price, 43.99);
  assert.equal(ad.rating, 3.6);
  assert.equal(ad.reviews, 15);
  assert.equal(org.title, 'Solar Power Manager Module (D), Support 6V~24V Solar Panel & Type-C Power Adapter, 5V/3A Output');
  assert.equal(org.sponsored, false);
  assert.equal(org.price, 33.8);
  assert.equal(org.reviews, 97);
});

test('real amazon.com.au grocery cards: unit price, list price, delivery, badge, stock', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('./fixtures/coffee.html', import.meta.url), 'utf8');
  const [a, b] = parseSearchPage(doc(html), html).cards;
  assert.equal(a.brand, 'Lavazza');
  assert.equal(a.title, 'Qualità Rossa Coffee Beans 1kg');
  assert.equal(a.price, 36.5);
  assert.equal(a.unitPrice, 3.65);          // not mistaken for a list price
  assert.equal(a.unit, '100 g');
  assert.equal(a.listPrice, null);
  assert.equal(a.delivery, 'FREE delivery Thu, 5 Nov on your first order');
  assert.equal(a.deliveryKind, 'conditional'); // first-order promo, not free for existing customers
  assert.equal(a.deliveryFee, null);
  assert.equal(a.badge, "Amazon's Choice");
  assert.equal(a.lowStock, 4);
  assert.equal(a.bought, 600);
  assert.equal(a.reviews, 1204);
  assert.equal(b.price, 19.99);
  assert.equal(b.listPrice, 24.99);
  assert.equal(b.unitPrice, 4);
  assert.equal(b.deliveryFee, 6.53);
  assert.equal(b.deliveryKind, 'fee');
  assert.equal(b.badge, null);
});

test('unit prices normalise so per-100 g and per-kg compare', () => {
  assert.deepEqual(normaliseUnit(3.65, '100 g'), { family: 'weight', price: 3.65 });
  assert.equal(normaliseUnit(30, 'kg').price, 3);
  assert.equal(normaliseUnit(2, '100 ml').family, 'volume');
  assert.equal(normaliseUnit(8, 'l').price, 0.8);
  assert.equal(normaliseUnit(1.5, 'count').family, 'count');
  assert.equal(normaliseUnit(null, 'kg'), null);
  const items = [
    { asin: 'a', unitPrice: 30, unit: 'kg' },      // 3.00 / 100 g
    { asin: 'b', unitPrice: 3.65, unit: '100 g' },
    { asin: 'c', unitPrice: 2.5, unit: '100 g' },
    { asin: 'd' },
  ];
  assert.equal(sortItems(items, 'unit').map((i) => i.asin).join(''), 'cabd'); // 2.50, 3.00, 3.65, none last
});

test('free delivery filter and delivery-cost sort use the delivered cost', () => {
  const items = withDelivery([
    { asin: 'a', price: 20, deliveryKind: 'fee', deliveryFee: 6.53 },
    { asin: 'b', price: 20, deliveryKind: 'free', deliveryFee: 0 },
    { asin: 'c', price: 20, deliveryKind: 'unknown' },
    { asin: 'd', price: 80, deliveryKind: 'unknown' },
  ]);
  assert.equal(applyFilters(items, { freeDelivery: true }).map((i) => i.asin).join(''), 'bd');
  assert.equal(sortItems(items, 'delivery').map((i) => i.asin).join(''), 'bdac'); // 0, 0, 6.53, 8
});


test('Kindle and audiobook prices are flagged digital by the format on the price shown', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('./fixtures/books.html', import.meta.url), 'utf8');
  const [kindle, audio, hardcover] = parseSearchPage(doc(html), html).cards;
  assert.deepEqual([kindle.format, kindle.digital, kindle.price], ['Kindle Edition', true, 0]);
  assert.deepEqual([audio.format, audio.digital, audio.price], ['Audiobook', true, 0]);
  // a hardcover that merely lists a Kindle edition keeps its real price
  assert.deepEqual([hardcover.format, hardcover.digital, hardcover.price, hardcover.listPrice], ['Hardcover', false, 46.7, 65]);
  const items = withDelivery([kindle, audio, hardcover]);
  assert.equal(applyFilters(items, {}).map((i) => i.asin).join(), '1408845644');
  assert.equal(applyFilters(items, { showDigital: true }).length, 3);
});

test('a deal badge before the format does not hide that the price is digital', () => {
  const html = '<html><body><div data-asin="B1" data-component-type="s-search-result"><a><h2 aria-label="Some novel"><span>Some novel</span></h2></a><div class="s-price-instructions-style"><div class="a-row"><span>Save 29%</span> <a class="a-text-bold">Kindle Edition</a></div><div class="a-row"><span class="aok-offscreen">Price, product page</span><span class="a-price"><span class="a-offscreen">$3.99</span></span></div></div></div></body></html>';
  const [c] = parseSearchPage(doc(html), html).cards;
  assert.deepEqual([c.format, c.digital, c.price], ['Save 29% Kindle Edition', true, 3.99]);
});

test('delivery messages are classified', () => {
  assert.deepEqual(parseDelivery('FREE delivery Thu, 5 Nov on your first order'), { kind: 'conditional', fee: null, threshold: null });
  assert.deepEqual(parseDelivery('$6.53 delivery 11 - 16 Nov'), { kind: 'fee', fee: 6.53, threshold: null });
  assert.deepEqual(parseDelivery('FREE delivery 29 Oct - 2 Nov'), { kind: 'free', fee: 0, threshold: null });
  assert.deepEqual(parseDelivery('FREE delivery Thu, 5 Nov on $59 of items shipped by Amazon'), { kind: 'conditional', fee: null, threshold: 59 });
  assert.deepEqual(parseDelivery('Delivery Thu, 5 Nov'), { kind: 'unknown', fee: null, threshold: null });
  assert.deepEqual(parseDelivery(null), { kind: 'unknown', fee: null, threshold: null });
});

test('delivered cost: listed fee, free, and standard fee below the free-delivery threshold', () => {
  const s = { fee: 8, threshold: 59 };
  const cost = (it) => deliveryCost(it, s);
  assert.deepEqual(cost({ price: 30, deliveryKind: 'fee', deliveryFee: 6.53 }), { cost: 6.53, note: 'listed' });
  assert.deepEqual(cost({ price: 120, deliveryKind: 'fee', deliveryFee: 15.08 }), { cost: 15.08, note: 'listed' }); // listed fee always applies
  assert.deepEqual(cost({ price: 13.99, deliveryKind: 'free', deliveryFee: 0 }), { cost: 0, note: 'free' });
  assert.deepEqual(cost({ price: 14.43, deliveryKind: 'conditional' }), { cost: 8, note: 'est' });  // first-order promo ignored
  assert.deepEqual(cost({ price: 70, deliveryKind: 'conditional' }), { cost: 0, note: 'over' });
  assert.deepEqual(cost({ price: 40, deliveryKind: 'conditional', deliveryThreshold: 35 }), { cost: 0, note: 'over' }); // message's own threshold wins
  assert.deepEqual(cost({ price: 20, deliveryKind: 'unknown' }), { cost: 8, note: 'est' });
  assert.deepEqual(cost({ price: null, deliveryKind: 'unknown' }), { cost: null, note: 'none' });
  assert.deepEqual(deliveryCost({ price: 20, deliveryKind: 'unknown' }, { fee: 0, threshold: 59 }), { cost: 0, note: 'est' }); // Prime: set the fee to 0
  const [x] = withDelivery([{ price: 14.43, deliveryKind: 'conditional' }], s);
  assert.equal(x.total, 22.43);
  assert.equal(deliveryLabel(x, s), '+$8.00 est.');
  assert.equal(deliveryLabel({ deliveryNote: 'over', deliveryCost: 0 }, s), 'free over $59');
});

test('price range can apply to price plus delivery', () => {
  const items = withDelivery([
    { asin: 'a', price: 14.43, deliveryKind: 'conditional' },   // total 22.43
    { asin: 'b', price: 20, deliveryKind: 'free', deliveryFee: 0 }, // total 20
  ]);
  assert.equal(applyFilters(items, { maxPrice: 21, includeDelivery: true }).map((i) => i.asin).join(), 'b');
  assert.equal(applyFilters(items, { maxPrice: 21, includeDelivery: false }).map((i) => i.asin).join(), 'a,b');
  assert.equal(sortItems(items, 'total').map((i) => i.asin).join(), 'b,a');
  assert.equal(sortItems(items, 'price').map((i) => i.asin).join(), 'a,b');
});
