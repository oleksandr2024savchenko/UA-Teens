import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const CATEGORIES = {
  macro: { emoji: '🏦', label: 'Макро й центробанки', finance: true },
  markets: { emoji: '📈', label: 'Ринки', finance: true },
  business: { emoji: '🏢', label: 'Бізнес і компанії', finance: true },
  crypto: { emoji: '₿', label: 'Крипто', finance: true },
  ukraine_economy: { emoji: '🇺🇦', label: 'Економіка України', finance: true },
  ukraine: { emoji: '🇺🇦', label: 'Україна', finance: false },
  world: { emoji: '🌍', label: 'Світ і геополітика', finance: false },
  tech: { emoji: '💻', label: 'Технології', finance: false },
  other: { emoji: '📰', label: 'Інше', finance: false },
};
export const CATEGORY_KEYS = Object.keys(CATEGORIES);
export const FINANCE_CATEGORIES = CATEGORY_KEYS.filter((k) => CATEGORIES[k].finance);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_name TEXT NOT NULL,
  title TEXT NOT NULL,
  link TEXT NOT NULL,
  snippet TEXT,
  published_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  story_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_story ON articles(story_id);

CREATE TABLE IF NOT EXISTS stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  headline TEXT NOT NULL,
  category TEXT NOT NULL,
  importance INTEGER NOT NULL,
  finance_score INTEGER NOT NULL DEFAULT 0,
  analysis TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  analyzed_at INTEGER,
  pushed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_stories_created ON stories(created_at);

CREATE TABLE IF NOT EXISTS story_extras (
  story_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (story_id, kind)
);

CREATE TABLE IF NOT EXISTS users (
  chat_id INTEGER PRIMARY KEY,
  first_name TEXT,
  username TEXT,
  subscribed INTEGER NOT NULL DEFAULT 1,
  min_importance INTEGER NOT NULL DEFAULT 7,
  categories TEXT NOT NULL DEFAULT '[]',
  digest_enabled INTEGER NOT NULL DEFAULT 1,
  digest_hour INTEGER NOT NULL DEFAULT 9,
  last_digest_date TEXT,
  mode TEXT,
  mode_story_id INTEGER,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  chat_id INTEGER NOT NULL,
  story_id INTEGER NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, story_id)
);

CREATE TABLE IF NOT EXISTS chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_chat ON chat_history(chat_id, created_at);

