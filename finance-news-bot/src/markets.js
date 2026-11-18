import { fetchText } from './fetcher.js';

/** Знімок ринків із безкоштовних публічних джерел. Кешується на 5 хвилин. */

const YAHOO = [
  { sym: '^GSPC', name: 'S&P 500', group: 'Індекси' },
  { sym: '^IXIC', name: 'Nasdaq', group: 'Індекси' },
  { sym: '^DJI', name: 'Dow Jones', group: 'Індекси' },
  { sym: '^STOXX50E', name: 'Euro Stoxx 50', group: 'Індекси' },
  { sym: '^VIX', name: 'VIX (індекс страху)', group: 'Індекси' },
  { sym: '^TNX', name: 'US 10Y yield', group: 'Облігації', isYield: true },
  { sym: 'DX-Y.NYB', name: 'DXY (індекс долара)', group: 'Валюти' },
  { sym: 'EURUSD=X', name: 'EUR/USD', group: 'Валюти', digits: 4 },
  { sym: 'GC=F', name: 'Золото', group: 'Сировина', prefix: '$' },
  { sym: 'BZ=F', name: 'Нафта Brent', group: 'Сировина', prefix: '$' },
];

let cache = { at: 0, data: null };

async function yahooQuote(q) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(q.sym)}?range=5d&interval=1d`;
  const json = JSON.parse(await fetchText(url, { timeoutMs: 10_000, accept: 'application/json' }));
  const meta = json?.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice) throw new Error('no data');
  const price = meta.regularMarketPrice;
  const prev = meta.chartPreviousClose ?? meta.previousClose;
  // Для 5d-діапазону chartPreviousClose — закриття 5 днів тому; беремо передостаннє денне закриття
  const closes = json.chart.result[0].indicators?.quote?.[0]?.close?.filter((x) => x != null) ?? [];
  const prevClose = closes.length >= 2 ? closes[closes.length - 2] : prev;
  return { ...q, price, change: prevClose ? ((price - prevClose) / prevClose) * 100 : null };
}

async function nbuRates() {
  const json = JSON.parse(await fetchText('https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json', { accept: 'application/json' }));
  const pick = (cc) => json.find((r) => r.cc === cc);
  return ['USD', 'EUR', 'PLN', 'GBP']
    .map((cc) => pick(cc))
    .filter(Boolean)
    .map((r) => ({ cc: r.cc, rate: r.rate, date: r.exchangedate }));
}

async function crypto() {
  const json = JSON.parse(
    await fetchText('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true', {
      accept: 'application/json',
    }),
  );
  const names = { bitcoin: 'Bitcoin (BTC)', ethereum: 'Ethereum (ETH)', solana: 'Solana (SOL)' };
  return Object.entries(names)
    .filter(([id]) => json[id])
    .map(([id, name]) => ({ name, price: json[id].usd, change: json[id].usd_24h_change }));
}

const settle = async (p) => {
  try {
    return await p;
  } catch {
    return null;
  }
};

export async function getMarkets({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < 5 * 60_000) return cache.data;
  const [quotes, nbu, cr] = await Promise.all([
    Promise.all(YAHOO.map((q) => settle(yahooQuote(q)))),
    settle(nbuRates()),
    settle(crypto()),
  ]);
  const data = { quotes: quotes.filter(Boolean), nbu: nbu ?? [], crypto: cr ?? [], at: Date.now() };
  if (data.quotes.length || data.nbu.length || data.crypto.length) cache = { at: Date.now(), data };
  return data;
}

const fmtNum = (n, digits = 2) => n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).replace(/,/g, ' ');

export function fmtChange(ch) {
  if (ch == null || !Number.isFinite(ch)) return '';
  const arrow = ch > 0.05 ? '🟢 ▲' : ch < -0.05 ? '🔴 ▼' : '⚪️ ▬';
  return `${arrow} ${ch > 0 ? '+' : ''}${ch.toFixed(2)}%`;
}

/** Текстове представлення для AI-коментаря. */
export function marketsToPlain(m) {
  const lines = [];
  for (const q of m.quotes) lines.push(`${q.name}: ${fmtNum(q.price, q.digits ?? 2)}${q.isYield ? '%' : ''} (${q.change?.toFixed(2) ?? '?'}% за день)`);
  for (const c of m.crypto) lines.push(`${c.name}: $${fmtNum(c.price, 0)} (${c.change?.toFixed(2) ?? '?'}% за 24 год)`);
  for (const r of m.nbu) lines.push(`НБУ ${r.cc}/UAH: ${r.rate.toFixed(4)}`);
  return lines.join('\n');
}

export function marketsToHtml(m, tz) {
  if (!m.quotes.length && !m.nbu.length && !m.crypto.length) return '⚠️ Не вдалося отримати котирування. Спробуй трохи пізніше.';
  const out = ['📊 <b>Ринки зараз</b>', ''];
  const groups = {};
  for (const q of m.quotes) (groups[q.group] ??= []).push(q);
  const icons = { Індекси: '📈', Облігації: '🏛', Валюти: '💱', Сировина: '🛢' };
  for (const [g, qs] of Object.entries(groups)) {
    out.push(`${icons[g] ?? '•'} <b>${g}</b>`);
    for (const q of qs) out.push(`  ${q.name}: <code>${q.prefix ?? ''}${fmtNum(q.price, q.digits ?? 2)}${q.isYield ? '%' : ''}</code> ${fmtChange(q.change)}`);
    out.push('');
  }
  if (m.crypto.length) {
    out.push('₿ <b>Крипто</b> <i>(24 год)</i>');
    for (const c of m.crypto) out.push(`  ${c.name}: <code>$${fmtNum(c.price, 0)}</code> ${fmtChange(c.change)}`);
    out.push('');
  }
  if (m.nbu.length) {
    out.push(`🇺🇦 <b>Офіційний курс НБУ</b> <i>(${m.nbu[0].date})</i>`);
    out.push('  ' + m.nbu.map((r) => `${r.cc}: <code>${r.rate.toFixed(2)}</code>`).join(' · '));
    out.push('');
  }
  const t = new Date(m.at).toLocaleTimeString('uk-UA', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  out.push(`<i>Оновлено о ${t}. Дані: Yahoo Finance, CoinGecko, НБУ; можлива затримка 15+ хв.</i>`);
  return out.join('\n');
}
