import { config } from './config.js';
import { collectNews, fetchArticleText, pool } from './fetcher.js';
import { triage, analyzeStory, deepDive, makeDigest } from './ai.js';
import { getMarkets, marketsToPlain } from './markets.js';

const log = (...a) => console.log(new Date().toISOString(), ...a);

/**
 * Конвеєр: збір → відбір/кластеризація → аналіз → розсилка.
 */
export class Pipeline {
  constructor(store, deps = {}) {
    this.store = store;
    // Залежності можна підмінити в тестах
    this.deps = { collectNews, fetchArticleText, triage, analyzeStory, deepDive, makeDigest, getMarkets, ...deps };
    this.running = false;
    this.inflight = new Map(); // storyId:kind -> Promise (щоб не робити однакові запити паралельно)
    this.onStoriesReady = null; // async (stories[]) => void — розсилка
    this.silent = false; // перший запуск: не засипати підписників старими новинами
    this.lastRun = null;
  }

  once(key, fn) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async runCycle() {
    if (this.running) return { skipped: true };
    this.running = true;
    const started = Date.now();
    try {
      const fetched = await this.deps.collectNews(this.store);
      const triaged = await this.triagePending();
      const analyzed = await this.analyzeTop();
      await this.pushReady();
      this.lastRun = { at: Date.now(), ms: Date.now() - started, ...fetched, ...triaged, analyzed };
      log(`🔄 цикл: +${fetched.added} статей (${fetched.failed}/${fetched.total} джерел з помилками), ${triaged.newStories ?? 0} нових історій, ${analyzed} розборів, ${Date.now() - started} мс`);
      return this.lastRun;
    } catch (e) {
      log('❌ помилка циклу:', e);
      return { error: e.message };
    } finally {
      this.running = false;
    }
  }

  async triagePending() {
    let newStories = 0;
    let merged = 0;
    // Обробляємо пачками, щоб не перевантажувати один запит
    for (let round = 0; round < 3; round++) {
      const pending = this.store.newArticles(70);
      if (!pending.length) break;
      const recent = this.store.recentStories({ hours: 24, limit: 60 });
      const clusters = await this.deps.triage(pending, recent);
      this.store.tx(() => {
        const covered = new Set();
        for (const c of clusters) {
          let storyId = c.existingStoryId && this.store.getStory(c.existingStoryId) ? c.existingStoryId : null;
          if (storyId) {
            this.store.bumpStory(storyId, c.importance);
            merged++;
          } else {
            storyId = this.store.createStory(c);
            newStories++;
          }
          for (const id of c.articleIds) {
            this.store.setArticleStatus(id, 'clustered', storyId);
            covered.add(id);
          }
        }
        for (const a of pending) if (!covered.has(a.id)) this.store.setArticleStatus(a.id, 'skipped');
      });
    }
    return { newStories, merged };
  }

  async analyzeTop() {
    const candidates = this.store
      .recentStories({ hours: 12, minImportance: config.analyzeMinImportance, limit: 50 })
      .filter((s) => !s.analysis)
      .sort((a, b) => b.importance * 10 + b.finance_score - (a.importance * 10 + a.finance_score))
      .slice(0, config.maxAnalysesPerCycle);
    let ok = 0;
    await pool(candidates, 3, async (s) => {
      try {
        await this.ensureAnalysis(s.id);
        ok++;
      } catch (e) {
        log(`⚠️ не вдалося розібрати історію ${s.id}:`, e.message);
      }
    });
    return ok;
  }

  /** Повертає історію з аналізом (генерує, якщо ще немає). */
  async ensureAnalysis(storyId) {
    const story = this.store.getStory(storyId);
    if (!story) throw new Error('story not found');
    if (story.analysis) return story;
    return this.once(`${storyId}:analysis`, async () => {
      const articles = story.sources.slice(0, 6);
      const texts = {};
      await pool(articles.slice(0, 3), 3, async (a) => {
        const t = await this.deps.fetchArticleText(a.link);
        if (t.length > 300) texts[a.id] = t;
      });
      const analysis = await this.deps.analyzeStory(story, articles, texts);
      this.store.saveAnalysis(storyId, analysis);
      return this.store.getStory(storyId);
    });
  }

  async ensureDeep(storyId) {
    const cached = this.store.getExtra(storyId, 'deep');
    if (cached) return JSON.parse(cached);
    return this.once(`${storyId}:deep`, async () => {
      const story = await this.ensureAnalysis(storyId);
      const sections = await this.deps.deepDive(story);
      this.store.setExtra(storyId, 'deep', JSON.stringify(sections));
      return sections;
    });
  }

  async pushReady() {
    const ready = this.store.storiesToPush();
    for (const s of ready) this.store.markPushed(s.id);
    if (this.silent) {
      this.silent = false;
      return;
    }
    const fresh = ready.filter((s) => Date.now() - s.created_at < 6 * 3600_000);
    if (!fresh.length || !this.onStoriesReady) return;
    try {
      await this.onStoriesReady(fresh);
    } catch (e) {
      log('⚠️ помилка розсилки:', e.message);
    }
  }

  /** Дайджест кешується на годину, щоб усі підписники того ж часу отримали однаковий. */
  async getDigest() {
    const key = `digest:${new Date().toISOString().slice(0, 13)}`;
    const cached = this.store.getKv(key);
    if (cached) return cached;
    return this.once(key, async () => {
      const stories = this.store.topStories({ hours: 24, limit: 14 });
      if (stories.length < 3) return null;
      let marketsText = '';
      try {
        marketsText = marketsToPlain(await this.deps.getMarkets());
      } catch {}
      const digest = await this.deps.makeDigest(stories, marketsText);
      const result = { digest, storyIds: stories.map((s) => s.id) };
      this.store.setKv(key, result);
      return result;
    });
  }
}
