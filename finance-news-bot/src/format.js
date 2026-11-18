import { CATEGORIES } from './db.js';

export const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s = '') => esc(s).replace(/"/g, '&quot;');

const MAX = 4000; // ліміт Telegram — 4096

export function importanceBadge(n) {
  if (n >= 9) return '🔥🔥🔥';
  if (n >= 7) return '🔥🔥';
  if (n >= 5) return '🔥';
  return '▫️';
}

const DIR = { up: '🟢 ▲', down: '🔴 ▼', mixed: '🟡 ⇅', neutral: '⚪️ ▬' };
const SENTIMENT = { risk_on: '🟢 Risk-on', risk_off: '🔴 Risk-off', neutral: '⚪️ Нейтрально', mixed: '🟡 Змішано' };
const CONFIDENCE = { high: 'висока', medium: 'середня', low: 'низька' };

export function timeAgo(ts, now = Date.now()) {
  const m = Math.max(0, Math.round((now - ts) / 60_000));
  if (m < 1) return 'щойно';
  if (m < 60) return `${m} хв тому`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} год тому`;
  return `${Math.round(h / 24)} дн тому`;
}

function sourcesLine(story) {
  const seen = new Set();
  const links = [];
  for (const s of story.sources) {
    if (seen.has(s.source_name)) continue;
    seen.add(s.source_name);
    links.push(`<a href="${escAttr(s.link)}">${esc(s.source_name)}</a>`);
  }
  return links.length ? `📰 ${links.slice(0, 6).join(' · ')}` : '';
}

/** Повна картка новини. Якщо не влазить у ліміт — скорочуємо необов'язкові блоки. */
export function renderCard(story) {
  const a = story.analysis;
  const cat = CATEGORIES[story.category] ?? CATEGORIES.other;
  if (!a) return renderBrief(story);

  const head = [
    `${esc(a.emoji)} <b>${esc(a.headline)}</b>`,
    `${cat.emoji} ${cat.label} · ${importanceBadge(story.importance)} ${story.importance}/10 · ${SENTIMENT[a.sentiment] ?? ''}`,
    '',
    `<i>${esc(a.tldr)}</i>`,
  ];
  const blocks = {
    what: `<b>📌 Що сталося</b>\n${esc(a.what_happened)}`,
    why: `<b>🎯 Чому це важливо</b>\n${esc(a.why_it_matters)}`,
    terms: a.terms.length ? `<b>💡 Простими словами</b>\n${a.terms.map((t) => `• <b>${esc(t.term)}</b> — ${esc(t.explanation)}`).join('\n')}` : '',
    market: a.market_impact.length
      ? `<b>📈 Вплив на ринки</b>\n${a.market_impact.map((m) => `${DIR[m.direction] ?? '•'} <b>${esc(m.asset)}</b> — ${esc(m.comment)}`).join('\n')}`
      : '',
    ukraine: a.ukraine_angle?.trim() ? `<b>🇺🇦 Для України</b>\n${esc(a.ukraine_angle)}` : '',
    next: `<b>🔭 Що далі</b>\n${esc(a.what_next)}`,
    watch: a.watch.length ? `👀 <b>Стежимо:</b> ${a.watch.map(esc).join(' · ')}` : '',
  };
  const footer = [
    sourcesLine(story),
    `<i>🕒 ${timeAgo(story.created_at)} · достовірність висновків: ${CONFIDENCE[a.confidence] ?? '—'} · не є інвестиційною порадою</i>`,
  ];

  // Порядок, у якому жертвуємо блоками, якщо текст задовгий
  const dropOrder = ['watch', 'next', 'ukraine', 'why', 'terms'];
  const build = () => [...head, '', ...Object.values(blocks).filter(Boolean).join('\n\n').split('\n'), '', ...footer.filter(Boolean)].join('\n');
  let text = build();
  for (const k of dropOrder) {
    if (text.length <= MAX) break;
    blocks[k] = '';
    text = build();
  }
  return text.length <= MAX ? text : text.slice(0, MAX - 1) + '…';
}

/** Коротка картка (для історій без повного аналізу). */
export function renderBrief(story) {
  const cat = CATEGORIES[story.category] ?? CATEGORIES.other;
  const snippet = story.sources.find((s) => s.snippet)?.snippet;
  return [
    `${cat.emoji} <b>${esc(story.headline)}</b>`,
    `${cat.label} · ${importanceBadge(story.importance)} ${story.importance}/10`,
    snippet ? `\n<i>${esc(snippet.slice(0, 400))}</i>` : '',
    '',
    sourcesLine(story),
    `<i>🕒 ${timeAgo(story.created_at)} · натисни «🧠 Пояснити», щоб отримати розбір</i>`,
  ]
    .filter((x) => x !== '')
    .join('\n');
}

/** Компактний рядок для списку-стрічки. */
export function renderListItem(story, n) {
  const cat = CATEGORIES[story.category] ?? CATEGORIES.other;
  const title = story.analysis?.headline ?? story.headline;
  return `<b>${n}.</b> ${cat.emoji} ${esc(title)}\n     ${importanceBadge(story.importance)} <i>${timeAgo(story.created_at)} · ${esc(story.sources[0]?.source_name ?? '')}${story.sources.length > 1 ? ` +${new Set(story.sources.map((s) => s.source_name)).size - 1}` : ''}</i>`;
}

export function renderList(title, stories, offset = 0, total = stories.length) {
  if (!stories.length) return `${title}\n\nПоки що порожньо — новини з'являться після найближчого оновлення (кожні кілька хвилин).`;
  const items = stories.map((s, i) => renderListItem(s, offset + i + 1));
  return `${title}\n<i>Показано ${offset + 1}–${offset + stories.length} з ${total}. Натисни номер, щоб відкрити.</i>\n\n${items.join('\n\n')}`;
}

