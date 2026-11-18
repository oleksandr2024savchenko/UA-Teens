import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Parser from 'rss-parser';
import { normalizeItem, normalizeUrl, articleId, stripHtml } from '../src/fetcher.js';

test('normalizeUrl прибирає трекінг і www', () => {
  assert.equal(normalizeUrl('https://www.cnbc.com/a/b?utm_source=x&id=5#top'), 'https://cnbc.com/a/b?id=5');
  assert.equal(articleId('https://www.x.com/a?utm_medium=rss'), articleId('https://x.com/a'));
});

test('stripHtml декодує сутності', () => {
  assert.equal(stripHtml('<p>S&amp;P 500 &#8212; up&nbsp;1%</p>'), 'S&P 500 — up 1%');
});

test('RSS-фікстура: беремо свіже, відкидаємо старе й короткі заголовки', async () => {
  const xml = fs.readFileSync(new URL('./fixtures/fed.xml', import.meta.url), 'utf8').replaceAll('__NOW__', new Date().toUTCString());
  const feed = await new Parser().parseString(xml);
  const src = { id: 'fed', name: 'Federal Reserve', tier: 1 };
  const items = feed.items.map((i) => normalizeItem(i, src)).filter(Boolean);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Federal Reserve issues FOMC statement');
  assert.match(items[0].snippet, /federal funds rate/);
  assert.equal(items[0].sourceName, 'Federal Reserve');
});
