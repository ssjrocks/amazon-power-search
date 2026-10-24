# Amazon Power Search

Firefox extension that collects every result an Amazon search will give you, then lets you sort and
filter them yourself.

## Why

Amazon says "over 40,000 results" but only pages through about 7 pages x 48 products, and sorting or
price filters change which products you see. Measured on amazon.com.au (2026-10-24):

- A plain search reaches about 336 products. Slicing the same search by price band reaches far more
  (736-result query: 743 recovered in 27 requests; "usb c cable", 70,000+: 6,631 in 220 requests).
- Totals are exact only below about 1,000 results. Above that Amazon shows rounded "over N" figures.
- Products with no price never match a price filter, so they are only reachable from unfiltered passes.
- Very crowded one-dollar price bands (e.g. $9-$15 for USB-C cables) can't be split further by price.

## How it works

- `src/collector.js` splits the price range into bands that fit under Amazon's cap, fetching one page at
  a time (default 2.2 s apart) from your own browser, with your own cookies and IP.
- If Amazon serves a CAPTCHA the scan pauses, opens the CAPTCHA tab and a notification, polls until you
  have solved it, then carries on from the same request.
- Results are saved locally in IndexedDB; an unfinished scan resumes where it stopped.
- `src/filter.js` filters (words, price, rating, reviews, Prime, sponsored) and sorts (price, unit price,
  rating adjusted for review count, rating per dollar, reviews, bought last month).

Nothing leaves your browser. The extension talks only to the Amazon sites it has permission for.

## Develop

```bash
npm install
npm test                 # parser, filters and collector against a simulated Amazon
npm run lint             # web-ext lint
```

Load it in Firefox: `about:debugging` -> This Firefox -> Load Temporary Add-on -> `manifest.json`.
Open an Amazon search page and press the "Power search" button, or click the toolbar icon.

Parser fixtures in `test/` are synthetic, modelled on markup seen on 2026-10-24. If Amazon changes its
markup, `src/parser.js` is the only file that should need changes.

## Status

Scaffold. Not yet done: splitting crowded bands by other facets (brand, rating, Prime), signed release
builds and the GitHub-release update manifest (`update_url` is already set in `manifest.json`).

Amazon's conditions of use restrict automated access. This tool is for personal use at a low request
rate; use it at your own risk.