CREATE TABLE IF NOT EXISTS source_health (
  source_id TEXT PRIMARY KEY,
  last_ok INTEGER,
  last_error TEXT,
  last_error_at INTEGER,
  items_last INTEGER NOT NULL DEFAULT 0,
  fail_streak INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const now = () => Date.now();
const parseJson = (s, def) => {
  if (s == null) return def;
  try {
    return JSON.parse(s);
  } catch {
    return def;
  }
};

export class Store {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ── articles ─────────────────────────────────────────
  insertArticle(a) {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO articles (id, source_id, source_name, title, link, snippet, published_at, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.id, a.sourceId, a.sourceName, a.title, a.link, a.snippet ?? '', a.publishedAt, now());
    return r.changes > 0;
  }

  hasArticle(id) {
    return !!this.db.prepare('SELECT 1 FROM articles WHERE id = ?').get(id);
  }

  hasTitle(title) {
    return !!this.db.prepare('SELECT 1 FROM articles WHERE lower(title) = lower(?) LIMIT 1').get(title);
  }

  newArticles(limit) {
    return this.db.prepare(`SELECT * FROM articles WHERE status = 'new' ORDER BY published_at DESC LIMIT ?`).all(limit);
  }

  setArticleStatus(id, status, storyId = null) {
    this.db.prepare('UPDATE articles SET status = ?, story_id = COALESCE(?, story_id) WHERE id = ?').run(status, storyId, id);
  }

  storyArticles(storyId) {
    return this.db.prepare('SELECT * FROM articles WHERE story_id = ? ORDER BY published_at ASC').all(storyId);
  }

  // ── stories ──────────────────────────────────────────
  createStory({ headline, category, importance, financeScore }) {
    const t = now();
    const r = this.db
      .prepare(
        `INSERT INTO stories (headline, category, importance, finance_score, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(headline, category, importance, financeScore, t, t);
    return Number(r.lastInsertRowid);
  }

  bumpStory(id, importance) {
    this.db.prepare('UPDATE stories SET importance = MAX(importance, ?), updated_at = ? WHERE id = ?').run(importance, now(), id);
  }

  saveAnalysis(id, analysis) {
    this.db
      .prepare('UPDATE stories SET analysis = ?, headline = ?, analyzed_at = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(analysis), analysis.headline || this.getStory(id)?.headline, now(), now(), id);
  }

  getStory(id) {
    const s = this.db.prepare('SELECT * FROM stories WHERE id = ?').get(id);
    return s ? this.#hydrate(s) : null;
  }

  #hydrate(s) {
    return { ...s, analysis: parseJson(s.analysis, null), sources: this.storyArticles(s.id) };
  }

  recentStories({ hours = 24, categories = null, minImportance = 0, limit = 20, offset = 0 } = {}) {
    const since = now() - hours * 3600_000;
    let sql = 'SELECT * FROM stories WHERE created_at >= ? AND importance >= ?';
    const args = [since, minImportance];
    if (categories?.length) {
      sql += ` AND category IN (${categories.map(() => '?').join(',')})`;
      args.push(...categories);
    }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    args.push(limit, offset);
    return this.db.prepare(sql).all(...args).map((s) => this.#hydrate(s));
  }

  countStories({ hours = 24, categories = null, minImportance = 0 } = {}) {
    const since = now() - hours * 3600_000;
    let sql = 'SELECT COUNT(*) AS n FROM stories WHERE created_at >= ? AND importance >= ?';
    const args = [since, minImportance];
    if (categories?.length) {
      sql += ` AND category IN (${categories.map(() => '?').join(',')})`;
      args.push(...categories);
    }
    return this.db.prepare(sql).get(...args).n;
  }

  topStories({ hours = 24, limit = 10, categories = null } = {}) {
    const since = now() - hours * 3600_000;
    let sql = 'SELECT * FROM stories WHERE created_at >= ?';
    const args = [since];
    if (categories?.length) {
      sql += ` AND category IN (${categories.map(() => '?').join(',')})`;
      args.push(...categories);
    }
    sql += ' ORDER BY (importance * 10 + finance_score) DESC, created_at DESC LIMIT ?';
    args.push(limit);
    return this.db.prepare(sql).all(...args).map((s) => this.#hydrate(s));
  }

  storiesToPush() {
    return this.db
      .prepare('SELECT * FROM stories WHERE pushed = 0 AND analysis IS NOT NULL ORDER BY importance DESC, created_at ASC')
      .all()
      .map((s) => this.#hydrate(s));
  }

  markPushed(id) {
    this.db.prepare('UPDATE stories SET pushed = 1 WHERE id = ?').run(id);
  }

  getExtra(storyId, kind) {
    return this.db.prepare('SELECT content FROM story_extras WHERE story_id = ? AND kind = ?').get(storyId, kind)?.content ?? null;
  }

  setExtra(storyId, kind, content) {
    this.db
      .prepare('INSERT OR REPLACE INTO story_extras (story_id, kind, content, created_at) VALUES (?, ?, ?, ?)')
      .run(storyId, kind, content, now());
  }

  // ── users ────────────────────────────────────────────
  upsertUser(chatId, { firstName = null, username = null } = {}) {
    const t = now();
    this.db
      .prepare(
        `INSERT INTO users (chat_id, first_name, username, created_at, last_seen) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET first_name = COALESCE(excluded.first_name, first_name),
           username = COALESCE(excluded.username, username), last_seen = excluded.last_seen`,
      )
      .run(chatId, firstName, username, t, t);
    return this.getUser(chatId);
  }

  getUser(chatId) {
    const u = this.db.prepare('SELECT * FROM users WHERE chat_id = ?').get(chatId);
    return u ? { ...u, categories: parseJson(u.categories, []) } : null;
  }

  updateUser(chatId, patch) {
    const allowed = ['subscribed', 'min_importance', 'categories', 'digest_enabled', 'digest_hour', 'last_digest_date', 'mode', 'mode_story_id'];
    const keys = Object.keys(patch).filter((k) => allowed.includes(k));
    if (!keys.length) return;
    const vals = keys.map((k) => (k === 'categories' ? JSON.stringify(patch[k]) : typeof patch[k] === 'boolean' ? Number(patch[k]) : patch[k]));
    this.db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE chat_id = ?`).run(...vals, chatId);
  }

  subscribers() {
    return this.db
      .prepare('SELECT * FROM users WHERE subscribed = 1')
      .all()
      .map((u) => ({ ...u, categories: parseJson(u.categories, []) }));
  }

  digestUsers(hour, date) {
    return this.db
      .prepare('SELECT * FROM users WHERE digest_enabled = 1 AND digest_hour = ? AND (last_digest_date IS NULL OR last_digest_date != ?)')
      .all(hour, date)
      .map((u) => ({ ...u, categories: parseJson(u.categories, []) }));
  }

  wasDelivered(chatId, storyId) {
    return !!this.db.prepare('SELECT 1 FROM deliveries WHERE chat_id = ? AND story_id = ?').get(chatId, storyId);
  }

  markDelivered(chatId, storyId) {
    this.db.prepare('INSERT OR IGNORE INTO deliveries (chat_id, story_id, sent_at) VALUES (?, ?, ?)').run(chatId, storyId, now());
  }

  // ── chat history (для Q&A з контекстом) ──────────────
  addHistory(chatId, role, content) {
    this.db.prepare('INSERT INTO chat_history (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)').run(chatId, role, content, now());
  }

  history(chatId, { limit = 8, maxAgeMin = 120 } = {}) {
    const rows = this.db
      .prepare('SELECT role, content FROM chat_history WHERE chat_id = ? AND created_at >= ? ORDER BY id DESC LIMIT ?')
      .all(chatId, now() - maxAgeMin * 60_000, limit);
    return rows.reverse();
  }

  clearHistory(chatId) {
    this.db.prepare('DELETE FROM chat_history WHERE chat_id = ?').run(chatId);
  }

  // ── source health ────────────────────────────────────
  sourceOk(id, items) {
    this.db
      .prepare(
        `INSERT INTO source_health (source_id, last_ok, items_last, fail_streak) VALUES (?, ?, ?, 0)
         ON CONFLICT(source_id) DO UPDATE SET last_ok = excluded.last_ok, items_last = excluded.items_last, fail_streak = 0`,
      )
      .run(id, now(), items);
  }

  sourceFail(id, error) {
    this.db
      .prepare(
        `INSERT INTO source_health (source_id, last_error, last_error_at, fail_streak) VALUES (?, ?, ?, 1)
         ON CONFLICT(source_id) DO UPDATE SET last_error = excluded.last_error, last_error_at = excluded.last_error_at,
           fail_streak = fail_streak + 1`,
      )
      .run(id, String(error).slice(0, 300), now());
  }

  sourceHealth() {
    return this.db.prepare('SELECT * FROM source_health').all();
  }

  // ── kv ───────────────────────────────────────────────
  getKv(key) {
    return parseJson(this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value, null);
  }

  setKv(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
  }

  // ── maintenance ──────────────────────────────────────
  cleanup({ days = 14 } = {}) {
    const cutoff = now() - days * 86400_000;
    this.db.prepare('DELETE FROM articles WHERE fetched_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM story_extras WHERE story_id IN (SELECT id FROM stories WHERE created_at < ?)').run(cutoff);
    this.db.prepare('DELETE FROM deliveries WHERE sent_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM stories WHERE created_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM chat_history WHERE created_at < ?').run(now() - 2 * 86400_000);
  }

  stats() {
    const one = (sql, ...a) => this.db.prepare(sql).get(...a).n;
    const day = now() - 86400_000;
    return {
      users: one('SELECT COUNT(*) n FROM users'),
      subscribers: one('SELECT COUNT(*) n FROM users WHERE subscribed = 1'),
      articles24h: one('SELECT COUNT(*) n FROM articles WHERE fetched_at >= ?', day),
      stories24h: one('SELECT COUNT(*) n FROM stories WHERE created_at >= ?', day),
      analyzed24h: one('SELECT COUNT(*) n FROM stories WHERE analyzed_at >= ?', day),
      pending: one(`SELECT COUNT(*) n FROM articles WHERE status = 'new'`),
    };
  }
}
