(() => {
  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    tg.ready(); tg.expand();
    try { tg.disableVerticalSwipes && tg.disableVerticalSwipes(); } catch {}
    try { tg.setHeaderColor('#090c1a'); tg.setBackgroundColor('#090c1a'); } catch {}
  }
  const $ = (id) => document.getElementById(id);
  const haptic = (kind, type) => { try { tg && tg.HapticFeedback && tg.HapticFeedback[kind](type); } catch {} };

  /* ---------- звук: ночной фон и звук тапа (генерируются в браузере, файлов нет) ---------- */
  const Snd = (() => {
    let ctx = null, master = null, started = false, on = true;
    try { on = localStorage.getItem('hh_sound') !== '0'; } catch {}
    function ensure() {
      if (ctx) return ctx;
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
      ctx = new AC(); master = ctx.createGain(); master.gain.value = on ? 1 : 0; master.connect(ctx.destination); return ctx;
    }
    // 24 секунды ночного города: низкий гул, ветер и сверчки; концы склеены кроссфейдом, поэтому петля без щелчка
    function nightBuffer(c) {
      const sr = 22050, L = 24 * sr, F = Math.floor(1.5 * sr), N = L + F, g = new Float32Array(N);
      let brown = 0, air = 0;
      for (let i = 0; i < N; i++) {
        const w = Math.random() * 2 - 1, tt = i / sr;
        brown = (brown + 0.02 * w) / 1.02; air += 0.05 * (w - air);
        const swell = 0.6 + 0.4 * Math.sin(2 * Math.PI * tt / 8 + 1.3) * Math.sin(2 * Math.PI * tt / 13);
        g[i] = brown * 2.2 + air * 0.32 * swell + Math.sin(2 * Math.PI * 55 * tt) * 0.012 + Math.sin(2 * Math.PI * 110 * tt) * 0.006;
      }
      [[4300, 0.0], [4650, 0.37], [5100, 0.71]].forEach(([f, off]) => {
        for (let tt = off + Math.random(); tt < N / sr - 0.5; tt += 1.1 + Math.random() * 0.8) {
          const n = Math.floor((0.28 + Math.random() * 0.12) * sr), s0 = Math.floor(tt * sr), a = 0.010 + Math.random() * 0.004;
          for (let k = 0; k < n && s0 + k < N; k++) {
            const x = k / sr, pulse = Math.pow(Math.max(0, Math.sin(2 * Math.PI * 45 * x)), 0.6);
            g[s0 + k] += a * Math.sin(Math.PI * k / n) * pulse * Math.sin(2 * Math.PI * f * x);
          }
        }
      });
      const buf = c.createBuffer(1, L, sr), d = buf.getChannelData(0);
      for (let i = 0; i < L; i++) d[i] = g[i];
      for (let i = 0; i < F; i++) { const a = i / F; d[i] = g[i] * Math.sin(a * Math.PI / 2) + g[L + i] * Math.cos(a * Math.PI / 2); }
      let peak = 0; for (let i = 0; i < L; i++) peak = Math.max(peak, Math.abs(d[i]));
      const k = peak > 0 ? 0.6 / peak : 1; for (let i = 0; i < L; i++) d[i] *= k;
      return buf;
    }
    function startNight() {
      const src = ctx.createBufferSource(), gain = ctx.createGain();
      src.buffer = nightBuffer(ctx); src.loop = true; gain.gain.value = 0;
      src.connect(gain); gain.connect(master); src.start();
      gain.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 3);
    }
    function unlock() { // вызывается из жестов пользователя: браузеры запрещают звук без касания
      const c = ensure(); if (!c) return;
      if (c.state === 'suspended' && on) c.resume();
      if (!started) { started = true; try { startNight(); } catch (e) { console.error(e); } }
    }
    function tap() {
      if (!on || !ctx || ctx.state !== 'running') return;
      const t0 = ctx.currentTime, k = 1 + (Math.random() - 0.5) * 0.06;
      [[988 * k, 0], [1319 * k, 0.055]].forEach(([f, d]) => {
        const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'triangle'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + d); g.gain.exponentialRampToValueAtTime(0.22, t0 + d + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.16);
        o.connect(g); g.connect(master); o.start(t0 + d); o.stop(t0 + d + 0.18);
      });
    }
    function setOn(v) {
      on = v; try { localStorage.setItem('hh_sound', v ? '1' : '0'); } catch {}
      if (ctx) { master.gain.setTargetAtTime(v ? 1 : 0, ctx.currentTime, 0.05); if (v && ctx.state === 'suspended') ctx.resume(); }
      $('soundBtn').textContent = v ? '🔊' : '🔇';
    }
    document.addEventListener('visibilitychange', () => { if (!ctx) return; if (document.hidden) ctx.suspend(); else if (on) ctx.resume(); });
    return { unlock, tap, setOn, get on() { return on; }, nightBuffer: () => nightBuffer(ensure()) };
  })();
  ['pointerdown', 'pointerup', 'touchend', 'click'].forEach((ev) => document.addEventListener(ev, () => Snd.unlock(), { passive: true }));
  $('soundBtn').addEventListener('click', () => Snd.setOn(!Snd.on)); Snd.setOn(Snd.on);

  /* ---------- геометрия окон на background_open.jpg (768 x 1376) ---------- */
  const IMG_W = 768, IMG_H = 1376;
  const ROWS = [[333, 458], [481, 612], [634, 755], [779, 905], [929, 1058]]; // сверху вниз
  const COLS = [[200, 376], [392, 569]];                                      // левая / правая комната
  const pct = (v, total) => (v / total * 100) + '%';
  const roomRect = (n) => { // комната 1 — низ слева, 2 — низ справа, 3 — выше слева ... 10 — верх справа
    const r = Math.floor((n - 1) / 2), c = (n - 1) % 2, [y0, y1] = ROWS[4 - r], [x0, x1] = COLS[c];
    return { x0, y0, w: x1 - x0, h: y1 - y0, c };
  };

  /* ---------- состояние ---------- */
  const s = { coins: 0, income: 0, rooms: [], nextBuy: 1, maxLevel: 25, totalTaps: 0, earned: 0, tapPower: 1, loaded: false,
    raid: { active: false, left: 0 }, defended: 0 };
  const TAP_DELAY = 300; // мс между тапами
  let lastTap = 0, raidEnd = 0;
  let pending = 0, inflight = null, flushTimer = null, view = 'game', tab = 'top';

  const fmt = (n) => {
    n = Math.floor(Number(n) || 0);
    if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
    return String(n);
  };
  const full = (n) => Math.floor(n).toLocaleString('ru-RU').replace(/\u00a0|\u202f/g, ' ');

  let toastTimer;
  function toast(msg, err) {
    const el = $('toast'); el.textContent = msg; el.classList.toggle('err', !!err); el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  async function api(url, body) {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': (tg && tg.initData) || '' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({ error: 'Неожиданный ответ сервера.' }));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Ошибка запроса.'), { status: res.status });
    return data;
  }

  /* ---------- построение комнат ---------- */
  const LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="10.5" width="14" height="10" rx="2.6"/><path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5"/><circle cx="12" cy="15.5" r="1.1" fill="currentColor"/></svg>';
  const wins = [];
  function build() {
    const host = $('rooms');
    for (let n = 1; n <= 10; n++) {
      const g = roomRect(n);
      const el = document.createElement('div');
      el.className = 'win';
      Object.assign(el.style, { left: pct(g.x0, IMG_W), top: pct(g.y0, IMG_H), width: pct(g.w, IMG_W), height: pct(g.h, IMG_H) });
      el.innerHTML = '<div class="pane l"></div><div class="pane r"></div><div class="lockbox"></div><div class="badge"><span class="lv"></span><i></i><span class="inc"></span></div>';
      el.addEventListener('click', () => onRoom(n));
      host.append(el);
      // номер комнаты на боковой колонне
      const tag = document.createElement('div');
      tag.className = 'pillar'; tag.textContent = n;
      const tw = 26, th = 28, tx = g.c === 0 ? 169 : 573;
      Object.assign(tag.style, { left: pct(tx, IMG_W), top: pct(g.y0 + g.h / 2 - th / 2, IMG_H), width: pct(tw, IMG_W), height: pct(th, IMG_H) });
      host.append(tag);
      wins.push({ el, lock: el.querySelector('.lockbox'), lv: el.querySelector('.lv'), inc: el.querySelector('.inc') });
    }
  }

  function paintRooms() {
    wins.forEach((w, i) => {
      const r = s.rooms[i]; if (!r) return;
      const open = r.level > 0 && !r.blocked;
      w.el.classList.toggle('open', open);
      w.el.classList.toggle('blocked', !!r.blocked);
      w.el.classList.toggle('maxed', r.level >= s.maxLevel);
      w.el.classList.toggle('next', !open && r.n === s.nextBuy);
      if (open) {
        w.lv.textContent = r.level; w.inc.textContent = '+' + fmt(r.income) + '/c';
      } else {
        const html = LOCK + (r.blocked || r.n === s.nextBuy ? '<span>' + fmt(r.cost) + '</span>' : '');
        if (w.lock.dataset.k !== html) { w.lock.innerHTML = html; w.lock.dataset.k = html; }
      }
    });
    paintAfford();
  }
  function paintAfford() {
    wins.forEach((w, i) => {
      const r = s.rooms[i];
      w.el.classList.toggle('afford', !!r && r.cost != null && s.coins >= r.cost && (r.level > 0 || r.n === s.nextBuy));
    });
  }
  function paintHud() {
    $('coins').textContent = fmt(s.coins);
    $('income').textContent = '+' + fmt(s.income) + '/c';
  }

  /* ---------- применение ответа сервера ---------- */
  function apply(v) {
    const first = !s.loaded, wasRaid = s.raid.active, prevBlocked = new Set(s.rooms.filter((r) => r.blocked).map((r) => r.n));
    Object.assign(s, { income: v.income, rooms: v.rooms, nextBuy: v.nextBuy || 0, maxLevel: v.maxLevel, totalTaps: v.totalTaps, earned: v.earned, tapPower: v.tapPower, raid: v.raid, defended: v.defended, loaded: true });
    s.coins = v.coins + pending * s.tapPower;
    raidEnd = v.raid.active ? performance.now() + v.raid.left * 1000 : 0;
    paintHud(); paintRooms(); paintRaid();
    if (!first) {
      if (v.raid.active && !wasRaid) toast('🚨 Начался рейд! Отбейте его за час.', true);
      v.rooms.filter((r) => r.blocked && !prevBlocked.has(r.n)).forEach((r) => toast(`🔒 Рейдеры заблокировали комнату №${r.n}`, true));
    }
  }
  function paintRaid() { $('raid').classList.toggle('hidden', !s.raid.active); }
  function raidTick() {
    if (!raidEnd) return;
    const left = Math.max(0, Math.ceil((raidEnd - performance.now()) / 1000));
    $('raidTimer').textContent = String(Math.floor(left / 60)).padStart(2, '0') + ':' + String(left % 60).padStart(2, '0');
    if (left === 0) { raidEnd = 0; s.raid.active = false; paintRaid(); setTimeout(() => sync(true), 1500); }
  }
  $('raidBtn').addEventListener('click', async () => {
    const b = $('raidBtn'); b.disabled = true;
    try { await flush(); apply(await api('/api/raid/defend', { go: 1 })); toast('🛡 Рейд отбит! Отель в безопасности.'); haptic('notificationOccurred', 'success'); }
    catch (e) { toast(e.message, true); haptic('notificationOccurred', 'error'); sync(true); }
    finally { b.disabled = false; }
  });

  async function sync(quiet) {
    try { await flush(); const v = await api('/api/state'); apply(v); if (!quiet && v.offlineEarned > 0) toast('Пока вас не было: +' + fmt(v.offlineEarned)); return v; }
    catch (e) { if (!quiet) toast(e.message, true); }
  }

  /* ---------- клики по ресепшену (пачками) ---------- */
  function queueFlush(delay = 500) { if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flush(); }, delay); }
  function flush() {
    clearTimeout(flushTimer); flushTimer = null;
    if (inflight) return inflight;
    if (!pending) return Promise.resolve();
    const n = pending; pending = 0;
    inflight = api('/api/tap', { count: n })
      .then(apply)
      .catch((e) => { pending += n; if (e.status === 401) toast(e.message, true); queueFlush(2500); })
      .finally(() => { inflight = null; if (pending) queueFlush(); });
    return inflight;
  }
  $('reception').addEventListener('pointerdown', (e) => {
    Snd.unlock();
    if (!s.loaded || view !== 'game') return;
    e.preventDefault();
    const now = performance.now();
    if (now - lastTap < TAP_DELAY) return; // пауза между тапами
    lastTap = now;
    pending++; s.coins += s.tapPower;
    paintHud(); Snd.tap();
    const f = document.createElement('div'); f.className = 'float'; f.textContent = '+' + s.tapPower;
    f.style.left = (e.clientX + (Math.random() * 30 - 15)) + 'px'; f.style.top = (e.clientY - 20) + 'px';
    document.body.append(f); setTimeout(() => f.remove(), 900);
    haptic('impactOccurred', 'light');
    queueFlush();
  });

  /* ---------- модальные окна ---------- */
  let modalOk = null;
  function openModal({ title, text, rows = [], cancel = 'Отмена', ok = 'Понятно', onOk, okDisabled }) {
    $('mTitle').textContent = title; $('mText').textContent = text;
    $('mRows').innerHTML = '';
    rows.forEach(([k, v, cls]) => {
      const row = document.createElement('div'); row.className = 'row';
      const a = document.createElement('span'); a.textContent = k;
      const b = document.createElement('b'); b.textContent = v; if (cls) b.className = cls;
      row.append(a, b); $('mRows').append(row);
    });
    $('mCancel').textContent = cancel; $('mOkLabel').textContent = ok;
    $('mOk').disabled = !!okDisabled; modalOk = onOk || closeModal;
    $('modal').classList.remove('hidden');
  }
  function closeModal() { $('modal').classList.add('hidden'); modalOk = null; }
  $('mCancel').addEventListener('click', closeModal);
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
  $('mOk').addEventListener('click', () => { if (modalOk) modalOk(); });

  async function act(kind, n, doneMsg) {
    $('mOk').disabled = true;
    try {
      await flush();
      const v = await api('/api/' + kind, { room: n });
      closeModal(); apply(v); toast(doneMsg); haptic('notificationOccurred', 'success');
    } catch (e) {
      closeModal(); toast(e.message, true); haptic('notificationOccurred', 'error'); sync(true);
    }
  }

  function onRoom(n) {
    if (view !== 'game' || !s.loaded) return;
    const r = s.rooms[n - 1]; if (!r) return;
    if (r.blocked) {
      const lack = r.cost - s.coins;
      return openModal({
        title: `Комната №${n} заблокирована`, text: 'Рейдеры заблокировали эту комнату. Она не приносит доход, пока вы её не разблокируете.',
        rows: [['Стоимость', full(r.cost), lack > 0 ? 'red' : ''], ['Доход комнаты', '+' + fmt(r.fullIncome) + '/c', 'green']].concat(lack > 0 ? [['Не хватает', full(lack), 'red']] : []),
        cancel: 'Отмена', ok: 'Разблокировать', okDisabled: lack > 0, onOk: () => act('unblock', n, `Комната №${n} разблокирована`),
      });
    }
    if (r.level === 0) {
      if (n !== s.nextBuy) {
        return openModal({ title: `Комната №${n} закрыта`, text: 'Чтобы открыть эту комнату, сначала купите все предыдущие по порядку.', cancel: 'Закрыть', ok: 'Понятно' });
      }
      const lack = r.cost - s.coins;
      return openModal({
        title: `Купить комнату №${n}`, text: 'Комната станет вашей и начнёт приносить пассивный доход каждую секунду — даже когда вы офлайн.',
        rows: [['Стоимость', full(r.cost), lack > 0 ? 'red' : ''], ['Доход комнаты', '+' + fmt(r.incomeAfter) + '/c', 'green']].concat(lack > 0 ? [['Не хватает', full(lack), 'red']] : []),
        cancel: 'Отмена', ok: 'Купить', okDisabled: lack > 0, onOk: () => act('buy', n, `Комната №${n} куплена!`),
      });
    }
    if (r.level >= s.maxLevel) {
      return openModal({ title: `Комната №${n}`, text: 'Максимальный уровень достигнут.', rows: [['Уровень', String(r.level)], ['Доход', '+' + fmt(r.income) + '/c', 'green']], cancel: 'Закрыть', ok: 'Отлично' });
    }
    const lack = r.cost - s.coins;
    openModal({
      title: `Улучшить комнату №${n}`, text: 'Каждый уровень увеличивает доход комнаты.',
      rows: [['Уровень', `${r.level} → ${r.level + 1}`], ['Доход', `+${fmt(r.income)} → +${fmt(r.incomeAfter)}/c`, 'green'], ['Стоимость', full(r.cost), lack > 0 ? 'red' : '']].concat(lack > 0 ? [['Не хватает', full(lack), 'red']] : []),
      cancel: 'Отмена', ok: 'Улучшить', okDisabled: lack > 0, onOk: () => act('upgrade', n, `Комната №${n}: уровень ${r.level + 1}`),
    });
  }

  /* ---------- рейтинг и ачивки ---------- */
  function setAvatar(el, name, photo) {
    el.textContent = ''; el.style.backgroundImage = '';
    if (photo) { el.style.backgroundImage = `url("${photo.replace(/"/g, '%22')}")`; }
    else { el.textContent = (name || '?').trim().charAt(0).toUpperCase(); }
  }
  function setView(v) {
    view = v; const game = v === 'game';
    $('board').classList.toggle('hidden', game);
    $('statsBtn').classList.toggle('hidden', !game);
    $('backBtn').classList.toggle('hidden', game);
    $('coins').parentElement.querySelector('.coin-ico').classList.toggle('hidden', !game);
    $('coins').classList.toggle('hidden', !game);
    $('playersWrap').classList.toggle('hidden', game);
    if (!game) showTab(tab);
  }
  async function showTab(t) {
    tab = t;
    $('tabTop').classList.toggle('active', t === 'top'); $('tabAch').classList.toggle('active', t === 'ach');
    $('boardTitle').textContent = t === 'top' ? 'ТОП-10 ИГРОКОВ' : 'АЧИВКИ';
    const body = $('boardBody'); body.innerHTML = '<div class="empty">Загрузка…</div>';
    try {
      if (t === 'top') {
        await flush();
        const d = await api('/api/top'); if (tab !== 'top' || view === 'game') return;
        $('players').textContent = d.players;
        body.innerHTML = '<div class="thead"><span>#</span><span>НИКНЕЙМ</span><span>ЗАРАБОТАНО</span></div>';
        const medals = ['🥇', '🥈', '🥉'];
        const addRow = (r, me) => {
          const row = document.createElement('div'); row.className = 'trow' + (me ? ' me' : '');
          const rk = document.createElement('span'); rk.className = 'rk'; rk.textContent = (!me && r.rank <= 3 ? medals[r.rank - 1] + ' ' : '') + r.rank;
          const who = document.createElement('span'); who.className = 'who';
          const av = document.createElement('span'); av.className = 'avatar'; setAvatar(av, r.name, r.photo);
          const nm = document.createElement('span'); nm.textContent = r.name;
          who.append(av, nm);
          const sum = document.createElement('span'); sum.className = 'sum'; sum.textContent = fmt(r.earned);
          row.append(rk, who, sum); body.append(row);
        };
        d.top.forEach((r) => addRow(r, r.me));
        if (d.me.rank > 10) addRow(d.me, true);
      } else {
        await sync(true); if (tab !== 'ach' || view === 'game') return;
        const owned = s.rooms.filter((r) => r.level > 0).length, best = Math.max(0, ...s.rooms.map((r) => r.level));
        const list = [
          ['🛎️', 'Первый гость', 'Купите первую комнату', owned, 1],
          ['🏨', 'Полдома', 'Купите 5 комнат', owned, 5],
          ['🌆', 'Аншлаг', 'Купите все 10 комнат', owned, 10],
          ['👆', 'Разминка', 'Сделайте 100 кликов по ресепшену', s.totalTaps, 100],
          ['⚡', 'Мастер ресепшена', 'Сделайте 1 000 кликов', s.totalTaps, 1000],
          ['🔥', 'Железный палец', 'Сделайте 10 000 кликов', s.totalTaps, 10000],
          ['💰', 'Первая тысяча', 'Заработайте 1 000 монет', s.earned, 1e3],
          ['💎', 'Богатый отель', 'Заработайте 100 000 монет', s.earned, 1e5],
          ['👑', 'Хакерская империя', 'Заработайте 10 000 000 монет', s.earned, 1e7],
          ['⭐', 'Комфорт-класс', 'Улучшите комнату до 10 уровня', best, 10],
          ['🛡️', 'Защитник', 'Отбейте первый рейд', s.defended, 1],
          ['🏰', 'Неприступный отель', 'Отбейте 10 рейдов', s.defended, 10],
          ['🚀', 'Максимум', `Улучшите комнату до ${s.maxLevel} уровня`, best, s.maxLevel],
          ['🔱', 'Бог', `Прокачайте весь отель: все 10 комнат до ${s.maxLevel} уровня`, s.rooms.filter((r) => r.level >= s.maxLevel).length, 10],
        ];
        body.innerHTML = '';
        list.forEach(([ic, t1, d1, cur, goal]) => {
          const done = cur >= goal, el = document.createElement('div'); el.className = 'ach' + (done ? ' done' : '');
          el.innerHTML = '<div class="ic"></div><div class="t"><b></b><small></small><div class="bar"><i></i></div></div>';
          el.querySelector('.ic').textContent = ic; el.querySelector('b').textContent = t1;
          el.querySelector('small').textContent = d1 + (done ? ' — выполнено' : ` (${fmt(cur)} / ${fmt(goal)})`);
          el.querySelector('i').style.width = Math.min(100, cur / goal * 100) + '%';
          body.append(el);
        });
      }
    } catch (e) { body.innerHTML = ''; toast(e.message, true); }
  }
  $('statsBtn').addEventListener('click', () => setView('board'));
  $('backBtn').addEventListener('click', () => setView('game'));
  $('tabTop').addEventListener('click', () => showTab('top'));
  $('tabAch').addEventListener('click', () => showTab('ach'));

  /* ---------- масштаб, тики, запуск ---------- */
  function resize() { $('stage').style.setProperty('--u', ($('stage').clientWidth / IMG_W) + 'px'); }
  window.addEventListener('resize', resize); resize();

  setInterval(() => {
    if (!s.loaded) return;
    s.coins += s.income / 10; if (view === 'game') paintHud();
    raidTick();
  }, 100);
  setInterval(() => { if (s.loaded && view === 'game') paintAfford(); }, 700);
  setInterval(() => { if (s.loaded && !document.hidden) sync(true); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && s.loaded) sync(); });

  const user = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
  const myName = (user && ([user.first_name, user.last_name].filter(Boolean).join(' ') || user.username)) || 'Игрок'; // в шапке — ник (имя), юзернейм только в топе
  $('name').textContent = myName; setAvatar($('avatar'), myName, user && user.photo_url);

  build();
  if (!tg || !tg.initData) {
    $('stage').innerHTML = '<div class="stub" style="margin:auto;padding-top:40%"><div style="font-size:42px;text-align:center">🏨</div><h2 style="text-align:center">Откройте в Telegram</h2><p>Игре нужна проверенная сессия Telegram. Откройте её кнопкой <b>«Открыть Hacker Hotel»</b> в вашем боте.</p></div>';
  } else {
    sync().then(() => { if (!s.loaded) queueFlush(0); });
  }
})();
