import { parseSearchPage } from './parser.js';

export const DOMAINS = ['com.au', 'com', 'co.uk', 'de', 'ca'];

export function searchUrl(domain, query, { lo, hi, page = 1, sort } = {}) {
  const u = new URL(`https://www.amazon.${domain}/s`);
  u.searchParams.set('k', query);
  if (page > 1) u.searchParams.set('page', page);
  if (lo != null) u.searchParams.set('low-price', lo);
  if (hi != null) u.searchParams.set('high-price', hi);
  if (sort) u.searchParams.set('s', sort);
  return u.toString();
}

// Real fetchPage for the collector. Runs in the extension page, so the
// request carries the user's own Amazon cookies and IP.
export function makeFetchPage(domain, query) {
  return async function fetchPage(params) {
    const res = await fetch(searchUrl(domain, query, params), { credentials: 'include' });
    const html = await res.text();
    if (res.status >= 500 && res.status < 600) return { blocked: true, total: null, over: false, cards: [] };
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return parseSearchPage(doc, html);
  };
}
