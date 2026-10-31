import assert from 'node:assert/strict';

import { beforeEach, test, vi } from 'vitest';

import { readSearchMemory, resetSearchMemoryCache, writeSearchMemory } from '@/modules/kabina-search/utils/searchMemory';

beforeEach(() => {
  window.sessionStorage.clear();
  resetSearchMemoryCache();
  vi.restoreAllMocks();
});

test('an empty tab starts with an empty query on «Всё»', () => {
  assert.deepEqual(readSearchMemory(), { query: '', scope: 'all', selectedKey: null });
});

test('the query, section and row survive a reload of the tab (sessionStorage)', () => {
  writeSearchMemory({ query: 'карта', scope: 'session', selectedKey: 'session:s1' });
  resetSearchMemoryCache(); // what a page reload does to the module copy
  assert.deepEqual(readSearchMemory(), { query: 'карта', scope: 'session', selectedKey: 'session:s1' });
});

test('broken or foreign storage values fall back to safe defaults', () => {
  window.sessionStorage.setItem('kabina-search:last', JSON.stringify({ query: 42, scope: 'nope', selectedKey: 7 }));
  assert.deepEqual(readSearchMemory(), { query: '', scope: 'all', selectedKey: null });
  resetSearchMemoryCache();
  window.sessionStorage.setItem('kabina-search:last', '{not json');
  assert.deepEqual(readSearchMemory(), { query: '', scope: 'all', selectedKey: null });
});

test('blocked storage still keeps the query for remounts within the page', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('QuotaExceededError');
  });
  writeSearchMemory({ query: 'сайт', scope: 'all', selectedKey: null });
  assert.equal(readSearchMemory().query, 'сайт');
});
