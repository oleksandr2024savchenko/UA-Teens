import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { config } from './config.js';
import { CATEGORY_KEYS } from './db.js';

let client;
const getClient = () => (client ??= new Anthropic({ maxRetries: 3, timeout: 180_000 }));

export class AiError extends Error {}

// Server-side fallback при відмові моделі — доступний для сімейств Opus 5.x / Fable 5.x / Sonnet 5.5
const supportsFallback = (model) => /claude-(opus-5|fable-5|mythos-5|sonnet-5-5)/.test(model);

const STYLE = `Ти — сильний фінансовий аналітик і редактор новин для україномовної аудиторії Telegram-бота.

Мова і стиль:
- Пиши українською. Ключові фінансові терміни, індикатори, назви інструментів і жаргон давай також англійською, як це роблять в українському фінансовому середовищі: «ставка ФРС (Fed funds rate)», «прибутковість 10-річних Treasuries», «настрій risk-off», «hawkish-сигнал», «guidance», «S&P 500».
- Пояснюй так, щоб зрозумів розумний 16-річний підліток без фінансової освіти, але без примітивізації. Коротко, по суті, без води й канцеляриту.
- Простими словами — через причинно-наслідковий ланцюжок: «ставка ↑ → кредити дорожчають → компаніям складніше рости → акції під тиском».

Чесність:
- Факти бери тільки з наданих джерел. Не вигадуй цифри, дати, цитати. Якщо в джерелах чогось немає — не стверджуй цього.
- Загальні знання (як працює ставка, історичні прецеденти) використовувати можна, але не видавай їх за свіжі факти.
- Відокремлюй факти від прогнозів; прогнози формулюй як ймовірності/сценарії, а не як гарантії.
- Ніколи не давай персональних інвестиційних порад («купуй/продавай»).`;

