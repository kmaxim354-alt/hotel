require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const WEBAPP_URL = (process.env.WEBAPP_URL || '').trim();
const PORT = Number(process.env.PORT || 3000);
const SKIP_BOT = process.env.SKIP_BOT === '1'; // для локальных тестов без Telegram

if (!BOT_TOKEN || BOT_TOKEN === 'PASTE_YOUR_BOT_TOKEN_HERE') { console.error('Укажи BOT_TOKEN в .env'); process.exit(1); }
if (!SKIP_BOT && !/^https:\/\/.+/i.test(WEBAPP_URL)) { console.error('WEBAPP_URL должен быть публичным HTTPS-адресом'); process.exit(1); }

/* ================== ЭКОНОМИКА (всё, что можно крутить, — здесь) ================== */
const ECON = {
  START_COINS: 100,        // стартовый баланс
  TAP_POWER: 1,            // монет за клик по ресепшену
  ROOMS: 10,               // количество комнат
  MAX_LEVEL: 25,           // максимальный уровень комнаты
  FIRST_ROOM_COST: 300,    // цена первой комнаты
  ROOM_COST_GROWTH: 2.6,   // во сколько раз каждая следующая комната дороже
  BASE_INCOME_GROWTH: 1.8, // рост базового дохода комнат (1, 2, 3, 6, 10, 19 ...)
  UPGRADE_COST_SHARE: 0.4, // цена апгрейда 1->2 как доля от цены комнаты
  UPGRADE_COST_GROWTH: 1.25, // рост цены апгрейда за уровень
  MAX_OFFLINE_SEC: 8 * 3600, // сколько офлайн-дохода копится максимум
  MIN_TAP_INTERVAL_MS: 250, // минимум между тапами на сервере (клиент делает 300 мс, 50 мс запас на сеть)
  MAX_TAPS_PER_BATCH: 60,
};

/* ================== РЕЙДЫ ================== */
const RAID = {
  START_HOUR_MSK: 5,       // рейд может начаться с 05:00
  END_HOUR_MSK: 23,        // ...до 23:00 по Москве
  MAX_PER_DAY: 2,          // максимум рейдов в сутки (по МСК)
  DURATION_SEC: 3600,      // час на то, чтобы отбить
  FIRST_DELAY: [3600, 3 * 3600],       // первый рейд после покупки первой комнаты
  NORMAL_DELAY: [4 * 3600, 8 * 3600],  // следующий рейд, если отбили
  EARLY_DELAY: [3600, 2 * 3600],       // следующий рейд, если комнату заблокировали (раньше)
  UNBLOCK_COST_SHARE: 0.5, // разблокировка = доля от цены покупки комнаты
};
const MSK_OFFSET = 3 * 3600; // Москва = UTC+3, без перехода на летнее время
const TIME_OFFSET_SEC = Number(process.env.TIME_OFFSET_SEC || 0); // только для тестов
const nowSec = () => Math.floor(Date.now() / 1000) + TIME_OFFSET_SEC;
const nowMs = () => Date.now() + TIME_OFFSET_SEC * 1000;
const dayIdx = (t) => Math.floor((t + MSK_OFFSET) / 86400);            // номер суток по МСК
const dayStart = (d) => d * 86400 - MSK_OFFSET;                        // unix-время 00:00 МСК этих суток
const hourMsk = (t) => ((t + MSK_OFFSET) % 86400) / 3600;
const inWindow = (t) => { const h = hourMsk(t); return h >= RAID.START_HOUR_MSK && h < RAID.END_HOUR_MSK; };
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

function niceRound(n) { // округляем до 3 значащих цифр, чтобы цены были красивые
  if (n < 1000) return Math.round(n / 10) * 10 || Math.round(n);
  const p = Math.pow(10, Math.floor(Math.log10(n)) - 2);
  return Math.round(n / p) * p;
}
const roomCost = (i) => niceRound(ECON.FIRST_ROOM_COST * Math.pow(ECON.ROOM_COST_GROWTH, i)); // i: 0..9
const baseIncome = (i) => Math.max(1, Math.round(Math.pow(ECON.BASE_INCOME_GROWTH, i)));
const roomIncome = (i, level) => (level > 0 ? baseIncome(i) * level : 0);
const upgradeCost = (i, level) => Math.ceil(roomCost(i) * ECON.UPGRADE_COST_SHARE * Math.pow(ECON.UPGRADE_COST_GROWTH, level - 1));

