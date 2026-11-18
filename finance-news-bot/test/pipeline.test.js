import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { Pipeline } from '../src/pipeline.js';
import { sampleAnalysis } from './fixtures/sample.js';

function seed(store) {
  const now = Date.now();
  const arts = [
    { id: 'a', sourceId: 'fed', sourceName: 'Federal Reserve', title: 'Federal Reserve issues FOMC statement', link: 'https://fed/a', snippet: 'cut 25bp', publishedAt: now },
    { id: 'b', sourceId: 'cnbc', sourceName: 'CNBC', title: 'Fed cuts rates by a quarter point', link: 'https://cnbc/b', snippet: '', publishedAt: now },
    { id: 'c', sourceId: 'bbc', sourceName: 'BBC', title: 'Celebrity wedding news today', link: 'https://bbc/c', snippet: '', publishedAt: now },
  ];
  arts.forEach((a) => store.insertArticle(a));
}

test('повний цикл: кластеризація, аналіз, розсилка без дублікатів', async () => {
  const store = new Store(':memory:');
  let triageCalls = 0;
  const pipeline = new Pipeline(store, {
    collectNews: async (s) => (seed(s), { added: 3, failed: 0, total: 1 }),
    fetchArticleText: async () => '',
    triage: async (pending) => {
      triageCalls++;
      const ids = pending.map((p) => p.id);
      assert.deepEqual(ids.sort(), ['a', 'b', 'c']);
      return [{ articleIds: ['a', 'b'], existingStoryId: null, headline: 'ФРС знизила ставку', category: 'macro', importance: 9, financeScore: 10 }];
    },
    analyzeStory: async (story, articles) => {
      assert.equal(articles.length, 2);
      return sampleAnalysis;
    },
  });

  store.upsertUser(100);
  store.upsertUser(200);
  store.updateUser(200, { categories: ['crypto'] });
  const pushed = [];
  pipeline.onStoriesReady = async (stories) => pushed.push(...stories.map((s) => s.id));

  const r = await pipeline.runCycle();
  assert.equal(r.newStories, 1);
  assert.equal(r.analyzed, 1);
  assert.equal(triageCalls, 1);
  assert.deepEqual(pushed, [1]);

  const s = store.getStory(1);
  assert.equal(s.analysis.headline, sampleAnalysis.headline);
  assert.equal(s.sources.length, 2);
  assert.equal(store.db.prepare(`SELECT status FROM articles WHERE id='c'`).get().status, 'skipped');

  // Другий цикл — нічого нового, повторної розсилки немає
  pipeline.deps.collectNews = async () => ({ added: 0, failed: 0, total: 1 });
  await pipeline.runCycle();
  assert.deepEqual(pushed, [1]);
});

test('тихий перший запуск не розсилає', async () => {
  const store = new Store(':memory:');
  const pipeline = new Pipeline(store, {
    collectNews: async (s) => (seed(s), { added: 3 }),
    fetchArticleText: async () => '',
    triage: async () => [{ articleIds: ['a'], existingStoryId: null, headline: 'X', category: 'macro', importance: 8, financeScore: 9 }],
    analyzeStory: async () => sampleAnalysis,
  });
  pipeline.silent = true;
  let sent = 0;
  pipeline.onStoriesReady = async () => sent++;
  await pipeline.runCycle();
  assert.equal(sent, 0);
  assert.equal(store.storiesToPush().length, 0);
});

test('злиття з наявною історією', async () => {
  const store = new Store(':memory:');
  const id = store.createStory({ headline: 'old', category: 'macro', importance: 5, financeScore: 5 });
  seed(store);
  const pipeline = new Pipeline(store, {
    collectNews: async () => ({ added: 0 }),
    triage: async () => [{ articleIds: ['a', 'b'], existingStoryId: id, headline: 'x', category: 'macro', importance: 8, financeScore: 9 }],
    analyzeStory: async () => sampleAnalysis,
    fetchArticleText: async () => '',
  });
  const r = await pipeline.triagePending();
  assert.equal(r.merged, 1);
  assert.equal(store.getStory(id).importance, 8);
  assert.equal(store.getStory(id).sources.length, 2);
});

test('паралельні запити на аналіз однієї історії → один виклик AI', async () => {
  const store = new Store(':memory:');
  const id = store.createStory({ headline: 'x', category: 'markets', importance: 5, financeScore: 5 });
  let calls = 0;
  const pipeline = new Pipeline(store, {
    fetchArticleText: async () => '',
    analyzeStory: async () => (calls++, await new Promise((r) => setTimeout(r, 20)), sampleAnalysis),
  });
  await Promise.all([pipeline.ensureAnalysis(id), pipeline.ensureAnalysis(id), pipeline.ensureAnalysis(id)]);
  assert.equal(calls, 1);
});
