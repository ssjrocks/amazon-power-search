import { collect, newState } from './collector.js';
import { DOMAINS, makeFetchPage, searchUrl } from './amazon.js';
import { applyFilters, SORT_KEYS, sortItems, valueScore } from './filter.js';
import { VIEWS, clampSize, imgUrl, loadUi, saveUi } from './view.js';
import { deliveryLabel, withDelivery } from './delivery.js';
import { loadScan, saveScan, scanKey } from './store.js';

const $ = (id) => document.getElementById(id);
const PAGE = 200;
const GRID_PAGE = 120;

let items = new Map();     // asin -> item
let shown = PAGE;
let run = null;            // { abort, domain, query, state } while scanning
let headline = null;
let ui = loadUi(localStorage);   // { view, sizes: { list, grid }, sort }

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

// ---- filters, sort, view ---------------------------------------------------
const currentFilters = () => ({
  include: $('f-include').value, exclude: $('f-exclude').value,
  minPrice: $('f-min').value === '' ? null : Number($('f-min').value),
  maxPrice: $('f-max').value === '' ? null : Number($('f-max').value),
  minRating: $('f-rating').value === '' ? null : Number($('f-rating').value),
  minReviews: $('f-reviews').value === '' ? null : Number($('f-reviews').value),
  hideSponsored: $('f-sponsored').checked, hideNoPrice: $('f-noprice').checked,
  primeOnly: $('f-prime').checked, freeDelivery: $('f-free').checked,
  showDigital: $('f-digital').checked, includeDelivery: ui.includeDelivery,
});

const view = () => sortItems(applyFilters(withDelivery([...items.values()], ui.delivery), currentFilters()), ui.sort.key, ui.sort.dir);
const fmt = (n) => (n == null ? '' : n.toLocaleString());
const money = (n) => (n == null ? '' : n.toFixed(2));
const unitText = (it) => (it.unitPrice != null ? `${money(it.unitPrice)}/${it.unit ?? ''}` : '');
const save = () => saveUi(localStorage, ui);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const tag = (text, cls = '') => el('span', `tag ${cls}`.trim(), text);
const link = (it, cls, child) => {
  const a = el('a', cls);
  a.href = `https://www.amazon.${$('domain').value}/dp/${it.asin}`; a.target = '_blank'; a.rel = 'noopener';
  if (typeof child === 'string') a.textContent = child; else if (child) a.append(child);
  return a;
};
function image(it, px) {
  const img = el('img');
  img.loading = 'lazy'; img.alt = '';
  if (it.image) img.src = imgUrl(it.image, px, window.devicePixelRatio || 1);
  return img;
}
function itemTags(it) {
  const tags = [];
  if (it.badge) tags.push(tag(it.badge, 'good'));
  if (it.sponsored) tags.push(tag('sponsored'));
  if (it.prime) tags.push(tag('prime', 'good'));
  if (it.lowStock) tags.push(tag(`only ${it.lowStock} left`, 'warn'));
  return tags;
}

function renderList(rows) {
  const body = $('results').tBodies[0];
  body.textContent = '';
  const px = ui.sizes.list;
  for (const it of rows.slice(0, shown)) {
    const tr = body.insertRow();
    const img = tr.insertCell(); img.className = 'img'; img.append(link(it, '', image(it, px)));
    const t = tr.insertCell(); t.className = 'title';
    t.append(link(it, 'clamp2', it.title || it.asin));
    const tags = itemTags(it);
    if (tags.length) { const row = el('div'); row.append(...tags); t.append(row); }
    const cell = (text, cls) => { const td = tr.insertCell(); td.textContent = text; if (cls) td.className = cls; return td; };
    cell(it.brand ?? '', 'muted');
    const pc = cell(money(it.price), 'num');
    if (it.listPrice && it.listPrice > (it.price ?? 0)) pc.append(el('span', 'was', money(it.listPrice)));
    const tc = cell(money(it.total), 'num total');
    if (it.deliveryNote === 'est') tc.title = `${money(it.price)} + ${money(it.deliveryCost)} estimated delivery`;
    cell(unitText(it), 'num');
    cell(it.rating ?? '', 'num');
    cell(fmt(it.reviews), 'num');
    cell(fmt(it.bought), 'num');
    const d = cell('', 'deliv');
    const label = deliveryLabel(it, ui.delivery);
    if (label) {
      const free = it.deliveryCost === 0;
      d.append(el('div', `fee${free ? ' free' : ''}${it.deliveryNote === 'est' ? ' est' : ''}`, label));
    }
    if (it.delivery) d.append(el('div', 'orig clamp2', it.delivery));
    const v = valueScore(it);
    cell(v == null ? '' : v.toFixed(2), 'num');
  }
}

