import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Лише перевірені джерела: центробанки та міжнародні інституції,
 * провідні фінансові медіа з редакційними стандартами, суспільні мовники
 * та українські видання з репутацією.
 *
 * tier: 1 — офіційне джерело (регулятор / інституція), 2 — топ-медіа, 3 — якісне профільне медіа
 * focus: на чому спеціалізується джерело (підказка для AI-відбору)
 *
 * Додати свої: створи data/sources.json з масивом об'єктів того ж формату.
 */
export const SOURCES = [
  // ── Офіційні: центробанки й інституції ──────────────────
  { id: 'fed', name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml', tier: 1, focus: 'finance', lang: 'en' },
  { id: 'ecb', name: 'ECB', url: 'https://www.ecb.europa.eu/rss/press.html', tier: 1, focus: 'finance', lang: 'en' },
  { id: 'imf', name: 'IMF', url: 'https://www.imf.org/en/News/rss?language=eng', tier: 1, focus: 'finance', lang: 'en' },

  // ── Фінанси й ринки ────────────────────────────────────
  { id: 'bloomberg_markets', name: 'Bloomberg', url: 'https://feeds.bloomberg.com/markets/news.rss', tier: 2, focus: 'finance', lang: 'en' },
  { id: 'bloomberg_econ', name: 'Bloomberg', url: 'https://feeds.bloomberg.com/economics/news.rss', tier: 2, focus: 'finance', lang: 'en' },
  { id: 'wsj_markets', name: 'WSJ', url: 'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain', tier: 2, focus: 'finance', lang: 'en' },
  { id: 'marketwatch', name: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', tier: 2, focus: 'finance', lang: 'en' },
  { id: 'cnbc_top', name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', tier: 2, focus: 'finance', lang: 'en' },
  { id: 'cnbc_economy', name: 'CNBC', url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html', tier: 2, focus: 'finance', lang: 'en' },
  { id: 'cnbc_finance', name: 'CNBC', url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html', tier: 2, focus: 'finance', lang: 'en' },
  { id: 'ft', name: 'Financial Times', url: 'https://www.ft.com/rss/home', tier: 2, focus: 'finance', lang: 'en' },
  { id: 'economist', name: 'The Economist', url: 'https://www.economist.com/finance-and-economics/rss.xml', tier: 2, focus: 'finance', lang: 'en' },
  { id: 'bbc_business', name: 'BBC', url: 'https://feeds.bbci.co.uk/news/business/rss.xml', tier: 2, focus: 'finance', lang: 'en' },
  { id: 'guardian_business', name: 'The Guardian', url: 'https://www.theguardian.com/uk/business/rss', tier: 2, focus: 'finance', lang: 'en' },
  { id: 'yahoo_finance', name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex', tier: 3, focus: 'finance', lang: 'en' },
  { id: 'coindesk', name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', tier: 3, focus: 'crypto', lang: 'en' },

  // ── Україна ────────────────────────────────────────────
  { id: 'epravda', name: 'Економічна правда', url: 'https://www.epravda.com.ua/rss/', tier: 2, focus: 'finance', lang: 'uk' },
  { id: 'interfax_ua', name: 'Інтерфакс-Україна', url: 'https://interfax.com.ua/news/economic.rss', tier: 2, focus: 'finance', lang: 'uk' },
  { id: 'forbes_ua', name: 'Forbes Україна', url: 'https://forbes.ua/rss', tier: 3, focus: 'finance', lang: 'uk' },
  { id: 'ukrinform', name: 'Укрінформ', url: 'https://www.ukrinform.ua/rss/block-lastnews', tier: 2, focus: 'general', lang: 'uk' },
  { id: 'suspilne', name: 'Суспільне', url: 'https://suspilne.media/rss/all.rss', tier: 2, focus: 'general', lang: 'uk' },
  { id: 'pravda', name: 'Українська правда', url: 'https://www.pravda.com.ua/rss/', tier: 2, focus: 'general', lang: 'uk' },
  { id: 'kyiv_independent', name: 'Kyiv Independent', url: 'https://kyivindependent.com/news-archive/rss/', tier: 2, focus: 'general', lang: 'en' },

  // ── Світ ───────────────────────────────────────────────
  { id: 'bbc_world', name: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', tier: 2, focus: 'general', lang: 'en' },
  { id: 'guardian_world', name: 'The Guardian', url: 'https://www.theguardian.com/world/rss', tier: 2, focus: 'general', lang: 'en' },
  { id: 'npr_world', name: 'NPR', url: 'https://feeds.npr.org/1004/rss.xml', tier: 2, focus: 'general', lang: 'en' },
  { id: 'dw', name: 'DW', url: 'https://rss.dw.com/rdf/rss-en-all', tier: 2, focus: 'general', lang: 'en' },

  // ── Технології (вплив на ринки: AI, Big Tech) ──────────
  { id: 'arstechnica', name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', tier: 3, focus: 'tech', lang: 'en' },
  { id: 'techcrunch', name: 'TechCrunch', url: 'https://techcrunch.com/feed/', tier: 3, focus: 'tech', lang: 'en' },
];

export function getSources() {
  let all = [...SOURCES];
  const customPath = path.join(path.dirname(config.dbPath), 'sources.json');
  if (fs.existsSync(customPath)) {
    try {
      const custom = JSON.parse(fs.readFileSync(customPath, 'utf8'));
      for (const s of custom) {
        if (s?.id && s?.url && s?.name) all = all.filter((x) => x.id !== s.id).concat({ tier: 3, focus: 'general', lang: 'en', ...s });
      }
    } catch (e) {
      console.warn('⚠️  Не вдалося прочитати data/sources.json:', e.message);
    }
  }
  return all.filter((s) => !config.disabledSources.has(s.id));
}

export const TIER_LABEL = { 1: 'офіційне', 2: 'топ-медіа', 3: 'профільне' };
