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
    if (inc.length && !inc.every((w) => t.includes(w))) return false;
    if (exc.length && exc.some((w) => t.includes(w))) return false;
    return true;
  });
}

const nullsLast = (get, dir) => (a, b) => {
  const x = get(a), y = get(b);
  if (x == null && y == null) return 0;
  if (x == null) return 1;
  if (y == null) return -1;
  return dir * (x - y);
};

export const SORTS = {
  'price-asc': nullsLast((i) => i.price, 1),
  'price-desc': nullsLast((i) => i.price, -1),
  'unit-asc': nullsLast((i) => i.unitPrice, 1),
  'rating': nullsLast((i) => bayes(i.rating, i.reviews), -1),
  'reviews': nullsLast((i) => i.reviews, -1),
  'bought': nullsLast((i) => i.bought, -1),
  // rating quality per dollar
  'value': nullsLast((i) => (i.price ? bayes(i.rating, i.reviews) / i.price : null), -1),
};

export const sortItems = (items, key) => [...items].sort(SORTS[key] || SORTS['price-asc']);
