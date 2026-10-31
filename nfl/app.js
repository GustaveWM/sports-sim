/* NFL Sim Dashboard.
   Everything is built from DOM nodes with textContent, never from HTML strings, so team and
   player names out of the API can never be read as markup. Charts are hand-drawn SVG and each
   one has a table underneath saying the same thing, for anyone reading with a screen reader or
   who just wants the numbers. */
'use strict';

const NS = 'http://www.w3.org/2000/svg';
const view = document.getElementById('view');
const progress = document.getElementById('progress');
const state = { season: null, week: null, sims: 10000, slate: null, busy: 0 };
const PUBLISHED = !!window.PUBLISHED_COPY;   // the published copy (static.js): its numbers were made on the PC, so there is nothing to re-run
const SIMS_KEY = 'nflsim-sims';
let paintToken = 0;                          // the page asked for last: an older answer arriving late must not paint over it

/* ------------------------------------------------------------------ helpers */
function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') throw new Error('build nodes, not markup');
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.appendChild(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

/** view.replaceChildren, but skipping the blanks that el() already skips. A section that is
    conditionally hidden hands back null, and replaceChildren would print that as the text
    "null" rather than leaving a gap. */
function render(...kids) {
  view.replaceChildren(
    ...kids.flat().filter(k => k !== null && k !== undefined && k !== false));
}

function svg(tag, props = {}, ...kids) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid) node.appendChild(kid);
  return node;
}

const pct = (x, places = 1) => (x === null || x === undefined || Number.isNaN(x))
  ? '–' : `${(x * 100).toFixed(places)}%`;
const num = (x, places = 1) => (x === null || x === undefined || Number.isNaN(x))
  ? '–' : Number(x).toFixed(places);
const signed = (x, places = 1) => (x === null || x === undefined || Number.isNaN(x))
  ? '–' : (x > 0 ? '+' : '') + Number(x).toFixed(places);
const odds = (x) => (x === null || x === undefined) ? '–' : (x > 0 ? `+${x}` : `${x}`);

function setBusy(on, message) {
  state.busy += on ? 1 : -1;
  progress.textContent = state.busy > 0 ? (message || 'Simulating…') : '';
}

/** The sims box. On the PC it is a real setting, remembered between visits. On the published copy the numbers were made at one
    count: the box starts at that count, and picking another shows a Run button (static/rerun.js) that asks the PC to simulate again. */
function showSims() {
  const box = document.getElementById('sims');
  if (!box) return;
  if (![...box.options].some(o => Number(o.value) === state.sims)) {
    const at = [...box.options].findIndex(o => Number(o.value) > state.sims);
    box.add(el('option', { value: state.sims, text: `${state.sims.toLocaleString()} sims` }), at < 0 ? null : at);
  }
  box.value = String(state.sims);
}
let publishedSims = 0;
function setPublishedSims(n) {
  n = Number(n);
  if (!PUBLISHED || !Number.isFinite(n) || n <= 0 || n === publishedSims) return;   // once per count: a later load must not undo a pick waiting for Run
  publishedSims = n;
  state.sims = n;
  showSims();
}
function loadSims() {
  if (PUBLISHED) return;
  try {
    const n = Number(localStorage.getItem(SIMS_KEY));
    if (n >= 200 && n <= 100000) state.sims = n;     // what the server allows
  } catch (e) { /* private window */ }
  showSims();
}

async function api(path, params = {}) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function showLoading(message, kind) {
  const blocks = kind === 'cards' ? 6 : 3;
  render(el('div', { class: `skeleton${kind === 'cards' ? '' : ' wide'}`, 'aria-busy': 'true' },
    el('i', { class: 'say', text: message }), Array.from({ length: blocks }, () => el('i'))));
}

/** The quarterback list is the same all week, so fetch it once. */
async function quarterbackList() {
  const key = `${state.season}-${state.week}`;
  if (state.qbKey !== key) {
    const d = await api('/api/quarterbacks', { season: state.season, week: state.week });
    state.qbs = d.quarterbacks;
    state.qbKey = key;
  }
  return state.qbs;
}

function showError(err) {
  render(el('p', { class: 'notice error', text: `Could not load: ${err.message}` }));
}

/* ------------------------------------------------------------------ charts */
/** A histogram with lines over the bars, plus a table saying the same thing. `marker` is DraftKings' number (dashed) and
    `model` the model's own (solid); a half-point line sits between two bars, and each line's label gets a row above the bars. */
function histogram(bins, opts) {
  const { title, note, colour = 'var(--away)', marker, markerLabel, model, modelLabel, unit = '' } = opts;
  const isNum = v => v !== null && v !== undefined && !Number.isNaN(v);
  const lines = [];
  if (isNum(marker)) lines.push({ value: marker, label: markerLabel || String(marker), cls: 'marker' });
  if (isNum(model)) lines.push({ value: model, label: modelLabel || String(model), cls: 'marker model' });
  const W = 620, padL = 30, padR = 12, padB = 22;
  const padT = 8 + (lines.length ? 16 * lines.length + 2 : 0);
  const H = 162 + padT;                                // the bars keep the height they always had
  const peak = Math.max(...bins.map(b => b.share), 0.0001);
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const step = innerW / bins.length;
  const x = i => padL + i * step;
  const chart = svg('svg', {
    viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': `${title}. ${note || ''}${lines.length ? ` ${lines.map(l => l.label).join(', ')}.` : ''}`
  });

  for (let g = 0; g <= 2; g++) {
    const y = padT + innerH * (g / 2);
    chart.appendChild(svg('line', { class: 'grid-line', x1: padL, x2: W - padR, y1: y, y2: y }));
  }
  bins.forEach((b, i) => {
    if (b.share <= 0) return;
    const h = Math.max(1.5, (b.share / peak) * innerH);
    const bar = svg('rect', {
      class: 'bar', x: x(i) + 1, y: padT + innerH - h, width: Math.max(1, step - 2), height: h,
      rx: Math.min(4, step / 2), fill: colour, tabindex: '0',
      'aria-label': `${b.value}${unit}: ${(b.share * 100).toFixed(1)}%`
    });
    bar.appendChild(svg('title', {}, document.createTextNode(
      `${b.value}${unit} — ${(b.share * 100).toFixed(1)}% of simulations`)));
    chart.appendChild(bar);
  });
  chart.appendChild(svg('line', {
    class: 'axis-line', x1: padL, x2: W - padR, y1: padT + innerH, y2: padT + innerH
  }));

  const labelEvery = Math.max(1, Math.round(bins.length / 9));
  bins.forEach((b, i) => {
    if (i % labelEvery) return;
    chart.appendChild(svg('text', {
      class: 'tick', x: x(i) + step / 2, y: H - 6, 'text-anchor': 'middle'
    }, document.createTextNode(String(b.value))));
  });
  chart.appendChild(svg('text', { class: 'tick', x: 4, y: padT + 8 },
    document.createTextNode(`${(peak * 100).toFixed(0)}%`)));

  if (lines.length) {
    const v0 = bins[0].value, dv = bins.length > 1 ? bins[1].value - v0 : 1;
    const at = v => {
      const i = (v - v0) / dv;
      return i < -0.5 || i > bins.length - 0.5 ? null : padL + (i + 0.5) * step;
    };
    const drawn = lines.map((m, k) => ({ ...m, k, mx: at(m.value) })).filter(m => m.mx !== null);
    drawn.forEach(m => chart.appendChild(svg('line', { class: m.cls, x1: m.mx, x2: m.mx, y1: 16 * m.k + 3, y2: padT + innerH })));
    // the labels share one side of the lines, so a label never lands on another line
    const widest = Math.max(0, ...drawn.map(m => m.label.length)) * 7;
    const right = Math.max(...drawn.map(m => m.mx)), left = Math.min(...drawn.map(m => m.mx));
    const toLeft = right + 5 + widest > W - padR;
    drawn.forEach(m => chart.appendChild(svg('text', {
      class: m.cls.replace('marker', 'marker-label'), x: toLeft ? left - 5 : right + 5, y: 16 * m.k + 14,
      'text-anchor': toLeft ? 'end' : 'start'
    }, document.createTextNode(m.label))));
  }

  const table = buildTable(
    ['Value', 'Share of sims'],
    bins.filter(b => b.share > 0.002).map(b => [`${b.value}${unit}`, pct(b.share)]));
  return chartBlock(title, note, chart, table, opts.legend);
}

function chartBlock(title, note, chart, table, legend) {
  const tableWrap = el('div', { class: 'table-wrap', hidden: '' }, table);
  const toggle = el('button', { class: 'toggle-view', type: 'button', text: 'Show as table' });
  toggle.addEventListener('click', () => {
    const showing = !tableWrap.hasAttribute('hidden');
    if (showing) tableWrap.setAttribute('hidden', '');
    else tableWrap.removeAttribute('hidden');
    toggle.textContent = showing ? 'Show as table' : 'Show as chart';
    chart.style.display = showing ? '' : 'none';
  });
  return el('figure', { class: 'card' },
    el('div', { class: 'chart-head' },
      el('div', {}, el('h2', { text: title }), note ? el('div', { class: 'sub', text: note, style: 'margin:0' }) : null),
      toggle),
    legend || null, chart, tableWrap);
}

function buildTable(headers, rows, opts = {}) {
  const cols = opts.cols || [];                      // a class for each column, to hide one on a phone
  const thead = el('thead', {}, el('tr', {}, headers.map((h, i) => el('th', { text: h, class: cols[i] || null }))));
  const tbody = el('tbody', {}, rows.map(r => el('tr', {},
    r.map((cell, i) => {
      if (cell && typeof cell === 'object' && cell.nodeType) return el('td', { class: cols[i] || null }, cell);
      if (cell && typeof cell === 'object') {
        return el('td', { class: [cols[i], cell.class].filter(Boolean).join(' ') || null, text: cell.text });
      }
      return el('td', { class: cols[i] || null, text: cell === null || cell === undefined ? '–' : String(cell) });
    })
  )));
  return el('table', { class: 'num' },
    opts.caption ? el('caption', { text: opts.caption }) : null, thead, tbody);
}

function legendFor(pairs) {
  return el('div', { class: 'legend' }, pairs.map(([cls, label]) =>
    el('span', {}, el('i', { class: `swatch ${cls}` }), label)));
}

/* ------------------------------------------------------------------ slate */
/** Who is unavailable, weighted by how much they actually play. */
function injuryNote(hurt, team) {
  const a = hurt && hurt[team];
  if (!a) return null;
  const lost = (a.defense || 0) + (a.offense || 0);
  if (lost < 0.4) return null;
  return `${team}: ${lost.toFixed(1)} every-down players out`;
}

function injuryPanel(result) {
  const hurt = result.injuries || {};
  const teams = Object.keys(hurt).filter(t => (hurt[t].names || []).length);
  if (!teams.length) {
    return el('section', { class: 'card' },
      el('h2', { text: 'Who is missing' }),
      el('p', { class: 'sub', style: 'margin:0', text:
        'Nobody who plays a meaningful share of snaps is ruled out on either side.' }));
  }
  const rows = [];
  for (const team of teams) {
    for (const p of hurt[team].names) {
      const share = Math.max(p.defense_pct || 0, p.offense_pct || 0);
      rows.push([p.name, p.position || '', team,
                 (p.defense_pct || 0) > (p.offense_pct || 0) ? 'defence' : 'offence',
                 pct(share, 0)]);
    }
  }
  const totals = teams.map(t =>
    `${t} is without ${((hurt[t].defense || 0) + (hurt[t].offense || 0)).toFixed(1)} `
    + 'every-down players');
  return el('section', { class: 'card' },
    el('h2', { text: 'Who is missing' }),
    el('p', { class: 'sub', text:
      totals.join('; ') + '. Ruled out or doubtful, weighted by the share of snaps they have '
      + 'been playing. This is already priced into the projection above: each every-down '
      + 'player missing is worth about 1.6 points.' }),
    el('div', { class: 'table-wrap' }, buildTable(
      ['Player', 'Pos', 'Team', 'Side', 'Snap share'], rows)));
}

function weatherLine(w) {
  if (!w) return '';
  if (w.indoor) return 'Indoors';
  const bits = [`${Math.round(w.temp)}°F`, `wind ${Math.round(w.wind)} mph`];
  if (w.rain > 0.4) bits.push('rain likely');
  return bits.join(' · ');
}

const MINUS = '−';

/** "CHI −2.9": the favourite and by how much, from the home side's expected margin. */
function favText(game, margin) {
  if (margin === null || margin === undefined || Number.isNaN(margin)) return '–';
  if (Math.abs(margin) < 0.05) return 'PK';
  return `${margin >= 0 ? game.home : game.away} ${MINUS}${Math.abs(margin).toFixed(1)}`;
}

