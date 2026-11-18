import { Bot, InlineKeyboard, Keyboard, GrammyError } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { config } from './config.js';
import { CATEGORIES, FINANCE_CATEGORIES } from './db.js';
import { getSources, TIER_LABEL } from './sources.js';
import { answerQuestion, explainTerm, marketCommentary, AiError } from './ai.js';
import { getMarkets, marketsToHtml, marketsToPlain } from './markets.js';
import { esc, renderCard, renderList, renderDeep, renderDigest, sanitizeHtml, splitMessage, timeAgo } from './format.js';

const BTN = {
  feed: '📰 Стрічка',
  finance: '💰 Фінанси',
  top: '🔥 Головне',
  markets: '📊 Ринки',
  digest: '🗞 Дайджест',
  glossary: '📚 Словник',
  settings: '⚙️ Налаштування',
  help: '❓ Допомога',
};

const mainKeyboard = new Keyboard()
  .text(BTN.feed).text(BTN.finance).row()
  .text(BTN.top).text(BTN.markets).row()
  .text(BTN.digest).text(BTN.glossary).row()
  .text(BTN.settings).text(BTN.help)
  .resized()
  .persistent()
  .placeholder('Запитай що завгодно про фінанси…');

const FILTERS = {
  all: { title: '📰 <b>Стрічка новин</b>', categories: null, minImportance: 4 },
  fin: { title: '💰 <b>Фінанси та економіка</b>', categories: FINANCE_CATEGORIES, minImportance: 3 },
  ua: { title: '🇺🇦 <b>Україна</b>', categories: ['ukraine', 'ukraine_economy'], minImportance: 3 },
  world: { title: '🌍 <b>Світ і технології</b>', categories: ['world', 'tech'], minImportance: 4 },
};
const PAGE = 8;

export const GLOSSARY = [
  'Ставка ФРС (Fed funds rate)', 'Облікова ставка НБУ', 'Інфляція та CPI', 'QE і QT', 'Облігації та прибутковість (yield)',
  'Рецесія', 'ВВП (GDP)', 'Hawkish / Dovish', 'Risk-on / Risk-off', 'S&P 500 і Nasdaq',
  'VIX — індекс страху', 'ОВДП', 'Індекс долара (DXY)', 'Ліквідність', 'ETF',
  'P/E (ціна/прибуток)', 'Спред', 'Ринок праці США (NFP)', 'Стейблкоїни', 'Санкції та їх вплив на ринки',
];

const IMPORTANCE_OPTIONS = [
  { v: 6, label: 'Багато (6+)' },
  { v: 7, label: 'Важливе (7+)' },
  { v: 8, label: 'Лише 🔥 (8+)' },
  { v: 9, label: 'Тільки екстрене (9+)' },
];
const DIGEST_HOURS = [7, 8, 9, 12, 18, 21];

