// Gathers as many results of one Amazon search as the site will give, by
// splitting the price range into bands that each fit inside Amazon's
// ~7 pages x 48 results cap. Network access is injected (`fetchPage`) so the
// logic can be tested offline.

export const PER_PAGE = 48;
export const MAX_PAGES = 7;
export const CAP = PER_PAGE * MAX_PAGES;

class Stop extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

export const newState = () => ({
  phase: 'init',      // init -> bands -> sorts -> done
  requests: 0,
  blocks: 0,
  headline: null,     // { total, over } from the unfiltered search
  maxPrice: null,
  queue: [],          // price bands still to do: [lo, hi]
  bandsDone: 0,
  denseBands: [],     // bands Amazon says hold more than we can page to
  sorts: null,        // extra whole-search sorts still to do
});

/**
 * fetchPage({ lo, hi, page, sort }) -> { blocked, total, over, cards }
 * onItems(cards, meta)   called with every page's cards (caller dedupes)
 * onBlocked(info)        resolves when the user has cleared the CAPTCHA
 * Returns { reason: 'done' | 'budget' | 'aborted', state }.
 */
export async function collect({
  fetchPage, state = newState(), budget = 200, delayMs = 2200, jitterMs = 700,
  onItems = () => {}, onProgress = () => {}, onBlocked, signal,
  extraSorts = ['review-rank'], sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  async function req(params) {
    for (;;) {
      if (signal?.aborted) throw new Stop('aborted');
      if (state.requests >= budget) throw new Stop('budget');
      const r = await fetchPage(params);
      state.requests++;
      if (r.blocked) {
        state.blocks++;
        if (!onBlocked) throw new Stop('blocked');
        onProgress(state, { blocked: true });
        await onBlocked({ params });
        continue; // same request again, not counted twice against the budget
      }
      onItems(r.cards, params);
      onProgress(state, { params });
      await sleep(delayMs + Math.random() * jitterMs);
      return r;
    }
  }

  const fits = (r) => !r.over && (r.total == null || r.total <= CAP);
  const pagesFor = (r) => Math.min(MAX_PAGES, Math.max(1, Math.ceil((r.total ?? r.cards.length) / PER_PAGE)));

  async function restPages(params, first) {
    for (let p = 2; p <= pagesFor(first); p++) await req({ ...params, page: p });
  }

  async function allPages(params) {
    const f = await req({ ...params, page: 1 });
    if (f.cards.length) await restPages(params, f);
  }

  async function band(lo, hi) {
    const f = await req({ lo, hi, page: 1 });
    if (f.cards.length === 0) return;
    if (fits(f)) return restPages({ lo, hi }, f);
    if (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      state.queue.push([lo, mid], [mid, hi]);
      return;
    }
    // One dollar wide and still over the cap: price can't separate these.
    state.denseBands.push([lo, hi, f.total]);
    for (const sort of ['price-asc-rank', 'price-desc-rank']) await allPages({ lo, hi, sort });
  }

  try {
    if (state.phase === 'init') {
      const f = await req({ page: 1 });
      state.headline = { total: f.total, over: f.over };
      if (fits(f)) {
        await restPages({}, f);
        state.phase = 'done';
      } else {
        const d = await req({ page: 1, sort: 'price-desc-rank' });
        const top = Math.max(0, ...d.cards.filter((c) => !c.sponsored).map((c) => c.price || 0));
        state.maxPrice = Math.ceil(top);
        state.queue = [[0, state.maxPrice + 1]];
        state.sorts = [...extraSorts];
        state.phase = 'bands';
      }
    }
    if (state.phase === 'bands') {
      while (state.queue.length) {
        const [lo, hi] = state.queue[0];
        await band(lo, hi);
        state.queue.shift();
        state.bandsDone++;
      }
      state.phase = 'sorts';
    }
    if (state.phase === 'sorts') {
      // Products without a price never match a price filter, so sweep the
      // unfiltered search under other sorts too.
      while (state.sorts?.length) {
        await allPages({ sort: state.sorts[0] });
        state.sorts.shift();
      }
      state.phase = 'done';
    }
    return { reason: 'done', state };
  } catch (e) {
    if (e instanceof Stop) return { reason: e.reason, state };
    throw e;
  }
}