/** 20:15 -> 8:15 PM. */
function clock(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  if (!m) return String(hhmm || '');
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

/** The win-chance bar: the model's split, with a tick where the market puts it. */
function winBar(game, awayWin, homeWin, marketHome) {
  const hasMk = marketHome !== null && marketHome !== undefined;
  return el('div', { class: 'pbar', role: 'img',
    'aria-label': `${game.away} ${pct(awayWin)} to win, ${game.home} ${pct(homeWin)}` },
    el('i', { class: 'a', style: `width:${(awayWin * 100).toFixed(2)}%` }),
    el('i', { class: 'h', style: `width:${(homeWin * 100).toFixed(2)}%` }),
    hasMk ? el('span', { class: 'mk', style: `left:${((1 - marketHome) * 100).toFixed(1)}%`,
                         title: `The market: ${game.away} ${pct(1 - marketHome)}` }) : null);
}

function winLabels(game, awayWin, homeWin, marketHome) {
  const hasMk = marketHome !== null && marketHome !== undefined;
  return [
    el('div', { class: 'pbar-lbl' },
      el('span', { class: 'num', text: `${game.away} ${pct(awayWin)}` }),
      el('span', { class: 'num', text: `${pct(homeWin)} ${game.home}` })),
    hasMk ? el('div', { class: 'pbar-lbl dim' },
      el('span', { class: 'num', text: `market ${pct(1 - marketHome)}` }),
      el('span', { class: 'num', text: `${pct(marketHome)} market` })) : null];
}

function gameCard(g, i) {
  const team = (code, qb, score, cls) => el('div', { class: 'gc-team' },
    el('span', {}, el('span', { class: 'gc-code' }, el('i', { style: `background:var(--${cls})` }), code),
      el('span', { class: 'gc-name', text: qb || 'starter unknown' })),
    el('span', { class: 'gc-score num', text: num(score) }));

  // The model's spread and total beside DraftKings', amber when they are well apart.
  const bookMargin = g.spread ? g.spread.line : null;
  const bookTotal = g.total_bet ? g.total_bet.line : null;
  const offSpread = bookMargin !== null && Math.abs(g.margin - bookMargin) >= 2.5;
  const offTotal = bookTotal !== null && Math.abs(g.total - bookTotal) >= 3.5;
  const lines = bookMargin === null && bookTotal === null ? null : el('div', { class: 'gc-lines' },
    el('span', { class: 'hd' }), el('span', { class: 'hd', text: 'Spread' }), el('span', { class: 'hd', text: 'Total' }),
    el('span', { class: 'lbl', text: 'Model' }),
    el('span', { class: 'v num', text: favText(g, g.margin) }), el('span', { class: 'v num', text: num(g.total) }),
    el('span', { class: 'lbl', text: 'DraftKings' }),
    el('span', { class: `v num${offSpread ? ' off' : ''}`, text: favText(g, bookMargin) }),
    el('span', { class: `v num${offTotal ? ' off' : ''}`, text: bookTotal === null ? '–' : num(bookTotal) }));

  const chips = el('div', { class: 'gc-chips' });
  if (g.spread) {
    chips.appendChild(el('span', { class: 'pill', text:
      `${g.spread.pick} · ${pct(Math.max(g.spread.home_cover, g.spread.away_cover))}` }));
  }
  if (g.total_bet) {
    chips.appendChild(el('span', { class: 'pill', text:
      `${g.total_bet.pick} ${g.total_bet.line} · ${pct(Math.max(g.total_bet.over, g.total_bet.under))}` }));
  }
  for (const side of [g.away, g.home]) {
    const note = injuryNote(g.injuries, side);
    if (note) chips.appendChild(el('span', { class: 'pill', text: note }));
    // A starter well below (or above) what the team has been playing with moves the line more
    // than anything else in the model, so it is called out on the card.
    const qb = g.qb_edge ? g.qb_edge[side] : null;
    if (qb !== null && qb !== undefined && Math.abs(qb) >= 1.5) {
      chips.appendChild(el('span', { class: `pill${qb < 0 ? ' warn' : ''}`,
        text: `${side} QB ${signed(qb, 1)} pts vs usual` }));
    }
  }

  const dog = underdog(g);
  const tags = el('span', { class: 'gc-tags' });
  if (!g.final && dog && state.upsets && state.upsets.has(g.id)) {
    tags.appendChild(el('span', { class: 'tag upset', text: `upset watch: ${dog.team}` }));
  }
  if (g.final) tags.appendChild(el('span', { class: 'tag', text: `final ${g.final_away}–${g.final_home}` }));
  if (g.div_game) tags.appendChild(el('span', { class: 'tag', text: 'division' }));
  if (g.neutral) tags.appendChild(el('span', { class: 'tag', text: 'neutral' }));

  return el('a', { class: `card game-card${g.final ? ' is-final' : ''}`, href: `#/game/${encodeURIComponent(g.id)}`,
                   style: `--i:${i || 0}` },
    el('div', { class: 'gc-top' },
      el('span', { text: `${String(g.weekday).slice(0, 3)} ${clock(g.gametime)} · ${weatherLine(g.weather)}` }), tags),
    el('div', { class: 'gc-teams' },
      team(g.away, g.away_qb, g.away_score, 'away'), team(g.home, g.home_qb, g.home_score, 'home')),
    el('div', { class: 'pbar-wrap' },
      winBar(g, g.away_win, g.home_win, g.market_home_win),
      winLabels(g, g.away_win, g.home_win, g.market_home_win)),
    lines, chips);
}

/** The betting market's underdog in a game, with the model's and the market's chance for them. */
function underdog(g) {
  const mk = g.market_home_win;
  if (mk === null || mk === undefined) return null;
  const home = mk < 0.5;
  return { team: home ? g.home : g.away, opponent: home ? g.away : g.home,
           model: home ? g.home_win : g.away_win, market: home ? mk : 1 - mk };
}

/** Real underdogs (not near coin flips) that the model gives a live chance, likeliest first. */
function likelyUpsets(slate) {
  return slate.games.filter(g => !g.final).map(g => ({ g, d: underdog(g) }))
    .filter(x => x.d && x.d.market <= 0.45 && x.d.model >= 0.3)
    .sort((a, b) => b.d.model - a.d.model);
}

/** Which underdogs are most likely to win, and how far to trust that. */
function upsetWatch(slate) {
  const rows = likelyUpsets(slate).slice(0, 8);
  const h = slate.upset_history;
  const bucket = h && h.buckets.find(b => b.from >= 0.35 && b.from < 0.45);
  const far = h && h.disagree.find(d => d.threshold >= 0.06);
  const lines = [];
  if (bucket) {
    lines.push(`The model's underdog chances have held up: when it gave an underdog ` +
      `${pct(bucket.from, 0)}–${pct(bucket.to, 0)}, they won ${pct(bucket.actual)} ` +
      `(${bucket.games.toLocaleString()} games, ${h.seasons[0]}–${h.seasons[1]}).`);
  }
  if (far) {
    lines.push(`But where it rated an underdog well above the market, the market was right: ` +
      `those dogs won ${pct(far.actual)} against the market's ${pct(far.market)} and the model's ` +
      `${pct(far.model)}. So this is a list of the likeliest upsets, not of good bets.`);
  }
  return el('section', { class: 'card', style: 'margin-top:16px' },
    el('h2', { text: 'Upset watch' }),
    el('p', { class: 'sub', text: 'Underdogs by at least a field goal or so in the betting market, ' +
      'ordered by the model’s chance of an upset; the top three are tagged on their cards. ' +
      lines.join(' ') }),
    rows.length ? el('div', { class: 'table-wrap' }, buildTable(
      ['Underdog', 'Against', 'Model', 'Market', 'Model vs market', 'Kickoff'],
      rows.map(({ g, d }) => [
        { text: d.team, class: d.model >= 0.4 ? 'win' : null }, d.opponent,
        pct(d.model), pct(d.market),
        signed((d.model - d.market) * 100, 1) + ' pts',
        `${g.weekday} ${g.gametime}`])))
      : el('p', { class: 'notice', text: 'No live underdogs left this week.' }));
}

async function renderSlate() {
  const mine = ++paintToken;
  showLoading(`Simulating every game of the week, ${state.sims.toLocaleString()} sims each…`, 'cards');
  setBusy(true, 'Simulating the week…');
  try {
    const slate = await api('/api/week', { season: state.season, week: state.week, sims: state.sims });
    if (mine !== paintToken) return;
    setPublishedSims(slate.sims);
    state.slate = slate;
    state.season = slate.season;
    state.week = slate.week;
    syncSelectors();

    const played = slate.games.filter(g => g.final);
    const right = played.filter(g =>
      (g.final_home > g.final_away && g.pick === g.home) ||
      (g.final_away > g.final_home && g.pick === g.away)).length;

    const head = el('div', {},
      el('div', { class: 'page-head' },
        el('h1', { text: `${slate.season} · Week ${slate.week}` }),
        el('span', { class: 'pill', text: `${slate.games.length} games` }),
        el('span', { class: 'pill', text: `${slate.sims.toLocaleString()} sims each` })),
      el('p', { class: 'sub', text:
        (slate.model === 'power ratings'
          ? 'Game numbers from the power ratings (opponent-adjusted EPA, success rate, points and ' +
            'the starting quarterback) pulled most of the way onto the betting line, which has beaten ' +
            'them; players and score ranges from simulations steered onto the same projected score.'
          : `The power ratings are unavailable (${slate.model_error || 'no data'}), so these ` +
            'numbers come from the play-by-play simulator on its own.') +
        (played.length ? `  Already played: ${right} of ${played.length} picked right.` : '') }));

    state.upsets = new Set(likelyUpsets(slate).slice(0, 3).map(x => x.g.id));
    render(head,
      el('div', { class: 'grid grid-games' }, slate.games.map(gameCard)),
      slate.games.length ? upsetWatch(slate) : null,
      slate.games.length ? bestBets(slate) : el('p', { class: 'notice', text: 'No games this week.' }));
  } catch (err) {
    if (mine === paintToken) showError(err);
  } finally {
    setBusy(false);
  }
}

function bestBets(slate) {
  const rows = [];
  for (const g of slate.games) {
    if (g.final) continue;
    if (g.spread) {
      rows.push({ what: `${g.spread.pick}`, game: `${g.away} @ ${g.home}`, kind: 'Spread',
        prob: Math.max(g.spread.home_cover, g.spread.away_cover), edge: Math.abs(g.spread.edge) });
    }
    if (g.total_bet) {
      rows.push({ what: `${g.total_bet.pick} ${g.total_bet.line}`, game: `${g.away} @ ${g.home}`,
        kind: 'Total', prob: Math.max(g.total_bet.over, g.total_bet.under),
        edge: Math.abs(g.total_bet.edge) });
    }
  }
  rows.sort((a, b) => b.edge - a.edge);
  if (!rows.length) return el('div');
  return el('section', { class: 'card', style: 'margin-top:16px' },
    el('h2', { text: 'Where the model disagrees most with the market' }),
    el('p', { class: 'sub', text:
      'Biggest gaps between the projection and the posted line. The projection starts from the ' +
      'line, so these are small by design: over six out-of-sample seasons the ratings’ side of the ' +
      'spread was right 49% of the time, at every size of disagreement, and the line predicted the ' +
      'margin better. Each game’s own page shows how far the ratings alone were from the line.' }),
    el('div', { class: 'table-wrap' }, buildTable(
      ['Pick', 'Game', 'Market', 'Model says', 'Gap'],
      rows.slice(0, 10).map(r => [r.what, r.game, r.kind, pct(r.prob),
        { text: `${r.edge.toFixed(1)} pts`, class: r.edge >= 2.5 ? 'win' : null }]))));
}

/* ------------------------------------------------------------------ game page */
function teamStatsTable(r, away, home) {
  const rows = [
    ['Points', 'score', 1], ['Total yards', 'total_yards', 0],
    ['Passing yards', 'pass_yards', 0], ['Rushing yards', 'rush_yards', 0],
    ['First downs', 'first_downs', 1], ['Plays', 'plays', 1], ['Drives', 'drives', 1],
    ['Yards per play', 'yards_per_play', 2], ['Points per drive', 'points_per_drive', 2],
    ['Red zone trips', 'red_zone_trips', 1], ['Red zone TD rate', 'red_zone_rate', 3],
    ['Turnovers', 'turnovers', 2], ['Sacks allowed', 'sacks_allowed', 1],
    ['Penalties', 'penalties', 1], ['Punts', 'punts', 1],
    ['Field goals', 'fg_made', 2], ['Avg start (yds to goal)', 'start_yl', 1],
  ];
  return buildTable(['', away, home], rows.map(([label, key, places]) =>
    [label, num(r.teams[away][key], places), num(r.teams[home][key], places)]));
}

function mergePlayers(p) {
  /* One row per player. A back who catches passes is one person, not a rushing entry and a
     receiving entry with different numbers beside each. */
  const byName = new Map();
  const take = (x, role) => {
    const row = byName.get(x.name) || {
      name: x.name, id: x.id, carries: 0, rush_yards: 0, targets: 0, catches: 0,
      rec_yards: 0, p_td: x.p_td, td_odds: x.td_odds,
      scrimmage: x.scrimmage_yards ?? 0, p_100: 0, p_50: 0,
    };
    if (role === 'rush') {
      row.carries = x.carries; row.rush_yards = x.yards;
    } else {
      row.targets = x.targets; row.catches = x.catches; row.rec_yards = x.yards;
    }
    row.p_td = Math.max(row.p_td || 0, x.p_td || 0);
    row.td_odds = x.td_odds;
    if (x.scrimmage_yards !== undefined) row.scrimmage = x.scrimmage_yards;
    byName.set(x.name, row);
  };
  p.rushing.forEach(x => take(x, 'rush'));
  p.receiving.forEach(x => take(x, 'rec'));
  const rows = [...byName.values()];
  rows.forEach(r => { r.touches = r.carries + r.targets; });
  rows.sort((a, b) => b.scrimmage - a.scrimmage || b.touches - a.touches);
  return rows;
}

/** A small bar showing how much of the workload a player carries. */
function usageBar(share, colour) {
  const width = Math.max(2, Math.min(100, share * 100));
  return el('span', {
    class: 'usage-bar', title: `${(share * 100).toFixed(0)}% of the team's touches`,
  }, el('i', { style: `width:${width.toFixed(1)}%;background:${colour}` }));
}

/** The yards cell of a player's row: scrimmage yards, and for a back who both runs and catches the two
    halves of it, so 151 reads as 82 rushing and 69 receiving. */
function yardsCell(x) {
  const runs = x.carries >= 0.4 && x.rush_yards >= 0.5;
  const catches = x.targets >= 0.4 && x.rec_yards >= 0.5;
  const label = runs && catches ? 'scrimmage yds' : runs ? 'rushing yds' : catches ? 'receiving yds' : 'scrimmage yds';
  return el('div', { class: 'player-yards num' },
    el('strong', { text: num(x.scrimmage, 0) }),
    el('span', { class: 'player-sub', text: label }),
    runs && catches ? el('span', { class: 'player-sub split',
      title: `Projected ${num(x.rush_yards, 1)} rushing and ${num(x.rec_yards, 1)} receiving yards`,
      text: `${num(x.rush_yards, 0)} rush \u00b7 ${num(x.rec_yards, 0)} rec` }) : null);
}

/** Click anywhere on a player's row to see his lines and put one in the parlay slip. */
function slipRow(row, game, side, name, title, stats, proj) {
  if (!window.SlipKit) return row;
  row.appendChild(el('span', { class: 'sk-plus', 'aria-hidden': 'true', text: '+' }));
  window.SlipKit.attach(row, () => ({ sport: 'nfl', gid: game.id, name,
    who: { pkey: window.SlipKit.nameKey(name, side) }, title: title || name,
    sub: `${side} \u00b7 ${game.away} at ${game.home}`,
    // His last five games: an average under his yards (the first of these stats he has a line on), and the games themselves when he is opened.
    formTarget: row.querySelector('.player-yards') || row.querySelectorAll('.stat-chip')[1] || row.querySelector('.player-sub'), formShort: true,
    formStats: stats || ['scrim_yds', 'rush_yds', 'rec_yds'],
    extra: () => formBlock(game.id, side, name, proj) }));
  return row;
}

/** His last five games, the way the NBA page shows them: a column a game (the date and who he played), a row a number, green where he went
    over DraftKings' line and red where he stayed under, then his average, what the simulation says and the book's line. The games come with
    the legs from the Parlays page (a game's players' last games, newest first, from the play-by-play); the book's line is the main line
    the legs are priced from. */
const GAME_IX = { car: 3, rush_yds: 4, rush_td: 5, tgt: 6, rec: 7, rec_yds: 8, rec_td: 9, att: 10, comp: 11, pass_yds: 12, pass_td: 13, int: 14 };

function qbProj(q) { return { comp: q.completions, att: q.attempts, pass_yds: q.yards, pass_td: q.td, int: q.interceptions }; }
function skillProj(x) { return { car: x.carries, rush_yds: x.rush_yards, tgt: x.targets, rec: x.catches, rec_yds: x.rec_yards, td_p: x.p_td }; }

function formBlock(gid, team, name, proj) {
  const box = el('div', { class: 'form-wrap' });
  fillForm(box, gid, team, name, proj || {});
  return box;
}

async function fillForm(box, gid, team, name, proj) {
  box.replaceChildren(el('p', { class: 'form-key', text: 'Loading his last five games…' }));
  try {
    const key = window.SlipKit.nameKey(name, team);
    const [forms, all] = await Promise.all([window.SlipKit.form('nfl', gid), window.SlipKit.legs('nfl', gid)]);
    if (all === null) { box.replaceChildren(); return; }                 // not opened from the Sports Sim page: there are no lines to show either
    const games = ((forms || {})[key] || []).slice().reverse();            // oldest first, so the newest sits beside the averages
    if (!games.length) { box.replaceChildren(el('p', { class: 'form-key', text: 'No games on record for him this season or last.' })); return; }
    const mine = window.SlipKit.mine(all, { pkey: key });
    const lineOf = stat => { const l = mine.find(x => x.stat === stat && x.anchor != null); return l ? l.anchor : null; };
    const at = (g, k) => g[GAME_IX[k]];
    const sum = k => games.reduce((a, g) => a + at(g, k), 0);
    const passer = sum('att') >= 10;
    const rows = [];                       // { label, val(game) -> number, text?(game), avgText?, stat | line, proj }
    const col = (label, k, stat, p) => ({ label, val: g => at(g, k), stat, proj: p });
    if (passer) {
      rows.push({ label: 'Cmp/Att', text: g => `${at(g, 'comp')}/${at(g, 'att')}`, avgText: `${num(sum('comp') / games.length)}/${num(sum('att') / games.length)}`,
                  proj: proj.comp != null ? `${num(proj.comp)}/${num(proj.att)}` : null });
      rows.push(col('Pass yds', 'pass_yds', 'pass_yds', proj.pass_yds), col('Pass TD', 'pass_td', 'pass_td', proj.pass_td), col('INT', 'int', 'int', proj.int));
    }
    if (sum('car') >= (passer ? 8 : 1)) rows.push(col('Car', 'car', 'car', proj.car), col('Rush yds', 'rush_yds', 'rush_yds', proj.rush_yds));
    if (!passer && sum('tgt') > 0) rows.push(col('Tgt', 'tgt', null, proj.tgt), col('Rec', 'rec', 'rec', proj.rec), col('Rec yds', 'rec_yds', 'rec_yds', proj.rec_yds));
    if (!passer || sum('rush_td') + sum('rec_td') > 0) {
      rows.push({ label: 'TD', val: g => at(g, 'rush_td') + at(g, 'rec_td'), line: mine.some(x => x.stat === 'td') ? 0.5 : null,
                  proj: proj.td_p != null ? pct(proj.td_p, 0) : null });
    }
    const lineFor = r => (r.line !== undefined ? r.line : (r.stat ? lineOf(r.stat) : null));
    const hasProj = rows.some(r => r.proj != null), hasLine = rows.some(r => lineFor(r) !== null);
    const now = new Date();
    const start = `${now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1}-07-01`;     // last season's games are faded beside this season's
    const anyNew = games.some(g => g[0] >= start);
    const isOld = g => anyNew && g[0] < start;
    const shortDay = d => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
    const cls = (v, line) => (line === null || line === undefined ? '' : v > line ? 'over' : v < line ? 'under' : '');
    const head = el('tr', {}, el('th'),
      games.map(g => el('th', { class: isOld(g) ? 'old' : null, title: g[0] }, shortDay(g[0]), el('small', { text: `${g[2] ? 'vs' : '@'} ${g[1]}` }))),
      el('th', { class: 'sep' }, 'Avg', el('small', { text: `last ${games.length}` })),
      hasProj ? el('th', {}, 'Model', el('small', { text: 'projected' })) : null,
      hasLine ? el('th', {}, 'DK', el('small', { text: 'line' })) : null);
    const body = rows.map(r => {
      const line = lineFor(r);
      const avg = r.val ? games.reduce((s, g) => s + r.val(g), 0) / games.length : null;
      return el('tr', {}, el('td', { text: r.label }),
        games.map(g => el('td', { class: `num ${isOld(g) ? 'old' : ''} ${r.val ? cls(r.val(g), line) : ''}`.replace(/\s+/g, ' ').trim(), text: r.text ? r.text(g) : String(r.val(g)) })),
        el('td', { class: `num sep strong ${r.val && !r.avgText ? cls(avg, line) : ''}`.trim(), text: r.avgText || num(avg) }),
        hasProj ? el('td', { class: 'num', title: r.label === 'TD' ? 'The simulation’s chance he scores' : null, text: r.proj == null ? '–' : (typeof r.proj === 'number' ? num(r.proj) : r.proj) }) : null,
        hasLine ? el('td', { class: 'num', text: line === null ? '–' : String(line) }) : null);
    });
    const note = !anyNew ? ' All five are from last season: this season has barely started for him.'
      : games.some(g => g[0] < start) ? ' Faded columns are from last season.' : '';
    box.replaceChildren(el('div', { class: 'table-wrap' }, el('table', { class: 'form-table' }, el('thead', {}, head), el('tbody', {}, body))),
      el('p', { class: 'form-key', text: `His last five games with a carry, a target or a pass, newest on the right. Green is over DraftKings’ line, red under.${note}` }));
  } catch (err) {
    console.error('The last-five table failed:', err);
    box.replaceChildren();
  }
}

/** The "Players" heading, and the switch that shows or hides the last-five average under every number (the NBA page's). */
function playersHead() {
  let on = true;
  try { on = localStorage.getItem('nfl.form') !== '0'; } catch (e) { /* private window */ }
  view.classList.toggle('hide-form', !on);
  const b = el('button', { class: 'switch', type: 'button', 'aria-pressed': String(on), title: 'Show each player’s average over his last five games under his numbers' }, el('i'), 'Last 5 games');
  b.addEventListener('click', () => {
    const now = b.getAttribute('aria-pressed') !== 'true';
    try { localStorage.setItem('nfl.form', now ? '1' : '0'); } catch (e) { /* private window */ }
    view.classList.toggle('hide-form', !now);
    b.setAttribute('aria-pressed', String(now));
  });
  return el('div', { style: 'margin-top:16px' },
    el('div', { class: 'pp-head' }, el('h2', { text: 'Players' }), b),
    el('p', { class: 'legend' }, el('span', {}, el('b', { text: 'L5 87.2' }), ' his average over his last five games'),
      el('span', { text: 'Click a player for the games themselves and all his bets.' })));
}

function playerPanel(r, side) {
  const isAway = side === r.game.away;
  const colour = isAway ? 'var(--away)' : 'var(--home)';
  const p = r.players[side];
  const q = p.passing;
  const players = mergePlayers(p);
  const mostTouches = Math.max(...players.map(x => x.touches), 1);

  const qbLine = slipRow(el('div', { class: 'qb-line' },
    el('div', {},
      el('div', { class: 'player-name', text: q.name }),
      el('div', { class: 'player-sub', text: 'quarterback' })),
    el('div', { class: 'qb-stats num' },
      statChip(`${num(q.completions)}/${num(q.attempts)}`, 'cmp/att'),
      statChip(num(q.yards, 0), 'pass yds'),
      statChip(num(q.td, 2), 'pass TD'),
      statChip(num(q.interceptions, 2), 'INT'),
      statChip(pct(q.p_300_yards), '300+ yds'),
      statChip(pct(q.p_2_td), '2+ TD'))), r.game, side, q.name, null, ['pass_yds'], qbProj(q));

  const rows = players.map(x => slipRow(el('div', { class: 'player-row' },
    el('div', { class: 'player-id' },
      el('div', { class: 'player-name', text: x.name }),
      el('div', { class: 'player-sub num', text: [
        x.carries >= 0.4 ? `${num(x.carries)} car` : null,
        x.targets >= 0.4 ? `${num(x.catches)}/${num(x.targets)} rec` : null,
      ].filter(Boolean).join('  ·  ') || 'situational' })),
    el('div', { class: 'player-usage' }, usageBar(x.touches / mostTouches, colour)),
    yardsCell(x),
    el('div', { class: 'player-td num' },
      el('strong', { class: x.p_td >= 0.5 ? 'win' : null, text: pct(x.p_td) }),
      el('span', { class: 'player-sub', text: `TD · ${odds(x.td_odds)}` }))), r.game, side, x.name, null, null, skillProj(x)));

  return el('section', { class: 'card' },
    el('h2', {}, el('i', { class: `swatch ${isAway ? 'sw-away' : 'sw-home'}` }), side),
    el('p', { class: 'sub', text:
      `Projected from ${r.sims.toLocaleString()} simulated games. The bar is each player's `
      + 'share of the team’s touches; "TD" is how often they scored, with fair odds beside '
      + 'it. A back who runs and catches shows both halves of his yards. Click a player for his lines '
      + 'and to put one in your parlay slip; full markets and custom lines are on the Props tab.' }),
    qbLine,
    el('div', { class: 'player-list' }, rows));
}

function statChip(value, label) {
  return el('span', { class: 'stat-chip' },
    el('strong', { text: value }), el('span', { class: 'player-sub', text: label }));
}


function whatIfPanel(gameId, current, qbs) {
  const qbOptions = (selected) => [el('option', { value: '', text: 'listed starter' })].concat(
    qbs.map(q => el('option', { value: q.name, text: q.name, selected: q.name === selected ? '' : null })));
  const away = el('select', { class: 'select', id: 'wi-qb-away' }, qbOptions());
  const home = el('select', { class: 'select', id: 'wi-qb-home' }, qbOptions());
  const wx = current.weather || {};
  const temp = el('input', { class: 'input num', id: 'wi-temp', type: 'number', step: '1',
    value: wx.indoor ? 68 : Math.round(wx.temp ?? 60) });
  const wind = el('input', { class: 'input num', id: 'wi-wind', type: 'number', step: '1',
    min: '0', value: wx.indoor ? 0 : Math.round(wx.wind ?? 0) });
  const rain = el('input', { class: 'input num', id: 'wi-rain', type: 'number', step: '10',
    min: '0', max: '100', value: Math.round((wx.rain ?? 0) * 100) });
  const neutral = el('input', { type: 'checkbox', id: 'wi-neutral' });

  const run = el('button', { class: 'btn btn-primary', text: 'Run what-if' });
  const reset = el('button', { class: 'btn', text: 'Back to the real game' });
  run.addEventListener('click', () => {
    const params = { sims: state.sims };
    if (away.value) params.qb_away = away.value;
    if (home.value) params.qb_home = home.value;
    if (neutral.checked) params.neutral = 1;
    const wxChanged = Number(temp.value) !== Math.round(wx.indoor ? 68 : (wx.temp ?? 60))
      || Number(wind.value) !== Math.round(wx.indoor ? 0 : (wx.wind ?? 0))
      || Number(rain.value) !== Math.round((wx.rain ?? 0) * 100);
    if (wxChanged) {
      params.temp = temp.value;
      params.wind = wind.value;
      params.rain = (Number(rain.value) / 100).toFixed(2);
    }
    renderGame(gameId, params);
  });
  reset.addEventListener('click', () => renderGame(gameId, { sims: state.sims }));

  return el('section', { class: 'card' },
    el('h2', { text: 'What if…' }),
    el('p', { class: 'sub', text:
      'Change the quarterback or the conditions and replay the game from the same team ratings.' }),
    el('div', { class: 'whatif' },
      el('div', { class: 'field' }, el('label', { for: 'wi-qb-away', text: `${current.game.away} QB` }), away),
      el('div', { class: 'field' }, el('label', { for: 'wi-qb-home', text: `${current.game.home} QB` }), home),
      el('div', { class: 'field' }, el('label', { for: 'wi-temp', text: 'Temp °F' }), temp),
      el('div', { class: 'field' }, el('label', { for: 'wi-wind', text: 'Wind mph' }), wind),
      el('div', { class: 'field' }, el('label', { for: 'wi-rain', text: 'Rain %' }), rain)),
    el('div', { class: 'whatif-actions' },
      el('label', { style: 'display:flex;gap:6px;align-items:center;font-size:13px' },
        neutral, 'Neutral site'),
      run, reset,
      Object.keys(current.overrides || {}).length
        ? el('span', { class: 'pill', text: 'showing a what-if' }) : null));
}

async function renderGame(gameId, params = {}) {
  const mine = ++paintToken;
  showLoading('Playing this game out ' + state.sims.toLocaleString() + ' times…');
  setBusy(true, 'Simulating…');
  try {
    const [r, qbs] = await Promise.all([
      api('/api/game', { id: gameId, sims: state.sims, season: state.season,
                         week: state.week, ...params }),
      quarterbackList(),
    ]);
    if (mine !== paintToken) return;
    if (r) setPublishedSims(r.sims);
    if (!r) {
      render(el('p', { class: 'notice', text: 'That game is not on this week’s slate.' }));
      return;
    }
    const g = r.game;
    const away = g.away, home = g.home;
    const game = { away, home };

    const board = scoreboard(r, away, home);
    const views = modelVsMarket(r, away, home);

    const head = el('div', {},
      el('div', { class: 'page-head' },
        el('a', { class: 'btn', href: '#/', text: '← Slate' }),
        el('h1', { text: `${away} at ${home}` }),
        window.SlipKit ? el('button', { class: 'btn', type: 'button', text: 'Game lines → slip', title:
          'The moneyline, spread, total, first half and team points of this game, to put in your parlay slip',
          onclick: () => window.SlipKit.choose({ sport: 'nfl', gid: g.id, title: `${away} at ${home}`, sub: 'Game lines',
            who: { markets: ['ML', 'SPREAD', 'ALT_SPREAD', 'TOTAL', 'ALT_TOTAL', 'TEAM_TOTAL', 'H1_ML', 'H1_SPREAD',
                             'H1_TOTAL', 'TEAM_H1'] } }) }) : null),
      el('p', { class: 'sub', text:
        `${g.kickoff} · ${g.stadium} (${g.roof}) · ${weatherLine(r.weather)}` +
        (r.weather.indoor ? '' : ` (${r.weather.source})`) +
        ` · ${r.qbs[away]} vs ${r.qbs[home]}` +
        (g.final ? ` · FINAL ${g.away_score}–${g.home_score}` : '')}));

    render(head,
      board,
      views,
      el('div', { class: 'grid grid-2', style: 'margin-top:16px' },
        histogram(r.margin_hist, {
          title: 'Winning margin',
          note: `Positive means ${home} wins. ${r.sims.toLocaleString()} simulations.`,
          colour: 'var(--home)', unit: '',
          marker: r.spread ? r.spread.line : null, markerLabel: r.spread ? `DK ${favText(game, r.spread.line)}` : null,
          model: r.margin, modelLabel: `model ${favText(game, r.margin)}`,
          legend: legendFor([['sw-home', `${home} margin`],
            ...(r.spread ? [['sw-dash', `DraftKings ${favText(game, r.spread.line)}`]] : []),
            ['sw-solid', `model ${favText(game, r.margin)}`]]),
        }),
        histogram(r.total_hist, {
          title: 'Total points',
          note: 'Both teams combined.',
          colour: 'var(--away)',
          marker: r.total_bet ? r.total_bet.line : null, markerLabel: r.total_bet ? `DK ${r.total_bet.line}` : null,
          model: r.total, modelLabel: `model ${num(r.total)}`,
          legend: legendFor([['sw-away', 'combined points'],
            ...(r.total_bet ? [['sw-dash', `DraftKings ${r.total_bet.line}`]] : []),
            ['sw-solid', `model ${num(r.total)}`]]),
        })),
      el('div', { class: 'grid grid-2', style: 'margin-top:16px' },
        histogram(r.away_score_hist, { title: `${away} points`, colour: 'var(--away)' }),
        histogram(r.home_score_hist, { title: `${home} points`, colour: 'var(--home)' })),
      el('section', { class: 'card', style: 'margin-top:16px' },
        el('h2', { text: 'Projected box score' }),
        el('p', { class: 'sub', text: 'The average of every simulated game.' }),
        el('div', { class: 'table-wrap' }, teamStatsTable(r, away, home))),
      el('section', { class: 'card', style: 'margin-top:16px' },
        el('h2', { text: 'Most likely final scores' }),
        el('div', { class: 'table-wrap' }, buildTable(['Score', 'Share of simulations'],
          r.common_scores.map(s => [`${away} ${s.away} – ${s.home} ${home}`, pct(s.share, 2)])))),
      playersHead(),
      el('div', { class: 'grid grid-2' },
        playerPanel(r, away), playerPanel(r, home)),
      el('div', { style: 'margin-top:16px' }, injuryPanel(r)),
      el('div', { style: 'margin-top:16px' },
        whatIfPanel(gameId, r, qbs)));
    view.focus();
  } catch (err) {
    if (mine === paintToken) showError(err);
  } finally {
    setBusy(false);
  }
}

/** The scoreboard: each side's projected score and chance, the model's split with the market's tick, and the model,
    DraftKings and the old simulator side by side. */
function scoreboard(r, away, home) {
  const game = { away, home };
  const m = r.model || {};
  const mk = r.market && r.market.home_win;
  const alone = m.simulator_alone;
  const side = (code, score, win, fair, cls, which) => el('div', { class: `sb-team ${which}` },
    el('div', { class: 'sb-code' }, el('i', { style: `background:var(--${cls})` }), code),
    el('div', { class: 'sb-score num', text: num(score) }),
    el('div', { class: 'sb-win num', text: `${pct(win)} to win · fair ${odds(fair)}` }));
  const mid = el('div', { class: 'sb-mid' },
    el('div', {}, 'total ', el('b', { class: 'num', text: num(r.total) })),
    el('div', {}, `${home} `, el('b', { class: 'num', text: signed(r.margin) }),
      el('span', { class: 'num', text: ` ± ${num(r.margin_sd)}` })),
    el('div', {}, 'overtime ', el('b', { class: 'num', text: pct(r.overtime) })));

  const bookMargin = r.market ? r.market.spread : null;
  const bookTotal = r.market ? r.market.total : null;
  const have = v => v !== null && v !== undefined && !Number.isNaN(v);
  const off = (a, b, gap) => have(a) && have(b) && Math.abs(a - b) >= gap;
  const winText = w => (have(w) ? `${home} ${pct(w)}` : '\u2013');
  const totalText = t => (have(t) ? num(t) : '\u2013');
  // Rows are what is compared, columns who says it: amber on DraftKings' number where the model is well apart from it.
  const cell = (text, cls) => el('span', { class: `cmp-v${cls ? ' ' + cls : ''}`, text });
  const compare = m.source !== 'power ratings' ? null : el('div', { class: 'cmp-grid' },
    el('span'), el('span', { class: 'cmp-h', text: 'Model' }), el('span', { class: 'cmp-h', text: 'DraftKings' }),
    el('span', { class: 'cmp-h', text: 'Simulator alone' }),
    el('span', { class: 'cmp-l', text: 'Win' }), cell(winText(r.home_win)), cell(winText(mk), 'book'),
    cell(winText(alone ? alone.home_win : null), 'book'),
    el('span', { class: 'cmp-l', text: 'Spread' }), cell(favText(game, r.margin)),
    cell(favText(game, bookMargin), `book${off(r.margin, bookMargin, 2.5) ? ' off' : ''}`),
    cell(favText(game, alone ? alone.margin : null), 'book'),
    el('span', { class: 'cmp-l', text: 'Total' }), cell(totalText(r.total)),
    cell(totalText(bookTotal), `book${off(r.total, bookTotal, 3.5) ? ' off' : ''}`),
    cell(totalText(alone ? alone.total : null), 'book'));

  const notes = el('div', { class: 'line-notes' });
  if (r.spread) {
    notes.appendChild(el('div', {}, 'Spread · ', el('b', { text: r.spread.pick }),
      ` — ${pct(Math.max(r.spread.home_cover, r.spread.away_cover))} to cover, the model is ${signed(r.spread.edge)} vs the line`));
  }
  if (r.total_bet) {
    notes.appendChild(el('div', {}, 'Total · ', el('b', { text: `${r.total_bet.pick} ${r.total_bet.line}` }),
      ` — ${pct(Math.max(r.total_bet.over, r.total_bet.under))}, the model is ${signed(r.total_bet.edge)} vs the line`));
  }
  return el('section', { class: 'card sb' },
    el('div', { class: 'sb-teams' }, side(away, r.away_score, r.away_win, r.away_odds, 'away', 'away'), mid,
      side(home, r.home_score, r.home_win, r.home_odds, 'home', 'home')),
    el('div', { class: 'pbar-wrap' }, winBar(game, r.away_win, r.home_win, mk), winLabels(game, r.away_win, r.home_win, mk)),
    compare, notes.children.length ? notes : null);
}

/** What the number is made of: the pulls on the line, and why the line leads. */
function modelVsMarket(r, away, home) {
  const m = r.model || {};
  if (m.source !== 'power ratings') return null;
  const why = m.why || {};
  const parts = [['Home field', why.home], ['Play-by-play efficiency (EPA, success rate)',
    (why.d_epa || 0) + (why.d_sr || 0)], ['Points scored and allowed', why.d_pts],
    ['Quarterbacks this week', why.d_qb], ['Rest', why.rest],
    ['Pulled onto the betting line', m.line_pull]]
    .filter(([, v]) => v !== undefined && v !== null);
  const table = buildTable(['What moves the line', `Points toward ${home}`],
    parts.map(([label, v]) => [label, { text: signed(v, 1), class: v > 0.05 ? 'win' : (v < -0.05 ? 'loss' : null) }])
      .concat([[{ text: 'Projected margin' }, { text: signed(r.margin, 1) }]]));
  return el('section', { class: 'card', style: 'margin-top:16px' },
    el('h2', { text: 'How the margin is built' }),
    el('div', { class: 'table-wrap' }, table),
    el('details', { class: 'how' },
      el('summary', { text: 'Why the numbers start from the line' }),
      el('p', { class: 'sub', text:
        'The ratings beat the simulator on every measure out of sample, but the betting line beat ' +
        'the ratings, and over six seasons the ratings’ side of the spread was right 49% of the time ' +
        'where the two disagreed. So the numbers on this page start from the line and keep only a ' +
        'small share of how far the ratings were from it (the pull in the table above); the simulator ' +
        'is steered onto that score. The market is the line with the bookmaker’s margin removed.' })));
}

function kpi(k, v, n) {
  return el('div', { class: 'kpi' },
    el('div', { class: 'k', text: k }),
    el('div', { class: 'v num', text: v }),
    n ? el('div', { class: 'n', text: n }) : null);
}

/* ------------------------------------------------------------------ props */
// What the Props page can price. `slider` is the span the line slider covers, in the whole numbers a book's ladder uses
// ("80+ yards"): the line is half a unit under (79.5), so a player who lands on it exactly has cleared it, and every notch
// has a stored rung (nflsim/week.py). `ladder` are the shortcut chips. A `lumpy` market has only a few outcomes (0, 1, 2
// touchdowns), so DraftKings' line there says little about its chance until its prices are in.
const MARKETS = [
  { key: 'anytime_td', label: 'Anytime touchdown', short: 'Anytime TD', kind: 'td' },
  { key: 'scrimmage', label: 'Rushing + receiving yards', short: 'Rush + rec', curve: 'over_scrimmage',
    lines: 'yards', projection: 'scrimmage_yards', start: 49.5, unit: 'yards',
    slider: { min: 10, max: 250, step: 5 }, ladder: [50, 75, 100, 125, 150, 200] },
  { key: 'rush_yards', label: 'Rushing yards', short: 'Rushing', curve: 'over_rush_yards',
    lines: 'yards', projection: 'rush_yards', start: 49.5, unit: 'yards',
    slider: { min: 10, max: 200, step: 5 }, ladder: [30, 40, 50, 60, 75, 100, 125] },
  { key: 'rec_yards', label: 'Receiving yards', short: 'Receiving', curve: 'over_rec_yards',
    lines: 'yards', projection: 'rec_yards', start: 49.5, unit: 'yards',
    slider: { min: 10, max: 200, step: 5 }, ladder: [30, 40, 50, 60, 70, 80, 90, 100, 125] },
  { key: 'catches', label: 'Receptions', short: 'Receptions', curve: 'over_catches',
    lines: 'catches', projection: 'catches', start: 3.5, unit: 'catches',
    slider: { min: 1, max: 13, step: 1 }, ladder: [3, 4, 5, 6, 7, 8, 10] },
  { key: 'carries', label: 'Carries', short: 'Carries', curve: 'over_carries',
    lines: 'carries', projection: 'carries', start: 11.5, unit: 'carries',
    slider: { min: 5, max: 30, step: 1 }, ladder: [10, 15, 20, 25] },
  { key: 'pass_yards', label: 'Passing yards', short: 'Pass yds', curve: 'over_pass_yards',
    lines: 'pass_yards', projection: 'pass_yards', start: 249.5, unit: 'yards',
    slider: { min: 175, max: 375, step: 25 }, ladder: [200, 225, 250, 275, 300, 325, 350] },
  { key: 'pass_td', label: 'Passing touchdowns', short: 'Pass TDs', curve: 'over_pass_td',
    lines: 'pass_td', projection: 'pass_td', start: 1.5, unit: 'TDs',
    slider: { min: 1, max: 4, step: 1 }, ladder: [1, 2, 3], lumpy: true },
  { key: 'interceptions', label: 'Interceptions thrown', short: 'INTs', curve: 'over_interceptions',
    lines: 'counts', projection: 'interceptions', start: 0.5, unit: 'INTs',
    slider: { min: 1, max: 3, step: 1 }, ladder: [1, 2], lumpy: true },
];
const POSITIONS = [['', 'All'], ['QB', 'QB'], ['RB', 'RB'], ['WR', 'WR'], ['TE', 'TE'], ['REC', 'WR + TE']];
const BIG_GAP = 0.08;        // 8+ points from the book: the Lab's "off book" line is 15, and the model has been the one in error

function americanOdds(p) {
  if (!(p > 0 && p < 1)) return null;
  return p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
}

/** The chance an American price implies, its margin still in. */
const priceChance = price => (price > 0 ? 100 / (price + 100) : -price / (-price + 100));

/** Read a probability off a player's over-curve, interpolating between the stored lines. */
function chanceOver(player, market, lines, line) {
  const curve = player[market.curve];
  if (!curve || !lines || !lines.length) return null;
  if (line <= lines[0]) return curve[0];
  if (line >= lines[lines.length - 1]) return curve[curve.length - 1];
  for (let i = 1; i < lines.length; i++) {
    if (line <= lines[i]) {
      const span = lines[i] - lines[i - 1];
      const t = span ? (line - lines[i - 1]) / span : 0;
      return curve[i - 1] + t * (curve[i] - curve[i - 1]);
    }
  }
  return curve[curve.length - 1];
}

/** Narrow the player list to the matchup, team, position or name being looked at. */
function matching(players, filters) {
  const needle = (filters.name || '').trim().toLowerCase();
  return players.filter(p => {
    if (filters.game && p.game !== filters.game) return false;
    if (filters.team && p.team !== filters.team) return false;
    const pos = filters.position;
    // A receiver the rosters have no spot for is "WR/TE": he shows under wide receivers, tight ends and both together.
    if (pos === 'REC' && !['WR', 'TE', 'WR/TE'].includes(p.position)) return false;
    if ((pos === 'WR' || pos === 'TE') && p.position !== pos && p.position !== 'WR/TE') return false;
    if ((pos === 'RB' || pos === 'QB') && p.position !== pos) return false;
    if (needle && !p.player.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/** DraftKings' chance of the over with its margin taken out. From both prices when the book has them; otherwise a coin
    flip at its own line, since it hangs the line where the money splits - which a lumpy market cannot assume. An
    anytime-touchdown price is one-sided, so its margin stays in. */
function bookChance(market, dk) {
  if (!dk) return null;
  if (market.kind === 'td') return dk.price == null ? null : { p: priceChance(dk.price), basis: 'margin' };
  if (dk.over != null && dk.under != null) {
    const a = priceChance(dk.over), b = priceChance(dk.under);
    return { p: a / (a + b), basis: 'prices' };
  }
  return market.lumpy ? null : { p: 0.5, basis: 'line' };
}

/** One player's row in a market: the model's chance at the line being looked at (the slider's, or his own DraftKings
    line), and how its chance at DraftKings' line sits against the book's. */
function propRow(p, market, lines, ctx) {
  const dk = p.dk && p.dk[market.key];
  const row = { p, dk, projection: p[market.projection], book: bookChance(market, dk) };
  const under = ctx.side === 'under' && market.kind !== 'td';
  if (market.kind === 'td') {
    if (p.p_td === null || p.p_td === undefined) return null;
    row.over = row.atBook = p.p_td;
  } else {
    if (!p[market.curve]) return null;
    row.line = ctx.mode === 'book' ? (dk ? dk.line : null) : ctx.line;
    if (row.line === null || row.line === undefined) return null;          // no DraftKings line for him: nothing to compare at
    row.over = chanceOver(p, market, lines, row.line);
    if (row.over === null) return null;
    // DraftKings' price at this line: its own where this is the line it has up, otherwise the estimate for this rung, if the page has one
    // (a line typed between two rungs has none).
    row.mode = ctx.mode;
    row.sameLine = !!dk && Math.abs(row.line - dk.line) < 1e-9;
    const rung = dk && dk.est ? lines.findIndex(x => Math.abs(x - row.line) < 1e-9) : -1;
    row.est = rung >= 0 && dk.est[rung] ? dk.est[rung] : null;
    row.atBook = dk && dk.line !== null && dk.line !== undefined ? chanceOver(p, market, lines, dk.line) : null;
    if (row.projection !== undefined && row.projection !== null && row.projection < 0.2) return null;
  }
  row.chance = under ? 1 - row.over : row.over;
  row.price = !dk ? null : market.kind === 'td' ? dk.price : (under ? dk.under : dk.over);
  row.gap = row.atBook !== null && row.atBook !== undefined && row.book
    ? (under ? -1 : 1) * (row.atBook - row.book.p) : null;
  return row;
}

const BIG = 1e9;
const SORTS = {
  chance: r => r.chance,
  gap: r => (r.gap === null ? -BIG : r.gap),
  proj: r => (r.projection === null || r.projection === undefined ? -BIG : r.projection),
};

/** The player cell: name, then position, team and opponent. */
function whoCell(p) {
  const [away] = String(p.game).split(' @ ');
  const vs = p.team === away ? `@ ${p.opponent}` : `vs ${p.opponent}`;
  return el('div', { class: 'who' }, el('b', { text: p.player }),
    el('small', { text: `${p.position} · ${p.team} ${vs}` }));
}

function chanceCell(chance) {
  return el('div', { class: 'ch' },
    el('b', { class: `num${chance >= 0.55 ? ' win' : ''}`, text: pct(chance) }),
    el('span', { class: 'mbar' }, el('i', { style: `width:${(Math.min(Math.max(chance, 0), 1) * 100).toFixed(1)}%` })));
}

/** A link to the game on DraftKings around a cell, where the book's event is known: one tap from the number to the bet.
    The row itself opens the player's lines, so the click stops here. */
function dkLink(p, cell) {
  const event = p.dk && p.dk.ev;
  if (!event) return cell;
  return el('a', { class: 'dklink', href: `https://sportsbook.draftkings.com/event/${encodeURIComponent(event)}`, target: '_blank',
    rel: 'noopener', title: 'Open this game on DraftKings', onclick: e => e.stopPropagation() }, cell);
}

/** DraftKings' line and what it pays on the side being looked at. */
function dkCell(market, row, side) {
  const dk = row.dk;
  if (!dk) return el('span', { class: 'dim', text: '–' });
  if (market.kind === 'td') {
    return dk.price === null || dk.price === undefined ? el('span', { class: 'dim', text: 'no price yet' })
      : dkLink(row.p, el('div', { class: 'dk' }, el('b', { class: 'num', text: odds(dk.price) })));
  }
  const both = dk.over !== null && dk.over !== undefined && dk.under !== null && dk.under !== undefined;
  const mine = side === 'under' ? dk.under : dk.over;
  const how = 'An estimate, not DraftKings\u2019 price: the model\u2019s distribution scaled to agree with DraftKings\u2019 line, plus the margin '
    + 'it charges. Checked on 843 real NFL ladder rungs it was off by 3\u20135% of the chance in the middle of the range and 17\u201325% for a '
    + 'long shot (marked ~).';
  const estimate = (price, note) => {
    const rough = priceChance(price) < 0.17;                       // a long shot: the book's view of one player's tail
    return dkLink(row.p, el('div', { class: `dk est${rough ? ' rough' : ''}`, title: how },
      el('b', { class: 'num', text: `${rough ? '~' : '\u2248'}${odds(price)}` }), el('small', { class: 'dim', text: note })));
  };
  if (row.mode === 'line' && !row.sameLine) {
    // Another line than the one DraftKings has up: its price here is only an estimate, and for overs (it hangs the "80+" rungs that way).
    const note = `main ${dk.line}`;
    if (side === 'over' && row.est) return estimate(row.est, note);
    return dkLink(row.p, el('div', { class: 'dk' }, el('b', { class: 'dim', text: '\u2013' }), el('small', { class: 'dim', text: note })));
  }
  if ((mine === null || mine === undefined) && side === 'over' && row.est) return estimate(row.est, `main ${dk.line}`);
  return dkLink(row.p, el('div', { class: 'dk', title: both ? `Over ${odds(dk.over)} · Under ${odds(dk.under)}` : null },
    el('b', { class: 'num', text: String(dk.line) }),
    mine === null || mine === undefined ? el('small', { class: 'dim', text: 'no price yet' })
      : el('small', { class: 'num', text: odds(mine) })));
}

/** The model's chance at the book's line less the book's, in points; amber when it is large, since a gap that big has
    mostly been the model's mistake. */
function gapCell(row) {
  if (row.gap === null) return el('span', { class: 'dim', text: '–' });
  const pts = row.gap * 100;
  const big = Math.abs(row.gap) >= BIG_GAP;
  const how = { prices: 'against DraftKings’ two prices with the margin taken out',
                line: 'against a coin flip at DraftKings’ line (its prices are not in yet)',
                margin: 'against DraftKings’ price, margin included' }[row.book.basis];
  return el('span', { class: `gap num${big ? ' far' : ''}${row.book.basis === 'prices' || row.book.basis === 'margin' ? '' : ' soft'}`,
    title: `The model’s chance at DraftKings’ line is ${pts >= 0 ? pts.toFixed(1) + ' points above' : (-pts).toFixed(1) + ' points below'} the book’s, ${how}.${big ? ' A gap this big has mostly been the model’s error.' : ''}`,
    text: `${signed(pts, 1)}${row.book.basis === 'line' ? '~' : ''}` });
}

function propsTable(data, market, ctx, filters) {
  const lines = data.lines[market.lines];
  const rows = matching(data.players, filters).map(p => propRow(p, market, lines, ctx)).filter(Boolean);
  const key = SORTS[ctx.sort] || SORTS.chance;
  rows.sort((a, b) => key(b) - key(a));
  const shown = rows.slice(0, 150);
  const side = ctx.side === 'under' && market.kind !== 'td' ? 'under' : 'over';
  const word = side === 'under' ? 'Under' : 'Over';
  let header, cols, cells;
  if (market.kind === 'td') {
    header = ['Player', 'Scores a TD', 'Fair odds', 'DraftKings', 'Gap', 'Sims alone'];
    cols = [null, null, 'hide-sm', null, null, 'hide-sm'];
    cells = r => [whoCell(r.p), chanceCell(r.chance), odds(r.p.td_odds), dkCell(market, r, side), gapCell(r),
                  r.p.p_td_sim === null || r.p.p_td_sim === undefined ? '–' : pct(r.p.p_td_sim)];
  } else {
    header = ['Player', 'Projected', ctx.mode === 'book' ? `${word} at DK line` : `${word} ${ctx.line}`, 'Fair odds',
              'DraftKings', 'Gap'];
    cols = [null, 'hide-sm', null, 'hide-sm', null, null];
    cells = r => {
      const p = r.p;
      const proj = el('div', { class: 'proj' },
        el('b', { class: 'num', text: num(r.projection, r.projection >= 20 ? 1 : 2) }),
        market.key === 'scrimmage'          // a back's yards, in the two halves they are made of
          ? el('small', { class: 'num', text: `${num(p.rush_yards, 0)} rush · ${num(p.rec_yards, 0)} rec` }) : null);
      return [whoCell(p), proj, chanceCell(r.chance), odds(americanOdds(r.chance)), dkCell(market, r, side), gapCell(r)];
    };
  }
  const table = buildTable(header, shown.map(cells), { cols });
  table.classList.add('props-table');
  // Click a row to see that player's lines and put one in the parlay slip.
  if (window.SlipKit) {
    table.querySelectorAll('tbody tr').forEach((tr, i) => {
      const p = shown[i].p;
      if (!p.game_id) return;
      window.SlipKit.attach(tr, () => ({ sport: 'nfl', gid: p.game_id, name: p.player, title: p.player,
        who: { pkey: window.SlipKit.nameKey(p.player, p.team) }, extra: () => formBlock(p.game_id, p.team, p.player, null), sub: `${p.team} · ${p.game}` }));
    });
  }
  return table;
}

/** A row of pill buttons, one pressed. `items` are [value, text, tip?, disabled?]. */
function chipRow(items, value, onPick, label, extra = '') {
  const row = el('div', { class: `chips ${extra}`.trim(), role: 'group', 'aria-label': label });
  row.set = v => row.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === String(v))));
  for (const [v, text, tip, off, short] of items) {
    row.appendChild(el('button', { type: 'button', class: 'chip', 'data-v': String(v), title: tip || null,
      disabled: off ? '' : null, 'aria-pressed': String(String(v) === String(value)),
      onclick: () => { onPick(v); row.set(v); } },
      short ? [el('span', { class: 'lg', text }), el('span', { class: 'sm', text: short })] : text));
  }
  return row;
}

/** When the newest DraftKings price on the page was fetched, said the way a person would. */
function priceAge(players) {
  let latest = null;
  for (const p of players) {
    const t = p.dk && p.dk.asof ? Date.parse(p.dk.asof) : NaN;
    if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t;
  }
  return latest === null ? null
    : new Date(latest).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

async function renderProps() {
  const mine = ++paintToken;
  showLoading(`Simulating every game and collecting the player markets, ${state.sims.toLocaleString()} sims each…`);
  setBusy(true, 'Simulating…');
  try {
    const data = await api('/api/props', { season: state.season, week: state.week,
                                           sims: state.sims });
    if (mine !== paintToken) return;
    setPublishedSims(data.sims);
    if (!data.players.length) {
      render(
        el('div', { class: 'page-head' }, el('h1', { text: 'Player props' })),
        el('p', { class: 'notice', text:
          'Every game this week has already kicked off, so there is nothing left to price.' }));
      return;
    }
    const ctx = state.props = Object.assign({ mode: 'line', side: 'over', sort: 'chance', position: '' }, state.props || {});
    let market = MARKETS.find(m => m.key === state.market) || MARKETS[0];
    const hasBook = data.players.some(p => p.dk);
    if (!hasBook) { ctx.mode = 'line'; if (ctx.sort === 'gap') ctx.sort = 'chance'; }
    const asof = priceAge(data.players);
    const games = [...new Set(data.players.map(p => p.game))].sort();
    const teams = [...new Set(data.players.map(p => p.team))].sort();

    const lineInput = el('input', { class: 'input num', type: 'number', step: '0.5',
                                    id: 'prop-line', value: market.start || 49.5 });
    // Slide the line: whole numbers ("80+ yards"), the line half a unit under, the table redrawn as it moves.
    const slider = el('input', { type: 'range', id: 'prop-slider', class: 'slider' });
    const sliderValue = el('span', { class: 'slider-val num' });
    const ladder = el('div', { class: 'ladder' });
    const lineGroup = el('div', { class: 'props-line' },
      el('div', { class: 'field field-line' }, el('label', { for: 'prop-line', text: 'Line' }), lineInput),
      el('div', { class: 'field slider-field' },
        el('div', { class: 'slider-head' }, el('label', { for: 'prop-slider', text: 'Slide the line' }), sliderValue),
        slider),
      ladder);
    const gameSelect = el('select', { class: 'select', id: 'prop-game', 'aria-label': 'Matchup' },
      [el('option', { value: '', text: `All ${games.length} matchups` })].concat(
        games.map(g => el('option', { value: g, text: g }))));
    const teamSelect = el('select', { class: 'select', id: 'prop-team', 'aria-label': 'Team' },
      [el('option', { value: '', text: 'Any team' })].concat(
        teams.map(t => el('option', { value: t, text: t }))));
    const nameInput = el('input', { class: 'input', type: 'search', id: 'prop-name', 'aria-label': 'Player',
                                    placeholder: 'Find a player' });
    const count = el('span', { class: 'pill' });
    const holder = el('div', { class: 'table-wrap' });
    const tableTitle = el('h2', { style: 'margin:0' });

    const marketChips = chipRow(MARKETS.map(m => [m.key, m.short, m.label]), market.key, key => {
      market = MARKETS.find(m => m.key === key) || MARKETS[0];
      lineInput.value = market.start || 49.5;
      draw();
    }, 'Market', 'scroll');
    const modeChips = chipRow([['line', 'Slide a line', 'Price any line, the way a book’s ladder does', false, 'My line'],
      ['book', 'DraftKings’ line', hasBook ? 'Each player at the line DraftKings has up for him' : 'DraftKings’ lines are not loaded', !hasBook, 'DK line']],
      ctx.mode, v => { ctx.mode = v; ctx.sort = v === 'book' ? 'proj' : 'chance'; sortChips.set(ctx.sort); draw(); }, 'Compare at');
    const sideChips = chipRow([['over', 'Over'], ['under', 'Under']], ctx.side, v => { ctx.side = v; draw(); }, 'Side');
    const sortChips = chipRow([['chance', 'Chance'], ['gap', 'Gap vs DK', 'Where the model is furthest above DraftKings', !hasBook, 'Gap'],
      ['proj', 'Projection', null, false, 'Proj']], ctx.sort, v => { ctx.sort = v; draw(); }, 'Sort by');
    const posChips = chipRow(POSITIONS, ctx.position, v => { ctx.position = v; draw(); }, 'Position');

    let ranged = null;
    /** Set the slider to this market's span and step, and the knob to where the line is. */
    function rangeSlider(line) {
      const s = market.slider;
      if (!s) return;
      if (ranged !== market.key) {
        slider.min = s.min; slider.max = s.max; slider.step = s.step;
        ranged = market.key;
        ladder.replaceChildren(...(market.ladder || []).map(n => el('button', { type: 'button', class: 'chip small',
          'data-line': String(n - 0.5), text: `${n}+`, onclick: () => { lineInput.value = n - 0.5; draw(); } })));
      }
      slider.value = Math.min(s.max, Math.max(s.min, line + 0.5));
      // "80+ yards" for a half-line; a line typed as a whole number (which can push) is said as it is.
      sliderValue.textContent = Number.isInteger(line + 0.5)
        ? `${line + 0.5}+ ${market.unit}` : `over ${line} ${market.unit}`;
      ladder.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.line) === line)));
    }

    const show = (node, on) => { node.style.display = on ? '' : 'none'; };
    function draw() {
      marketChips.set(market.key);
      state.market = market.key;
      const isTd = market.kind === 'td';
      let line = Number(lineInput.value);
      if (!Number.isFinite(line) || lineInput.value === '') line = market.start || 49.5;
      show(lineGroup, !isTd && ctx.mode === 'line');
      show(modeChips, !isTd);
      show(sideChips, !isTd);
      sortChips.querySelector('[data-v="gap"]').disabled = !hasBook;
      if (!isTd && ctx.mode === 'line') rangeSlider(line);
      const filters = { game: gameSelect.value, team: teamSelect.value, position: ctx.position, name: nameInput.value };
      // Choosing a matchup and then a team from the other one leaves nothing; say so.
      const table = propsTable(data, market, { ...ctx, line }, filters);
      const shown = table.querySelectorAll('tbody tr').length;
      count.textContent = shown
        ? `${shown} player${shown === 1 ? '' : 's'}`
        : (!isTd && ctx.mode === 'book' ? 'DraftKings has no line for these yet' : 'nothing matches these filters');
      holder.replaceChildren(table);
      tableTitle.textContent = isTd ? 'Odds to score' : (ctx.mode === 'book' ? 'Against DraftKings\u2019 own line' : 'Priced by the model');
    }
    for (const control of [lineInput, gameSelect, teamSelect, nameInput]) {
      control.addEventListener('input', draw);
      control.addEventListener('change', draw);
    }
    slider.addEventListener('input', function () {
      lineInput.value = Number(slider.value) - 0.5;
      draw();
    });

    render(
      el('div', { class: 'page-head' },
        el('h1', { text: 'Player props' }),
        el('span', { class: 'pill', text: data.season + ' week ' + data.week }),
        el('span', { class: 'pill', text: data.sims.toLocaleString() + ' sims per game' }),
        hasBook ? el('span', { class: 'pill live', title: 'DraftKings’ prices are fetched once per game, a few hours before kickoff',
                               text: asof ? `DraftKings prices ${asof}` : 'DraftKings lines (prices post before kickoff)' }) : null),
      el('p', { class: 'sub', text:
        'Every skill player on the slate, priced by the simulations. Slide the line to any rung of a book’s ladder, '
        + 'or compare each player at DraftKings’ own line to see where the model and the book part ways.' }),
      el('section', { class: 'card controls' },
        marketChips,
        el('div', { class: 'ctl-row' },
          modeChips, sideChips,
          el('div', { class: 'ctl-sort' }, el('span', { class: 'ctl-label', text: 'Sort' }), sortChips)),
        lineGroup,
        el('div', { class: 'ctl-row filters' },
          posChips, gameSelect, teamSelect, nameInput)),
      el('section', { class: 'card', style: 'margin-top:16px' },
        el('div', { class: 'row-between', style: 'margin-bottom:10px' },
          tableTitle, count),
        holder),
      el('details', { class: 'how' },
        el('summary', { text: 'How to read this' }),
        el('p', { class: 'sub', text:
          'The chance is how often the player cleared the line across every simulated game, with each game steered onto the '
          + 'power ratings’ projected score. Touchdown odds are corrected for the simulator being too sure of itself, '
          + 'which the props backtest measured; the raw simulation number sits beside them. Games already kicked off are left out.' }),
        el('p', { class: 'sub', text:
          'Gap is the model’s chance at DraftKings’ own line less DraftKings’, with its margin taken out of both '
          + 'prices (an anytime-touchdown price has one side, so its margin stays in and the gap there runs negative). Until a '
          + 'game’s prices are fetched it assumes the line splits the money (marked ~), and it will not '
          + 'guess for a market with only a few outcomes. Across the Lab’s graded legs the model has not beaten these '
          + 'prices, so a big gap (amber) is the model disagreeing with the book, which has usually been the model’s mistake, '
          + 'not a pick. Fair odds are what a chance is worth with no margin; how the model has held up is on the Record page.' })));
    draw();
  } catch (err) {
    if (mine === paintToken) showError(err);
  } finally {
    setBusy(false);
  }
}

