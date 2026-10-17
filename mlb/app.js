'use strict';
/* MLB Sim Dashboard: slate of games -> game detail with charts, player projections and a
   what-if simulator. Talks to dashboard.py's JSON API. All text from the API is inserted with
   textContent (via h()), never as HTML. */
(() => {
  // ---------------------------------------------------------------- DOM helpers
  const SVGNS = 'http://www.w3.org/2000/svg';
  const $ = (sel, root = document) => root.querySelector(sel);

  function append(el, kids) {
    for (const k of kids.flat(Infinity)) {
      if (k == null || k === false) continue;
      el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
    return el;
  }
  function setAttrs(el, attrs) {
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.setAttribute('class', v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    setAttrs(el, attrs);
    return append(el, kids);
  }
  function sv(tag, attrs, ...kids) {
    const el = document.createElementNS(SVGNS, tag);
    setAttrs(el, attrs);
    return append(el, kids);
  }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  const ICONS = {
    left: 'M10 3 5 8l5 5', right: 'M6 3l5 5-5 5',
    refresh: 'M13.2 6.2A5.5 5.5 0 1 0 13.5 9M13.5 2.8v3.4h-3.4',
    check: 'M3.5 8.5l3 3 6-7', cross: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
    minus: 'M4 8h8', plus: 'M8 4v8M4 8h8',
  };
  function icon(name) {
    if (name === 'theme') {
      return sv('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        sv('circle', { cx: 8, cy: 8, r: 6, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6 }),
        sv('path', { d: 'M8 2a6 6 0 0 1 0 12z', fill: 'currentColor' }));
    }
    return sv('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, sv('path', { d: ICONS[name] }));
  }

  // ---------------------------------------------------------------- formatting
  const pct = (x, d = 1) => (x == null ? '–' : `${Number(x).toFixed(d)}%`);            // x in 0-100
  const pct01 = (x, d = 1) => (x == null ? '–' : `${(100 * x).toFixed(d)}%`);          // x in 0-1
  const fix = (x, d = 2) => (x == null || Number.isNaN(Number(x)) ? '–' : Number(x).toFixed(d));
  const rate = s => (s == null || s === '' ? '–' : String(s).replace(/^0(?=\.)/, ''));  // ".265"
  const odds = n => (n == null ? '–' : n > 0 ? `+${n}` : `${n}`.replace('-', '−'));
  const signed = (x, d = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;
  const americanOdds = p => {
    p = Math.min(Math.max(p, 1e-4), 1 - 1e-4);
    return p >= 0.5 ? -Math.round(100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
  };
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const shiftDate = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return iso(d); };
  const longDate = s => parseISO(s).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const timeOf = utc => new Date(utc).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const lastName = n => {
    if (!n) return 'TBD';
    if (n.startsWith('TBD')) return 'TBD';
    const p = n.split(' ');
    return p.length > 2 && ['Jr.', 'Sr.', 'II', 'III'].includes(p[p.length - 1]) ? p[p.length - 2] : p[p.length - 1];
  };
  const hand = t => (t === 'L' ? 'LHP' : 'RHP');

  // ---------------------------------------------------------------- images
  function isDark() {
    const t = document.documentElement.dataset.theme;
    return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function logo(team, cls = 'logo') {
    const img = h('img', { class: cls, alt: '', loading: 'lazy',
      src: `https://www.mlbstatic.com/team-logos/team-cap-on-${isDark() ? 'dark' : 'light'}/${team.id}.svg` });
    img.addEventListener('error', () => img.replaceWith(h('span', { class: 'logo-fallback', 'aria-hidden': 'true' }, team.abbr || '')));
    return img;
  }
  const headshot = (id, cls = 'headshot') => h('img', { class: cls, alt: '', loading: 'lazy',
    src: `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_96,q_auto:best/v1/people/${id || 0}/headshot/67/current` });

  // ---------------------------------------------------------------- storage (per-viewer conveniences only)
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  // ---------------------------------------------------------------- API
  async function api(path, body) {
    const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON error */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  let toastTimer;
  function toast(msg) {
    let t = $('.toast');
    if (!t) { t = h('div', { class: 'toast', role: 'status' }); document.body.append(t); }
    t.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 6000);
  }

  // ---------------------------------------------------------------- state
  const state = {
    date: iso(new Date()),
    slate: null, slateDate: null,
    sims: store.get('sims', 10000),
    sort: store.get('sort', 'time'), filter: '',
    queue: [], running: false, busy: new Set(), progress: { done: 0, total: 0 },
    route: { name: 'slate' },
    game: null, baseline: null, form: null, gameBusy: false,
    lineupView: store.get('lineupView', 'sim'), totalLine: null, kLines: {},
    players: null, pfilter: '', showAllHr: false,
    followToday: true,   // viewing today: roll over to the new day at midnight
    lastUpdate: 0,       // last automatic check for new lineups, starters and weather
  };
  let charts = [];
  const AUTO_UPDATE_MS = 10 * 60 * 1000;

  // ---------------------------------------------------------------- routing
  function parseRoute() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    const okDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
    if (parts[0] === 'g' && okDate(parts[1]) && parts[2]) return { name: 'game', date: parts[1], pk: Number(parts[2]) };
    if (parts[0] === 'd' && okDate(parts[1])) return { name: 'slate', date: parts[1] };
    if (parts[0] === 'p' && okDate(parts[1])) return { name: 'players', date: parts[1] };
    if (parts[0] === 'record') return { name: 'record', date: null };
    return { name: 'slate', date: null };
  }
  async function onRoute() {
    const r = parseRoute();
    if (r.date) state.date = r.date;
    else state.date = iso(new Date());
    state.route = r;
    state.followToday = state.date === iso(new Date());
    hideTooltip();
    syncTopbar();
    window.scrollTo(0, 0);
    if (r.name === 'game') await openGame(r.date, r.pk);
    else if (r.name === 'players') await openPlayers();
    else if (r.name === 'record') await openRecord();
    else await openSlate();
  }
  const goDate = d => { location.hash = state.route.name === 'players' ? `#/p/${d}` : `#/d/${d}`; };

  // ---------------------------------------------------------------- top bar
  function syncTopbar() {
    $('#date-input').value = state.date;
    $('#sims').value = String(state.sims);
    const theme = document.documentElement.dataset.theme || 'automatic';
    $('#theme').setAttribute('aria-label', `Theme: ${theme}`);
    $('#theme').title = `Theme: ${theme}`;
  }
  function updateProgress() {
    const el = $('#progress');
    el.replaceChildren();
    if (state.running && state.progress.total) {
      append(el, [h('span', { class: 'spinner', 'aria-hidden': 'true' }),
        `Simulating ${Math.min(state.progress.done + 1, state.progress.total)} of ${state.progress.total}`]);
    }
  }
  function initTopbar() {
    $('#prev-day').append(icon('left'));
    $('#next-day').append(icon('right'));
    $('#refresh').append(icon('refresh'));
    $('#theme').append(icon('theme'));
    $('#prev-day').addEventListener('click', () => goDate(shiftDate(state.date, -1)));
    $('#next-day').addEventListener('click', () => goDate(shiftDate(state.date, 1)));
    $('#today').addEventListener('click', () => goDate(iso(new Date())));
    $('#date-input').addEventListener('change', e => { if (e.target.value) goDate(e.target.value); });
    $('#sims').addEventListener('change', e => { state.sims = Number(e.target.value); store.set('sims', state.sims); });
    $('#run-all').addEventListener('click', () => {
      if (state.route.name !== 'slate') goDate(state.date);
      simulateAll(true);
    });
    $('#refresh').addEventListener('click', async () => {
      await loadSlate(true);
      simulateAll(true);
    });
    $('#theme').addEventListener('click', () => {
      const order = [undefined, 'dark', 'light'];
      const cur = document.documentElement.dataset.theme;
      const next = order[(order.indexOf(cur) + 1) % order.length];
      if (next) document.documentElement.dataset.theme = next; else delete document.documentElement.dataset.theme;
      store.set('theme', next || null);
      syncTopbar();
      rerender();
    });
    const saved = store.get('theme', null);
    if (saved) document.documentElement.dataset.theme = saved;
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => rerender());
    window.addEventListener('resize', debounce(drawCharts, 120));
    window.addEventListener('scroll', hideTooltip, { passive: true });
  }
  function rerender() {
    if (state.route.name === 'game' && state.game) renderGame();
    else if (state.route.name === 'players' && state.players) renderPlayers();
    else if (state.route.name === 'record' && state.record) renderRecord();
    else if (state.route.name === 'slate' && state.slate) renderSlate();
  }

  // ---------------------------------------------------------------- generic views
  function renderLoading(title, note) {
    charts = [];
    $('#view').replaceChildren(h('div', { class: 'card loading-card' },
      h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('div', {}, title), note && h('div', { class: 'muted' }, note)));
  }
  function renderError(err) {
    charts = [];
    $('#view').replaceChildren(h('div', { class: 'card empty' },
      h('div', { style: { fontWeight: 650, color: 'var(--ink)' } }, 'Something went wrong'),
      h('div', {}, err.message || String(err)),
      h('div', { style: { marginTop: '14px' } }, h('button', { class: 'btn', onclick: () => onRoute() }, 'Try again'))));
  }
  const tile = (label, value, sub) => h('div', { class: 'tile' },
    h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value' }, value), sub && h('div', { class: 'tile-sub' }, sub));
  function badge(kind, text) {
    return h('span', { class: `badge ${kind}` }, kind === 'good' ? icon('check') : kind === 'bad' ? icon('cross') : null, text);
  }
  function seg(options, value, onChange, label) {
    const box = h('div', { class: 'seg', role: 'group', 'aria-label': label });
    for (const [v, text] of options) {
      box.append(h('button', { type: 'button', 'aria-pressed': String(v === value), onclick: () => onChange(v) }, text));
    }
    return box;
  }

  // ---------------------------------------------------------------- slate
  async function openSlate() {
    if (state.slateDate !== state.date || !state.slate) await loadSlate(false);
    else renderSlate();
    simulateAll(false);
  }
  async function loadSlate(fresh) {
    const date = state.date;
    if (state.route.name === 'slate' && (fresh || state.slateDate !== date)) {
      renderLoading(fresh ? 'Reloading lineups, starters and weather…' : 'Loading games…',
        'The first load pulls three seasons of player data and can take a minute.');
    }
    try {
      const data = fresh ? await api('/api/refresh', { date }) : await api(`/api/slate?date=${date}&auto=1`);
      if (date !== state.date) return;
      state.slate = data;
      state.slateDate = date;
      state.lastUpdate = Date.now();
      if (fresh) state.queue = state.queue.filter(j => j.date !== date);
      if (state.route.name === 'slate') renderSlate();
      else if (state.route.name === 'players' && fresh) loadPlayers();
    } catch (e) {
      if (state.route.name === 'slate') renderError(e);
      else toast(e.message);
    }
  }
  function simulateAll(force) {
    if (!state.slate) return;
    for (const g of state.slate.games) {
      if (!g.skipped && (force || !g.result)) enqueue(state.slateDate, g.game_pk, force);
    }
  }
  function enqueue(date, pk, force) {
    if (state.queue.some(j => j.date === date && j.pk === pk) || state.busy.has(`${date}/${pk}`)) return;
    state.queue.push({ date, pk, force, sims: state.sims });
    state.progress.total++;
    updateProgress();
    pump();
  }
  async function pump() {
    if (state.running) return;
    state.running = true;
    while (state.queue.length) {
      const job = state.queue.shift();
      const key = `${job.date}/${job.pk}`;
      const card = findGame(job.date, job.pk);
      if (!job.force && card && card.result) { state.progress.done++; continue; }
      state.busy.add(key);
      refreshCard(job.date, job.pk);
      updateProgress();
      try {
        applyResult(await api('/api/simulate', { date: job.date, game_pk: job.pk, sims: job.sims }));
      } catch (e) {
        toast(`Simulation failed: ${e.message}`);
      }
      state.busy.delete(key);
      state.progress.done++;
      refreshCard(job.date, job.pk);
    }
    state.running = false;
    state.progress = { done: 0, total: 0 };
    updateProgress();
  }
  const findGame = (date, pk) => (state.slate && state.slateDate === date ? state.slate.games.find(g => g.game_pk === pk) : null);
  function applyResult(p) {
    const g = findGame(p.date, p.game_pk);
    if (!g || p.what_if) return;
    const s = p.sim;
    g.result = {
      away_win_pct: s.away_win_pct, home_win_pct: s.home_win_pct, away_runs_avg: s.away_runs_avg,
      home_runs_avg: s.home_runs_avg, total_runs_avg: s.total_runs_avg, fair_ml_away: s.fair_ml_away,
      fair_ml_home: s.fair_ml_home, sims: s.sims, generated: p.generated,
      lineups: [p.away.lineup_status, p.home.lineup_status], starters: [p.away.starter, p.home.starter], weather: p.weather,
    };
    if (state.route.name === 'slate') renderKpis();
    if (state.route.name === 'players') refreshPlayersSoon();
  }

  // Keep today's view current on its own: every 10 minutes re-check lineups, starters and
  // weather (the server re-simulates only games whose inputs changed) and roll over at midnight.
  async function autoUpdate() {
    const today = iso(new Date());
    if (state.followToday && state.date !== today && ['slate', 'players'].includes(state.route.name)) { goDate(today); return; }
    if (state.slateDate !== today || document.hidden || Date.now() - state.lastUpdate < AUTO_UPDATE_MS) return;
    state.lastUpdate = Date.now();
    try {
      const data = await api(`/api/slate?date=${today}&auto=1`);
      if (state.slateDate !== today) return;
      state.slate = data;
      if (state.route.name === 'slate') { renderKpis(); renderGrid(); renderUpdated(); }
      if (state.route.name === 'players') loadPlayers();
      simulateAll(false);
    } catch { /* try again on the next tick */ }
  }
  function updatedNote() {
    if (!state.slate || state.slateDate !== iso(new Date()) || !state.slate.updated) return '';
    const t = new Date(state.slate.updated).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `Lineups, starters and weather checked at ${t} · updates automatically every 10 minutes`;
  }
  function renderUpdated() { const el = $('#updated'); if (el) el.textContent = updatedNote(); }
  function viewSwitch(active) {
    return seg([['slate', 'Games'], ['players', 'Home runs & strikeouts'], ['record', 'Track record']], active,
      v => { location.hash = v === 'players' ? `#/p/${state.date}` : v === 'record' ? '#/record' : `#/d/${state.date}`; }, 'View');
  }

  function renderSlate() {
    charts = [];
    const view = $('#view');
    const games = state.slate.games;
    const head = h('div', { class: 'card-head', style: { marginBottom: '14px', flexWrap: 'wrap' } },
      h('div', {}, h('h1', { class: 'card-title', style: { fontSize: '22px' } }, longDate(state.slateDate)),
        h('p', { class: 'card-sub' }, `${games.length} game${games.length === 1 ? '' : 's'} · ${Number(state.sims).toLocaleString()} simulations per game`),
        h('p', { class: 'card-sub', id: 'updated' }, updatedNote())),
      viewSwitch('slate'));
    const kpis = h('div', { class: 'tiles', id: 'kpis' });
    const search = h('input', { class: 'search', type: 'search', placeholder: 'Filter by team', 'aria-label': 'Filter by team', value: state.filter });
    search.addEventListener('input', e => { state.filter = e.target.value; renderGrid(); });
    const toolbar = h('div', { class: 'toolbar' },
      seg([['time', 'Start time'], ['close', 'Closest'], ['fav', 'Biggest favorite'], ['total', 'Highest total'],
        ['market', 'Model vs market']], state.sort,
        v => { state.sort = v; store.set('sort', v); renderSlate(); }, 'Sort games'),
      h('div', { class: 'spacer' }), search);
    const grid = h('div', { class: 'games', id: 'games' });
    view.replaceChildren(head, kpis, toolbar, grid);
    if (!games.length) grid.append(h('div', { class: 'card empty' }, 'No MLB games on this date.'));
    renderKpis();
    renderGrid();
  }
  function renderKpis() {
    const el = $('#kpis');
    if (!el || !state.slate) return;
    const games = state.slate.games.filter(g => !g.skipped);
    const done = games.filter(g => g.result);
    const fav = done.map(g => ({ g, p: Math.max(g.result.away_win_pct, g.result.home_win_pct) })).sort((a, b) => b.p - a.p)[0];
    const close = done.map(g => ({ g, p: Math.max(g.result.away_win_pct, g.result.home_win_pct) })).sort((a, b) => a.p - b.p)[0];
    const high = [...done].sort((a, b) => b.result.total_runs_avg - a.result.total_runs_avg)[0];
    const favTeam = f => (f.g.result.home_win_pct >= f.g.result.away_win_pct ? f.g.home : f.g.away);
    const other = f => (f.g.result.home_win_pct >= f.g.result.away_win_pct ? f.g.away : f.g.home);
    el.replaceChildren(
      tile('Games', String(games.length), `${state.slate.games.length - games.length ? `${state.slate.games.length - games.length} postponed · ` : ''}${done.length} simulated`),
      tile('Biggest favorite', fav ? `${favTeam(fav).abbr} ${pct(fav.p)}` : '–', fav ? `vs ${other(fav).name}` : 'waiting for simulations'),
      tile('Closest matchup', close ? `${pct(close.p)}` : '–', close ? `${close.g.away.abbr} @ ${close.g.home.abbr}` : ''),
      tile('Highest projected total', high ? `${fix(high.result.total_runs_avg, 1)} runs` : '–', high ? `${high.away.abbr} @ ${high.home.abbr} · ${high.venue}` : ''),
    );
  }
  function sortedGames() {
    const q = state.filter.trim().toLowerCase();
    let games = state.slate.games.filter(g => !q || [g.away.name, g.home.name, g.away.abbr, g.home.abbr]
      .some(s => (s || '').toLowerCase().includes(q)));
    const fav = g => (g.result ? Math.max(g.result.away_win_pct, g.result.home_win_pct) : null);
    const cmp = {
      time: (a, b) => a.time_utc.localeCompare(b.time_utc),
      close: (a, b) => (fav(a) ?? 999) - (fav(b) ?? 999),
      fav: (a, b) => (fav(b) ?? -1) - (fav(a) ?? -1),
      total: (a, b) => (b.result ? b.result.total_runs_avg : -1) - (a.result ? a.result.total_runs_avg : -1),
      market: (a, b) => (marketGap(b) ?? -1) - (marketGap(a) ?? -1),
    }[state.sort] || ((a, b) => a.time_utc.localeCompare(b.time_utc));
    return [...games].sort(cmp);
  }
  /** How far the model's home win chance sits from the market's, in points (null without both). */
  function marketGap(g) {
    if (!g.result || !g.market || g.market.p_home == null) return null;
    return Math.abs(g.result.home_win_pct - 100 * g.market.p_home);
  }
  function renderGrid() {
    const grid = $('#games');
    if (!grid) return;
    grid.replaceChildren(...sortedGames().map(gameCard));
  }
  function refreshCard(date, pk) {
    if (state.route.name !== 'slate' || state.slateDate !== date) return;
    const old = document.querySelector(`[data-pk="${pk}"]`);
    const g = findGame(date, pk);
    if (old && g) old.replaceWith(gameCard(g));
  }
  function gameCard(g) {
    const r = g.result;
    const busy = state.busy.has(`${state.slateDate}/${g.game_pk}`);
    const final = g.state === 'Final' && g.away.score != null;
    const live = g.state === 'Live';
    const liveScore = live && g.away.score != null ? ` · ${g.away.abbr} ${g.away.score}–${g.home.score} ${g.home.abbr}` : '';
    const topRight = g.skipped ? g.status : final ? 'Final' : live ? `${g.status}${liveScore}` : timeOf(g.time_utc);
    const teamRow = (t, k) => {
      const sp = r ? r.starters[k === 'away' ? 0 : 1] : (t.starter ? t.starter.name : null);
      const throws = t.starter && sp === t.starter.name ? ` (${t.starter.throws})` : '';
      return h('div', { class: 'team-row' },
        logo(t),
        h('div', { style: { minWidth: 0 } },
          h('div', { class: 'team-name' }, t.name, h('span', { class: 'record' }, t.record)),
          h('div', { class: 'team-sp' }, sp ? `${lastName(sp)}${throws}` : 'Starter TBD')),
        h('div', { class: 'team-pct' },
          final ? h('div', { class: 'pct num' }, String(t.score))
            : h('div', { class: 'pct' }, r ? pct(k === 'away' ? r.away_win_pct : r.home_win_pct) : '–'),
          h('div', { class: 'runs' }, r ? `${final ? `${pct(k === 'away' ? r.away_win_pct : r.home_win_pct, 0)} · ` : ''}${fix(k === 'away' ? r.away_runs_avg : r.home_runs_avg)} R` : '')));
    };
    const bar = r
      ? h('div', { class: 'winbar', role: 'img', 'aria-label': `${g.away.abbr} ${pct(r.away_win_pct)}, ${g.home.abbr} ${pct(r.home_win_pct)}` },
        h('span', { style: { flex: `${r.away_win_pct} 1 0` } }), h('span', { style: { flex: `${r.home_win_pct} 1 0` } }))
      : h('div', { class: 'winbar empty', 'aria-hidden': 'true' }, h('span', { style: { flex: '1 1 0' } }), h('span', { style: { flex: '1 1 0' } }));
    let foot;
    if (g.skipped) foot = h('div', { class: 'pending' }, g.status);
    else if (!r) foot = h('div', { class: 'pending' }, busy ? [h('span', { class: 'spinner' }), 'Simulating…'] : 'Waiting to simulate');
    else {
      const confirmed = r.lineups.every(s => s === 'confirmed');
      const w = r.weather || {};
      const wx = w.roof_closed ? (w.roof_type === 'dome' ? 'Dome' : 'Roof closed') : w.temp_f != null ? `${Math.round(w.temp_f)}°F` : '';
      const items = [h('span', {}, `${live || final ? 'Pre-game total' : 'Total'} ${fix(r.total_runs_avg, 1)}`),
        h('span', { class: 'dot' }, `${odds(r.fair_ml_away)} / ${odds(r.fair_ml_home)}`)];
      const m = g.market;
      if (m && m.p_home != null) {
        const mHome = m.p_home >= 0.5;
        items.push(h('span', { class: 'dot', title: `Betting market${m.book ? ` (${m.book})` : ''}, bookmaker's margin removed${m.total != null ? ` · total ${m.total}` : ''}` },
          `Market ${mHome ? g.home.abbr : g.away.abbr} ${pct01(mHome ? m.p_home : 1 - m.p_home, 0)}`));
      }
      if (wx) items.push(h('span', { class: 'dot' }, wx));
      items.push(h('span', { class: 'dot' }, confirmed ? badge('good', 'Lineups set') : badge('', 'Projected lineups')));
      if (final) {
        const favHome = r.home_win_pct >= r.away_win_pct;
        const homeWon = g.home.score > g.away.score;
        items.push(h('span', { class: 'dot' }, favHome === homeWon ? badge('good', 'Favorite won') : badge('bad', 'Upset')));
      }
      foot = h('div', { class: 'gc-foot' }, items, busy ? h('span', { class: 'spinner', 'aria-label': 'Simulating' }) : null);
    }
    return h('a', { class: `card game-card${busy && r ? ' busy' : ''}`, href: `#/g/${state.slateDate}/${g.game_pk}`, 'data-pk': g.game_pk,
      'aria-label': `${g.away.name} at ${g.home.name}` },
    h('div', { class: 'gc-top' }, h('span', { class: 'venue' }, g.venue), h('span', { class: 'num' }, topRight)),
    teamRow(g.away, 'away'), teamRow(g.home, 'home'), bar, foot);
  }

  // ---------------------------------------------------------------- home run & strikeout odds
  async function openPlayers() {
    if (state.slateDate !== state.date || !state.slate) await loadSlate(false);
    simulateAll(false);
    await loadPlayers();
  }
  async function loadPlayers() {
    const date = state.date;
    if (!state.players || state.players.date !== date) renderLoading('Loading home run and strikeout odds…', '');
    try {
      const data = await api(`/api/players?date=${date}`);
      if (state.route.name !== 'players' || date !== state.date) return;
      state.players = data;
      renderPlayers();
    } catch (e) {
      if (state.route.name === 'players') renderError(e);
    }
  }
  const refreshPlayersSoon = debounce(() => { if (state.route.name === 'players') loadPlayers(); }, 800);

  function renderPlayers() {
    charts = [];
    const d = state.players;
    const search = h('input', { class: 'search', type: 'search', placeholder: 'Filter by player or team',
      'aria-label': 'Filter by player or team', value: state.pfilter });
    search.addEventListener('input', e => { state.pfilter = e.target.value; renderPlayerTables(); });
    $('#view').replaceChildren(
      h('div', { class: 'card-head', style: { marginBottom: '6px', flexWrap: 'wrap' } },
        h('div', {}, h('h1', { class: 'card-title', style: { fontSize: '22px' } }, longDate(d.date)),
          h('p', { class: 'card-sub' }, 'Every batter and starting pitcher on the slate, counted across each game’s simulations'),
          h('p', { class: 'card-sub', id: 'updated' }, updatedNote())),
        viewSwitch('players')),
      h('div', { class: 'toolbar' },
        d.pending ? h('span', { class: 'progress-note' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }),
          `${d.pending} game${d.pending === 1 ? '' : 's'} still simulating; the lists fill in as they finish`) : null,
        h('div', { class: 'spacer' }), search),
      h('div', { id: 'player-tables', class: 'stack' }));
    renderPlayerTables();
  }
  function renderPlayerTables() {
    const box = $('#player-tables');
    if (!box) return;
    const d = state.players;
    const q = state.pfilter.trim().toLowerCase();
    const match = x => !q || [x.name, x.team, x.opp].some(s => (s || '').toLowerCase().includes(q));
    const batters = d.batters.filter(match);
    const pitchers = d.pitchers.filter(match);
    const sims = (d.batters[0] || d.pitchers[0] || {}).sims || state.sims;
    const limit = state.showAllHr || q ? null : 25;
    const more = batters.length > 25 && !q ? h('div', { style: { marginTop: '12px' } }, h('button', { class: 'btn', type: 'button',
      onclick: () => { state.showAllHr = !state.showAllHr; renderPlayerTables(); } },
    state.showAllHr ? 'Show top 25' : `Show all ${batters.length} batters`)) : null;
    box.replaceChildren(
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('div', {},
          h('h2', { class: 'card-title' }, 'Home run chances'),
          h('p', { class: 'card-sub' }, `Out of ${sims.toLocaleString()} simulations of each game: how many games the batter hit a home run in, that as a percent, and his average home runs per game`))),
        batters.length ? hrTable(batters, limit) : h('div', { class: 'muted' }, 'No batters match.'), more),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('div', {},
          h('h2', { class: 'card-title' }, 'Starting pitcher strikeouts'),
          h('p', { class: 'card-sub' }, 'Total strikeouts across all simulations of the game, and that as an average per game'))),
        pitchers.length ? kTable(pitchers) : h('div', { class: 'muted' }, 'No pitchers match.')));
  }
  function hrTable(rows, limit) {
    const shown = limit ? rows.slice(0, limit) : rows;
    return h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {},
        h('th', { class: 'left' }, '#'),
        h('th', { class: 'left' }, 'Batter'),
        h('th', { title: 'Simulated games in which he hit at least one home run' }, 'Games with a HR'),
        h('th', { title: 'Games with a home run divided by simulations' }, 'HR chance'),
        h('th', { title: 'Total home runs divided by simulations (multi-homer games count more than once)' }, 'Avg HR per game'),
        h('th', { title: 'Chance of at least one hit' }, '1+ hit'))),
      h('tbody', {}, shown.map((b, i) => {
        const games = b.hr_games ?? Math.round(b.p_hr * b.sims);
        return h('tr', {},
          h('td', { class: 'left muted' }, String(i + 1)),
          h('td', { class: 'left' }, h('div', { class: 'player' }, headshot(b.id),
            h('div', { style: { minWidth: 0 } }, h('div', { class: 'player-name' }, b.name),
              h('div', { class: 'player-meta' }, `${b.team} · bats ${b.bats} · vs ${lastName(b.vs)} (${b.vs_throws})`)))),
          h('td', {}, `${games.toLocaleString()} of ${b.sims.toLocaleString()}`),
          h('td', {}, h('strong', {}, pct01(b.p_hr, 1))),
          h('td', {}, fix(b.hr_avg, 3)),
          h('td', {}, pct01(b.p_hit, 0)));
      }))));
  }
  function kTable(rows) {
    return h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {},
        h('th', { class: 'left' }, '#'),
        h('th', { class: 'left' }, 'Pitcher'),
        h('th', { title: 'Strikeouts by this starter across every simulated game' }, 'Strikeouts in sims'),
        h('th', { title: 'Total strikeouts divided by simulations' }, 'Avg K per game'),
        h('th', { title: 'Strikeouts divided by batters faced' }, 'K per batter'),
        h('th', { title: 'Chance of 5 or more strikeouts' }, '5+ K'),
        h('th', { title: 'Chance of 7 or more strikeouts' }, '7+ K'))),
      h('tbody', {}, rows.map((p, i) => {
        const total = p.k_total ?? Math.round(p.k_avg * p.sims);
        return h('tr', {},
          h('td', { class: 'left muted' }, String(i + 1)),
          h('td', { class: 'left' }, h('div', { class: 'player' }, headshot(p.id),
            h('div', { style: { minWidth: 0 } }, h('div', { class: 'player-name' }, p.name),
              h('div', { class: 'player-meta' }, `${p.team} · ${hand(p.throws)} · vs ${p.opp} · ${p.ip} IP avg`)))),
          h('td', {}, `${total.toLocaleString()} in ${p.sims.toLocaleString()} games`),
          h('td', {}, h('strong', {}, fix(p.k_avg, 2))),
          h('td', {}, p.k_rate == null ? '–' : pct01(p.k_rate, 1)),
          h('td', {}, pct01(p.p_5k, 0)),
          h('td', {}, pct01(p.p_7k, 0)));
      }))));
  }
  function oddsCard(p) {
    const n = p.sim.sims;
    const batters = [];
    const pitchers = [];
    for (const [key, opp] of [['away', 'home'], ['home', 'away']]) {
      const t = p[key], o = p[opp], sp = t.starter_sim;
      for (const b of t.lineup) {
        batters.push({ id: b.id, name: b.name, bats: b.bats, team: t.abbr, vs: o.starter, vs_throws: o.starter_throws,
          sims: n, hr_games: b.sim.hr_games, p_hr: b.sim.p_hr, hr_avg: b.sim.hr, p_hit: b.sim.p_hit });
      }
      const tail = k => sp.k_dist.slice(k).reduce((a, x) => a + x, 0);
      pitchers.push({ id: t.starter_id, name: t.starter, throws: t.starter_throws, team: t.abbr, opp: o.abbr, sims: n,
        k_total: sp.k_total, k_avg: sp.k, k_rate: sp.bf_total ? sp.k_total / sp.bf_total : sp.k / sp.bf, ip: sp.ip,
        p_5k: tail(5), p_7k: tail(7) });
    }
    batters.sort((a, b) => b.p_hr - a.p_hr);
    return h('div', { class: 'card', style: { marginTop: '16px' } },
      h('div', { class: 'card-head' }, h('div', {},
        h('h2', { class: 'card-title' }, 'Home run and strikeout odds'),
        h('p', { class: 'card-sub' }, `Counted across all ${n.toLocaleString()} simulations of this game`))),
      h('div', { class: 'subhead' }, 'Home runs'),
      hrTable(batters),
      h('div', { class: 'subhead', style: { marginTop: '20px' } }, 'Starting pitcher strikeouts'),
      kTable(pitchers));
  }

  // ---------------------------------------------------------------- track record
  async function openRecord() {
    renderLoading('Grading finished games…', 'Checking final scores and box scores for saved predictions.');
    try {
      const d = await api('/api/record');
      if (state.route.name !== 'record') return;
      state.record = d;
      renderRecord();
    } catch (e) {
      if (state.route.name === 'record') renderError(e);
    }
  }
  const resultBadge = right => (right ? badge('good', 'Right') : badge('bad', 'Wrong'));
  const shortDate = s => parseISO(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  // headers: [label, tooltip, 'left'?]; text columns align left, numbers right.
  /** Replace the page's content. Sections that are not showing are null, and the browser's own
      replaceChildren would print those as the word "null"; this skips them as h() does. */
  function showView(...kids) {
    $('#view').replaceChildren(...kids.flat().filter(k => k != null && k !== false));
  }
  function simpleTable(headers, rows) {
    const align = i => (i === 0 || headers[i][2] === 'left' ? 'left' : null);
    return h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, headers.map(([label, title], i) => h('th', { class: align(i), title }, label)))),
      h('tbody', {}, rows.map(cells => h('tr', {}, cells.map((c, i) => h('td', { class: align(i) }, c)))))));
  }
  /** Whole seasons replayed from only what was known before each game, beside the market. */
  function replayedSeasons(bts) {
    if (!bts.length) return null;
    const rows = bts.map(b => {
      const sg = b.same_games || {};
      const t = b.totals || {};
      return [String(b.seasons.join(', ')), b.games.toLocaleString(),
        sg.model ? pct01(sg.model.right) : '–', sg.market ? pct01(sg.market.right) : '–',
        sg.model ? fix(sg.model.brier, 4) : '–', sg.market ? fix(sg.market.brier, 4) : '–',
        signed(b.runs.bias, 2), t.model_mae != null ? `${fix(t.model_mae, 2)} vs ${fix(t.market_mae, 2)}` : '–'];
    });
    const latest = bts[0];
    const propRows = (latest.props || []).map(m => [m.market, m.n.toLocaleString(), pct01(m.said), pct01(m.actual),
      `${signed(100 * (m.actual - m.said))} pts`]);
    return h('div', { class: 'card', style: { marginTop: '16px' } },
      h('div', { class: 'card-head' }, h('div', {},
        h('h2', { class: 'card-title' }, 'Tested on whole seasons'),
        h('p', { class: 'card-sub' }, 'Every game replayed from only what was known the day before, with the lineups, starters and weather it was played with, and scored beside the closing betting line with the bookmaker\u2019s margin taken out. Lower Brier is better.'))),
      simpleTable([['Season'], ['Games'], ['Model picked right'], ['Market picked right'], ['Model Brier'], ['Market Brier'],
        ['Run bias', 'Projected minus actual runs per team'], ['Total miss', 'Average miss on the game total: model vs market']], rows),
      propRows.length ? h('div', { style: { marginTop: '14px' } },
        h('div', { class: 'card-sub', style: { marginBottom: '6px' } }, `Props, ${latest.seasons.join(', ')}: what the model said against what happened (a well-calibrated market lands near zero)`),
        simpleTable([['Market'], ['Chances'], ['Model said'], ['Happened'], ['Gap']], propRows)) : null);
  }

  function renderRecord() {
    charts = [];
    const d = state.record;
    const s = n => (n === 1 ? '' : 's');
    const head = h('div', { class: 'card-head', style: { marginBottom: '14px', flexWrap: 'wrap' } },
      h('div', {}, h('h1', { class: 'card-title', style: { fontSize: '22px' } }, 'Track record'),
        h('p', { class: 'card-sub' }, `Each game's last simulation before first pitch, graded after the game${d.first_date ? ` · tracking since ${longDate(d.first_date)}` : ''}`)),
      viewSwitch('record'));
    const upcoming = d.upcoming.length ? h('div', { class: 'card', style: { marginTop: '16px' } },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', { class: 'card-title' }, 'Saved picks waiting for results'),
        h('p', { class: 'card-sub' }, 'These are graded automatically once the games are final'))),
      simpleTable([['Date'], ['Matchup', null, 'left'], ['Pick', null, 'left'], ['Saved at', 'When the prediction was locked in']],
        d.upcoming.map(g => [shortDate(g.date), `${g.away} @ ${g.home}`, `${g.pick} ${pct01(g.pick_p)}`,
          new Date(g.predicted_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })]))) : null;
    if (!d.overall.games) {
      showView(head, h('div', { class: 'card empty' },
        h('div', { style: { fontWeight: 650, color: 'var(--ink)' } }, 'No graded predictions yet'),
        h('div', {}, d.pending ? `${d.pending} saved pick${s(d.pending)} waiting for games to finish.`
          : 'Open the Games page before first pitch: every game you simulate is saved as a prediction and graded after it ends.')),
      upcoming);
      return;
    }
    const rec = r => (r.games ? `${r.right}-${r.wrong}` : '–');
    const tiles = h('div', { class: 'tiles' },
      tile('Winner picks', rec(d.overall), `${pct01(d.overall.pct)} right · ${d.overall.games} game${s(d.overall.games)}`),
      tile('Last 7 days', rec(d.last7), d.last7.games ? `${pct01(d.last7.pct)} right` : 'no graded games'),
      tile('Last 30 days', rec(d.last30), d.last30.games ? `${pct01(d.last30.pct)} right` : 'no graded games'),
      tile('Brier score', fix(d.brier.model, 3), `vs ${fix(d.brier.baseline, 3)} always picking the home team · lower is better`),
      d.market ? tile('Betting market, same games', fix(d.market.market.brier, 3),
        `closing-line Brier on these ${d.market.games} games (the model's is ${fix(d.market.model.brier, 3)}) · the market picked ${pct01(d.market.market.right, 0)} right`) : null,
      tile('Waiting for results', String(d.pending), d.pending ? 'saved picks for games not final yet' : 'everything graded'));

    const cal = d.calibration;
    const calSpec = {
      categories: cal.map(c => c.label), categoryLabel: 'Model confidence in the favorite',
      series: [
        { name: 'Predicted', color: '--deemph', values: cal.map(c => c.predicted ?? 0) },
        { name: 'Actual', color: '--accent', values: cal.map(c => c.actual ?? 0) },
      ],
      ariaLabel: 'Predicted versus actual win rate of the favorite, by model confidence',
      tooltip: i => ({ title: `${cal[i].label} favorites · ${cal[i].games} game${s(cal[i].games)}`, rows: [
        { color: '--deemph', value: cal[i].games ? pct01(cal[i].predicted) : '–', label: 'predicted' },
        { color: '--accent', value: cal[i].games ? pct01(cal[i].actual) : '–', label: 'actually won' }] }),
    };
    const calCard = chartCard({ title: 'Were the probabilities right?',
      sub: 'How often the favorite won, grouped by how confident the model was. Over many games the two bars should match.',
      spec: calSpec, legendItems: [{ color: '--deemph', label: 'Predicted win %' }, { color: '--accent', label: 'Actual win %' }],
      readout: h('div', { class: 'readout' }, h('span', { class: 'muted' },
        'Small samples swing a lot: judge calibration after a few hundred games.')) });
    const daily = h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', { class: 'card-title' }, 'By day'))),
      simpleTable([['Date'], ['Games'], ['Right'], ['Wrong'], ['Pct']],
        d.daily.slice(0, 21).map(x => [shortDate(x.date), String(x.games), String(x.right), String(x.wrong), pct01(x.pct)])));
    const r = d.runs;
    const recent = h('div', { class: 'card', style: { marginTop: '16px' } },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', { class: 'card-title' }, 'Recent picks'),
        h('p', { class: 'card-sub' }, `Runs: projected ${fix(r.projected)} per game, actual ${fix(r.actual)} · average miss ${fix(r.miss)} runs · went over the projection in ${pct01(r.over_share, 0)} of games`))),
      simpleTable([['Date'], ['Matchup', null, 'left'], ['Pick', "The model's favorite and its win chance", 'left'],
        ['Projected'], ['Final'], ['Result', null, 'left']],
        d.recent.map(g => [shortDate(g.date), `${g.away} @ ${g.home}`, `${g.pick} ${pct01(g.pick_p)}`,
          `${fix(g.pred_away, 1)} – ${fix(g.pred_home, 1)}`, `${g.away_score} – ${g.home_score}`, resultBadge(g.correct)])));
    let props;
    if (d.hr || d.k) {
      const hr = d.hr, k = d.k;
      props = h('div', { class: 'grid grid-2', style: { marginTop: '16px' } },
        hr ? h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('div', {}, h('h2', { class: 'card-title' }, 'Home run predictions'),
            h('p', { class: 'card-sub' }, `${hr.batters.toLocaleString()} batter-games tracked: the model expected ${fix(hr.expected, 0)} home-run games; there were ${hr.actual}`))),
          simpleTable([['HR chance'], ['Batters'], ['Predicted'], ['Homered']],
            hr.buckets.filter(b => b.batters).map(b => [b.label, String(b.batters), pct01(b.predicted), pct01(b.actual)])),
          h('div', { class: 'readout' }, `Each day's top home run pick homered on ${hr.top_pick.homered} of ${hr.top_pick.days} days (expected ${fix(hr.top_pick.expected, 1)})`))
          : h('div', { class: 'card empty' }, 'Home run tracking starts with games simulated from Sept 19 on.'),
        k ? h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('div', {}, h('h2', { class: 'card-title' }, 'Strikeout predictions'),
            h('p', { class: 'card-sub' }, `${k.starts} starts tracked`))),
          h('div', { class: 'kv' },
            h('div', {}, h('span', {}, 'Projected per start'), h('b', {}, fix(k.projected))),
            h('div', {}, h('span', {}, 'Actual per start'), h('b', {}, fix(k.actual))),
            h('div', {}, h('span', {}, 'Beat the projection'), h('b', {}, pct01(k.over_share, 0))),
            h('div', {}, h('span', {}, 'Average miss'), h('b', {}, `${fix(k.miss, 1)} K`)),
            h('div', {}, h('span', {}, '5+ K predicted'), h('b', {}, pct01(k.p5_predicted, 0))),
            h('div', {}, h('span', {}, '5+ K happened'), h('b', {}, pct01(k.p5_actual, 0)))))
          : h('div', { class: 'card empty' }, 'Strikeout tracking starts with games simulated from Sept 19 on.'));
    } else {
      props = h('div', { class: 'card', style: { marginTop: '16px' } }, h('div', { class: 'muted' },
        'Home run and strikeout predictions are tracked for games simulated from Sept 19 on; they appear here once those games are final.'));
    }
    showView(head, tiles,
      h('div', { class: 'grid grid-2', style: { marginTop: '16px' } }, calCard, daily),
      replayedSeasons(d.backtests || []), recent, props, upcoming);
    drawCharts();
  }

  // ---------------------------------------------------------------- charts
  function niceTicks(max, count = 4) {
    const raw = max / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
    const ticks = [];
    for (let t = 0; t <= Math.ceil(max / step - 1e-9) * step + 1e-12; t += step) ticks.push(Number(t.toFixed(10)));
    return ticks;
  }
  function barPath(x, top, w, hgt, r = 4) {
    if (hgt <= 0) return '';
    r = Math.min(r, w / 2, hgt);
    const b = top + hgt;
    return `M${x},${b}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${b}Z`;
  }
  function legend(items) {
    return h('div', { class: 'legend' }, items.map(i => h('span', {}, h('i', { class: 'key', style: { background: `var(${i.color})` } }), i.label)));
  }
  function chartBox(spec) {
    const box = h('div', { class: 'chart' });
    charts.push({ box, spec });
    return box;
  }
  function drawCharts() { for (const c of charts) if (c.box.isConnected && !c.box.hidden) drawChart(c.box, c.spec); }
  function drawChart(box, spec) {
    const W = Math.max(240, Math.round(box.clientWidth || 320));
    const H = spec.height || 190;
    const padL = 36, padR = 6, padT = spec.marker ? 18 : 8, padB = 24;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const n = spec.categories.length, S = spec.series.length;
    const maxV = Math.max(1e-6, ...spec.series.flatMap(s => s.values));
    const ticks = niceTicks(maxV);
    const top = ticks[ticks.length - 1];
    const y = v => padT + plotH - (v / top) * plotH;
    const band = plotW / n;
    const gap = 2;
    const bw = Math.max(2, Math.min(24, (band * 0.8 - gap * (S - 1)) / S));
    const groupW = bw * S + gap * (S - 1);
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': spec.ariaLabel });
    const tickFmt = spec.tickFormat || (t => `${+(t * 100).toFixed(1)}%`);
    for (const t of ticks) {
      svg.append(sv('line', { class: t === 0 ? 'baseline' : 'grid-line', x1: padL, x2: W - padR, y1: y(t), y2: y(t) }),
        sv('text', { class: 'tick', x: padL - 6, y: y(t) + 3.5, 'text-anchor': 'end' }, tickFmt(t)));
    }
    const bands = sv('g', {});
    const barsG = sv('g', { class: 'bars' });
    const barEls = [];
    spec.categories.forEach((cat, i) => {
      const x0 = padL + i * band;
      const hit = sv('rect', { class: 'band', x: x0, y: padT, width: band, height: plotH, tabindex: 0, rx: 4,
        'aria-label': spec.tooltip(i).rows.map(r => `${r.label} ${r.value}`).join(', ') + ` (${spec.tooltip(i).title})` });
      bands.append(hit);
      const els = spec.series.map((s, k) => {
        const v = s.values[i];
        const hgt = v > 0 ? Math.max(1, (v / top) * plotH) : 0;
        const x = x0 + (band - groupW) / 2 + k * (bw + gap);
        const color = spec.colorOf ? spec.colorOf(i, k) : s.color;
        const p = sv('path', { class: 'bar', d: barPath(x, padT + plotH - hgt, bw, hgt), style: { fill: `var(${color})` } });
        barsG.append(p);
        return p;
      });
      barEls.push(els);
      const on = e => {
        hit.classList.add('on');
        barsG.classList.add('dim');
        els.forEach(b => b.classList.add('on'));
        const r = hit.getBoundingClientRect();
        showTooltip(spec.tooltip(i), e && e.clientX != null ? e.clientX : r.left + r.width / 2, e && e.clientY != null ? e.clientY : r.top + 20);
      };
      const off = () => { hit.classList.remove('on'); barsG.classList.remove('dim'); els.forEach(b => b.classList.remove('on')); hideTooltip(); };
      hit.addEventListener('pointerenter', on);
      hit.addEventListener('pointermove', e => positionTooltip(e.clientX, e.clientY));
      hit.addEventListener('pointerleave', off);
      hit.addEventListener('focus', () => on(null));
      hit.addEventListener('blur', off);
    });
    svg.append(bands, barsG);
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 30))));
    spec.categories.forEach((cat, i) => {
      if (i % every === 0 || i === n - 1) {
        svg.append(sv('text', { class: 'tick', x: padL + (i + 0.5) * band, y: H - 7, 'text-anchor': 'middle' }, cat));
      }
    });
    if (spec.marker) {
      const mx = padL + spec.marker.at * band;
      svg.append(sv('line', { class: 'marker', x1: mx, x2: mx, y1: padT - 4, y2: padT + plotH }),
        sv('text', { class: 'marker-label', x: mx, y: padT - 8, 'text-anchor': 'middle' }, spec.marker.label));
    }
    box.replaceChildren(svg);
  }
  function chartTable(spec) {
    return h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', { class: 'left' }, spec.categoryLabel || ''), spec.series.map(s => h('th', {}, s.name)))),
      h('tbody', {}, spec.categories.map((c, i) => h('tr', {}, h('td', { class: 'left' }, c),
        spec.series.map(s => h('td', {}, (spec.format || pct01)(s.values[i])))))));
  }
  function chartCard({ title, sub, spec, legendItems, readout, tools }) {
    const box = chartBox(spec);
    const table = h('div', { class: 'table-wrap', hidden: true }, chartTable(spec));
    const toggle = h('button', { class: 'btn', type: 'button', 'aria-pressed': 'false' }, 'Table');
    toggle.addEventListener('click', () => {
      const on = toggle.getAttribute('aria-pressed') !== 'true';
      toggle.setAttribute('aria-pressed', String(on));
      toggle.textContent = on ? 'Chart' : 'Table';
      box.hidden = on;
      table.hidden = !on;
      if (!on) drawChart(box, spec);
    });
    return h('div', { class: 'card chart-card' },
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', { class: 'card-title' }, title), sub && h('p', { class: 'card-sub' }, sub)),
        h('div', { class: 'chart-tools' }, tools, toggle)),
      legendItems && legendItems.length > 1 ? legend(legendItems) : null, box, table, readout);
  }
  function showTooltip({ title, rows }, x, y) {
    const tt = $('#tooltip');
    tt.replaceChildren(h('div', { class: 'tt-title' }, title),
      rows.map(r => h('div', { class: 'tt-row' }, h('i', { class: 'key-line', style: { background: `var(${r.color})` } }),
        h('strong', {}, r.value), h('span', {}, r.label))));
    tt.hidden = false;
    positionTooltip(x, y);
  }
  function positionTooltip(x, y) {
    const tt = $('#tooltip');
    if (tt.hidden) return;
    const r = tt.getBoundingClientRect();
    let left = x + 14, top = y - r.height - 10;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
    if (top < 8) top = y + 16;
    tt.style.left = `${Math.max(8, left)}px`;
    tt.style.top = `${top}px`;
  }
  function hideTooltip() { const tt = $('#tooltip'); if (tt) tt.hidden = true; }
  function stepper(value, onChange, label, min, max) {
    const out = h('output', { class: 'num', 'aria-live': 'polite' }, value.toFixed(1));
    const b = (dir, name) => h('button', { class: 'btn', type: 'button', 'aria-label': `${label} ${name}`,
      onclick: () => onChange(Math.min(max, Math.max(min, value + dir))) }, icon(dir < 0 ? 'minus' : 'plus'));
    return h('span', { class: 'stepper', role: 'group', 'aria-label': label }, b(-1, 'down'), out, b(1, 'up'));
  }

  // ---------------------------------------------------------------- game view
  async function openGame(date, pk) {
    const same = state.game && state.game.game_pk === pk && state.game.date === date;
    if (same) { renderGame(); return; }
    state.game = state.baseline = state.form = null;
    state.totalLine = null;
    state.kLines = {};
    renderLoading('Simulating this game…', 'Usually a second or two.');
    try {
      let p = await api(`/api/game?date=${date}&pk=${pk}`);
      if (!p) {
        p = await api('/api/simulate', { date, game_pk: pk, sims: state.sims });
        applyResult(p);
      }
      if (state.route.name !== 'game' || state.route.pk !== pk) return;
      state.game = state.baseline = p;
      state.form = formFrom(p);
      renderGame();
    } catch (e) {
      renderError(e);
    }
  }
  function formFrom(p) {
    const w = p.weather || {};
    return { sims: state.sims, seed: '', away: p.away.starter_id, home: p.home.starter_id, weather: 'actual',
      temp: Math.round(w.temp_f ?? 72), wind: Math.round(w.wind_out_mph ?? 0), roof: !!w.roof_closed };
  }
  async function runWhatIf() {
    const f = state.form, base = state.baseline;
    const starters = {};
    if (f.away && f.away !== base.away.starter_id) starters.away = f.away;
    if (f.home && f.home !== base.home.starter_id) starters.home = f.home;
    const weather = f.weather === 'actual' ? null : f.weather === 'neutral' ? { mode: 'neutral' }
      : { mode: 'custom', temp_f: f.temp, wind_out_mph: f.wind, roof_closed: f.roof };
    state.gameBusy = true;
    markGameBusy();
    try {
      const p = await api('/api/simulate', { date: base.date, game_pk: base.game_pk, sims: f.sims,
        seed: f.seed === '' ? null : Number(f.seed), starters, weather });
      if (state.route.name !== 'game' || state.route.pk !== base.game_pk) return;
      state.game = p;
      if (!p.what_if) { state.baseline = p; applyResult(p); }
      state.gameBusy = false;
      renderGame();
    } catch (e) {
      toast(e.message);
    } finally {
      state.gameBusy = false;
      markGameBusy();
    }
  }
  function markGameBusy() {
    const res = $('#results');
    if (res) res.classList.toggle('busy', state.gameBusy);
    const btn = $('#run-sim');
    if (btn) {
      btn.disabled = state.gameBusy;
      btn.replaceChildren(...(state.gameBusy ? [h('span', { class: 'spinner' }), 'Simulating…'] : ['Run simulation']));
    }
  }

  function renderGame() {
    charts = [];
    hideTooltip();
    const p = state.game;
    const view = $('#view');
    view.replaceChildren(
      h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' },
        h('a', { href: `#/d/${p.date}` }, icon('left'), ' All games'), h('span', {}, `· ${longDate(p.date)}`)),
      matchupCard(p),
      heroRow(p),
      whatIfCard(p),
      h('div', { class: 'results', id: 'results' },
        h('div', { class: 'grid grid-3', style: { marginTop: '16px' } }, runsCard(p), totalsCard(p), marginCard(p)),
        lineupsCard(p),
        oddsCard(p),
        h('h2', { class: 'section-title' }, 'Pitching'),
        h('div', { class: 'grid grid-2' }, pitcherCard(p, 'away'), pitcherCard(p, 'home')),
        conditionsCard(p)));
    drawCharts();
    markGameBusy();
  }

  function matchupCard(p) {
    const actual = p.actual || {};
    const final = actual.state === 'Final' && actual.away != null;
    const team = (t, k) => h('div', { class: `mu-team ${k}` }, logo(t),
      h('div', { style: { minWidth: 0 } },
        h('div', { class: 'mu-name' }, t.name),
        h('div', { class: 'mu-meta' }, [t.record, `${lastName(t.starter)} (${hand(t.starter_throws)})`].filter(Boolean).join(' · '))));
    return h('div', { class: 'card matchup' },
      team(p.away, 'away'),
      h('div', { class: 'mu-center' },
        final ? h('div', { class: 'final num' }, `${actual.away} – ${actual.home}`) : h('div', { class: 'vs' }, 'at'),
        h('div', {}, final ? 'Final' : `${timeOf(p.game_time_utc)} · ${p.status}`),
        h('div', { class: 'muted' }, p.venue)),
      team(p.home, 'home'));
  }

  function heroRow(p) {
    const s = p.sim, base = state.baseline.sim;
    const whatIf = !!p.what_if;
    const homeFav = s.home_win_pct >= s.away_win_pct;
    const fav = homeFav ? p.home : p.away;
    const favPct = homeFav ? s.home_win_pct : s.away_win_pct;
    const delta = (v, b) => (whatIf ? h('span', { class: 'delta' }, `${signed(v - b)} pts`) : null);
    const hero = h('div', { class: 'card' },
      h('div', { class: 'hero-label' }, `${fav.name} win probability`),
      h('div', { class: 'hero-figure' }, pct(favPct), h('small', {}, fav.abbr)),
      h('div', { class: 'winbar lg', role: 'img', 'aria-label': `${p.away.abbr} ${pct(s.away_win_pct)}, ${p.home.abbr} ${pct(s.home_win_pct)}` },
        h('span', { style: { flex: `${s.away_win_pct} 1 0` } }), h('span', { style: { flex: `${s.home_win_pct} 1 0` } })),
      h('div', { class: 'hero-legend' },
        h('span', {}, h('i', { class: 'key', style: { background: 'var(--away)' } }), `${p.away.abbr} `, h('strong', {}, pct(s.away_win_pct)), delta(s.away_win_pct, base.away_win_pct)),
        h('span', {}, h('strong', {}, pct(s.home_win_pct)), delta(s.home_win_pct, base.home_win_pct), ` ${p.home.abbr}`, h('i', { class: 'key', style: { background: 'var(--home)', margin: '0 0 0 6px' } }))),
      h('div', { class: 'hero-note' }, `${s.sims.toLocaleString()} simulations · ±${fix(s.win_pct_se, 1)} pts simulation error · simulated ${new Date(p.generated).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`),
      edgesTable(p));
    const runDelta = (v, b) => (whatIf ? ` (${signed(v - b, 2)})` : '');
    const homeRL = s.home_minus_1_5_pct, awayRL = s.away_plus_1_5_pct;
    const tiles = h('div', { class: 'tiles' },
      tile('Projected score', `${fix(s.away_runs_avg)} – ${fix(s.home_runs_avg)}`,
        `${p.away.abbr}${runDelta(s.away_runs_avg, base.away_runs_avg)} – ${p.home.abbr}${runDelta(s.home_runs_avg, base.home_runs_avg)}`),
      tile('Total runs', fix(s.total_runs_avg), `median ${fix(s.total_runs_median, 0)}${runDelta(s.total_runs_avg, base.total_runs_avg)}`),
      tile('Fair moneyline', `${odds(s.fair_ml_away)} / ${odds(s.fair_ml_home)}`, `${p.away.abbr} / ${p.home.abbr} · no vig`),
      marketTile(p),
      tile('Run line', `${p.home.abbr} −1.5 ${pct(homeRL, 0)}`, `${p.away.abbr} +1.5 ${pct(awayRL, 0)}`),
      tile('Extra innings', pct(s.extra_innings_pct), 'chance the game goes past 9'));
    return h('div', { class: 'hero-row' }, hero, tiles);
  }

  function marketTile(p) {
    const m = p.market;
    if (!m || m.p_home == null) return tile('Betting market', '–', 'no line posted yet');
    const homeFav = m.p_home >= 0.5;
    const gap = p.sim.home_win_pct - 100 * m.p_home;
    return tile('Betting market', `${homeFav ? p.home.abbr : p.away.abbr} ${pct01(homeFav ? m.p_home : 1 - m.p_home)}`,
      `${odds(m.away_ml)} / ${odds(m.home_ml)}${m.total != null ? ` · total ${m.total}` : ''} · model ${signed(gap)} pts on ${p.home.abbr}`);
  }

  function edgesTable(p) {
    const lineupWoba = t => t.lineup.reduce((a, b) => a + b.vs_starter.woba, 0) / t.lineup.length;
    const staff = x => `${x.ip} IP · ${fix(x.runs)} R`;
    const row = (label, title, a, b) => h('tr', {}, h('td', { title }, label), h('td', {}, a), h('td', {}, b));
    return h('div', { class: 'table-wrap edges' }, h('table', { class: 'data' },
      h('caption', { class: 'sr-only' }, 'Matchup edges'),
      h('thead', {}, h('tr', {}, h('th', { class: 'left' }, 'Matchup edges'),
        h('th', {}, h('i', { class: 'key', style: { background: 'var(--away)' } }), p.away.abbr),
        h('th', {}, h('i', { class: 'key', style: { background: 'var(--home)' } }), p.home.abbr))),
      h('tbody', {},
        row('Lineup vs. opposing starter', "Average projected wOBA of the lineup against the other team's starter",
          rate(lineupWoba(p.away).toFixed(3)), rate(lineupWoba(p.home).toFixed(3))),
        row(`Starter: ${lastName(p.away.starter)} / ${lastName(p.home.starter)}`, 'Average simulated innings and runs allowed',
          staff(p.away.starter_sim), staff(p.home.starter_sim)),
        row('Bullpen', 'Average simulated relief innings and runs allowed', staff(p.away.bullpen_sim), staff(p.home.bullpen_sim)),
        row('Lineup status', 'Confirmed lineups are posted by the teams; projected ones come from recent games',
          p.away.lineup_status === 'confirmed' ? 'Confirmed' : 'Projected', p.home.lineup_status === 'confirmed' ? 'Confirmed' : 'Projected'))));
  }

  function whatIfCard(p) {
    const f = state.form, base = state.baseline;
    const setF = (k, v, redraw = false) => { f[k] = v; if (redraw) replaceWhatIf(); };
    const starterSelect = key => {
      const team = base[key];
      const opts = team.pitcher_options || [];
      const sel = h('select', { class: 'select', id: `sp-${key}` });
      const current = base[key].starter_id;
      if (!opts.some(o => o.id === current)) {
        sel.append(h('option', { value: current }, `${base[key].starter}${base[key].probable_id ? ' (probable)' : ''}`));
      }
      for (const [role, label] of [['SP', 'Starters'], ['RP', 'Relievers']]) {
        const group = h('optgroup', { label });
        for (const o of opts.filter(x => x.role === role)) {
          const tag = o.id === base[key].probable_id ? ' · probable' : '';
          group.append(h('option', { value: o.id }, `${o.name} (${o.throws}HP${o.era ? `, ${o.era} ERA` : ''})${tag}`));
        }
        if (group.children.length) sel.append(group);
      }
      sel.value = String(f[key]);
      sel.addEventListener('change', e => setF(key, Number(e.target.value)));
      return h('div', { class: 'field' }, h('label', { for: `sp-${key}` }, `${team.abbr} starting pitcher`), sel);
    };
    const seed = h('input', { class: 'input num', id: 'seed', inputmode: 'numeric', placeholder: 'Random', value: f.seed });
    seed.addEventListener('input', e => setF('seed', e.target.value.replace(/\D/g, '')));
    const fields = [
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Simulations'),
        seg([[1000, '1k'], [5000, '5k'], [10000, '10k'], [25000, '25k'], [50000, '50k']], f.sims, v => setF('sims', v, true), 'Simulations')),
      starterSelect('away'),
      starterSelect('home'),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Weather'),
        seg([['actual', 'Actual'], ['neutral', 'Neutral'], ['custom', 'Custom']], f.weather, v => setF('weather', v, true), 'Weather')),
      h('div', { class: 'field' }, h('label', { for: 'seed' }, 'Random seed'), seed),
    ];
    if (f.weather === 'custom') {
      const temp = h('output', { class: 'num' }, `${f.temp}°F`);
      const wind = h('output', { class: 'num' }, windText(f.wind));
      const tIn = h('input', { type: 'range', min: 35, max: 105, step: 1, value: f.temp, 'aria-label': 'Temperature' });
      tIn.addEventListener('input', e => { f.temp = Number(e.target.value); temp.textContent = `${f.temp}°F`; });
      const wIn = h('input', { type: 'range', min: -20, max: 20, step: 1, value: f.wind, 'aria-label': 'Wind (negative blows in)' });
      wIn.addEventListener('input', e => { f.wind = Number(e.target.value); wind.textContent = windText(f.wind); });
      fields.push(h('div', { class: 'field' }, h('span', { class: 'label' }, 'Temperature'), h('div', { class: 'range' }, tIn, temp)),
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Wind'), h('div', { class: 'range' }, wIn, wind)));
      if ((p.weather.roof_type || 'open') !== 'open') {
        const cb = h('input', { type: 'checkbox', id: 'roof', checked: f.roof });
        cb.addEventListener('change', e => { f.roof = e.target.checked; });
        fields.push(h('div', { class: 'field' }, h('label', { class: 'checkbox', for: 'roof' }, cb, 'Roof closed')));
      }
    }
    const reset = h('button', { class: 'btn', type: 'button', onclick: () => {
      state.game = state.baseline; state.form = formFrom(state.baseline); renderGame();
    } }, 'Reset to baseline');
    const run = h('button', { class: 'btn btn-primary', id: 'run-sim', type: 'button', onclick: runWhatIf }, 'Run simulation');
    const card = h('div', { class: 'card whatif', id: 'whatif' },
      h('div', { class: 'card-head' }, h('div', {},
        h('h2', { class: 'card-title' }, 'Run a simulation'),
        h('p', { class: 'card-sub' }, 'Change the starter, weather or number of simulations and re-run this game. Game cards keep the baseline projection.'))),
      h('div', { class: 'wf-grid' }, fields),
      h('div', { class: 'wf-actions' }, reset, run),
      p.what_if ? whatIfBanner(p) : null);
    return card;
  }
  function replaceWhatIf() {
    const old = $('#whatif');
    if (old) { old.replaceWith(whatIfCard(state.game)); markGameBusy(); }
  }
  const windText = w => (w === 0 ? 'calm' : `${Math.abs(w)} mph ${w > 0 ? 'out' : 'in'}`);
  function whatIfBanner(p) {
    const parts = [];
    const wi = p.what_if;
    for (const k of ['away', 'home']) if (wi.starters && wi.starters[k]) parts.push(`${p[k].abbr} starter: ${p[k].starter}`);
    if (wi.weather) parts.push(wi.weather.mode === 'neutral' ? 'weather effects off'
      : `${wi.weather.temp_f}°F, ${windText(wi.weather.wind_out_mph)}${wi.weather.roof_closed ? ', roof closed' : ''}`);
    return h('div', { class: 'wf-banner', role: 'status' }, h('strong', {}, 'Showing a what-if.'),
      parts.join(' · '), h('span', { class: 'muted' }, 'Changes vs the baseline are shown next to each number.'));
  }

  // ------------------------------------------------ distribution charts
  function runsCard(p) {
    const s = p.sim, N = s.sims, cap = 11;
    const bucket = d => d.slice(0, cap).map(c => c / N).concat([d.slice(cap).reduce((a, b) => a + b, 0) / N]);
    const cats = [...Array(cap).keys()].map(String).concat([`${cap}+`]);
    const series = [
      { name: p.away.abbr, color: '--away', values: bucket(s.away_runs_dist) },
      { name: p.home.abbr, color: '--home', values: bucket(s.home_runs_dist) },
    ];
    const spec = { categories: cats, series, categoryLabel: 'Runs', ariaLabel: 'Runs scored by each team across simulations',
      tooltip: i => ({ title: `${cats[i]} run${cats[i] === '1' ? '' : 's'}`, rows: series.map(x => ({ color: x.color, value: pct01(x.values[i]), label: x.name })) }) };
    return chartCard({ title: 'Runs scored', sub: 'Share of simulations ending with each score',
      spec, legendItems: series.map(x => ({ color: x.color, label: x.name })),
      readout: h('div', { class: 'readout' },
        h('span', {}, `${p.away.abbr} shutout `, h('strong', {}, pct01(s.away_runs_dist[0] / N))),
        h('span', {}, `${p.home.abbr} shutout `, h('strong', {}, pct01(s.home_runs_dist[0] / N)))) });
  }
  function totalsCard(p) {
    const s = p.sim, N = s.sims, cap = 20;
    if (state.totalLine == null) state.totalLine = Math.max(3.5, Math.floor(s.total_runs_avg) + 0.5);
    const line = state.totalLine;
    const vals = s.total_runs_dist.slice(0, cap).map(c => c / N).concat([s.total_runs_dist.slice(cap).reduce((a, b) => a + b, 0) / N]);
    const cats = [...Array(cap).keys()].map(String).concat([`${cap}+`]);
    const over = s.total_runs_dist.reduce((a, c, k) => a + (k > line ? c : 0), 0) / N;
    const spec = { categories: cats, series: [{ name: 'Share of simulations', color: '--accent', values: vals }],
      categoryLabel: 'Total runs', ariaLabel: `Total runs distribution with over/under line at ${line}`,
      colorOf: i => (i > line ? '--accent' : '--deemph'), marker: { at: Math.ceil(line), label: line.toFixed(1) },
      tooltip: i => ({ title: `${cats[i]} total runs`, rows: [{ color: i > line ? '--accent' : '--deemph', value: pct01(vals[i]), label: i > line ? `Over ${line}` : `Under ${line}` }] }) };
    const card = chartCard({ title: 'Total runs', sub: 'Pick a line to see the over/under split',
      spec, legendItems: [{ color: '--accent', label: `Over ${line}` }, { color: '--deemph', label: `Under ${line}` }],
      tools: stepper(line, v => { state.totalLine = v; const old = $('#totals-card'); const fresh = totalsCard(p); old.replaceWith(fresh); drawCharts(); }, 'Total line', 0.5, 25.5),
      readout: h('div', { class: 'readout' },
        h('span', {}, `Over ${line} `, h('strong', {}, pct01(over)), h('span', { class: 'muted' }, ` (${odds(americanOdds(over))})`)),
        h('span', {}, `Under `, h('strong', {}, pct01(1 - over)), h('span', { class: 'muted' }, ` (${odds(americanOdds(1 - over))})`)),
        h('span', { class: 'muted' }, `avg ${fix(s.total_runs_avg)}`)) });
    card.id = 'totals-card';
    return card;
  }
  function marginCard(p) {
    const s = p.sim, N = s.sims, d = s.margin_dist;   // index = home margin + 15
    const at = m => d[m + 15] / N;
    const sum = (a, b) => { let t = 0; for (let m = a; m <= b; m++) t += at(m); return t; };
    const cats = ['−6+', '−5', '−4', '−3', '−2', '−1', '+1', '+2', '+3', '+4', '+5', '+6+'];
    const vals = [sum(-15, -6), at(-5), at(-4), at(-3), at(-2), at(-1), at(1), at(2), at(3), at(4), at(5), sum(6, 15)];
    const margins = ['6 or more', '5', '4', '3', '2', '1', '1', '2', '3', '4', '5', '6 or more'];
    const side = i => (i < 6 ? p.away : p.home);
    const spec = { categories: cats, series: [{ name: 'Share of simulations', color: '--home', values: vals }],
      categoryLabel: `Margin (${p.home.abbr} runs minus ${p.away.abbr} runs)`, ariaLabel: 'Winning margin distribution',
      colorOf: i => (i < 6 ? '--away' : '--home'),
      tooltip: i => ({ title: `${side(i).abbr} wins by ${margins[i]}`, rows: [{ color: i < 6 ? '--away' : '--home', value: pct01(vals[i]), label: side(i).name }] }) };
    return chartCard({ title: 'Winning margin', sub: `Left: ${p.away.abbr} wins · right: ${p.home.abbr} wins`,
      spec, legendItems: [{ color: '--away', label: `${p.away.abbr} wins` }, { color: '--home', label: `${p.home.abbr} wins` }],
      readout: h('div', { class: 'readout' },
        h('span', {}, `${p.home.abbr} −1.5 `, h('strong', {}, pct(s.home_minus_1_5_pct))),
        h('span', {}, `${p.away.abbr} +1.5 `, h('strong', {}, pct(s.away_plus_1_5_pct))),
        h('span', { class: 'muted' }, `one-run game ${pct01(at(-1) + at(1))}`)) });
  }

  // ------------------------------------------------ lineups
  const SIM_COLS = [
    ['PA', 'Plate appearances per game', b => fix(b.sim.pa)],
    ['H', 'Hits per game', b => fix(b.sim.h)],
    ['HR', 'Home runs per game', b => fix(b.sim.hr)],
    ['RBI', 'Runs batted in per game', b => fix(b.sim.rbi)],
    ['R', 'Runs scored per game', b => fix(b.sim.r)],
    ['BB', 'Walks and hit-by-pitches per game', b => fix(b.sim.bb)],
    ['K', 'Strikeouts per game', b => fix(b.sim.k)],
    ['TB', 'Total bases per game', b => fix(b.sim.tb)],
    ['1+ H', 'Chance of at least one hit', b => pct01(b.sim.p_hit, 0)],
    ['2+ H', 'Chance of two or more hits', b => pct01(b.sim.p_2hits, 0)],
    ['1+ HR', 'Chance of at least one home run', b => pct01(b.sim.p_hr, 1)],
  ];
  const SEASON_COLS = [
    ['G', 'Games', b => b.season ? String(b.season.g ?? '–') : '–'],
    ['PA', 'Plate appearances', b => b.season ? String(b.season.pa) : '–'],
    ['AVG', 'Batting average', b => b.season ? rate(b.season.avg) : '–'],
    ['OBP', 'On-base percentage', b => b.season ? rate(b.season.obp) : '–'],
    ['SLG', 'Slugging percentage', b => b.season ? rate(b.season.slg) : '–'],
    ['HR', 'Home runs', b => b.season ? String(b.season.hr ?? '–') : '–'],
    ['SB', 'Stolen bases', b => b.season ? String(b.season.sb ?? '–') : '–'],
    ['K%', 'Strikeout rate', b => b.season ? pct01(b.season.k_pct) : '–'],
    ['BB%', 'Walk rate', b => b.season ? pct01(b.season.bb_pct) : '–'],
    ['xwOBA', 'Statcast expected wOBA (contact quality)', b => b.season && b.season.xwoba != null ? rate(b.season.xwoba.toFixed(3)) : '–'],
  ];
  function matchCols(teamColor) {
    return [
      ['Proj. wOBA', "Projected wOBA against today's starter (first time through the order)", b => {
        const v = b.vs_starter.woba;
        const w = Math.max(0, Math.min(1, (v - 0.2) / 0.25));
        return h('span', { class: 'meter' }, h('span', { class: 'num' }, rate(v.toFixed(3))),
          h('span', { class: 'track', 'aria-hidden': 'true' }, h('span', { class: 'fill', style: { width: `${(100 * w).toFixed(0)}%`, background: `var(${teamColor})` } })));
      }],
      ['Hit%', 'Chance of a hit in each plate appearance', b => pct01(b.vs_starter.hit)],
      ['HR%', 'Chance of a home run in each plate appearance', b => pct01(b.vs_starter.hr, 1)],
      ['K%', 'Chance of a strikeout in each plate appearance', b => pct01(b.vs_starter.k)],
      ['BB%', 'Chance of a walk or HBP in each plate appearance', b => pct01(b.vs_starter.bb)],
    ];
  }
  function lineupsCard(p) {
    const view = state.lineupView;
    const choose = v => { state.lineupView = v; store.set('lineupView', v); const old = $('#lineups'); old.replaceWith(lineupsCard(state.game)); };
    const subs = {
      sim: 'Average per game across all simulations, plus the chance of each outcome',
      season: `Real ${p.date.slice(0, 4)} stats`,
      match: "Each batter's projected rates against today's opposing starter",
    };
    return h('div', { class: 'card', id: 'lineups', style: { marginTop: '16px' } },
      h('div', { class: 'card-head' },
        h('div', {}, h('h2', { class: 'card-title' }, 'Lineups and player projections'), h('p', { class: 'card-sub' }, subs[view])),
        seg([['sim', 'Simulated'], ['season', 'Season'], ['match', 'Vs. starter']], view, choose, 'Player stat view')),
      h('div', { class: 'lineups-grid' }, lineupTable(p, 'away', view), lineupTable(p, 'home', view)));
  }
  function lineupTable(p, key, view) {
    const team = p[key];
    const other = p[key === 'away' ? 'home' : 'away'];
    const color = key === 'away' ? '--away' : '--home';
    const cols = view === 'sim' ? SIM_COLS : view === 'season' ? SEASON_COLS : matchCols(color);
    const confirmed = team.lineup_status === 'confirmed';
    const rows = team.lineup.map((b, i) => h('tr', {},
      h('td', {}, h('div', { class: 'player' }, h('span', { class: 'order num' }, String(i + 1)), headshot(b.id),
        h('div', { style: { minWidth: 0 } }, h('div', { class: 'player-name' }, b.name),
          h('div', { class: 'player-meta' }, `${b.pos || '–'} · bats ${b.bats}`)))),
      cols.map(([, , get]) => h('td', {}, get(b)))));
    let foot = null;
    if (view === 'sim') {
      const tot = k => team.lineup.reduce((a, b) => a + b.sim[k], 0);
      foot = h('tfoot', {}, h('tr', {}, h('td', { class: 'left' }, h('strong', {}, 'Team')),
        ['pa', 'h', 'hr', 'rbi', 'r', 'bb', 'k', 'tb'].map(k => h('td', {}, h('strong', {}, fix(tot(k))))),
        h('td', {}), h('td', {}), h('td', {})));
    }
    return h('div', { style: { minWidth: 0 } },
      h('div', { class: 'team-table-head' }, logo(team), team.name,
        h('span', { style: { marginLeft: 'auto' } }, confirmed ? badge('good', 'Confirmed lineup') : badge('', 'Projected lineup'))),
      view === 'match' ? h('p', { class: 'card-sub', style: { margin: '-4px 0 6px' } }, `vs ${other.starter} (${hand(other.starter_throws)})`) : null,
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', { class: 'left' }, 'Batter'), cols.map(([label, title]) => h('th', { title }, label)))),
        h('tbody', {}, rows), foot)));
  }

  // ------------------------------------------------ pitchers
  function statline(items) {
    return h('div', { class: 'statline' }, items.filter(([, v]) => v != null && v !== '–').map(([label, v]) =>
      h('div', {}, h('b', {}, v), h('span', {}, label))));
  }
  function pitcherCard(p, key) {
    const t = p[key];
    const color = key === 'away' ? '--away' : '--home';
    const line = t.starter_line;
    const sim = t.starter_sim;
    const whatIf = t.starter_id !== t.probable_id;
    const note = !t.starter_id ? 'No starter announced · replacement-level stand-in'
      : whatIf ? 'What-if starter' : t.probable_id ? 'Probable starter' : '';
    const kd = sim.k_dist;
    const cats = [...Array(12).keys()].map(String).concat(['12+']);
    const vals = kd.slice(0, 12).concat([kd.slice(12).reduce((a, b) => a + b, 0)]);
    const meanK = sim.k;
    if (state.kLines[key] == null) state.kLines[key] = Math.max(0.5, Math.floor(meanK) + 0.5);
    const kLine = state.kLines[key];
    const over = kd.reduce((a, pr, k) => a + (k > kLine ? pr : 0), 0);
    const mode = vals.indexOf(Math.max(...vals));
    const spec = { categories: cats, series: [{ name: 'Share of simulations', color, values: vals }], height: 150,
      categoryLabel: 'Strikeouts', ariaLabel: `${t.starter} strikeout distribution`,
      tooltip: i => ({ title: `${cats[i]} strikeout${cats[i] === '1' ? '' : 's'}`, rows: [{ color, value: pct01(vals[i]), label: t.starter }] }) };
    const kCard = chartCard({ title: 'Strikeouts', sub: `${t.starter}, simulated`, spec,
      tools: stepper(kLine, v => { state.kLines[key] = v; $(`#pitcher-${key}`).replaceWith(pitcherCard(state.game, key)); drawCharts(); }, 'Strikeout line', 0.5, 14.5),
      readout: h('div', { class: 'readout' },
        h('span', {}, `Over ${kLine} `, h('strong', {}, pct01(over)), h('span', { class: 'muted' }, ` (${odds(americanOdds(over))})`)),
        h('span', { class: 'muted' }, `most likely ${cats[mode]} · avg ${fix(meanK, 1)}`)) });
    kCard.classList.remove('card');
    kCard.style.marginTop = '12px';
    const bp = t.bullpen_sim;
    return h('div', { class: 'card', id: `pitcher-${key}` },
      h('div', { class: 'pitcher-head' }, headshot(t.starter_id),
        h('div', { style: { minWidth: 0 } },
          h('div', { class: 'pitcher-name' }, t.starter),
          h('div', { class: 'muted' }, [hand(t.starter_throws), t.name, note].filter(Boolean).join(' · '))),
        h('span', { style: { marginLeft: 'auto' } }, logo(t))),
      h('div', { class: 'subhead' }, `${p.date.slice(0, 4)} season`),
      line ? statline([['W-L', `${line.w ?? 0}-${line.l ?? 0}`], ['ERA', line.era], ['xERA', line.xera != null ? fix(line.xera) : null],
        ['IP', line.ip], ['K%', pct01(line.k_pct)], ['BB%', pct01(line.bb_pct)], ['WHIP', line.whip], ['HR/9', line.hr9 != null ? fix(line.hr9) : null]])
        : h('div', { class: 'muted' }, 'No MLB innings this season.'),
      h('div', { class: 'subhead' }, 'Simulated tonight (average)'),
      statline([['IP', sim.ip], ['Pitches', fix(sim.pitches, 0)], ['K', fix(sim.k, 1)], ['BB', fix(sim.bb, 1)],
        ['H', fix(sim.h, 1)], ['HR', fix(sim.hr, 2)], ['R', fix(sim.runs, 2)]]),
      kCard,
      h('div', { class: 'subhead' }, `Bullpen · projected ${bp.ip} IP, ${fix(bp.runs, 2)} runs`),
      h('div', { class: 'chips' }, t.bullpen_high_leverage.map(n => h('span', { class: 'chip' }, n))),
      t.bullpen_resting.length ? h('div', { class: 'muted', style: { fontSize: '12.5px', marginTop: '8px' } },
        `Likely unavailable after heavy recent use: ${t.bullpen_resting.join(', ')}`) : null);
  }

  // ------------------------------------------------ conditions
  function conditionsCard(p) {
    const w = p.weather || {};
    const eff = x => (x == null ? '–' : `${x >= 1 ? '+' : '−'}${Math.abs(100 * (x - 1)).toFixed(0)}%`);
    const cond = w.roof_closed ? (w.roof_type === 'dome' ? 'Dome' : 'Roof closed')
      : w.temp_f != null ? `${Math.round(w.temp_f)}°F${w.wind_mph ? `, wind ${Math.round(w.wind_mph)} mph ${w.wind_dir || ''}` : ''}${w.condition ? ` · ${w.condition}` : ''}` : 'Not available';
    const kv = (k, v) => h('div', {}, h('span', {}, k), h('b', {}, v));
    return h('div', { class: 'card', style: { marginTop: '16px' } },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', { class: 'card-title' }, 'Conditions and inputs'),
        h('p', { class: 'card-sub' }, 'Weather is measured against this park’s usual conditions, which its park factors already include'))),
      h('div', { class: 'kv' },
        kv('Ballpark', p.venue),
        kv('Weather', cond),
        kv('Source', w.source || '–'),
        kv('Weather effect on home runs', eff(w.hr_mult)),
        kv('Park effect on home runs', `LHB ${eff(p.park_hr_mult.L)} · RHB ${eff(p.park_hr_mult.R)}`),
        kv('Elevation', w.elevation_ft != null ? `${w.elevation_ft.toLocaleString()} ft` : '–'),
        kv('Defense (hits allowed on balls in play)', `${p.away.abbr} ${eff(p.away.defense_hit_mult)} · ${p.home.abbr} ${eff(p.home.defense_hit_mult)}`),
        kv('Simulations', `${p.sim.sims.toLocaleString()} · ${new Date(p.generated).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`)));
  }

  // ---------------------------------------------------------------- start
  initTopbar();
  window.addEventListener('hashchange', onRoute);
  setInterval(autoUpdate, 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) autoUpdate(); });
  onRoute();
})();
