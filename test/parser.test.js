import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parseSearchPage, parseTotal } from '../src/parser.js';
import { applyFilters, sortItems, bayes } from '../src/filter.js';

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
  ${list ? `<span class="a-price a-text-price"><span class="a-offscreen">$${list}</span></span>` : ''}
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
