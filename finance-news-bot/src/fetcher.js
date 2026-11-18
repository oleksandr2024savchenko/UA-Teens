import crypto from 'node:crypto';
import Parser from 'rss-parser';
import { config } from './config.js';
import { getSources } from './sources.js';

const UA = 'Mozilla/5.0 (compatible; FinNewsBot/1.0; +https://core.telegram.org/bots)';
const parser = new Parser({ timeout: 20_000 });

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };

export function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

export function stripHtml(s = '') {
  return decodeEntities(
    String(s)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Нормалізуємо URL: прибираємо трекінгові параметри та хеш, щоб ловити дублікати. */
export function normalizeUrl(raw) {
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref$|cmpid|taid|yptr|ncid|mod$|siteid|guccounter)/i.test(k)) u.searchParams.delete(k);
    }
    u.hostname = u.hostname.replace(/^www\./, '');
    return u.toString().replace(/\/$/, '');
  } catch {
    return raw.trim();
  }
}

export const articleId = (link) => crypto.createHash('sha1').update(normalizeUrl(link)).digest('hex').slice(0, 16);

export async function fetchText(url, { timeoutMs = 15_000, accept = '*/*' } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'uk,en;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Перетворює RSS/Atom-елемент у нашу статтю або null, якщо вона не підходить. */
export function normalizeItem(item, source, nowMs = Date.now()) {
  const link = item.link || item.guid;
  const title = stripHtml(item.title || '');
  if (!link || !/^https?:/i.test(link) || title.length < 8) return null;
  const dateStr = item.isoDate || item.pubDate;
  let publishedAt = dateStr ? Date.parse(dateStr) : NaN;
  if (!Number.isFinite(publishedAt) || publishedAt > nowMs + 3600_000) publishedAt = nowMs;
  if (nowMs - publishedAt > config.maxArticleAgeHours * 3600_000) return null;
  const snippet = stripHtml(item.contentSnippet || item.summary || item.content || item.description || '').slice(0, 600);
  return {
    id: articleId(link),
    sourceId: source.id,
    sourceName: source.name,
    tier: source.tier,
    title,
    link: link.trim(),
    snippet,
    publishedAt,
  };
}

export async function fetchSource(source) {
  const xml = await fetchText(source.url, { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' });
  const feed = await parser.parseString(xml);
  return (feed.items || []).map((it) => normalizeItem(it, source)).filter(Boolean);
}

async function pool(items, limit, fn) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}
export { pool };

/**
 * Збирає всі джерела паралельно, зберігає лише нові статті.
 * @returns {Promise<{added:number, failed:number, total:number}>}
 */
export async function collectNews(store) {
  const sources = getSources();
  let added = 0;
  let failed = 0;
  await pool(sources, 6, async (src) => {
    try {
      const items = await fetchSource(src);
      store.sourceOk(src.id, items.length);
      for (const a of items) {
        // Дублікат за заголовком (часто той самий матеріал у кількох стрічках одного видання)
        if (store.hasArticle(a.id) || store.hasTitle(a.title)) continue;
        if (store.insertArticle(a)) added++;
      }
    } catch (e) {
      failed++;
      store.sourceFail(src.id, e.message);
    }
  });
  return { added, failed, total: sources.length };
}

/**
 * Пробуємо дістати текст статті (без пейволу) — допомагає точнішому аналізу.
 * Повертає до maxChars символів або ''.
 */
export async function fetchArticleText(url, maxChars = 5000) {
  try {
    const html = await fetchText(url, { timeoutMs: 10_000, accept: 'text/html' });
    const body = html.replace(/<(script|style|noscript|svg|header|footer|nav|aside|form)[\s\S]*?<\/\1>/gi, ' ');
    const paras = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((m) => stripHtml(m[1]))
      .filter((p) => p.length > 60 && !/cookie|subscribe|sign up|newsletter|javascript/i.test(p));
    return paras.join('\n').slice(0, maxChars);
  } catch {
    return '';
  }
}
