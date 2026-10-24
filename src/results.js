import { collect, newState } from './collector.js';
import { DOMAINS, makeFetchPage, searchUrl } from './amazon.js';
import { applyFilters, SORT_KEYS, sortItems, valueScore } from './filter.js';
import { loadScan, saveScan, scanKey } from './store.js';

const $ = (id) => document.getElementById(id);
const PAGE = 200;

let items = new Map();     // asin -> item
let shown = PAGE;
let run = null;            // { abort, domain, query, state } while scanning
let headline = null;
let sort = { key: 'price', dir: 'asc' };

// ---- form setup ----------------------------------------------------------
for (const d of DOMAINS) $('domain').add(new Option(`amazon.${d}`, d));
const params = new URLSearchParams(location.search);
if (params.get('q')) $('q').value = params.get('q');
if (DOMAINS.includes(params.get('d'))) $('domain').value = params.get('d');
if (params.get('q')) loadSaved();

async function loadSaved() {
  const scan = await loadScan(scanKey($('domain').value, $('q').value)).catch(() => null);
  if (!scan) return;
  items = new Map(scan.items.map((i) => [i.asin, i]));
  headline = scan.state.headline;
  status(scan.state, scan.state.phase === 'done' ? 'Saved scan' : 'Saved scan (unfinished, press Scan to continue)');
  render();
}

// ---- scanning ------------------------------------------------------------
$('scan-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (run) return;
  const domain = $('domain').value, query = $('q').value.trim();
  const key = scanKey(domain, query);
  const saved = await loadScan(key).catch(() => null);
  let state;
  if (saved && saved.state.phase !== 'done') {
    state = saved.state;
    items = new Map(saved.items.map((i) => [i.asin, i]));
  } else {
    state = newState();
    items = new Map();
  }
  const abort = new AbortController();
  run = { abort, domain, query, state, startReq: state.requests };
  $('start').disabled = true; $('stop').disabled = false; $('progress').hidden = false;
  const budget = state.requests + Number($('budget').value);
  const fetchPage = makeFetchPage(domain, query);
  const persist = () => saveScan({ key, domain, query, state, items: [...items.values()] }).catch(console.error);

  const result = await collect({
    fetchPage, state, budget, delayMs: Number($('delay').value), signal: abort.signal,
    onItems: (cards) => { for (const c of cards) if (!items.has(c.asin)) items.set(c.asin, c); },
    onProgress: (s, info) => {
      headline = s.headline;
      status(s, info?.blocked ? 'Blocked by Amazon' : 'Scanning');
      if (s.requests % 5 === 0) render();
      if (s.requests % 15 === 0) persist();
    },
    onBlocked: ({ params: p }) => waitForCaptcha(domain, query, p, abort.signal),
  });
  await persist();
  clearBanner();
  run = null;
  $('start').disabled = false; $('stop').disabled = true; $('progress').hidden = true;
  const why = { done: 'Finished', budget: 'Stopped: request budget reached (press Scan to continue)', aborted: 'Stopped' }[result.reason];
  status(result.state, why);
  render();
});

$('stop').addEventListener('click', () => run?.abort.abort());

// ---- CAPTCHA: ask the user to solve it, then carry on ----------------------
async function waitForCaptcha(domain, query, p, signal) {
  const url = searchUrl(domain, query, p);
  const probe = makeFetchPage(domain, query);
  const banner = $('banner');
  banner.hidden = false;
  banner.innerHTML = '';
  const msg = document.createElement('span');
  msg.textContent = 'Amazon is asking for a CAPTCHA. Solve it in the tab that just opened; the scan carries on by itself afterwards. ';
  const open = document.createElement('a');
  open.href = url; open.target = '_blank'; open.textContent = 'Open the CAPTCHA tab again';
  const resume = document.createElement('button');
  resume.textContent = 'Resume now';
  banner.append(msg, open, ' ', resume);

  let tab = null;
  try { tab = await browser.tabs.create({ url, active: true }); } catch { /* user can use the link */ }
  browser.notifications?.create({
    type: 'basic', title: 'Amazon Power Search',
    message: 'Amazon wants a CAPTCHA. Solve it to continue the scan.',
  }).catch?.(() => {});

  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; clearInterval(timer); resolve(); } };
    resume.onclick = finish;
    signal.addEventListener('abort', finish, { once: true });
    const timer = setInterval(async () => {
      try { if (!(await probe(p)).blocked) finish(); } catch { /* still offline or blocked */ }
    }, 6000);
  });
  if (tab) browser.tabs.remove(tab.id).catch(() => {});
  clearBanner();
}

