import { config, assertConfig } from './config.js';
import { Store } from './db.js';
import { Pipeline } from './pipeline.js';
import { createBot } from './bot.js';

assertConfig();

const store = new Store(config.dbPath);
const pipeline = new Pipeline(store);
const { bot, sendDigests, setupProfile } = createBot(store, pipeline);

/** Поточні година й дата в часовому поясі користувачів. */
function localNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return { hour: Number(parts.hour), date: `${parts.year}-${parts.month}-${parts.day}` };
}

const timers = [];

async function main() {
  await setupProfile().catch((e) => console.warn('setMyCommands:', e.message));

  // Перший запуск на порожній базі — збираємо новини «тихо», без розсилки старого
  if (!store.getKv('bootstrapped')) {
    pipeline.silent = true;
    store.setKv('bootstrapped', true);
  }

  const cycle = () => pipeline.runCycle();
  cycle();
  timers.push(setInterval(cycle, config.fetchIntervalMin * 60_000));

  // Дайджести: перевіряємо щохвилини, кому вже час
  timers.push(
    setInterval(() => {
      const { hour, date } = localNow();
      sendDigests(hour, date).catch((e) => console.error('digest error:', e.message));
    }, 60_000),
  );

  // Прибирання старих даних раз на 6 годин
  timers.push(setInterval(() => store.cleanup(), 6 * 3600_000));

  await bot.start({
    allowed_updates: ['message', 'callback_query'],
    onStart: (me) => console.log(`✅ Бот @${me.username} запущено. Модель: ${config.model}. Оновлення кожні ${config.fetchIntervalMin} хв.`),
  });
}

async function shutdown(signal) {
  console.log(`\n${signal}: зупиняю бота…`);
  timers.forEach(clearInterval);
  await bot.stop().catch(() => {});
  store.db.close();
  process.exit(0);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