async function call({ model = config.model, system, messages, effort = 'medium', schema = null, maxTokens = 16000 }) {
  const params = {
    model,
    max_tokens: maxTokens,
    system,
    messages,
    output_config: { effort, ...(schema ? { format: betaZodOutputFormat(schema) } : {}) },
  };
  if (supportsFallback(model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  const api = getClient().beta.messages;
  const res = schema ? await api.parse(params) : await api.create(params);

  if (res.stop_reason === 'refusal') throw new AiError(`refusal: ${res.stop_details?.category ?? 'unknown'}`);
  if (res.stop_reason === 'max_tokens') throw new AiError('відповідь обрізана (max_tokens)');
  if (schema) {
    if (!res.parsed_output) throw new AiError('не вдалося розібрати структуровану відповідь');
    return res.parsed_output;
  }
  return res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

export const todayLine = () =>
  `Сьогодні: ${new Date().toLocaleString('uk-UA', { timeZone: config.timezone, dateStyle: 'full', timeStyle: 'short' })} (${config.timezone}).`;

// ─────────────────────────────────────────────────────────
// 1. Відбір і кластеризація свіжих статей
// ─────────────────────────────────────────────────────────
export const TriageSchema = z.object({
  clusters: z.array(
    z.object({
      items: z.array(z.string()).describe('Ідентифікатори статей (a1, a2…) про одну й ту саму подію'),
      existing_story: z.string().nullable().describe('id вже відомої історії (s123), якщо це її продовження, інакше null'),
      headline_uk: z.string().describe('Короткий інформативний заголовок українською, до 100 символів'),
      category: z.enum(CATEGORY_KEYS),
      importance: z.number().int().describe('1–10'),
      finance_score: z.number().int().describe('0–10: наскільки подія важлива саме для фінансів і ринків'),
    }),
  ),
});

const TRIAGE_SYSTEM = `${STYLE}

Зараз твоя роль — випусковий редактор. Тобі дають список свіжих статей із перевірених джерел. Завдання:
1. Згрупуй статті про ту саму подію в один кластер (різні видання часто пишуть про одне й те саме).
2. Якщо подія — продовження вже відомої історії зі списку «Вже опубліковано», вкажи її id в existing_story.
3. Відкинь шум: lifestyle, спорт, шоу-бізнес, кримінальну хроніку без суспільного значення, рекламу, промо, гороскопи, дрібні корпоративні пресрелізи, колонки думок без нових фактів, оглядові «5 акцій, які варто купити». Відкинуті статті просто не включай у жоден кластер.
4. Оціни importance (1–10) з позиції людини, яка хоче розуміти світ і особливо фінанси:
   9–10 — рухає світові ринки: рішення ФРС/ЄЦБ щодо ставки, сильний сюрприз в інфляції (CPI) чи ринку праці США (NFP), обвал/ралі індексів, ескалація війни з наслідками для ринків, дефолт великої держави/банку.
   7–8 — суттєво: рішення НБУ, звіти мегакапів (Apple, Nvidia…), різкі рухи нафти/золота/долара, великі M&A, важливі санкції, ключові новини економіки України (бюджет, МВФ, гривня).
   5–6 — помітно, варто знати.
   1–4 — дрібниця.
   Фінансовим і макроекономічним подіям давай пріоритет; важливі нефінансові події (геополітика, війна, технології) теж включай.
5. finance_score — окремо, наскільки подія стосується фінансів/ринків/економіки.
6. category: macro (центробанки, інфляція, ставки, макростатистика), markets (акції, облігації, валюти, сировина), business (компанії, звітності, угоди), crypto, ukraine_economy (економіка, фінанси, бюджет, гривня України), ukraine (інші важливі новини України), world (геополітика, світ), tech, other.`;

export async function triage(articles, recentStories) {
  const idMap = new Map();
  const lines = articles.map((a, i) => {
    const key = `a${i + 1}`;
    idMap.set(key, a.id);
    const snippet = a.snippet ? ` — ${a.snippet.slice(0, 220)}` : '';
    return `${key} [${a.source_name}] ${a.title}${snippet}`;
  });
  const known = recentStories.map((s) => `s${s.id}: ${s.headline} (${s.category})`).join('\n') || '—';

  const out = await call({
    model: config.triageModel,
    system: TRIAGE_SYSTEM,
    effort: 'low',
    schema: TriageSchema,
    messages: [
      {
        role: 'user',
        content: `${todayLine()}\n\nВже опубліковано за останню добу:\n${known}\n\nНові статті:\n${lines.join('\n')}`,
      },
    ],
  });

  const used = new Set();
  return out.clusters
    .map((c) => {
      const ids = c.items.map((k) => idMap.get(k.trim())).filter((id) => id && !used.has(id));
      ids.forEach((id) => used.add(id));
      const existing = c.existing_story ? Number.parseInt(String(c.existing_story).replace(/^s/i, ''), 10) : null;
      return {
        articleIds: ids,
        existingStoryId: Number.isFinite(existing) ? existing : null,
        headline: c.headline_uk.trim().slice(0, 140),
        category: CATEGORY_KEYS.includes(c.category) ? c.category : 'other',
        importance: clampInt(c.importance, 1, 10),
        financeScore: clampInt(c.finance_score, 0, 10),
      };
    })
    .filter((c) => c.articleIds.length > 0);
}

// ─────────────────────────────────────────────────────────
// 2. Повний розбір історії
// ─────────────────────────────────────────────────────────
export const AnalysisSchema = z.object({
  headline: z.string().describe('Заголовок українською, до 110 символів, інформативний, без клікбейту'),
  emoji: z.string().describe('Одна доречна емодзі'),
  tldr: z.string().describe('Суть в 1–2 реченнях'),
  what_happened: z.string().describe('Що сталося: 2–4 речення, лише факти з джерел'),
  why_it_matters: z.string().describe('Чому це важливо: 2–4 речення'),
  terms: z
    .array(z.object({ term: z.string().describe('Термін, бажано з англ. оригіналом'), explanation: z.string().describe('1–2 речення простими словами, можна з аналогією') }))
    .describe('0–4 ключові терміни з новини, які новачок може не знати'),
  market_impact: z
    .array(
      z.object({
        asset: z.string().describe('Актив/ринок: S&P 500, долар (USD), золото, нафта Brent, Bitcoin, гривня, облігації…'),
        direction: z.enum(['up', 'down', 'mixed', 'neutral']),
        comment: z.string().describe('Чому саме так — коротко, через механізм'),
      }),
    )
    .describe('0–5 пунктів. Для нефінансових подій — лише якщо є реальний вплив'),
  ukraine_angle: z.string().describe('Що це означає для України, гривні, українців. Порожній рядок, якщо зв’язку немає'),
  what_next: z.string().describe('Що далі: можливі сценарії та їхні тригери, 2–3 речення'),
  watch: z.array(z.string()).describe('0–3 конкретні події/індикатори, за якими варто стежити'),
  sentiment: z.enum(['risk_on', 'risk_off', 'neutral', 'mixed']),
  confidence: z.enum(['high', 'medium', 'low']).describe('Наскільки впевнено можна робити висновки з наявних даних'),
});

const ANALYSIS_SYSTEM = `${STYLE}

Зараз ти пишеш картку-пояснення новини для Telegram. Аудиторія хоче не лише знати, що сталося, а й розуміти механіку: що означають терміни, як це вплине на ринки, гроші та Україну.
Обмеження довжини: вся картка має вміщатися приблизно в 2500 символів. Кожне поле — щільне й корисне.
Якщо новина фінансова — особливо ретельно розпиши market_impact і terms. Якщо нефінансова — поясни контекст і, якщо є, економічні наслідки.`;

export async function analyzeStory(story, articles, texts = {}) {
  const blocks = articles
    .map((a, i) => {
      const text = texts[a.id] ? `\nТекст (фрагмент):\n${texts[a.id]}` : '';
      return `### Джерело ${i + 1}: ${a.source_name}\nЗаголовок: ${a.title}\nОпис: ${a.snippet || '—'}${text}`;
    })
    .join('\n\n');
  const analysis = await call({
    system: ANALYSIS_SYSTEM,
    effort: 'medium',
    schema: AnalysisSchema,
    messages: [{ role: 'user', content: `${todayLine()}\nКатегорія: ${story.category}\n\n${blocks}` }],
  });
  analysis.terms = analysis.terms.slice(0, 4);
  analysis.market_impact = analysis.market_impact.slice(0, 5);
  analysis.watch = analysis.watch.slice(0, 3);
  return analysis;
}

// ─────────────────────────────────────────────────────────
// 3. Поглиблене пояснення (на запит)
// ─────────────────────────────────────────────────────────
export const DeepSchema = z.object({
  sections: z
    .array(z.object({ title: z.string(), emoji: z.string(), body: z.string() }))
    .describe('4–6 розділів'),
});

export async function deepDive(story) {
  const out = await call({
    system: `${STYLE}

Зроби поглиблений розбір новини для новачка, який хоче реально розібратися. Розділи (адаптуй під тему):
- «Як це працює» — механізм крок за кроком, ланцюжок причин і наслідків.
- «Аналогія з життя» — порівняння з побутовою ситуацією.
- «Історичний контекст» — схожі випадки в минулому і що тоді було з ринками (лише загальновідомі факти).
- «Сценарії» — базовий / оптимістичний / песимістичний, від чого залежить кожен.
- «Що це означає для тебе» — гаманець, депозити, кредити, курс, інвестиції (без порад купувати/продавати).
Кожен розділ — 3–6 речень. Загалом до 3000 символів. Без markdown-розмітки.`,
    effort: 'medium',
    schema: DeepSchema,
    messages: [{ role: 'user', content: `${todayLine()}\n\nНовина:\n${storyContext(story)}` }],
  });
  return out.sections.slice(0, 6);
}

// ─────────────────────────────────────────────────────────
// 4. Вільні запитання / словник / коментар ринку
// ─────────────────────────────────────────────────────────
const HTML_RULES = `Формат відповіді — Telegram HTML: дозволені лише теги <b>, <i>, <u>, <code>, <blockquote>. Жодного markdown (** або #). Списки — рядками з «•». Абзаци розділяй порожнім рядком. До 2500 символів.`;

export function storyContext(story) {
  const a = story.analysis;
  const srcs = story.sources.map((s) => `- ${s.source_name}: ${s.title}${s.snippet ? ` — ${s.snippet.slice(0, 300)}` : ''}`).join('\n');
  if (!a) return `${story.headline}\nДжерела:\n${srcs}`;
  return [
    `Заголовок: ${a.headline}`,
    `Суть: ${a.tldr}`,
    `Що сталося: ${a.what_happened}`,
    `Чому важливо: ${a.why_it_matters}`,
    a.market_impact.length ? `Вплив: ${a.market_impact.map((m) => `${m.asset} ${m.direction} — ${m.comment}`).join('; ')}` : '',
    `Джерела:\n${srcs}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function answerQuestion({ question, history = [], story = null, headlines = [] }) {
  const ctx = [
    todayLine(),
    headlines.length ? `Головні новини за добу (для контексту):\n${headlines.map((h) => `- ${h}`).join('\n')}` : '',
    story ? `Користувач питає про цю новину:\n${storyContext(story)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const messages = [];
  for (const h of history) {
    const role = h.role === 'assistant' ? 'assistant' : 'user';
    if (messages.length === 0 && role === 'assistant') continue;
    messages.push({ role, content: h.content });
  }
  messages.push({ role: 'user', content: `${ctx}\n\nЗапитання: ${question}` });

  return call({
    system: `${STYLE}

Ти відповідаєш на запитання користувача в чаті. Якщо запитання про новини — спирайся на контекст новин. Якщо про фінансове поняття — поясни простими словами, з прикладом і тим, як це впливає на ринки та звичайну людину. Якщо питання не про новини/економіку/фінанси/світ — коротко відповідай і м'яко поверни розмову до теми бота. Якщо даних про актуальні цифри немає — чесно скажи, що не маєш живих котирувань, і порадь кнопку «📊 Ринки».
${HTML_RULES}`,
    effort: 'medium',
    messages,
  });
}

export async function explainTerm(term) {
  return call({
    system: `${STYLE}

Поясни фінансовий/економічний термін. Структура:
<b>Термін (English term)</b>
Що це — 2–3 речення простими словами.
<b>Аналогія:</b> побутове порівняння.
<b>Як впливає на ринки:</b> 2–4 пункти з «•» через механізм (↑/↓).
<b>Приклад:</b> реальний відомий приклад.
${HTML_RULES} Не більше 1500 символів.`,
    effort: 'low',
    messages: [{ role: 'user', content: `Термін: ${term}` }],
  });
}

export const DigestSchema = z.object({
  intro: z.string().describe('1–2 речення: головний настрій доби'),
  highlights: z
    .array(z.object({ story: z.string().describe('id історії (s123)'), line: z.string().describe('Одне речення: що сталося і чому важливо') }))
    .describe('5–8 найважливіших подій, фінанси в пріоритеті'),
  market_mood: z.string().describe('Настрій ринків одним-двома реченнями (risk-on / risk-off тощо)'),
  outlook: z.string().describe('На що дивитися далі: 1–3 речення'),
});

export async function makeDigest(stories, marketsText = '') {
  const list = stories.map((s) => `s${s.id} [${s.category}, важл. ${s.importance}]: ${s.analysis?.headline ?? s.headline}${s.analysis ? ` — ${s.analysis.tldr}` : ''}`).join('\n');
  const out = await call({
    system: `${STYLE}

Склади короткий ранковий/вечірній дайджест: найважливіше за добу, з фокусом на фінанси та ринки, але не пропускаючи ключові світові та українські події. Кожен рядок — щільний і зрозумілий.`,
    effort: 'low',
    schema: DigestSchema,
    messages: [{ role: 'user', content: `${todayLine()}\n\nІсторії за добу:\n${list}${marketsText ? `\n\nРинки зараз:\n${marketsText}` : ''}` }],
  });
  const byId = new Map(stories.map((s) => [s.id, s]));
  out.highlights = out.highlights
    .map((h) => ({ ...h, storyId: Number.parseInt(String(h.story).replace(/^s/i, ''), 10) }))
    .filter((h) => byId.has(h.storyId))
    .slice(0, 8);
  return out;
}

export async function marketCommentary(marketsText, headlines) {
  return call({
    system: `${STYLE}

Тобі дають знімок ринків (ціни та зміни за день) і головні фінансові новини. Поясни коротко, що рухає ринки зараз: 3–5 пунктів «•», кожен — актив/рух + ймовірна причина з новин. Якщо зв'язок неочевидний — так і скажи. Наприкінці одне речення «Загальний настрій: …».
${HTML_RULES} До 1500 символів.`,
    effort: 'low',
    messages: [{ role: 'user', content: `${todayLine()}\n\nРинки:\n${marketsText}\n\nНовини:\n${headlines.map((h) => `- ${h}`).join('\n')}` }],
  });
}