/* ------------------------------------------------------------------ teams */
async function renderTeams() {
  showLoading('Loading team ratings…');
  setBusy(true, 'Loading ratings…');
  try {
    const [d, pw] = await Promise.all([
      api('/api/teams', { season: state.season, week: state.week }),
      api('/api/power', { season: state.season, week: state.week })]);
    const powerRows = (pw.teams || []).map((t, i) => [
      String(i + 1), t.team + (t.playing ? '' : ' (bye)'),
      { text: signed(t.net, 1), class: t.net > 0 ? 'win' : 'loss' },
      signed(t.off_epa, 3), signed(t.def_epa, 3),
      signed(t.off_sr * 100, 1), signed(t.def_sr * 100, 1),
      signed(t.off_pts, 1), signed(t.def_pts, 1),
      t.qb || '–', t.qb_epa === null || t.qb_epa === undefined ? '–' : signed(t.qb_epa, 3)]);
    const rows = d.teams.map(t => [
      t.team + (t.playing ? '' : ' (bye)'),
      num(t.off_pass_yards, 3), num(t.off_rush_yards, 3), signed(t.off_comp, 3),
      signed(t.off_sack, 3), signed(t.off_int, 3),
      num(t.def_pass_yards, 3), num(t.def_rush_yards, 3), signed(t.def_comp, 3),
      signed(t.def_sack, 3),
    ]);
    render(
      el('div', { class: 'page-head' }, el('h1', { text: 'Power ratings' })),
      el('p', { class: 'sub', text:
        'What decides every win chance on the slate. Net is the margin against an average team ' +
        `on a neutral field, in points (home field is worth another ${num(pw.home_edge, 1)}). ` +
        'Each rating is opponent-adjusted, with recent games counting for more; for a defence, ' +
        'positive means it takes that much away. EPA is per play, success rate in percentage ' +
        'points, points per game. QB is the latest starter\u2019s EPA per dropback against the league.' }),
      el('section', { class: 'card' }, el('div', { class: 'table-wrap' }, buildTable(
        ['#', 'Team', 'Net', 'Off EPA', 'Def EPA', 'Off success', 'Def success',
         'Off points', 'Def points', 'QB', 'QB EPA'], powerRows))),
      el('div', { class: 'page-head', style: 'margin-top:28px' }, el('h2', { text: 'Simulator inputs' })),
      el('p', { class: 'sub', text:
        'What the play-by-play simulator plays with, for props and what-ifs. ' +
        'Opponent-adjusted and regressed for sample size, blended with last season. Yardage is a ' +
        'multiplier on the league average (1.05 means five per cent more); rates are in log-odds, ' +
        'where positive means more of that thing happens. For a defence, a lower yardage number ' +
        'is better and a higher sack number is better.' }),
      el('section', { class: 'card' }, el('div', { class: 'table-wrap' }, buildTable(
        ['Team', 'Off pass yds', 'Off rush yds', 'Off comp', 'Sacks taken', 'INT thrown',
         'Def pass yds', 'Def rush yds', 'Def comp', 'Sacks made'], rows))));
  } catch (err) {
    showError(err);
  } finally {
    setBusy(false);
  }
}

