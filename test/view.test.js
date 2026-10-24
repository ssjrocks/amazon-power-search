import test from 'node:test';
import assert from 'node:assert/strict';
import { VIEWS, clampSize, imgUrl, loadUi, saveUi, DEFAULT_UI } from '../src/view.js';

test('slider sizes are clamped per view, bad values fall back to the default', () => {
  assert.equal(clampSize('list', 10), VIEWS.list.min);
  assert.equal(clampSize('list', 999), VIEWS.list.max);
  assert.equal(clampSize('grid', 'abc'), VIEWS.grid.def);
  assert.equal(clampSize('grid', 205.4), 205);
});

test('image size token follows the displayed size and pixel ratio', () => {
  const src = 'https://m.media-amazon.com/images/I/61zmSPwPqhL._AC_UL320_.jpg';
  assert.match(imgUrl(src, 48, 1), /_AC_UL160_/);
  assert.match(imgUrl(src, 100, 2), /_AC_UL320_/);
  assert.match(imgUrl(src, 300, 2), /_AC_UL640_/);
  assert.match(imgUrl(src, 900, 1), /_AC_UL640_/);   // capped
  assert.equal(imgUrl('https://x/y.jpg', 300), 'https://x/y.jpg'); // other shapes untouched
  assert.equal(imgUrl(null, 300), null);
});

test('ui settings round-trip and survive broken storage', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.deepEqual(loadUi(storage), DEFAULT_UI);
  saveUi(storage, { view: 'grid', sizes: { list: 80, grid: 260 }, sort: { key: 'rating', dir: 'desc' } });
  assert.deepEqual(loadUi(storage), { view: 'grid', sizes: { list: 80, grid: 260 }, sort: { key: 'rating', dir: 'desc' } });
  mem.set('aps-ui', '{not json');
  assert.deepEqual(loadUi(storage), DEFAULT_UI);
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(loadUi(throwing), DEFAULT_UI);
  assert.doesNotThrow(() => saveUi(throwing, DEFAULT_UI));
  mem.set('aps-ui', JSON.stringify({ view: 'grid', sizes: { list: 5, grid: 99999 } }));
  assert.equal(loadUi(storage).sizes.list, VIEWS.list.min);
  assert.equal(loadUi(storage).sizes.grid, VIEWS.grid.max);
});
