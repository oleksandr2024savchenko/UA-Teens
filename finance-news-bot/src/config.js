import fs from 'node:fs';
import path from 'node:path';

// Завантажуємо .env, якщо він є (Node 22 вміє це без dotenv)
if (fs.existsSync('.env')) process.loadEnvFile('.env');

const int = (name, def) => {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : def;
};
const list = (name) =>
  (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  model: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
  triageModel: process.env.CLAUDE_TRIAGE_MODEL || process.env.CLAUDE_MODEL || 'claude-opus-5-5',
  fetchIntervalMin: Math.max(3, int('FETCH_INTERVAL_MIN', 10)),
  analyzeMinImportance: int('ANALYZE_MIN_IMPORTANCE', 6),
  maxAnalysesPerCycle: int('MAX_ANALYSES_PER_CYCLE', 6),
  maxArticleAgeHours: int('MAX_ARTICLE_AGE_HOURS', 24),
  timezone: process.env.TIMEZONE || 'Europe/Kyiv',
  adminIds: list('ADMIN_IDS').map(Number),
  dbPath: path.resolve(process.env.DB_PATH || './data/bot.db'),
  disabledSources: new Set(list('DISABLED_SOURCES')),
};

export function assertConfig() {
  const missing = [];
  if (!config.telegramToken) missing.push('TELEGRAM_BOT_TOKEN');
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) missing.push('ANTHROPIC_API_KEY');
  if (missing.length) {
    console.error(`❌ Не задано: ${missing.join(', ')}. Скопіюй .env.example у .env і заповни.`);
    process.exit(1);
  }
}