/* ------------------------------------------------------------------ record */
function backtestPanel(b) {
  if (!b) {
    return el('section', { class: 'card' },
      el('h2', { text: 'How it has done historically' }),
      el('p', { class: 'sub', text:
        'Run backtest.py to replay past seasons out of sample and fill this in.' }));
  }
  const rows = [
    ['Straight-up winner', `${b.straight_up.wins}–${b.straight_up.losses}`,
      pct(b.straight_up.rate), 'a coin flip is 50%'],
    ['Brier score', '', num(b.brier, 3), 'a coin flip is 0.250, lower is better'],
  ];
  if (b.spread) {
    rows.push(['Against the spread', `${b.spread.wins}–${b.spread.losses}`,
      pct(b.spread.rate), 'you need 52.4% to break even at -110']);
  }
  if (b.spread_when_far_off) {
    rows.push(['…when 3+ points off the line', `${b.spread_when_far_off.games} games`,
      pct(b.spread_when_far_off.rate), 'disagreeing more has not helped']);
  }
  if (b.totals) {
    rows.push(['Over / under', `${b.totals.wins}–${b.totals.losses}`, pct(b.totals.rate), '']);
  }
  rows.push(['Error in predicted margin', '', `${num(b.margin_mae, 1)} pts`,
    b.market_margin_mae ? `the closing line missed by ${num(b.market_margin_mae, 1)}` : '']);

  /* Pooling the seasons hides how differently they went, and the gap between them is the
     honest measure of how much any single season's result is worth. */
  const years = Object.keys(b.by_season || {}).sort();
  const split = years.length < 2 ? null : el('div', { class: 'table-wrap', style: 'margin-top:16px' },
    buildTable(['Season', 'Games', 'Straight up', 'Rate', 'ATS', 'Brier', 'Margin err', 'The line'],
      years.map(y => {
        const m = b.by_season[y];
        return [y, m.games, `${m.straight_up.wins}–${m.straight_up.losses}`,
          pct(m.straight_up.rate),
          m.spread ? pct(m.spread.rate) : '–', num(m.brier, 3),
          num(m.margin_mae, 2), num(m.market_margin_mae, 2)];
      }), { caption: 'Each season on its own' }));

  const comparison = (b.comparison || []).length ? el('div', { class: 'table-wrap', style: 'margin-top:16px' },
    buildTable(['', 'Games', 'Straight up', 'Brier', 'Log loss', 'Margin err', 'Total err', 'ATS'],
      b.comparison.map(c => [c.label, c.games, pct(c.su), num(c.brier, 3), num(c.logloss, 3),
        num(c.mae, 2), num(c.total_mae, 2), c.ats === undefined ? '–' : pct(c.ats)]),
      { caption: 'The same games, three ways (lower is better except straight up and ATS)' })) : null;

  const u = b.upsets;
  const upsets = u ? el('div', { class: 'table-wrap', style: 'margin-top:16px' },
    buildTable(['Model gave the underdog', 'Games', 'Model said', 'Market said', 'Underdogs won'],
      u.buckets.map(x => [`${pct(x.from, 0)}–${pct(x.to, 0)}`, x.games.toLocaleString(),
        pct(x.model), pct(x.market), pct(x.actual)]),
      { caption: `Upsets, ${u.seasons[0]}–${u.seasons[1]} (${u.games.toLocaleString()} games)` })) : null;

  return el('section', { class: 'card' },
    el('h2', { text: 'How it has done historically' }),
    el('p', { class: 'sub', text:
      `The power ratings replayed over ${b.seasons.join(' and ')}: ${b.games} games no setting was ` +
      'chosen on, each week predicted from only what had happened before it.' }),
    el('div', { class: 'table-wrap' }, buildTable(
      ['', 'Record', 'Rate', 'For comparison'], rows)),
    split, comparison, upsets);
}