function clearBanner() { $('banner').hidden = true; $('banner').textContent = ''; }

// ---- status ---------------------------------------------------------------
function status(s, label) {
  const h = s.headline;
  const claimed = h?.total != null ? `${h.over ? 'over ' : ''}${h.total.toLocaleString()}` : 'unknown';
  const exact = h && !h.over ? ' (exact count)' : ' (rounded by Amazon)';
  const more = h?.total != null && items.size > h.total ? ' Amazon\'s own count is a little lower because sorted and price-filtered views include looser matches.' : '';
  const dense = s.denseBands.length ? `, ${s.denseBands.length} crowded price bands only sampled` : '';
  $('status').textContent =
    `${label}. Collected ${items.size.toLocaleString()} of ${claimed}${h ? exact : ''}. ` +
    `Requests ${s.requests}${s.blocks ? `, CAPTCHAs ${s.blocks}` : ''}, phase ${s.phase}, bands left ${s.queue.length}${dense}.${more}`;
  const p = $('progress');
  p.max = Math.max(1, Number($('budget').value));
  p.value = Math.min(p.max, s.requests - (run?.startReq ?? s.requests));
}

// ---- table ---------------------------------------------------------------
const currentFilters = () => ({
  include: $('f-include').value, exclude: $('f-exclude').value,
  minPrice: $('f-min').value === '' ? null : Number($('f-min').value),
  maxPrice: $('f-max').value === '' ? null : Number($('f-max').value),
  minRating: $('f-rating').value === '' ? null : Number($('f-rating').value),
  minReviews: $('f-reviews').value === '' ? null : Number($('f-reviews').value),
  hideSponsored: $('f-sponsored').checked, hideNoPrice: $('f-noprice').checked, primeOnly: $('f-prime').checked,
});

const view = () => sortItems(applyFilters([...items.values()], currentFilters()), sort.key, sort.dir);
const fmt = (n) => (n == null ? '' : n.toLocaleString());
const money = (n) => (n == null ? '' : n.toFixed(2));

function cell(tr, text, cls) {
  const td = tr.insertCell(); td.textContent = text; if (cls) td.className = cls; return td;
}

function render() {
  const rows = view();
  $('count').textContent = `${rows.length.toLocaleString()} shown of ${items.size.toLocaleString()} collected`;
  const body = $('results').tBodies[0];
  body.textContent = '';
  const domain = $('domain').value;
  for (const it of rows.slice(0, shown)) {
    const tr = body.insertRow();
    const img = document.createElement('img'); img.loading = 'lazy'; if (it.image) img.src = it.image;
    tr.insertCell().append(img);
    const td = tr.insertCell();
    const a = document.createElement('a');
    a.href = `https://www.amazon.${domain}/dp/${it.asin}`; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = it.title || it.asin;
    td.append(a);
    if (it.sponsored) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = 'sponsored'; td.append(t); }
    if (it.prime) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = 'prime'; td.append(t); }
    cell(tr, money(it.price), 'num');
    cell(tr, it.unitPrice != null ? `${it.unitPrice}/${it.unit}` : '', 'num');
    cell(tr, it.rating ?? '', 'num');
    cell(tr, fmt(it.reviews), 'num');
    cell(tr, fmt(it.bought), 'num');
    const v = valueScore(it);
    cell(tr, v == null ? '' : v.toFixed(2), 'num');
  }
  $('more').hidden = rows.length <= shown;
}

function markSort() {
  for (const th of document.querySelectorAll('th[data-sort]')) {
    if (th.dataset.sort === sort.key) th.setAttribute('aria-sort', sort.dir === 'asc' ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
  }
}
for (const th of document.querySelectorAll('th[data-sort]')) {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    sort = key === sort.key
      ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: SORT_KEYS[key].dir };
    shown = PAGE;
    markSort();
    render();
  });
}
markSort();

$('more').addEventListener('click', () => { shown += PAGE; render(); });
for (const id of ['f-include', 'f-exclude', 'f-min', 'f-max', 'f-rating', 'f-reviews', 'f-sponsored', 'f-noprice', 'f-prime']) {
  $(id).addEventListener('input', () => { shown = PAGE; render(); });
}

$('csv').addEventListener('click', () => {
  const cols = ['asin', 'title', 'price', 'unitPrice', 'unit', 'rating', 'reviews', 'bought', 'prime', 'sponsored'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...view().map((i) => cols.map((c) => esc(i[c])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'amazon-power-search.csv';
  a.click();
});
