import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, newState, CAP, PER_PAGE } from '../src/collector.js';

// A model of the Amazon behaviour measured on amazon.com.au (2026-10-24):
// 48 results per page, 7 pages max, exact totals below 1000, "over N" rounded
// down to a coarse step above, price filters and sorts applied to the full set.
function fakeAmazon(products, { blockEvery = 0, leak = 0 } = {}) {
  let calls = 0;
  const fetchPage = async ({ lo, hi, page = 1, sort } = {}) => {
    calls++;
    if (blockEvery && calls % blockEvery === 0) return { blocked: true, total: null, over: false, cards: [] };
    let set = products.filter((p) => lo == null || (p.price != null && p.price >= lo - leak && p.price <= hi + leak));
    if (sort === 'price-asc-rank') set = [...set].sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9));
    else if (sort === 'price-desc-rank') set = [...set].sort((a, b) => (b.price ?? -1) - (a.price ?? -1));
    else if (sort === 'review-rank') set = [...set].sort((a, b) => b.reviews - a.reviews);
    const total = set.length;
    const over = total >= 1000;
    const shownTotal = over ? Math.floor(total / 1000) * 1000 : total;
    const start = (page - 1) * PER_PAGE;
    const cards = page > 7 ? [] : set.slice(start, start + PER_PAGE);
    return { blocked: false, total: total ? shownTotal : null, over, cards };
  };
  return { fetchPage, get calls() { return calls; } };
}

const make = (n, priceOf) => Array.from({ length: n }, (_, i) => ({
  asin: `A${i}`, price: priceOf(i), reviews: (i * 7919) % 1000, sponsored: false,
}));
const run = (opts) => {
  const found = new Map();
  return collect({
    sleep: async () => {}, onItems: (cs) => cs.forEach((c) => found.set(c.asin, c)), ...opts,
  }).then((r) => ({ ...r, found }));
};

test('a search that fits under the cap is read directly', async () => {
  const am = fakeAmazon(make(200, (i) => 1 + i));
  const r = await run({ fetchPage: am.fetchPage });
  assert.equal(r.reason, 'done');
  assert.equal(r.found.size, 200);
  assert.equal(r.state.phase, 'done');
  assert.equal(am.calls, 5);
});

test('a search over the cap is recovered in full by price bands', async () => {
  const products = make(736, (i) => 1 + ((i * 37) % 580));
  const am = fakeAmazon(products);
  const r = await run({ fetchPage: am.fetchPage, extraSorts: [] });
  assert.equal(r.reason, 'done');
  assert.equal(r.found.size, 736);
});

test('unpriced products only come from unfiltered passes; extra sorts add more of them', async () => {
  // Price filters never match unpriced products, and each unfiltered sort
  // reaches at most CAP of them, so this is best-effort, not complete.
  const products = make(600, (i) => (i % 10 === 0 ? null : 1 + (i % 400)));
  const unpriced = (r) => [...r.found.values()].filter((p) => p.price == null).length;
  const without = await run({ fetchPage: fakeAmazon(products).fetchPage, extraSorts: [] });
  const withSort = await run({ fetchPage: fakeAmazon(products).fetchPage, extraSorts: ['review-rank'] });
  assert.ok(unpriced(withSort) > unpriced(without));
  assert.ok(withSort.found.size > without.found.size);
});

test('price filter leakage is deduplicated', async () => {
  const am = fakeAmazon(make(700, (i) => 1 + (i % 300)), { leak: 1 });
  const r = await run({ fetchPage: am.fetchPage, extraSorts: [] });
  assert.equal(r.found.size, 700);
});

test('a crowded one-dollar band falls back to sorts and is reported as dense', async () => {
  // 3000 products all at $9.99: price can't separate them.
  const products = make(3000, () => 9.99);
  const am = fakeAmazon(products);
  const r = await run({ fetchPage: am.fetchPage, extraSorts: [], budget: 500 });
  assert.equal(r.reason, 'done');
  assert.ok(r.state.denseBands.length >= 1);
  assert.ok(r.found.size >= CAP, `got ${r.found.size}`);
  assert.ok(r.found.size < 3000);
});

test('stops at the request budget and resumes from saved state', async () => {
  const products = make(900, (i) => 1 + ((i * 13) % 500));
  const am = fakeAmazon(products);
  const found = new Map();
  const base = { fetchPage: am.fetchPage, sleep: async () => {}, extraSorts: [], onItems: (cs) => cs.forEach((c) => found.set(c.asin, c)) };
  const state = newState();
  const a = await collect({ ...base, state, budget: 12 });
  assert.equal(a.reason, 'budget');
  assert.ok(found.size < 900);
  const restored = JSON.parse(JSON.stringify(state)); // survives storage
  const b = await collect({ ...base, state: restored, budget: 500 });
  assert.equal(b.reason, 'done');
  assert.equal(found.size, 900);
});

test('a CAPTCHA pauses the scan, then the same request is retried', async () => {
  const am = fakeAmazon(make(500, (i) => 1 + (i % 300)), { blockEvery: 4 });
  let blocks = 0;
  const r = await run({
    fetchPage: am.fetchPage, extraSorts: [],
    onBlocked: async () => { blocks++; },
  });
  assert.equal(r.reason, 'done');
  assert.ok(blocks > 0);
  assert.equal(r.state.blocks, blocks);
  assert.equal(r.found.size, 500);
});

test('without a CAPTCHA handler a block stops the scan cleanly', async () => {
  const am = fakeAmazon(make(500, (i) => 1 + i), { blockEvery: 3 });
  const r = await run({ fetchPage: am.fetchPage });
  assert.equal(r.reason, 'blocked');
});

test('abort signal stops the scan', async () => {
  const ac = new AbortController();
  const am = fakeAmazon(make(900, (i) => 1 + (i % 500)));
  const r = await run({ fetchPage: am.fetchPage, signal: ac.signal, onProgress: (s) => { if (s.requests === 3) ac.abort(); } });
  assert.equal(r.reason, 'aborted');
});