// ── простий ліміт на AI-запити, щоб не спалити бюджет ─────────
const aiUsage = new Map();
function aiAllowed(chatId) {
  if (config.adminIds.includes(chatId)) return true;
  const hourAgo = Date.now() - 3600_000;
  const list = (aiUsage.get(chatId) ?? []).filter((t) => t > hourAgo);
  if (list.length >= 25) return false;
  list.push(Date.now());
  aiUsage.set(chatId, list);
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cardKeyboard(story) {
  const kb = new InlineKeyboard();
  if (story.analysis) kb.text('🧠 Глибше', `d:${story.id}`).text('❓ Запитати', `q:${story.id}`);
  else kb.text('🧠 Пояснити', `x:${story.id}`).text('❓ Запитати', `q:${story.id}`);
  const link = story.sources[0]?.link;
  if (link) kb.row().url('🔗 Першоджерело', link);
  return kb;
}

function listKeyboard(stories, filter, offset, total) {
  const kb = new InlineKeyboard();
  stories.forEach((s, i) => {
    kb.text(String(offset + i + 1), `o:${s.id}`);
    if (i % 4 === 3) kb.row();
  });
  kb.row();
  if (offset > 0) kb.text('⬅️ Новіші', `l:${filter}:${Math.max(0, offset - PAGE)}`);
  if (offset + PAGE < total) kb.text('Старіші ➡️', `l:${filter}:${offset + PAGE}`);
  kb.row();
  for (const [k, label] of [['all', '📰 Усі'], ['fin', '💰 Фінанси'], ['ua', '🇺🇦 Україна'], ['world', '🌍 Світ']]) {
    if (k !== filter) kb.text(label, `l:${k}:0`);
  }
  return kb;
}

function settingsText(u) {
  const cats = u.categories.length ? u.categories.map((c) => CATEGORIES[c]?.emoji + ' ' + CATEGORIES[c]?.label).join(', ') : 'усі';
  return [
    '⚙️ <b>Налаштування</b>',
    '',
    `🔔 Сповіщення про важливі новини: <b>${u.subscribed ? 'увімкнено' : 'вимкнено'}</b>`,
    `🎚 Поріг важливості: <b>${u.min_importance}+ з 10</b>`,
    `🗂 Теми сповіщень: <b>${cats}</b>`,
    `🗞 Щоденний дайджест: <b>${u.digest_enabled ? `о ${String(u.digest_hour).padStart(2, '0')}:00` : 'вимкнено'}</b> <i>(${config.timezone})</i>`,
  ].join('\n');
}

function settingsKeyboard(u) {
  const kb = new InlineKeyboard();
  kb.text(u.subscribed ? '🔕 Вимкнути сповіщення' : '🔔 Увімкнути сповіщення', 's:sub').row();
  IMPORTANCE_OPTIONS.forEach((o, i) => {
    kb.text(`${u.min_importance === o.v ? '✅ ' : ''}${o.label}`, `s:imp:${o.v}`);
    if (i % 2 === 1) kb.row();
  });
  const catKeys = ['macro', 'markets', 'business', 'crypto', 'ukraine_economy', 'ukraine', 'world', 'tech'];
  catKeys.forEach((c, i) => {
    const on = u.categories.length === 0 || u.categories.includes(c);
    kb.text(`${on ? '✅' : '▫️'} ${CATEGORIES[c].emoji} ${CATEGORIES[c].label}`, `s:cat:${c}`);
    if (i % 2 === 1) kb.row();
  });
  kb.text(u.digest_enabled ? '🗞 Вимкнути дайджест' : '🗞 Увімкнути дайджест', 's:dig').row();
  if (u.digest_enabled) {
    for (const h of DIGEST_HOURS) kb.text(`${u.digest_hour === h ? '✅' : ''}${String(h).padStart(2, '0')}:00`, `s:dh:${h}`);
  }
  return kb;
}

const HELP = `🤖 <b>Що я вмію</b>

Я збираю новини лише з перевірених джерел — центробанків (Fed, ECB, IMF), провідних фінансових медіа (Bloomberg, WSJ, FT, CNBC, The Economist…), суспільних мовників і надійних українських видань. Кожну важливу новину я не лише переказую, а й <b>пояснюю</b>: що означають терміни, як це вплине на ринки, долар, гривню і твій гаманець.

<b>Кнопки меню</b>
${BTN.feed} — усі свіжі новини
${BTN.finance} — лише фінанси, ринки, економіка
${BTN.top} — найважливіше за добу
${BTN.markets} — індекси, долар, золото, нафта, крипта, курс НБУ + AI-коментар
${BTN.digest} — коротке зведення доби
${BTN.glossary} — фінансові терміни простими словами
${BTN.settings} — сповіщення, теми, час дайджесту

<b>Під кожною новиною</b>
🧠 Глибше — механізм, аналогія, історія, сценарії
❓ Запитати — постав будь-яке запитання саме про цю новину

<b>Просто напиши мені</b> — наприклад:
• <i>що таке ставка ФРС і чому всі за нею стежать?</i>
• <i>чому падає біткоїн?</i>
• <i>як рішення НБУ вплине на депозити?</i>

Команди: /news /finance /top /markets /digest /term <i>термін</i> /sources /settings /reset

<i>⚠️ Бот пояснює новини, але не дає інвестиційних порад.</i>`;

export function createBot(store, pipeline) {
  const bot = new Bot(config.telegramToken);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));

  // Реєструємо / оновлюємо користувача на кожному апдейті
  bot.use(async (ctx, next) => {
    if (ctx.chat) {
      ctx.user = store.upsertUser(ctx.chat.id, { firstName: ctx.from?.first_name, username: ctx.from?.username });
    }
    await next();
  });

  const isAdmin = (ctx) => config.adminIds.includes(ctx.from?.id);

  // ── допоміжні ──────────────────────────────────────────
  async function sendStory(chatId, story) {
    await bot.api.sendMessage(chatId, renderCard(story), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: cardKeyboard(story),
    });
  }

  /** Показує «друкує…» і плейсхолдер, потім замінює на результат. */
  async function withProgress(ctx, label, work, extra = {}) {
    if (!aiAllowed(ctx.chat.id)) {
      return ctx.reply('⏳ Забагато запитів за годину. Спробуй трохи пізніше 🙏');
    }
    await ctx.replyWithChatAction('typing').catch(() => {});
    const ph = await ctx.reply(`⏳ ${label}`);
    const typing = setInterval(() => ctx.replyWithChatAction('typing').catch(() => {}), 4500);
    try {
      const html = await work();
      const parts = splitMessage(html);
      const opts = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
      await ctx.api.editMessageText(ctx.chat.id, ph.message_id, parts[0], { ...opts, ...(parts.length === 1 ? extra : {}) });
      for (let i = 1; i < parts.length; i++) {
        await ctx.reply(parts[i], { ...opts, ...(i === parts.length - 1 ? extra : {}) });
      }
    } catch (e) {
      console.error('AI error:', e);
      const msg = e instanceof AiError && e.message.startsWith('refusal')
        ? '🙅 На це запитання я не можу відповісти. Спробуй сформулювати інакше.'
        : '😔 Щось пішло не так під час аналізу. Спробуй ще раз за хвилину.';
      await ctx.api.editMessageText(ctx.chat.id, ph.message_id, msg).catch(() => {});
    } finally {
      clearInterval(typing);
    }
  }

  async function showList(ctx, filter, offset = 0, edit = false) {
    const f = FILTERS[filter] ?? FILTERS.all;
    const total = store.countStories({ hours: 48, categories: f.categories, minImportance: f.minImportance });
    const stories = store.recentStories({ hours: 48, categories: f.categories, minImportance: f.minImportance, limit: PAGE, offset });
    const text = renderList(f.title, stories, offset, total);
    const opts = { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: listKeyboard(stories, filter, offset, total) };
    if (edit) await ctx.editMessageText(text, opts).catch(() => {});
    else await ctx.reply(text, opts);
  }

  async function showTop(ctx) {
    const stories = store.topStories({ hours: 24, limit: 8 });
    const text = renderList('🔥 <b>Головне за добу</b>', stories, 0, stories.length);
    const kb = new InlineKeyboard();
    stories.forEach((s, i) => {
      kb.text(String(i + 1), `o:${s.id}`);
      if (i % 4 === 3) kb.row();
    });
    await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: kb });
  }

  async function showMarkets(ctx, edit = false) {
    if (!edit) await ctx.replyWithChatAction('typing').catch(() => {});
    const m = await getMarkets({ force: edit });
    const kb = new InlineKeyboard().text('🔄 Оновити', 'm:r').text('🤖 Що рухає ринки?', 'm:ai');
    const opts = { parse_mode: 'HTML', reply_markup: kb };
    if (edit) await ctx.editMessageText(marketsToHtml(m, config.timezone), opts).catch(() => {});
    else await ctx.reply(marketsToHtml(m, config.timezone), opts);
  }

  async function showDigest(ctx) {
    await withProgress(ctx, 'Збираю дайджест доби…', async () => {
      const res = await pipeline.getDigest();
      if (!res) return '🗞 Поки замало новин для дайджесту. Загляни трохи пізніше.';
      const stories = res.storyIds.map((id) => store.getStory(id)).filter(Boolean);
      ctx.digestKeyboard = digestKeyboard(res.digest);
      return renderDigest(res.digest, stories, todayLabel());
    }).then(async () => {
      // Кнопки до дайджесту надсилаємо окремо, щоб withProgress лишався універсальним
      if (ctx.digestKeyboard) await ctx.reply('Відкрити розбір:', { reply_markup: ctx.digestKeyboard });
    });
  }

  function showGlossary(ctx) {
    store.updateUser(ctx.chat.id, { mode: 'term', mode_story_id: null });
    const kb = new InlineKeyboard();
    GLOSSARY.forEach((t, i) => {
      kb.text(t, `g:${i}`);
      if (i % 2 === 1) kb.row();
    });
    return ctx.reply('📚 <b>Словник</b>\n\nОбери термін або просто напиши будь-який інший — поясню простими словами.', {
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  }

  async function showSettings(ctx, edit = false) {
    const u = store.getUser(ctx.chat.id);
    const opts = { parse_mode: 'HTML', reply_markup: settingsKeyboard(u) };
    if (edit) await ctx.editMessageText(settingsText(u), opts).catch(() => {});
    else await ctx.reply(settingsText(u), opts);
  }

  function headlines(limit = 15) {
    return store.topStories({ hours: 24, limit }).map((s) => `[${s.category}] ${s.analysis?.headline ?? s.headline}`);
  }

  async function explainTermCached(term) {
    const key = `term:${term.toLowerCase()}`;
    const cached = store.getKv(key);
    if (cached) return cached;
    const html = sanitizeHtml(await explainTerm(term));
    store.setKv(key, html);
    return html;
  }

  // ── команди ────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    store.updateUser(ctx.chat.id, { mode: null });
    const name = ctx.from?.first_name ? `, ${esc(ctx.from.first_name)}` : '';
    await ctx.reply(
      `👋 Привіт${name}!\n\nЯ — твій <b>фінансовий новинний аналітик</b>. Щохвилини стежу за перевіреними джерелами — від Federal Reserve і Bloomberg до Економічної правди — відбираю найважливіше і <b>пояснюю людською мовою</b>: що сталося, що означають терміни, як це вплине на ринки, долар і гривню.\n\n🔔 Сповіщення про важливі новини вже <b>увімкнено</b> (поріг 7/10), а щоранку о 09:00 прийде дайджест. Змінити — у ${BTN.settings}.\n\nТисни кнопки внизу або просто напиши запитання 👇`,
      { parse_mode: 'HTML', reply_markup: mainKeyboard },
    );
  });

  bot.command('help', (ctx) => ctx.reply(HELP, { parse_mode: 'HTML', reply_markup: mainKeyboard }));
  bot.command('news', (ctx) => showList(ctx, 'all'));
  bot.command('finance', (ctx) => showList(ctx, 'fin'));
  bot.command('ukraine', (ctx) => showList(ctx, 'ua'));
  bot.command('world', (ctx) => showList(ctx, 'world'));
  bot.command('top', (ctx) => showTop(ctx));
  bot.command('markets', (ctx) => showMarkets(ctx));
  bot.command('digest', (ctx) => showDigest(ctx));
  bot.command('settings', (ctx) => showSettings(ctx));
  bot.command('glossary', (ctx) => showGlossary(ctx));
  bot.command('reset', async (ctx) => {
    store.clearHistory(ctx.chat.id);
    store.updateUser(ctx.chat.id, { mode: null, mode_story_id: null });
    await ctx.reply('🧹 Контекст розмови очищено.', { reply_markup: mainKeyboard });
  });
  bot.command('term', async (ctx) => {
    const term = ctx.match?.trim();
    if (!term) return showGlossary(ctx);
    await withProgress(ctx, `Пояснюю «${term}»…`, () => explainTermCached(term.slice(0, 100)));
  });
  bot.command('sources', async (ctx) => {
    const groups = {};
    for (const s of getSources()) (groups[TIER_LABEL[s.tier]] ??= new Set()).add(s.name);
    const text = Object.entries(groups)
      .map(([tier, names]) => `<b>${tier[0].toUpperCase() + tier.slice(1)}:</b> ${[...names].map(esc).join(', ')}`)
      .join('\n\n');
    await ctx.reply(`✅ <b>Перевірені джерела</b>\n\n${text}\n\n<i>Жодних анонімних Telegram-каналів чи сумнівних сайтів. Кожна картка містить посилання на першоджерело.</i>`, { parse_mode: 'HTML' });
  });

  // ── адмінські ──────────────────────────────────────────
  bot.command('stats', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const s = store.stats();
    const lr = pipeline.lastRun;
    await ctx.reply(
      `📈 <b>Статистика</b>\nКористувачі: ${s.users} (підписані: ${s.subscribers})\nСтатей за 24 год: ${s.articles24h}\nІсторій за 24 год: ${s.stories24h} (з розбором: ${s.analyzed24h})\nУ черзі: ${s.pending}\nОстанній цикл: ${lr ? `${timeAgo(lr.at)}, ${lr.ms} мс, +${lr.added ?? 0} статей` : '—'}`,
      { parse_mode: 'HTML' },
    );
  });
  bot.command('refresh', async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.reply('🔄 Запускаю цикл оновлення…');
    const r = await pipeline.runCycle();
    await ctx.reply(r.skipped ? '⏳ Цикл уже виконується.' : r.error ? `❌ ${esc(r.error)}` : `✅ +${r.added} статей, ${r.newStories} нових історій, ${r.analyzed} розборів`, { parse_mode: 'HTML' });
  });
  bot.command('health', async (ctx) => {
    if (!isAdmin(ctx)) return;
    const h = new Map(store.sourceHealth().map((r) => [r.source_id, r]));
    const lines = getSources().map((s) => {
      const r = h.get(s.id);
      if (!r) return `⚪️ ${s.id} — ще не перевірявся`;
      if (r.fail_streak > 0) return `🔴 ${s.id} — ${esc(r.last_error ?? '')} (×${r.fail_streak})`;
      return `🟢 ${s.id} — ${r.items_last} шт., ${timeAgo(r.last_ok)}`;
    });
    for (const part of splitMessage(`🩺 <b>Стан джерел</b>\n\n${lines.join('\n')}`)) await ctx.reply(part, { parse_mode: 'HTML' });
  });

  // ── кнопки головного меню ──────────────────────────────
  const menu = {
    [BTN.feed]: (ctx) => showList(ctx, 'all'),
    [BTN.finance]: (ctx) => showList(ctx, 'fin'),
    [BTN.top]: showTop,
    [BTN.markets]: (ctx) => showMarkets(ctx),
    [BTN.digest]: showDigest,
    [BTN.glossary]: showGlossary,
    [BTN.settings]: (ctx) => showSettings(ctx),
    [BTN.help]: (ctx) => ctx.reply(HELP, { parse_mode: 'HTML', reply_markup: mainKeyboard }),
  };
  for (const [label, handler] of Object.entries(menu)) {
    bot.hears(label, async (ctx) => {
      if (label !== BTN.glossary) store.updateUser(ctx.chat.id, { mode: null, mode_story_id: null });
      await handler(ctx);
    });
  }

  // ── inline-кнопки ──────────────────────────────────────
  bot.callbackQuery(/^l:(\w+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showList(ctx, ctx.match[1], Number(ctx.match[2]), true);
  });

  bot.callbackQuery(/^o:(\d+)$/, async (ctx) => {
    const story = store.getStory(Number(ctx.match[1]));
    if (!story) return ctx.answerCallbackQuery({ text: 'Новина вже застаріла 🤷', show_alert: true });
    await ctx.answerCallbackQuery();
    if (story.analysis) return sendStory(ctx.chat.id, story);
    // Немає розбору — генеруємо на льоту
    await withProgress(ctx, 'Аналізую новину…', async () => renderCard(await pipeline.ensureAnalysis(story.id)), {
      reply_markup: cardKeyboard({ ...story, analysis: true }),
    });
  });

  bot.callbackQuery(/^x:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: '🧠 Аналізую…' });
    const id = Number(ctx.match[1]);
    await withProgress(ctx, 'Аналізую новину…', async () => renderCard(await pipeline.ensureAnalysis(id)), {
      reply_markup: cardKeyboard({ ...store.getStory(id), analysis: true }),
    });
  });

  bot.callbackQuery(/^d:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: '🧠 Готую поглиблений розбір…' });
    const id = Number(ctx.match[1]);
    await withProgress(ctx, 'Готую поглиблений розбір…', async () => {
      const sections = await pipeline.ensureDeep(id);
      return renderDeep(store.getStory(id), sections);
    }, { reply_markup: new InlineKeyboard().text('❓ Запитати про це', `q:${id}`) });
  });

  bot.callbackQuery(/^q:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const story = store.getStory(id);
    if (!story) return ctx.answerCallbackQuery({ text: 'Новина вже застаріла 🤷', show_alert: true });
    store.updateUser(ctx.chat.id, { mode: 'ask_story', mode_story_id: id });
    store.clearHistory(ctx.chat.id);
    await ctx.answerCallbackQuery();
    await ctx.reply(`❓ Пиши запитання про:\n<b>${esc(story.analysis?.headline ?? story.headline)}</b>\n\n<i>Наприклад: «а як це вплине на курс гривні?» або «поясни простіше».</i>`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('🔚 Завершити тему', 'q:end'),
    });
  });

  bot.callbackQuery('q:end', async (ctx) => {
    store.updateUser(ctx.chat.id, { mode: null, mode_story_id: null });
    store.clearHistory(ctx.chat.id);
    await ctx.answerCallbackQuery({ text: 'Готово! Можеш питати про будь-що 🙂' });
  });

  bot.callbackQuery(/^g:(\d+)$/, async (ctx) => {
    const term = GLOSSARY[Number(ctx.match[1])];
    if (!term) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    await withProgress(ctx, `Пояснюю «${term}»…`, () => explainTermCached(term));
  });

  bot.callbackQuery('m:r', async (ctx) => {
    await ctx.answerCallbackQuery({ text: '🔄 Оновлюю…' });
    await showMarkets(ctx, true);
  });

  bot.callbackQuery('m:ai', async (ctx) => {
    await ctx.answerCallbackQuery();
    await withProgress(ctx, 'Аналізую, що рухає ринки…', async () => {
      const key = `mcomment:${new Date().toISOString().slice(0, 15)}`; // кеш на ~10 хв
      const cached = store.getKv(key);
      if (cached) return cached;
      const m = await getMarkets();
      const fin = store.topStories({ hours: 24, limit: 12, categories: FINANCE_CATEGORIES }).map((s) => s.analysis?.headline ?? s.headline);
      const html = `🤖 <b>Що рухає ринки</b>\n\n${sanitizeHtml(await marketCommentary(marketsToPlain(m), fin))}\n\n<i>Не є інвестиційною порадою.</i>`;
      store.setKv(key, html);
      return html;
    });
  });

  // налаштування
  bot.callbackQuery(/^s:(\w+)(?::(\w+))?$/, async (ctx) => {
    const [, action, arg] = ctx.match;
    const u = store.getUser(ctx.chat.id);
    if (action === 'sub') store.updateUser(u.chat_id, { subscribed: !u.subscribed });
    if (action === 'imp') store.updateUser(u.chat_id, { min_importance: Number(arg) });
    if (action === 'dig') store.updateUser(u.chat_id, { digest_enabled: !u.digest_enabled });
    if (action === 'dh') store.updateUser(u.chat_id, { digest_hour: Number(arg) });
    if (action === 'cat' && CATEGORIES[arg]) {
      const all = ['macro', 'markets', 'business', 'crypto', 'ukraine_economy', 'ukraine', 'world', 'tech'];
      let cats = u.categories.length ? [...u.categories] : [...all];
      cats = cats.includes(arg) ? cats.filter((c) => c !== arg) : [...cats, arg];
      if (!cats.length) return ctx.answerCallbackQuery({ text: 'Залиш хоча б одну тему 🙂', show_alert: true });
      store.updateUser(u.chat_id, { categories: cats.length === all.length ? [] : cats });
    }
    await ctx.answerCallbackQuery({ text: '✅ Збережено' });
    await showSettings(ctx, true);
  });

  // ── вільний текст: запитання до AI ─────────────────────
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return ctx.reply('Не знаю такої команди 🤔 Натисни /help');
    if (ctx.chat.type !== 'private') {
      const me = ctx.me.username;
      const mentioned = text.includes(`@${me}`) || ctx.message.reply_to_message?.from?.id === ctx.me.id;
      if (!mentioned) return;
    }
    const question = text.replace(new RegExp(`@${ctx.me.username}`, 'g'), '').trim().slice(0, 1500);
    if (!question) return;
    const u = store.getUser(ctx.chat.id);

    if (u.mode === 'term') {
      store.updateUser(u.chat_id, { mode: null });
      return withProgress(ctx, `Пояснюю «${question.slice(0, 60)}»…`, () => explainTermCached(question.slice(0, 100)));
    }

    const story = u.mode === 'ask_story' && u.mode_story_id ? store.getStory(u.mode_story_id) : null;
    const extra = story ? { reply_markup: new InlineKeyboard().text('🔚 Завершити тему', 'q:end') } : {};
    await withProgress(ctx, 'Думаю…', async () => {
      const history = store.history(ctx.chat.id);
      const answer = sanitizeHtml(await answerQuestion({ question, history, story, headlines: headlines() }));
      store.addHistory(ctx.chat.id, 'user', question);
      store.addHistory(ctx.chat.id, 'assistant', answer);
      return answer;
    }, extra);
  });

  bot.catch((err) => {
    console.error('Bot error:', err.error instanceof GrammyError ? err.error.description : err.error);
  });

  // ── розсилка ───────────────────────────────────────────
  async function safeSend(chatId, fn) {
    try {
      await fn();
      return true;
    } catch (e) {
      if (e instanceof GrammyError && (e.error_code === 403 || /chat not found/i.test(e.description))) {
        store.updateUser(chatId, { subscribed: false, digest_enabled: false });
      } else console.error(`send to ${chatId} failed:`, e.message);
      return false;
    }
  }

  pipeline.onStoriesReady = async (stories) => {
    for (const u of store.subscribers()) {
      const matching = stories
        .filter((s) => s.importance >= u.min_importance && (u.categories.length === 0 || u.categories.includes(s.category)))
        .filter((s) => !store.wasDelivered(u.chat_id, s.id))
        .slice(0, 3); // не більше 3 сповіщень за цикл
      for (const s of matching) {
        const ok = await safeSend(u.chat_id, () => sendStory(u.chat_id, s));
        if (!ok) break;
        store.markDelivered(u.chat_id, s.id);
        await sleep(60);
      }
    }
  };

  function digestKeyboard(d) {
    const kb = new InlineKeyboard();
    d.highlights.forEach((h, i) => {
      kb.text(String(i + 1), `o:${h.storyId}`);
      if (i % 4 === 3) kb.row();
    });
    return kb;
  }

  function todayLabel() {
    return new Date().toLocaleDateString('uk-UA', { timeZone: config.timezone, weekday: 'long', day: 'numeric', month: 'long' });
  }

  async function sendDigests(hour, date) {
    const users = store.digestUsers(hour, date);
    if (!users.length) return;
    const res = await pipeline.getDigest();
    if (!res) return;
    const stories = res.storyIds.map((id) => store.getStory(id)).filter(Boolean);
    const text = renderDigest(res.digest, stories, todayLabel());
    for (const u of users) {
      store.updateUser(u.chat_id, { last_digest_date: date });
      await safeSend(u.chat_id, () =>
        bot.api.sendMessage(u.chat_id, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: digestKeyboard(res.digest) }),
      );
      await sleep(60);
    }
  }

  async function setupProfile() {
    await bot.api.setMyCommands([
      { command: 'news', description: '📰 Стрічка новин' },
      { command: 'finance', description: '💰 Фінанси та економіка' },
      { command: 'top', description: '🔥 Головне за добу' },
      { command: 'markets', description: '📊 Ринки зараз' },
      { command: 'digest', description: '🗞 Дайджест доби' },
      { command: 'term', description: '📚 Пояснити термін' },
      { command: 'ukraine', description: '🇺🇦 Новини України' },
      { command: 'world', description: '🌍 Світ і технології' },
      { command: 'settings', description: '⚙️ Налаштування' },
      { command: 'sources', description: '✅ Джерела' },
      { command: 'reset', description: '🧹 Очистити контекст розмови' },
      { command: 'help', description: '❓ Допомога' },
    ]);
    await bot.api.setMyShortDescription('Фінансові новини з перевірених джерел + пояснення простими словами 🇺🇦').catch(() => {});
    await bot.api
      .setMyDescription(
        'Збираю новини з перевірених джерел (Fed, ECB, Bloomberg, WSJ, FT, Економічна правда…) з особливою увагою до фінансів і пояснюю їх українською: що сталося, що означають терміни, як вплине на ринки, долар і гривню.',
      )
      .catch(() => {});
  }

  return { bot, sendDigests, setupProfile };
}