/** Player props: what the model said against what happened, replayed and live. */
function propsHonesty(d) {
  const hist = d.props_history || [];
  const live = d.props || [];
  const names = { anytime_td: 'Anytime touchdown', pass_yards_300: 'Passing yards, 300+',
                  pass_td_2plus: 'Passing touchdowns, 2+' };
  const blocks = [];
  if (hist.length) {
    const seasons = hist.map(h => h.season);
    const markets = hist[0].markets.map(m => m.market);
    const rows = markets.map(name => {
      const cells = [name];
      for (const h of hist) {
        const m = h.markets.find(x => x.market === name);
        cells.push(m ? `${pct(m.said)} → ${pct(m.actual)}` : '–');
      }
      const all = hist.map(h => h.markets.find(x => x.market === name)).filter(Boolean);
      const n = all.reduce((a, m) => a + m.n, 0);
      const gap = all.reduce((a, m) => a + (m.actual - m.said) * m.n, 0) / Math.max(n, 1);
      cells.push(n.toLocaleString());
      cells.push({ text: signed(gap * 100, 1) + ' pts', class: Math.abs(gap) <= 0.03 ? 'win' : null });
      return cells;
    });
    blocks.push(el('div', { class: 'table-wrap' }, buildTable(
      ['Market'].concat(seasons.map(String)).concat(['Player-games', 'Gap']), rows,
      { caption: 'Replayed seasons: model said → actually happened' })));
    // For the over/under markets each player is scored at the standard line nearest the model's
    // own median, so 50% is a perfect answer there.
  }
  if (live.length) {
    blocks.push(el('div', { class: 'table-wrap', style: 'margin-top:12px' }, buildTable(
      ['Market', 'Graded', 'Model expected', 'Hit'],
      live.map(m => [names[m.market] || m.market, m.n, pct(m.expected), pct(m.actual)]),
      { caption: 'This season, live (a player who took no part in the game is void)' })));
  }
  return el('section', { class: 'card' },
    el('h2', { text: 'Are the props honest?' }),
    el('p', { class: 'sub', text:
      'Every projected skill player in past seasons, replayed week by week from only what was known ' +
      'beforehand and scored against what they actually did. For yardage and catches each player is ' +
      'scored at the line nearest the model\u2019s own median, so a well-centred projection goes over ' +
      'about half the time. Players who did not play are void, as a sportsbook would treat them.' }),
    blocks.length ? blocks : el('p', { class: 'notice', text: 'Run props_backtest.py to fill this in.' }));
}

