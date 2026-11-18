import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleAnalysis } from './fixtures/sample.js';
import { renderCard, renderBrief, sanitizeHtml, splitMessage, balanceTags, renderDigest } from '../src/format.js';


const story = (over = {}) => ({
  id: 1, headline: 'Fed cuts rates', category: 'macro', importance: 9, finance_score: 10, created_at: Date.now() - 5 * 60_000,
  analysis: sampleAnalysis,
  sources: [{ source_name: 'Federal Reserve', link: 'https://federalreserve.gov/a?x=1&y=<2>', title: 't', snippet: 's' }, { source_name: 'CNBC', link: 'https://cnbc.com/b', title: 't2' }],
  ...over,
});

test('картка містить ключові блоки і екранує HTML', () => {
  const html = renderCard(story());
  assert.match(html, /<b>ФРС знизила ставку/);
  assert.match(html, /📈 Вплив на ринки/);
  assert.match(html, /🟢 ▲ <b>S&amp;P 500<\/b>/);
  assert.match(html, /x=1&amp;y=&lt;2&gt;/);
  assert.match(html, /🔥🔥🔥 9\/10/);
  assert.equal(balanceTags(html), html);
});

test('задовга картка скорочується до ліміту Telegram', () => {
  const long = { ...sampleAnalysis, why_it_matters: 'а'.repeat(2000), what_next: 'б'.repeat(2000), terms: Array(4).fill({ term: 'X', explanation: 'в'.repeat(500) }) };
  const html = renderCard(story({ analysis: long }));
  assert.ok(html.length <= 4000, `довжина ${html.length}`);
  assert.match(html, /Вплив на ринки/);
});

test('коротка картка без аналізу', () => {
  const html = renderBrief(story({ analysis: null }));
  assert.match(html, /Пояснити/);
});

test('sanitizeHtml: дозволені теги лишаються, решта екранується', () => {
  const out = sanitizeHtml('**Жирний** <b>ok</b> <script>x</script> 5 < 6 <i>незакритий');
  assert.equal(out, '<b>Жирний</b> <b>ok</b> &lt;script&gt;x&lt;/script&gt; 5 &lt; 6 <i>незакритий</i>');
});

test('splitMessage ріже по абзацах', () => {
  const parts = splitMessage(Array(10).fill('х'.repeat(900)).join('\n\n'));
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 4000));
});

test('дайджест', () => {
  const html = renderDigest({ intro: 'День ФРС', highlights: [{ storyId: 1, line: 'Ставку знижено' }], market_mood: 'risk-on', outlook: 'CPI' }, [story()], 'середа, 18 листопада');
  assert.match(html, /1\. 🏦 Ставку знижено/);
});