export function renderDeep(story, sections) {
  const title = story.analysis?.headline ?? story.headline;
  const body = sections.map((s) => `${esc(s.emoji)} <b>${esc(s.title)}</b>\n${esc(s.body)}`).join('\n\n');
  return `🧠 <b>Глибше: ${esc(title)}</b>\n\n${body}\n\n<i>Не є інвестиційною порадою.</i>`;
}

export function renderDigest(d, stories, dateLabel) {
  const byId = new Map(stories.map((s) => [s.id, s]));
  const lines = d.highlights.map((h, i) => {
    const s = byId.get(h.storyId);
    const cat = CATEGORIES[s?.category] ?? CATEGORIES.other;
    return `${i + 1}. ${cat.emoji} ${esc(h.line)}`;
  });
  return [
    `🗞 <b>Дайджест · ${esc(dateLabel)}</b>`,
    '',
    `<i>${esc(d.intro)}</i>`,
    '',
    ...lines,
    '',
    `📊 <b>Настрій ринків:</b> ${esc(d.market_mood)}`,
    `🔭 <b>Далі:</b> ${esc(d.outlook)}`,
    '',
    '<i>Натисни номер, щоб відкрити повний розбір.</i>',
  ].join('\n');
}

/**
 * Санітайзер для відповідей моделі у Telegram HTML:
 * екрануємо все, а потім повертаємо лише дозволені теги.
 */
export function sanitizeHtml(input = '') {
  let s = String(input)
    .replace(/\r/g, '')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/<br\s*\/?>/gi, '\n');
  s = esc(s);
  s = s.replace(/&lt;(\/?)(b|i|u|s|code|pre|blockquote)&gt;/gi, '<$1$2>');
  s = s.replace(/&lt;a href=&quot;(https?:\/\/[^"&]+?)&quot;&gt;([\s\S]*?)&lt;\/a&gt;/gi, '<a href="$1">$2</a>');
  s = s.replace(/&lt;a href="(https?:\/\/[^"]+?)"&gt;([\s\S]*?)&lt;\/a&gt;/gi, '<a href="$1">$2</a>');
  return balanceTags(s).trim();
}

/** Закриває незакриті теги та прибирає зайві закриваючі, щоб Telegram не відхилив повідомлення. */
export function balanceTags(s) {
  const stack = [];
  let out = s.replace(/<(\/?)(b|i|u|s|code|pre|blockquote|a)(\s[^>]*)?>/gi, (m, close, tag) => {
    tag = tag.toLowerCase();
    if (!close) {
      stack.push(tag);
      return m;
    }
    const idx = stack.lastIndexOf(tag);
    if (idx === -1) return '';
    const toClose = stack.splice(idx);
    return toClose
      .reverse()
      .map((t) => `</${t}>`)
      .join('');
  });
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}

/** Розбиває довгий текст на повідомлення по абзацах. */
export function splitMessage(text, limit = MAX) {
  if (text.length <= limit) return [text];
  const parts = [];
  let cur = '';
  for (const para of text.split('\n\n')) {
    const chunk = para.length > limit ? para.slice(0, limit - 1) + '…' : para;
    if ((cur + '\n\n' + chunk).length > limit && cur) {
      parts.push(balanceTags(cur));
      cur = chunk;
    } else cur = cur ? `${cur}\n\n${chunk}` : chunk;
  }
  if (cur) parts.push(balanceTags(cur));
  return parts;
}