/** The model, the simulator on its own and the market, on the same live games. */
function headToHead(d) {
  const rows = d.head_to_head || [];
  const n = rows.length ? rows[0].games : 0;
  return el('section', { class: 'card' },
    el('h2', { text: 'Head to head, live' }),
    el('p', { class: 'sub', text: n
      ? `Every game since the switch to the power ratings, scored three ways on exactly the same ${n} games.`
      : 'Fills in from the first week the power ratings make the picks: each pick also records ' +
        'what the simulator would have said on its own and the market\u2019s price, so all three ' +
        'can be scored on the same games.' }),
    n ? el('div', { class: 'table-wrap' }, buildTable(['', 'Games', 'Right', 'Brier', 'Margin err'],
      rows.map(r => [r.label, r.games, `${r.right}–${r.games - r.right}`, num(r.brier, 3),
        num(r.margin_mae, 1)]))) : null,
    (d.by_model || []).length > 1 || ((d.by_model || [])[0] || {}).model === 'simulator'
      ? el('p', { class: 'sub', style: 'margin:10px 0 0', text: 'Picks by model: ' +
          d.by_model.map(m => `${m.model} ${m.wins}–${m.games - m.wins}`).join(' · ') +
          '. Picks made before the switch stay as the simulator made them.' }) : null);
}

