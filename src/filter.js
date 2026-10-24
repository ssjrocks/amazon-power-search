// Client-side filtering and sorting of collected items. Pure functions.

// Rating pulled toward the site average by a prior of 50 reviews, so 5.0 from
// 3 reviews doesn't beat 4.6 from 3000.
export const bayes = (rating, reviews, prior = 50, mean = 4.0) =>
  rating == null ? null : (rating * (reviews || 0) + mean * prior) / ((reviews || 0) + prior);

const words = (s) => (s || '').toLowerCase().split(/[\s,]+/).filter(Boolean);

export function applyFilters(items, f = {}) {
  const inc = words(f.include), exc = words(f.exclude);
  return items.filter((it) => {
    const t = (it.title || '').toLowerCase();
    if (f.hideSponsored && it.sponsored) return false;
    if (f.hideNoPrice && it.price == null) return false;
    if (f.minPrice != null && (it.price == null || it.price < f.minPrice)) return false;
    if (f.maxPrice != null && (it.price == null || it.price > f.maxPrice)) return false;
    if (f.minRating != null && (it.rating == null || it.rating < f.minRating)) return false;
    if (f.minReviews != null && (it.reviews || 0) < f.minReviews) return false;
    if (f.primeOnly && !it.prime) return false;
    if (f.freeDelivery && it.deliveryFee !== 0) return false;
    if (inc.length && !inc.every((w) => t.includes(w))) return false;
    if (exc.length && exc.some((w) => t.includes(w))) return false;
    return true;
  });
}

// Each sort is a value getter plus the direction a first click should use.
// "$3.65 / 100 g" and "$30 / kg" are the same price; put weights on a per-100 g
// basis and volumes on a per-100 ml basis so they compare. Other units
// ("count", "metre") stay as they are, grouped by unit name.
const UNIT_FAMILY = ['weight', 'volume'];
export function normaliseUnit(unitPrice, unit) {
  if (unitPrice == null || !unit) return null;
  const m = unit.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)?\s*(kg|g|l|ml|litres?|liters?)\b/);
  if (!m) return { family: unit.trim().toLowerCase().replace(/^\d+(?:\.\d+)?\s*/, ''), price: unitPrice / (parseFloat(unit) || 1) };
  const qty = parseFloat(m[1] ?? '1');
  const base = { kg: 1000, g: 1, l: 1000, litre: 1000, litres: 1000, liter: 1000, liters: 1000, ml: 1 }[m[2]];
  const family = ['kg', 'g'].includes(m[2]) ? 'weight' : 'volume';
  return { family, price: (unitPrice / (qty * base)) * 100 };
}

// One number per item so unit prices sort: families are kept apart, weight and
// volume first, then other units alphabetically.
const familyRank = (f) => (UNIT_FAMILY.includes(f) ? UNIT_FAMILY.indexOf(f) : 2 + [...f].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 9973, 0));
const unitSortValue = (i) => {
  const n = normaliseUnit(i.unitPrice, i.unit);
  return n ? familyRank(n.family) * 1e6 + n.price : null;
};

export const SORT_KEYS = {
  title: { get: (i) => (i.title || '').toLowerCase(), dir: 'asc' },
  brand: { get: (i) => (i.brand || '').toLowerCase() || null, dir: 'asc' },
  price: { get: (i) => i.price, dir: 'asc' },
  unit: { get: unitSortValue, dir: 'asc' },
  delivery: { get: (i) => i.deliveryFee, dir: 'asc' },
  rating: { get: (i) => bayes(i.rating, i.reviews), dir: 'desc' },
  reviews: { get: (i) => i.reviews, dir: 'desc' },
  bought: { get: (i) => i.bought, dir: 'desc' },
  // rating quality per dollar
  value: { get: (i) => (i.price ? bayes(i.rating, i.reviews) / i.price : null), dir: 'desc' },
};

export const valueScore = (i) => SORT_KEYS.value.get(i);

export function sortItems(items, key = 'price', dir) {
  const { get, dir: first } = SORT_KEYS[key] || SORT_KEYS.price;
  const sign = (dir || first) === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const x = get(a), y = get(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1; // missing values always last
    if (y == null) return -1;
    return x < y ? -sign : x > y ? sign : 0;
  });
}
