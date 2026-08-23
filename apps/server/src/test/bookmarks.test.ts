/**
 * Bookmarks and history.
 *
 * The interesting behaviour is all in the upserts: a bookmarked URL must not
 * duplicate, and a visit must accumulate rather than overwrite - including when
 * the page reports an empty title mid-load, which Chromium routinely does.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  openInMemoryForTests,
  addBookmark,
  listBookmarks,
  getBookmarkByUrl,
  removeBookmark,
  recordVisit,
  recentHistory,
  searchHistory,
  clearHistory,
} from '../db.js';

before(() => openInMemoryForTests());

test('bookmarks: the same url bookmarked twice stays one entry, with the newer title', () => {
  const first = addBookmark('https://example.com/', 'Example', null);
  const again = addBookmark('https://example.com/', 'Example Domain', null);
  assert.equal(again.id, first.id);
  assert.equal(listBookmarks().filter((b) => b.url === 'https://example.com/').length, 1);
  assert.equal(getBookmarkByUrl('https://example.com/')?.title, 'Example Domain');

  removeBookmark(first.id);
  assert.equal(getBookmarkByUrl('https://example.com/'), undefined);
});

test('history: visits accumulate and an empty title does not erase a known one', () => {
  clearHistory();
  recordVisit('https://news.example/', 'The News');
  recordVisit('https://news.example/', '');
  const [row] = recentHistory();
  assert.equal(row?.visits, 2);
  assert.equal(row?.title, 'The News');
});

test('history: suggestions rank by visits, then recency', () => {
  clearHistory();
  recordVisit('https://rare.example/', 'rare');
  recordVisit('https://often.example/', 'often');
  recordVisit('https://often.example/', 'often');
  const hits = searchHistory('example');
  assert.deepEqual(
    hits.map((h) => h.url),
    ['https://often.example/', 'https://rare.example/'],
  );
});

test('history: pages the user never navigated to are not recorded', () => {
  clearHistory();
  recordVisit('about:blank', '');
  recordVisit('chrome://newtab', '');
  recordVisit('', '');
  assert.equal(recentHistory().length, 0);
});

test('history: a wildcard in the query is matched literally, not as a wildcard', () => {
  clearHistory();
  recordVisit('https://a.example/', 'a');
  assert.equal(searchHistory('%').length, 0);
});