/* ================== БАЗА ================== */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.use((_req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'hotel-tycoon.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS hotel_players(
  telegram_id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  photo TEXT NOT NULL DEFAULT '',
  coins REAL NOT NULL,
  earned REAL NOT NULL DEFAULT 0,
  rooms TEXT NOT NULL DEFAULT '0,0,0,0,0,0,0,0,0,0',
  total_taps INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL DEFAULT 0,
  last_tap_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
)`);
const have = new Set(db.prepare('PRAGMA table_info(hotel_players)').all().map((c) => c.name));
[
  ['blocked', "TEXT NOT NULL DEFAULT ''"],
  ['raid_state', 'INTEGER NOT NULL DEFAULT 0'], ['raid_deadline', 'INTEGER NOT NULL DEFAULT 0'], ['next_raid_at', 'INTEGER NOT NULL DEFAULT 0'],
  ['raids_day', "TEXT NOT NULL DEFAULT ''"], ['raids_today', 'INTEGER NOT NULL DEFAULT 0'], ['raids_defended', 'INTEGER NOT NULL DEFAULT 0'],
].forEach(([n, ddl]) => { if (!have.has(n)) db.exec(`ALTER TABLE hotel_players ADD COLUMN ${n} ${ddl}`); });
db.exec('CREATE INDEX IF NOT EXISTS idx_hotel_earned ON hotel_players(earned DESC)');

const qGet = db.prepare('SELECT * FROM hotel_players WHERE telegram_id=?');
const qInsert = db.prepare('INSERT OR IGNORE INTO hotel_players(telegram_id,name,photo,coins,earned,last_seen,created_at) VALUES(?,?,?,?,0,?,?)');
const qSave = db.prepare(`UPDATE hotel_players SET name=?,photo=?,coins=?,earned=?,rooms=?,total_taps=?,last_seen=?,last_tap_ms=?,
  blocked=?,raid_state=?,raid_deadline=?,next_raid_at=?,raids_day=?,raids_today=?,raids_defended=? WHERE telegram_id=?`);
const EMPTY_ROOMS = '0,0,0,0,0,0,0,0,0,0';
const qDue = db.prepare(`SELECT telegram_id FROM hotel_players WHERE
  (raid_state=1 AND raid_deadline<=?) OR (raid_state=0 AND ((next_raid_at>0 AND next_raid_at<=?) OR (next_raid_at=0 AND rooms!='${EMPTY_ROOMS}')))`);
const qTop = db.prepare('SELECT telegram_id,name,photo,earned FROM hotel_players ORDER BY earned DESC, created_at ASC LIMIT 10');
const qCount = db.prepare('SELECT COUNT(*) AS c FROM hotel_players');
const qRank = db.prepare('SELECT COUNT(*) AS c FROM hotel_players WHERE earned > ?');

/* ================== АВТОРИЗАЦИЯ TELEGRAM ================== */
function httpError(status, message) { return Object.assign(new Error(message), { status }); }

function validate(raw) {
  if (!raw || typeof raw !== 'string' || raw.length > 8192) throw httpError(401, 'Откройте игру через Telegram.');
  const p = new URLSearchParams(raw);
  const hash = p.get('hash');
  const date = Number(p.get('auth_date'));
  if (!hash || !Number.isFinite(date)) throw httpError(401, 'Неверная сессия Telegram.');
  p.delete('hash');
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(check).digest();
  let supplied;
  try { supplied = Buffer.from(hash, 'hex'); } catch { supplied = Buffer.alloc(0); }
  if (supplied.length !== calc.length || !crypto.timingSafeEqual(supplied, calc)) throw httpError(401, 'Не удалось проверить Telegram.');
  const now = Math.floor(Date.now() / 1000);
  if (date > now + 30 || now - date > 86400) throw httpError(401, 'Сессия устарела. Откройте игру заново.');
  let u; try { u = JSON.parse(p.get('user') || 'null'); } catch { /* ignore */ }
  if (!u || !u.id) throw httpError(401, 'Пользователь Telegram не найден.');
  const photo = typeof u.photo_url === 'string' && /^https:\/\//.test(u.photo_url) ? u.photo_url.slice(0, 300) : '';
  return { id: String(u.id), name: String(u.username || u.first_name || 'Игрок').slice(0, 32), photo };
}
function auth(req, res, next) {
  try { req.user = validate(req.get('x-telegram-init-data') || ''); next(); }
  catch (e) { res.status(e.status || 401).json({ error: e.message || 'Ошибка авторизации.' }); }
}

/* ================== ИГРОВАЯ ЛОГИКА ================== */
const parseRooms = (s) => {
  const a = String(s || '').split(',').map((x) => Math.max(0, Math.min(ECON.MAX_LEVEL, parseInt(x, 10) || 0)));
  while (a.length < ECON.ROOMS) a.push(0);
  return a.slice(0, ECON.ROOMS);
};
const parseBlocked = (s) => new Set(String(s || '').split(',').filter(Boolean).map(Number).filter((i) => i >= 0 && i < ECON.ROOMS));
const isActive = (p, i) => p.rooms[i] > 0 && !p.blocked.has(i);
const totalIncome = (p) => p.rooms.reduce((sum, l, i) => sum + (isActive(p, i) ? roomIncome(i, l) : 0), 0);
const unblockCost = (i) => Math.floor(roomCost(i) * RAID.UNBLOCK_COST_SHARE);

// Сообщения о рейдах отправляются после коммита транзакции
const outbox = [];
const RAID_TEXT = '🚨 Начался рейд на твой отель!\n\nУ тебя есть час, чтобы зайти и отбить его. Иначе одну из комнат заблокируют, а следующий рейд начнётся раньше.';

function accrue(p, t) {
  const elapsed = Math.max(0, Math.min(ECON.MAX_OFFLINE_SEC, t - p.lastSeen));
  const gain = elapsed * totalIncome(p);
  p.coins += gain; p.earned += gain; p.lastSeen = Math.max(p.lastSeen, t);
}

// Планирует следующий рейд: случайная задержка, затем подгоняем под окно 05:00–23:00 МСК и лимит 2 в сутки
function scheduleNext(p, now, kind) {
  const [a, b] = kind === 'early' ? RAID.EARLY_DELAY : kind === 'first' ? RAID.FIRST_DELAY : RAID.NORMAL_DELAY;
  const spread = kind === 'early' ? 3600 : 3 * 3600; // если переносим на утро следующих суток — при раннем рейде он ближе к 05:00
  let t = now + rand(a, b);
  for (let guard = 0; guard < 4; guard++) {
    const d = dayIdx(t), h = hourMsk(t);
    if (h < RAID.START_HOUR_MSK) { t = dayStart(d) + RAID.START_HOUR_MSK * 3600 + rand(0, spread); continue; }
    if (h >= RAID.END_HOUR_MSK) { t = dayStart(d + 1) + RAID.START_HOUR_MSK * 3600 + rand(0, spread); continue; }
    const count = p.raidsDay === String(d) ? p.raidsToday : 0;
    if (count >= RAID.MAX_PER_DAY) { t = dayStart(d + 1) + RAID.START_HOUR_MSK * 3600 + rand(0, spread); continue; }
    break;
  }
  p.nextRaidAt = t;
}

function blockRandomRoom(p) {
  const pool = p.rooms.map((_, i) => i).filter((i) => isActive(p, i));
  if (!pool.length) return false;
  p.blocked.add(pool[crypto.randomInt(pool.length)]);
  return true;
}

function maybeStartRaid(p, now) {
  if (p.raidState !== 0) return;
  if (!p.rooms.some((_, i) => isActive(p, i))) { p.nextRaidAt = 0; return; } // рейдить нечего
  if (p.nextRaidAt === 0) { scheduleNext(p, now, 'first'); return; }
  if (now < p.nextRaidAt) return;
  const d = dayIdx(now), count = p.raidsDay === String(d) ? p.raidsToday : 0;
  if (!inWindow(now) || count >= RAID.MAX_PER_DAY) { scheduleNext(p, now, 'normal'); return; }
  p.raidState = 1; p.raidDeadline = now + RAID.DURATION_SEC;
  p.raidsDay = String(d); p.raidsToday = count + 1; p.nextRaidAt = 0;
  outbox.push(p.id);
}

// Загружает игрока (создаёт при первом входе), начисляет доход, квоту и обрабатывает рейды.
// sweep=true — вызов планировщика: рейды обрабатываются, но доход не начисляется (чтобы не сбивать офлайн-лимит).
// Вызывать внутри транзакции.
function load(u, sweep = false) {
  const now = nowSec(), ms = nowMs();
  qInsert.run(u.id, u.name || '', u.photo || '', ECON.START_COINS, now, now);
  const r = qGet.get(u.id);
  const p = {
    id: u.id, name: u.name || r.name, photo: u.photo || r.photo,
    coins: r.coins, earned: r.earned, rooms: parseRooms(r.rooms), blocked: parseBlocked(r.blocked),
    taps: r.total_taps, lastSeen: r.last_seen || now, lastTapMs: r.last_tap_ms || 0,
    raidState: r.raid_state, raidDeadline: r.raid_deadline, nextRaidAt: r.next_raid_at,
    raidsDay: r.raids_day, raidsToday: r.raids_today, defended: r.raids_defended, offline: 0,
  };
  const t0 = p.lastSeen, c0 = p.coins;
  if (p.raidState === 1 && now >= p.raidDeadline) { // время вышло — рейд удался
    if (!sweep) accrue(p, Math.min(p.raidDeadline, now));
    const blocked = blockRandomRoom(p);
    p.raidState = 0;
    scheduleNext(p, now, blocked ? 'early' : 'normal');
  }
  if (!sweep) {
    accrue(p, now);
    p.offline = now - t0 > 60 ? p.coins - c0 : 0;
  }
  maybeStartRaid(p, now);
  return p;
}
const persist = (p) => qSave.run(p.name, p.photo, p.coins, p.earned, p.rooms.join(','), p.taps, p.lastSeen, p.lastTapMs,
  [...p.blocked].sort((a, b) => a - b).join(','), p.raidState, p.raidDeadline, p.nextRaidAt, p.raidsDay, p.raidsToday, p.defended, p.id);

function view(p) {
  const now = nowSec();
  const nextBuy = p.rooms.findIndex((l) => l === 0); // индекс следующей комнаты к покупке, -1 если всё куплено
  return {
    coins: Math.floor(p.coins),
    earned: Math.floor(p.earned),
    income: totalIncome(p),
    tapPower: ECON.TAP_POWER,
    totalTaps: p.taps,
    offlineEarned: Math.floor(p.offline),
    maxLevel: ECON.MAX_LEVEL,
    nextBuy: nextBuy === -1 ? null : nextBuy + 1,
    defended: p.defended,
    raid: { active: p.raidState === 1, left: p.raidState === 1 ? Math.max(0, p.raidDeadline - now) : 0 },
    rooms: p.rooms.map((level, i) => {
      const blocked = level > 0 && p.blocked.has(i);
      return {
        n: i + 1, level, blocked,
        income: level > 0 && !blocked ? roomIncome(i, level) : 0,
        fullIncome: roomIncome(i, level),
        // купленная — цена апгрейда, некупленная — цена покупки, заблокированная — цена разблокировки
        cost: blocked ? unblockCost(i) : level === 0 ? roomCost(i) : level >= ECON.MAX_LEVEL ? null : upgradeCost(i, level),
        incomeAfter: level >= ECON.MAX_LEVEL ? null : roomIncome(i, level + 1),
      };
    }),
  };
}

const wrap = (fn) => (req, res) => {
  try { fn(req, res); }
  catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e); res.status(500).json({ error: 'Ошибка сервера.' });
  }
};

// Telegram: отправка сообщений о рейде с небольшой паузой (лимиты API)
const sendQueue = [];
let draining = false;
async function drain() {
  if (draining) return; draining = true;
  while (sendQueue.length) {
    const id = sendQueue.shift();
    if (!bot) { console.log(`RAID_NOTIFY ${id}`); continue; }
    try {
      await bot.telegram.sendMessage(id, RAID_TEXT, Markup.inlineKeyboard([[Markup.button.webApp('🛡 Отбить рейд', WEBAPP_URL)]]));
    } catch (e) { console.error(`Не удалось отправить рейд-сообщение ${id}:`, e.message); }
    await new Promise((r) => setTimeout(r, 50));
  }
  draining = false;
}
function tx(fn) {
  const result = db.transaction(fn)();
  if (outbox.length) { sendQueue.push(...outbox.splice(0)); drain(); }
  return result;
}
let bot = null;

app.get('/api/health', (_q, s) => s.json({ ok: true }));

app.get('/api/state', auth, wrap((req, res) => {
  res.json(tx(() => { const p = load(req.user); persist(p); return view(p); }));
}));

app.post('/api/tap', auth, wrap((req, res) => {
  const asked = Math.floor(Number(req.body && req.body.count));
  if (!Number.isFinite(asked) || asked < 1) throw httpError(400, 'Неверный запрос.');
  res.json(tx(() => {
    const p = load(req.user), ms = nowMs();
    const byTime = Math.floor(Math.min(5000, ms - p.lastTapMs) / ECON.MIN_TAP_INTERVAL_MS) + 1;
    const taps = Math.max(0, Math.min(asked, byTime, ECON.MAX_TAPS_PER_BATCH));
    if (taps > 0) {
      p.coins += taps * ECON.TAP_POWER; p.earned += taps * ECON.TAP_POWER; p.taps += taps;
      p.lastTapMs = ms;
    }
    persist(p);
    return view(p);
  }));
}));

function roomAction(kind) {
  return wrap((req, res) => {
    const n = Math.floor(Number(req.body && req.body.room));
    if (!Number.isInteger(n) || n < 1 || n > ECON.ROOMS) throw httpError(400, 'Нет такой комнаты.');
    const i = n - 1;
    res.json(tx(() => {
      const p = load(req.user), now = nowSec();
      const pay = (cost) => { if (p.coins < cost) throw httpError(400, 'Не хватает монет.'); p.coins -= cost; };
      if (kind === 'buy') {
        if (p.rooms[i] > 0) throw httpError(400, 'Комната уже куплена.');
        if (i > 0 && p.rooms[i - 1] === 0) throw httpError(400, 'Покупайте комнаты по порядку.');
        pay(roomCost(i)); p.rooms[i] = 1;
      } else if (kind === 'unblock') {
        if (!(p.rooms[i] > 0 && p.blocked.has(i))) throw httpError(400, 'Комната не заблокирована.');
        pay(unblockCost(i)); p.blocked.delete(i);
      } else {
        const level = p.rooms[i];
        if (level === 0) throw httpError(400, 'Сначала купите комнату.');
        if (p.blocked.has(i)) throw httpError(400, 'Комната заблокирована рейдом.');
        if (level >= ECON.MAX_LEVEL) throw httpError(400, 'Максимальный уровень.');
        pay(upgradeCost(i, level)); p.rooms[i] = level + 1;
      }
      maybeStartRaid(p, now); // после покупки первой комнаты / разблокировки планируем рейд
      persist(p);
      return view(p);
    }));
  });
}
app.post('/api/buy', auth, roomAction('buy'));
app.post('/api/upgrade', auth, roomAction('upgrade'));
app.post('/api/unblock', auth, roomAction('unblock'));

app.post('/api/raid/defend', auth, wrap((req, res) => {
  res.json(tx(() => {
    const p = load(req.user);
    if (p.raidState !== 1) throw httpError(400, 'Рейд уже закончился или ещё не начался.');
    p.raidState = 0; p.defended++;
    scheduleNext(p, nowSec(), 'normal');
    persist(p);
    return view(p);
  }));
}));

app.get('/api/top', auth, wrap((req, res) => {
  const out = tx(() => {
    const p = load(req.user); persist(p);
    const top = qTop.all().map((r, i) => ({ rank: i + 1, name: r.name, photo: r.photo, earned: Math.floor(r.earned), me: r.telegram_id === p.id }));
    const rank = qRank.get(p.earned).c + 1;
    return { players: qCount.get().c, top, me: { rank, name: p.name, photo: p.photo, earned: Math.floor(p.earned) } };
  });
  res.json(out);
}));

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (_q, s) => s.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

/* ================== БОТ ================== */
const server = app.listen(PORT, '0.0.0.0', () => console.log(`Web server: http://localhost:${PORT}`));
if (!SKIP_BOT) {
  bot = new Telegraf(BOT_TOKEN);
  const keyboard = () => Markup.inlineKeyboard([[Markup.button.webApp('🏨 Открыть Hacker Hotel', WEBAPP_URL)]]);
  bot.start((ctx) => ctx.reply(`🏨 Добро пожаловать, ${ctx.from.first_name || 'менеджер'}!\n\nТапай по ресепшену, покупай комнаты и копи пассивный доход — даже когда ты офлайн.`, keyboard()));
  bot.command('hotel', (ctx) => ctx.reply('Готов управлять отелем?', keyboard()));
  bot.catch((e) => console.error('Bot error:', e));
  bot.launch().then(() => console.log('Telegram bot is running.')).catch((e) => { console.error('Bot failed:', e); process.exit(1); });
}

// Планировщик рейдов: старт по расписанию и итог по истечении часа (даже если игрок не заходит)
function sweep() {
  try {
    const now = nowSec();
    for (const { telegram_id } of qDue.all(now, now)) {
      try { tx(() => { const p = load({ id: telegram_id }, true); persist(p); }); }
      catch (e) { console.error('sweep', telegram_id, e); }
    }
  } catch (e) { console.error('sweep', e); }
}
const sweepTimer = setInterval(sweep, 20000);
setTimeout(sweep, 3000);

function stop(sig) {
  clearInterval(sweepTimer);
  console.log(`Stopping: ${sig}`);
  if (bot) bot.stop(sig);
  server.close(() => { db.close(); process.exit(0); });
}
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