/** Predicted margin against what actually happened, one dot per game.
    The diagonal is a perfect call; dots in the top-right and bottom-left quadrants are games
    where the model at least picked the right winner. */
function predictedVsActual(points, opts) {
  const W = 620, H = 340, pad = 40;
  const limit = Math.max(
    28, ...points.map(p => Math.max(Math.abs(p.predicted), Math.abs(p.actual))));
  const round = Math.ceil(limit / 7) * 7;
  const x = v => pad + ((v + round) / (2 * round)) * (W - pad * 2);
  const y = v => H - pad - ((v + round) / (2 * round)) * (H - pad * 2);
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': `Predicted margin against actual margin for ${points.length} games.` });

  for (let v = -round; v <= round; v += 7) {
    chart.appendChild(svg('line', { class: 'grid-line', x1: x(v), x2: x(v), y1: pad, y2: H - pad }));
    chart.appendChild(svg('line', { class: 'grid-line', x1: pad, x2: W - pad, y1: y(v), y2: y(v) }));
    chart.appendChild(svg('text', { class: 'tick', x: x(v), y: H - pad + 14,
      'text-anchor': 'middle' }, document.createTextNode(String(v))));
    chart.appendChild(svg('text', { class: 'tick', x: pad - 8, y: y(v) + 3,
      'text-anchor': 'end' }, document.createTextNode(String(v))));
  }
  // Axes through zero, and the line where prediction equals result.
  chart.appendChild(svg('line', { class: 'axis-line', x1: pad, x2: W - pad, y1: y(0), y2: y(0) }));
  chart.appendChild(svg('line', { class: 'axis-line', x1: x(0), x2: x(0), y1: pad, y2: H - pad }));
  chart.appendChild(svg('line', { class: 'marker', x1: x(-round), y1: y(-round),
                                  x2: x(round), y2: y(round) }));

  for (const p of points) {
    const right = p.correct === 1;
    const dot = svg('circle', {
      cx: x(Math.max(-round, Math.min(round, p.predicted))),
      cy: y(Math.max(-round, Math.min(round, p.actual))),
      r: 4, fill: right ? 'var(--away)' : 'var(--home)',
      'fill-opacity': 0.72, tabindex: '0',
      'aria-label': `${p.game}: predicted ${p.predicted.toFixed(1)}, actual ${p.actual}`,
    });
    dot.appendChild(svg('title', {}, document.createTextNode(
      `${p.game} (wk ${p.week})\npredicted ${p.predicted > 0 ? '+' : ''}`
      + `${p.predicted.toFixed(1)}, actual ${p.actual > 0 ? '+' : ''}${p.actual}`)));
    chart.appendChild(dot);
  }
  chart.appendChild(svg('text', { class: 'tick', x: W / 2, y: H - 4, 'text-anchor': 'middle' },
    document.createTextNode('predicted home margin')));

  const rows = points.slice().sort((a, b) =>
    Math.abs(b.actual - b.predicted) - Math.abs(a.actual - a.predicted)).slice(0, 15)
    .map(p => [p.game, `${p.season} wk ${p.week}`, signed(p.predicted), signed(p.actual, 0),
               { text: signed(p.actual - p.predicted, 1),
                 class: Math.abs(p.actual - p.predicted) > 17 ? 'loss' : null }]);
  const table = buildTable(['Game', 'Week', 'Predicted', 'Actual', 'Miss'], rows,
                           { caption: rows.length < 15 ? 'Ordered by how far off it was'
                                       : 'The fifteen it got most wrong' });
  return chartBlock('Predicted against actual', opts.note, chart, table,
                    legendFor([['sw-away', 'right winner'], ['sw-home', 'wrong winner'],
                               ['sw-accent', 'a perfect call']]));
}

