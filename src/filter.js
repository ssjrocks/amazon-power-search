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

// Each sort is a value getter plus the direction a first click should use.
export const SORT_KEYS = {
  title: { get: (i) => (i.title || '').toLowerCase(), dir: 'asc' },
  price: { get: (i) => i.price, dir: 'asc' },
  unit: { get: (i) => i.unitPrice, dir: 'asc' },
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
