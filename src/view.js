// Pure helpers for the results views (list / grid) and their image-size sliders.

export const VIEWS = {
  list: { min: 32, max: 160, step: 4, def: 48 },   // thumbnail edge, px
  grid: { min: 120, max: 360, step: 10, def: 200 }, // card width = image width, px
};

export const clampSize = (view, v) => {
  const { min, max, def } = VIEWS[view];
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};

// Amazon image URLs carry a size token ("._AC_UL320_."). Ask for the smallest
// size that is still sharp at the displayed size; leave other URL shapes alone.
const SIZES = [160, 320, 480, 640];
export function imgUrl(src, px, dpr = 1) {
  if (!src || !/\._AC_UL\d+_\./.test(src)) return src;
  const want = px * dpr;
  const n = SIZES.find((s) => s >= want) ?? SIZES.at(-1);
  return src.replace(/\._AC_UL\d+_\./, `._AC_UL${n}_.`);
}

export const DEFAULT_UI = {
  view: 'list',
  sizes: { list: VIEWS.list.def, grid: VIEWS.grid.def },
  sort: { key: 'total', dir: 'asc' },
  delivery: { fee: 8, threshold: 59 },   // what to charge when Amazon doesn't list a fee
  includeDelivery: true,                 // price range filter applies to price + delivery
};

const money = (v, def) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : def);

// Per-viewer convenience only: any storage failure just means defaults.
export function loadUi(storage) {
  try {
    const raw = JSON.parse(storage.getItem('aps-ui') || 'null');
    if (!raw) return structuredClone(DEFAULT_UI);
    const view = raw.view === 'grid' ? 'grid' : 'list';
    return {
      view,
      sizes: { list: clampSize('list', raw.sizes?.list), grid: clampSize('grid', raw.sizes?.grid) },
      sort: { key: typeof raw.sort?.key === 'string' ? raw.sort.key : 'total', dir: raw.sort?.dir === 'desc' ? 'desc' : 'asc' },
      delivery: { fee: money(raw.delivery?.fee, DEFAULT_UI.delivery.fee), threshold: money(raw.delivery?.threshold, DEFAULT_UI.delivery.threshold) },
      includeDelivery: raw.includeDelivery !== false,
    };
  } catch {
    return structuredClone(DEFAULT_UI);
  }
}

export function saveUi(storage, ui) {
  try { storage.setItem('aps-ui', JSON.stringify(ui)); } catch { /* ignore */ }
}