function seasonTable(seasons) {
  const rows = seasons.map(s => [
    String(s.season), s.games,
    `${s.wins}–${s.games - s.wins}`,
    { text: pct(s.rate), class: s.rate >= 0.6 ? 'win' : null },
    s.spread_games ? `${s.spread_wins}–${s.spread_games - s.spread_wins}` : '–',
    s.spread_games ? pct(s.spread_wins / s.spread_games) : '–',
    s.total_games ? `${s.total_wins}–${s.total_games - s.total_wins}` : '–',
    num(s.brier, 3), num(s.margin_error, 1),
  ]);
  return el('section', { class: 'card' },
    el('h2', { text: 'By season' }),
    el('p', { class: 'sub', text:
      'The current season on its own, so a good or bad run is not hidden inside a career total.' }),
    el('div', { class: 'table-wrap' }, buildTable(
      ['Season', 'Games', 'Straight up', 'Rate', 'Spread', 'ATS', 'Total', 'Brier', 'Margin err'],
      rows)));
}

function recordBlock(label, r, note) {
  if (!r) return kpi(label, '–', 'nothing graded yet');
  return kpi(label, `${r.wins}–${r.losses}`, `${pct(r.rate)}${note ? ' · ' + note : ''}`);
}

async function renderRecord() {
  showLoading('Loading the record…');
  setBusy(true, 'Loading record…');
  try {
    const d = await api('/api/record');
    if (!d.games) {
      render(
        el('div', { class: 'page-head' }, el('h1', { text: 'Prediction record' })),
        el('p', { class: 'notice', text:
          `Nothing graded yet. ${d.pending || 0} picks are saved and waiting on results. ` +
          'Run track.py (or let the daily task run) to save picks before kickoff and grade them after.' }),
        backtestPanel(d.backtest));
      return;
    }
    const cal = d.calibration.map(c => [
      `${pct(c.from, 0)}–${pct(c.to, 0)}`, c.games, pct(c.said), pct(c.actual),
      { text: signed((c.actual - c.said) * 100, 1) + ' pts',
        class: Math.abs(c.actual - c.said) < 0.06 ? 'win' : null }]);
    const weeks = d.weeks.slice().reverse().map(w => [
      `${w.season} wk ${w.week}`, `${w.wins}–${w.games - w.wins}`,
      w.spread_games ? `${w.spread_wins}–${w.spread_games - w.spread_wins}` : '–',
      w.total_games ? `${w.total_wins}–${w.total_games - w.total_wins}` : '–']);
    const recent = d.recent.map(r => [
      `${r.away} @ ${r.home}`, `${r.season} wk ${r.week}`,
      `${r.pick} ${pct(r.confidence)}`,
      `${num(r.proj_away)}–${num(r.proj_home)}`,
      `${r.away_score}–${r.home_score}`,
      { text: r.winner_ok === null ? 'tie' : (r.winner_ok ? 'right' : 'wrong'),
        class: r.winner_ok === null ? null : (r.winner_ok ? 'win' : 'loss') },
      { text: r.spread_ok === null ? '–' : (r.spread_ok ? 'cover' : 'no'),
        class: r.spread_ok === null ? null : (r.spread_ok ? 'win' : 'loss') },
      { text: r.total_ok === null ? '–' : (r.total_ok ? 'hit' : 'no'),
        class: r.total_ok === null ? null : (r.total_ok ? 'win' : 'loss') }]);

    render(
      el('div', { class: 'page-head' }, el('h1', { text: 'Prediction record' }),
        el('span', { class: 'pill', text: `${d.games} graded` }),
        d.pending ? el('span', { class: 'pill', text: `${d.pending} waiting` }) : null),
      el('p', { class: 'sub', text:
        'Every pick is written down before kickoff and graded afterwards, so this is the real ' +
        'record and not a retelling.' }),
      el('div', { class: 'card' }, el('div', { class: 'kpis' },
        recordBlock('Straight up', d.straight_up),
        recordBlock('Against the spread', d.spread, 'break-even is 52.4%'),
        recordBlock('Over/under', d.totals),
        kpi('Brier score', num(d.brier, 3), `coin flip is ${num(d.brier_baseline, 3)} · lower is better`),
        kpi('Margin error', num(d.margin_mae, 1), 'points, average miss'),
        kpi('Total error', num(d.total_mae, 1), 'points, average miss'))),
      (d.scatter && d.scatter.length)
        ? el('div', { style: 'margin-top:16px' }, predictedVsActual(d.scatter, {
            note: `Every graded game. ${d.games} of them, `
                  + `${pct(d.straight_up ? d.straight_up.rate : 0)} with the right winner.` }))
        : el('section', { class: 'card', style: 'margin-top:16px' },
            el('h2', { text: 'Predicted against actual' }),
            el('p', { class: 'sub', text:
              'Nothing graded yet. Each game becomes a dot here once it has been played.' })),
      (d.seasons && d.seasons.length) ? el('div', { style: 'margin-top:16px' },
        seasonTable(d.seasons)) : null,
      el('div', { class: 'grid grid-2', style: 'margin-top:16px' },
        el('section', { class: 'card' },
          el('h2', { text: 'Are the percentages honest?' }),
          el('p', { class: 'sub', text:
            'When the model says 70%, does it win about 70% of the time? Close to zero in the last ' +
            'column is what you want.' }),
          el('div', { class: 'table-wrap' }, buildTable(
            ['Confidence', 'Games', 'Model said', 'Actually won', 'Gap'], cal))),
        el('section', { class: 'card' },
          el('h2', { text: 'By week' }),
          el('div', { class: 'table-wrap' }, buildTable(
            ['Week', 'Straight up', 'Spread', 'Total'], weeks)))),
      el('div', { style: 'margin-top:16px' }, headToHead(d)),
      el('div', { style: 'margin-top:16px' }, propsHonesty(d)),
      el('div', { style: 'margin-top:16px' }, backtestPanel(d.backtest)),
      el('section', { class: 'card', style: 'margin-top:16px' },
        el('h2', { text: 'Recent picks' }),
        el('div', { class: 'table-wrap' }, buildTable(
          ['Game', 'Week', 'Pick', 'Projected', 'Actual', 'Winner', 'Spread', 'Total'], recent))));
  } catch (err) {
    showError(err);
  } finally {
    setBusy(false);
  }
}

/* ------------------------------------------------------------------ chrome */
function syncSelectors() {
  const seasonSel = document.getElementById('season');
  const weekSel = document.getElementById('week');
  if (state.seasons && seasonSel.options.length !== state.seasons.length) {
    seasonSel.replaceChildren(...state.seasons.map(s =>
      el('option', { value: s, text: s, selected: s === state.season ? '' : null })));
  }
  if (state.weeks) {
    const want = state.weeks.map(String).join(',');
    if (weekSel.dataset.weeks !== want) {
      weekSel.dataset.weeks = want;
      weekSel.replaceChildren(...state.weeks.map(w =>
        el('option', { value: w, text: `Week ${w}` })));
    }
  }
  seasonSel.value = String(state.season);
  weekSel.value = String(state.week);
}

function markNav(route) {
  for (const a of document.querySelectorAll('.nav a')) {
    if (a.dataset.route === route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

function route() {
  paintToken++;
  const hash = location.hash.replace(/^#/, '') || '/';
  const parts = hash.split('/').filter(Boolean);
  if (parts[0] === 'game' && parts[1]) {
    markNav('slate');
    renderGame(decodeURIComponent(parts.slice(1).join('/')));
  } else if (parts[0] === 'props') {
    markNav('props');
    renderProps();
  } else if (parts[0] === 'teams') {
    markNav('teams');
    renderTeams();
  } else if (parts[0] === 'record') {
    markNav('record');
    renderRecord();
  } else {
    markNav('slate');
    renderSlate();
  }
}

function applyTheme(mode) {
  if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
  try { localStorage.setItem('nflsim-theme', mode); } catch (e) { /* private window */ }
  document.getElementById('theme').title = `Theme: ${mode}`;
}

async function boot() {
  let saved = 'auto';
  try { saved = localStorage.getItem('nflsim-theme') || 'auto'; } catch (e) { /* ignore */ }
  applyTheme(saved);
  document.getElementById('theme').addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    let now = 'auto';
    try { now = localStorage.getItem('nflsim-theme') || 'auto'; } catch (e) { /* ignore */ }
    applyTheme(order[(order.indexOf(now) + 1) % order.length]);
  });

  loadSims();
  if (PUBLISHED) {
    try { setPublishedSims((await api('/api/meta')).sims); } catch (err) { /* the slate says it too */ }
  }

  try {
    const meta = await api('/api/weeks');
    state.season = meta.season;
    state.week = meta.week;
    state.seasons = meta.seasons;
    state.weeks = meta.weeks;
    syncSelectors();
  } catch (err) { /* the slate call will surface it */ }

  document.getElementById('season').addEventListener('change', async (e) => {
    state.season = Number(e.target.value);
    const meta = await api('/api/weeks', { season: state.season });
    state.weeks = meta.weeks;
    state.week = Math.min(state.week, Math.max(...meta.weeks));
    syncSelectors();
    location.hash = '#/';
    route();
  });
  document.getElementById('week').addEventListener('change', (e) => {
    state.week = Number(e.target.value);
    location.hash = '#/';
    route();
  });
  document.getElementById('sims').addEventListener('change', (e) => {
    if (PUBLISHED) return;     // the published copy's box picks a count to ask the PC for (static/rerun.js)
    state.sims = Number(e.target.value);
    try { localStorage.setItem(SIMS_KEY, String(state.sims)); } catch (err) { /* private window */ }
    route();
  });
  document.getElementById('refresh').addEventListener('click', async () => {
    setBusy(true, 'Reloading data…');
    try {
      await api('/api/week', { season: state.season, week: state.week,
                               sims: state.sims, fresh: 1 });
    } finally {
      setBusy(false);
      route();
    }
  });

  window.addEventListener('hashchange', route);
  route();
}

boot();