function renderGrid(rows) {
  const grid = $('grid');
  grid.textContent = '';
  const px = ui.sizes.grid;
  for (const it of rows.slice(0, shown)) {
    const card = el('article', 'card');
    card.append(link(it, 'thumb', image(it, px)));
    const tags = el('div', 'tags'); tags.append(...itemTags(it)); card.append(tags);
    card.append(link(it, 'title clamp3', it.title || it.asin));
    if (it.brand) card.append(el('div', 'brand', it.brand));
    const price = el('div');
    price.append(el('span', 'price', it.price != null ? money(it.price) : 'no price'));
    if (it.listPrice && it.listPrice > (it.price ?? 0)) price.append(el('span', 'was', money(it.listPrice)));
    if (it.unitPrice != null) price.append(el('span', 'muted', `  ${unitText(it)}`));
    card.append(price);
    if (it.total != null) {
      const label = deliveryLabel(it, ui.delivery);
      card.append(el('div', 'total', `${money(it.total)} delivered${label && it.deliveryCost ? ` (${label.replace('+', '')} delivery)` : ''}${it.deliveryCost === 0 ? ' (free delivery)' : ''}`));
    }
    const rate = [it.rating != null ? `${it.rating} ★` : null, it.reviews != null ? `(${fmt(it.reviews)})` : null,
      it.bought != null ? `${fmt(it.bought)}+ bought` : null].filter(Boolean).join(' ');
    if (rate) card.append(el('div', 'rate', rate));
    if (it.delivery) card.append(el('div', 'deliv clamp2', it.delivery));
    grid.append(card);
  }
}

function render() {
  const rows = view();
  $('count').textContent = `${rows.length.toLocaleString()} shown of ${items.size.toLocaleString()} collected`;
  const isGrid = ui.view === 'grid';
  $('grid').hidden = !isGrid;
  $('results').hidden = isGrid;
  if (isGrid) renderGrid(rows); else renderList(rows);
  $('more').hidden = rows.length <= shown;
}

// image-size slider: one remembered size per view
function applySize() {
  const v = VIEWS[ui.view], size = ui.sizes[ui.view];
  const slider = $('size');
  slider.min = v.min; slider.max = v.max; slider.step = v.step; slider.value = size;
  $('size-out').textContent = `${size}px`;
  document.documentElement.style.setProperty('--list-img', `${ui.sizes.list}px`);
  document.documentElement.style.setProperty('--card-w', `${ui.sizes.grid}px`);
}

function applyView() {
  for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-pressed', String(b.dataset.view === ui.view));
  shown = ui.view === 'grid' ? GRID_PAGE : PAGE;
  applySize();
}

function markSort() {
  for (const th of document.querySelectorAll('th[data-sort]')) {
    if (th.dataset.sort === ui.sort.key) th.setAttribute('aria-sort', ui.sort.dir === 'asc' ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
  }
  $('sort').value = SORT_KEYS[ui.sort.key] ? ui.sort.key : 'price';
  $('dir').textContent = ui.sort.dir === 'asc' ? '▲ Low to high' : '▼ High to low';
}

function setSort(key, dir) {
  ui.sort = { key, dir: dir ?? (key === ui.sort.key ? (ui.sort.dir === 'asc' ? 'desc' : 'asc') : SORT_KEYS[key].dir) };
  shown = ui.view === 'grid' ? GRID_PAGE : PAGE;
  save(); markSort(); render();
}

for (const th of document.querySelectorAll('th[data-sort]')) th.addEventListener('click', () => setSort(th.dataset.sort));
$('sort').addEventListener('change', () => setSort($('sort').value, SORT_KEYS[$('sort').value].dir));
$('dir').addEventListener('click', () => setSort(ui.sort.key, ui.sort.dir === 'asc' ? 'desc' : 'asc'));

for (const b of document.querySelectorAll('.seg button')) {
  b.addEventListener('click', () => { ui.view = b.dataset.view; save(); applyView(); render(); });
}
$('size').addEventListener('input', () => {
  ui.sizes[ui.view] = clampSize(ui.view, $('size').value);
  $('size-out').textContent = `${ui.sizes[ui.view]}px`;
  document.documentElement.style.setProperty('--list-img', `${ui.sizes.list}px`);
  document.documentElement.style.setProperty('--card-w', `${ui.sizes.grid}px`);
});
// re-render on release so the sharper image size is requested
$('size').addEventListener('change', () => { save(); render(); });

function applyDelivery() {
  $('d-fee').value = ui.delivery.fee;
  $('d-threshold').value = ui.delivery.threshold;
  $('d-include').checked = ui.includeDelivery;
}
for (const id of ['d-fee', 'd-threshold']) {
  $(id).addEventListener('input', () => {
    ui.delivery = { fee: Number($('d-fee').value) || 0, threshold: Number($('d-threshold').value) || 0 };
    save(); render();
  });
}
$('d-include').addEventListener('change', () => { ui.includeDelivery = $('d-include').checked; save(); render(); });

$('more').addEventListener('click', () => { shown += ui.view === 'grid' ? GRID_PAGE : PAGE; render(); });
for (const id of ['f-include', 'f-exclude', 'f-min', 'f-max', 'f-rating', 'f-reviews', 'f-sponsored', 'f-noprice', 'f-prime', 'f-free', 'f-digital']) {
  $(id).addEventListener('input', () => { shown = ui.view === 'grid' ? GRID_PAGE : PAGE; render(); });
}

$('csv').addEventListener('click', () => {
  const cols = ['asin', 'title', 'brand', 'price', 'listPrice', 'unitPrice', 'unit', 'rating', 'reviews', 'bought',
    'delivery', 'deliveryCost', 'deliveryNote', 'total', 'format', 'badge', 'prime', 'sponsored', 'digital'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...view().map((i) => cols.map((c) => esc(i[c])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'amazon-power-search.csv';
  a.click();
});

applyView();
applyDelivery();
markSort();
