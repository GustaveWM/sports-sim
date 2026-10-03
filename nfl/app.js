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

async function api(path, params = {}) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function showLoading(message) {
  render(el('p', { class: 'notice', text: message }));
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
/** A histogram with a marker line, plus a table saying the same thing. */
function histogram(bins, opts) {
  const { title, note, colour = 'var(--away)', marker, markerLabel, unit = '' } = opts;
  const W = 620, H = 170, padL = 30, padR = 12, padT = 8, padB = 22;
  const peak = Math.max(...bins.map(b => b.share), 0.0001);
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const step = innerW / bins.length;
  const x = i => padL + i * step;
  const chart = svg('svg', {
    viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': `${title}. ${note || ''}`
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

  if (marker !== null && marker !== undefined) {
    const idx = bins.findIndex(b => b.value >= marker);
    if (idx >= 0) {
      const mx = x(idx) + step / 2;
      chart.appendChild(svg('line', { class: 'marker', x1: mx, x2: mx, y1: padT, y2: padT + innerH }));
      chart.appendChild(svg('text', {
        class: 'marker-label', x: Math.min(mx + 5, W - 60), y: padT + 11
      }, document.createTextNode(markerLabel || String(marker))));
    }
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
  const thead = el('thead', {}, el('tr', {}, headers.map(h => el('th', { text: h }))));
  const tbody = el('tbody', {}, rows.map(r => el('tr', {},
    r.map((cell, i) => {
      if (cell && typeof cell === 'object' && cell.nodeType) return el('td', {}, cell);
      if (cell && typeof cell === 'object') {
        return el('td', { class: cell.class || null, text: cell.text });
      }
      return el('td', { text: cell === null || cell === undefined ? '–' : String(cell) });
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

function gameCard(g) {
  const awayPct = g.away_win, homePct = g.home_win;
  const bar = el('div', { class: 'winbar', role: 'img',
    'aria-label': `${g.away} ${pct(awayPct)} to win, ${g.home} ${pct(homePct)}` },
    el('i', { class: 'a', style: `width:${(awayPct * 100).toFixed(2)}%` }),
    el('i', { class: 'h', style: `width:${(homePct * 100).toFixed(2)}%` }));

  const row = (side, name, qb, score, cls) => el('div', { class: 'teams-row' },
    el('div', {},
      el('div', { class: 'team-name' }, el('i', { class: `swatch ${cls}` }), name),
      el('div', { class: 'team-qb', text: qb || 'starter unknown' })),
    el('div', { class: 'score-big num', text: num(score) }));

  const foot = el('div', { class: 'card-foot' });
  if (g.spread) {
    const edge = g.spread.edge;
    foot.appendChild(el('span', {},
      el('span', { class: 'pill', text: `line ${g.home} ${signed(-g.spread.line, 1)}` }), ' ',
      el('span', { class: 'edge',
        text: `${g.spread.pick} ${pct(Math.max(g.spread.home_cover, g.spread.away_cover))}` })));
  }
  if (g.total_bet) {
    foot.appendChild(el('span', {},
      el('span', { class: 'pill', text: `O/U ${g.total_bet.line}` }), ' ',
      el('span', { class: 'edge',
        text: `${g.total_bet.pick} ${pct(Math.max(g.total_bet.over, g.total_bet.under))}` })));
  }
  foot.appendChild(el('span', { class: 'num', text: `total ${num(g.total)}` }));
  for (const side of [g.away, g.home]) {
    const note = injuryNote(g.injuries, side);
    if (note) foot.appendChild(el('span', { class: 'pill', text: note }));
    // A starter well below (or above) what the team has been playing with moves the line more
    // than anything else in the model, so it is called out on the card.
    const qb = g.qb_edge ? g.qb_edge[side] : null;
    if (qb !== null && qb !== undefined && Math.abs(qb) >= 1.5) {
      foot.appendChild(el('span', { class: `pill${qb < 0 ? ' warn' : ''}`,
        text: `${side} QB ${signed(qb, 1)} pts vs usual` }));
    }
  }

  const dog = underdog(g);
  const tags = el('span', {});
  if (!g.final && dog && state.upsets && state.upsets.has(g.id)) {
    tags.appendChild(el('span', { class: 'tag upset', text: `upset watch: ${dog.team}` }));
  }
  if (g.final) tags.appendChild(el('span', { class: 'tag', text: `final ${g.final_away}-${g.final_home}` }));
  if (g.div_game) tags.appendChild(el('span', { class: 'tag', text: 'division' }));
  if (g.neutral) tags.appendChild(el('span', { class: 'tag', text: 'neutral' }));

  return el('a', { class: 'card game-card', href: `#/game/${encodeURIComponent(g.id)}` },
    el('div', { class: 'when' },
      el('span', { text: `${g.weekday} ${g.gametime} · ${weatherLine(g.weather)}` }), tags),
    row('away', g.away, g.away_qb, g.away_score, 'sw-away'),
    row('home', g.home, g.home_qb, g.home_score, 'sw-home'),
    bar,
    el('div', { class: 'row-between', style: 'font-size:12px;color:var(--ink-2)' },
      el('span', { class: 'num', text: `${g.away} ${pct(awayPct)}` }),
      el('span', { class: 'num', text: `${pct(homePct)} ${g.home}` })),
    g.market_home_win === null || g.market_home_win === undefined ? null :
      el('div', { class: 'row-between market-line' },
        el('span', { class: 'num', text: `market ${pct(1 - g.market_home_win)}` }),
        el('span', { class: 'num', text: `${pct(g.market_home_win)} market` })),
    foot);
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
  return el('section', { class: 'card', style: 'margin-top:14px' },
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
  showLoading('Simulating every game of the week…');
  setBusy(true, 'Simulating the week…');
  try {
    const slate = await api('/api/week', { season: state.season, week: state.week, sims: state.sims });
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
          ? 'Win chances from the power ratings (opponent-adjusted EPA, success rate, points and ' +
            'the starting quarterback); players and score ranges from simulations steered onto ' +
            'the same projected score.'
          : `The power ratings are unavailable (${slate.model_error || 'no data'}), so these ` +
            'numbers come from the play-by-play simulator on its own.') +
        (played.length ? `  Already played: ${right} of ${played.length} picked right.` : '') }));

    state.upsets = new Set(likelyUpsets(slate).slice(0, 3).map(x => x.g.id));
    render(head,
      el('div', { class: 'grid grid-games' }, slate.games.map(gameCard)),
      slate.games.length ? upsetWatch(slate) : null,
      slate.games.length ? bestBets(slate) : el('p', { class: 'notice', text: 'No games this week.' }));
  } catch (err) {
    showError(err);
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
  return el('section', { class: 'card', style: 'margin-top:14px' },
    el('h2', { text: 'Where the model disagrees most with the market' }),
    el('p', { class: 'sub', text:
      'Biggest gaps between the projection and the posted line. These are disagreements, not ' +
      'edges: over 480 out-of-sample games the closing line predicted the margin better than ' +
      'this model (9.8 points of error against 10.2), and disagreeing by three or more points ' +
      'did not win more often. Treat the list as "worth a second look", not as picks.' }),
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

function playerPanel(r, side) {
  const isAway = side === r.game.away;
  const colour = isAway ? 'var(--away)' : 'var(--home)';
  const p = r.players[side];
  const q = p.passing;
  const players = mergePlayers(p);
  const mostTouches = Math.max(...players.map(x => x.touches), 1);

  const qbLine = el('div', { class: 'qb-line' },
    el('div', {},
      el('div', { class: 'player-name', text: q.name }),
      el('div', { class: 'player-sub', text: 'quarterback' })),
    el('div', { class: 'qb-stats num' },
      statChip(`${num(q.completions)}/${num(q.attempts)}`, 'cmp/att'),
      statChip(num(q.yards, 0), 'pass yds'),
      statChip(num(q.td, 2), 'pass TD'),
      statChip(num(q.interceptions, 2), 'INT'),
      statChip(pct(q.p_300_yards), '300+ yds'),
      statChip(pct(q.p_2_td), '2+ TD')));

  const rows = players.map(x => el('div', { class: 'player-row' },
    el('div', { class: 'player-id' },
      el('div', { class: 'player-name', text: x.name }),
      el('div', { class: 'player-sub num', text: [
        x.carries >= 0.4 ? `${num(x.carries)} car` : null,
        x.targets >= 0.4 ? `${num(x.catches)}/${num(x.targets)} rec` : null,
      ].filter(Boolean).join('  ·  ') || 'situational' })),
    el('div', { class: 'player-usage' }, usageBar(x.touches / mostTouches, colour)),
    el('div', { class: 'player-yards num' },
      el('strong', { text: num(x.scrimmage, 0) }),
      el('span', { class: 'player-sub', text: 'scrimmage yds' })),
    el('div', { class: 'player-td num' },
      el('strong', { class: x.p_td >= 0.5 ? 'win' : null, text: pct(x.p_td) }),
      el('span', { class: 'player-sub', text: `TD · ${odds(x.td_odds)}` }))));

  return el('section', { class: 'card' },
    el('h2', {}, el('i', { class: `swatch ${isAway ? 'sw-away' : 'sw-home'}` }), side),
    el('p', { class: 'sub', text:
      `Projected from ${r.sims.toLocaleString()} simulated games. The bar is each player's `
      + 'share of the team’s touches; "TD" is how often they scored, with fair odds beside '
      + 'it. Full markets and custom lines are on the Props tab.' }),
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
  showLoading('Playing this game out ' + state.sims.toLocaleString() + ' times…');
  setBusy(true, 'Simulating…');
  try {
    const [r, qbs] = await Promise.all([
      api('/api/game', { id: gameId, sims: state.sims, season: state.season,
                         week: state.week, ...params }),
      quarterbackList(),
    ]);
    if (!r) {
      render(el('p', { class: 'notice', text: 'That game is not on this week’s slate.' }));
      return;
    }
    const g = r.game;
    const away = g.away, home = g.home;

    const kpis = el('div', { class: 'kpis' },
      kpi(`${away} win`, pct(r.away_win), `fair odds ${odds(r.away_odds)}`),
      kpi(`${home} win`, pct(r.home_win), `fair odds ${odds(r.home_odds)}`),
      kpi('Projected', `${num(r.away_score)} – ${num(r.home_score)}`, `total ${num(r.total)}`),
      kpi('Margin', signed(r.margin), `± ${num(r.margin_sd)} typical swing`),
      kpi('Overtime', pct(r.overtime), 'of simulations'));

    const views = modelVsMarket(r, away, home);
    const marketCards = [];
    if (r.spread) {
      marketCards.push(el('div', { class: 'card' },
        el('h3', { text: 'Against the spread' }),
        el('div', { class: 'kpi' },
          el('div', { class: 'k', text: `market: ${home} ${signed(-r.spread.line)}` }),
          el('div', { class: 'v', text: r.spread.pick }),
          el('div', { class: 'n', text:
            `${pct(Math.max(r.spread.home_cover, r.spread.away_cover))} to cover · ` +
            `model is ${signed(r.spread.edge)} vs the line` }))));
    }
    if (r.total_bet) {
      marketCards.push(el('div', { class: 'card' },
        el('h3', { text: 'Total' }),
        el('div', { class: 'kpi' },
          el('div', { class: 'k', text: `market: ${r.total_bet.line}` }),
          el('div', { class: 'v', text: r.total_bet.pick }),
          el('div', { class: 'n', text:
            `${pct(Math.max(r.total_bet.over, r.total_bet.under))} · ` +
            `model is ${signed(r.total_bet.edge)} vs the line` }))));
    }

    const head = el('div', {},
      el('div', { class: 'page-head' },
        el('a', { class: 'btn', href: '#/', text: '← Slate' }),
        el('h1', { text: `${away} at ${home}` })),
      el('p', { class: 'sub', text:
        `${g.kickoff} · ${g.stadium} (${g.roof}) · ${weatherLine(r.weather)}` +
        (r.weather.indoor ? '' : ` (${r.weather.source})`) +
        ` · ${r.qbs[away]} vs ${r.qbs[home]}` +
        (g.final ? ` · FINAL ${g.away_score}–${g.home_score}` : '')}));

    render(head,
      el('div', { class: 'card' }, kpis),
      views,
      marketCards.length ? el('div', { class: 'grid grid-2', style: 'margin-top:14px' }, marketCards) : null,
      el('div', { class: 'grid grid-2', style: 'margin-top:14px' },
        histogram(r.margin_hist, {
          title: 'Winning margin',
          note: `Positive means ${home} wins. ${r.sims.toLocaleString()} simulations.`,
          colour: 'var(--home)', marker: r.spread ? r.spread.line : null,
          markerLabel: r.spread ? 'spread' : null, unit: '',
          legend: legendFor([['sw-home', `${home} margin`], ['sw-accent', 'market spread']]),
        }),
        histogram(r.total_hist, {
          title: 'Total points',
          note: 'Both teams combined.',
          colour: 'var(--away)', marker: r.total_bet ? r.total_bet.line : null,
          markerLabel: r.total_bet ? 'O/U' : null,
          legend: legendFor([['sw-away', 'combined points'], ['sw-accent', 'market total']]),
        })),
      el('div', { class: 'grid grid-2', style: 'margin-top:14px' },
        histogram(r.away_score_hist, { title: `${away} points`, colour: 'var(--away)' }),
        histogram(r.home_score_hist, { title: `${home} points`, colour: 'var(--home)' })),
      el('section', { class: 'card', style: 'margin-top:14px' },
        el('h2', { text: 'Projected box score' }),
        el('p', { class: 'sub', text: 'The average of every simulated game.' }),
        el('div', { class: 'table-wrap' }, teamStatsTable(r, away, home))),
      el('section', { class: 'card', style: 'margin-top:14px' },
        el('h2', { text: 'Most likely final scores' }),
        el('div', { class: 'table-wrap' }, buildTable(['Score', 'Share of simulations'],
          r.common_scores.map(s => [`${away} ${s.away} – ${s.home} ${home}`, pct(s.share, 2)])))),
      el('div', { class: 'grid grid-2', style: 'margin-top:14px' },
        playerPanel(r, away), playerPanel(r, home)),
      el('div', { style: 'margin-top:14px' }, injuryPanel(r)),
      el('div', { style: 'margin-top:14px' },
        whatIfPanel(gameId, r, qbs)));
    view.focus();
  } catch (err) {
    showError(err);
  } finally {
    setBusy(false);
  }
}

/** The model beside the betting market and the old simulator, and what the number is made of. */
function modelVsMarket(r, away, home) {
  const m = r.model || {};
  if (m.source !== 'power ratings') return null;
  const alone = m.simulator_alone;
  const market = r.market && r.market.home_win;
  const cards = el('div', { class: 'kpis' },
    kpi('Model', `${home} ${pct(r.home_win)}`, `projects ${home} ${signed(r.margin)}`),
    kpi('Betting market', market === null || market === undefined ? '–' : `${home} ${pct(market)}`,
        r.market && r.market.spread !== null ? `line ${home} ${signed(-r.market.spread)}` : 'no line yet'),
    kpi('Simulator on its own', alone ? `${home} ${pct(alone.home_win)}` : '–',
        alone ? `projects ${home} ${signed(alone.margin)}` : ''));
  const why = m.why || {};
  const parts = [['Home field', why.home], ['Play-by-play efficiency (EPA, success rate)',
    (why.d_epa || 0) + (why.d_sr || 0)], ['Points scored and allowed', why.d_pts],
    ['Quarterbacks this week', why.d_qb], ['Rest', why.rest]]
    .filter(([, v]) => v !== undefined && v !== null);
  const table = buildTable(['What moves the line', `Points toward ${home}`],
    parts.map(([label, v]) => [label, { text: signed(v, 1), class: v > 0.05 ? 'win' : (v < -0.05 ? 'loss' : null) }])
      .concat([[{ text: 'Projected margin' }, { text: signed(r.margin, 1) }]]));
  return el('section', { class: 'card', style: 'margin-top:14px' },
    el('h2', { text: 'Model, market and simulator' }),
    el('p', { class: 'sub', text:
      'The model is the power ratings, which beat the simulator on every measure out of sample ' +
      'and set every number on this page. The market is the closing line with the bookmaker’s ' +
      'margin removed; over 480 test games it was still the most accurate of the three.' }),
    cards,
    el('div', { class: 'table-wrap', style: 'margin-top:12px' }, table));
}

function kpi(k, v, n) {
  return el('div', { class: 'kpi' },
    el('div', { class: 'k', text: k }),
    el('div', { class: 'v num', text: v }),
    n ? el('div', { class: 'n', text: n }) : null);
}

/* ------------------------------------------------------------------ props */
const MARKETS = [
  { key: 'anytime_td', label: 'Anytime touchdown', kind: 'td' },
  { key: 'scrimmage', label: 'Rushing + receiving yards', curve: 'over_scrimmage',
    lines: 'yards', projection: 'scrimmage_yards', start: 49.5 },
  { key: 'rush_yards', label: 'Rushing yards', curve: 'over_rush_yards',
    lines: 'yards', projection: 'rush_yards', start: 49.5 },
  { key: 'rec_yards', label: 'Receiving yards', curve: 'over_rec_yards',
    lines: 'yards', projection: 'rec_yards', start: 49.5 },
  { key: 'catches', label: 'Receptions', curve: 'over_catches',
    lines: 'catches', projection: 'catches', start: 3.5 },
  { key: 'carries', label: 'Carries', curve: 'over_carries',
    lines: 'carries', projection: 'carries', start: 11.5 },
  { key: 'pass_yards', label: 'Passing yards', curve: 'over_pass_yards',
    lines: 'pass_yards', projection: 'pass_yards', start: 249.5 },
  { key: 'pass_td', label: 'Passing touchdowns', curve: 'over_pass_td',
    lines: 'pass_td', projection: 'pass_td', start: 1.5 },
  { key: 'interceptions', label: 'Interceptions thrown', curve: 'over_interceptions',
    lines: 'counts', projection: 'interceptions', start: 0.5 },
];

function americanOdds(p) {
  if (!(p > 0 && p < 1)) return null;
  return p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
}

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
    if (filters.position === 'skill' && p.position === 'QB') return false;
    if (filters.position && filters.position !== 'skill'
        && p.position !== filters.position) return false;
    if (needle && !p.player.toLowerCase().includes(needle)) return false;
    return true;
  });
}

function propsTable(data, market, line, filters) {
  const lines = data.lines[market.lines];
  const rows = [];
  for (const p of matching(data.players, filters)) {
    if (market.kind === 'td') {
      if (p.p_td === null || p.p_td === undefined) continue;
      rows.push({ p, chance: p.p_td, projection: null });
      continue;
    }
    if (!p[market.curve]) continue;
    const chance = chanceOver(p, market, lines, line);
    if (chance === null) continue;
    const projection = p[market.projection];
    if (projection !== undefined && projection !== null && projection < 0.2) continue;
    rows.push({ p, chance, projection });
  }
  rows.sort((a, b) => b.chance - a.chance);
  const header = market.kind === 'td'
    ? ['Player', 'Pos', 'Team', 'Game', 'Scores a TD', 'Fair odds', 'Simulations alone']
    : ['Player', 'Pos', 'Team', 'Game', 'Projected', 'Over ' + line, 'Under ' + line,
       'Fair odds on over'];
  return buildTable(header, rows.slice(0, 120).map(function (row) {
    const p = row.p;
    const base = [p.player, p.position, p.team, p.game];
    if (market.kind === 'td') {
      return base.concat([
        { text: pct(row.chance), class: row.chance >= 0.5 ? 'win' : null },
        odds(p.td_odds),
        // What the raw simulations said, before the calibration the backtest showed it needs.
        p.p_td_sim === null || p.p_td_sim === undefined ? '–' : pct(p.p_td_sim)]);
    }
    return base.concat([
      num(row.projection, row.projection >= 20 ? 1 : 2),
      { text: pct(row.chance), class: row.chance >= 0.55 ? 'win' : null },
      pct(1 - row.chance),
      odds(americanOdds(row.chance))]);
  }));
}

async function renderProps() {
  showLoading('Simulating every game and collecting the player markets…');
  setBusy(true, 'Simulating…');
  try {
    const data = await api('/api/props', { season: state.season, week: state.week,
                                           sims: state.sims });
    if (!data.players.length) {
      render(
        el('div', { class: 'page-head' }, el('h1', { text: 'Player props' })),
        el('p', { class: 'notice', text:
          'Every game this week has already kicked off, so there is nothing left to price.' }));
      return;
    }
    let market = MARKETS.find(m => m.key === state.market) || MARKETS[0];
    const games = [...new Set(data.players.map(p => p.game))].sort();
    const teams = [...new Set(data.players.map(p => p.team))].sort();

    const marketSelect = el('select', { class: 'select', id: 'prop-market' },
      MARKETS.map(m => el('option', { value: m.key, text: m.label,
                                      selected: m.key === market.key ? '' : null })));
    const lineInput = el('input', { class: 'input num', type: 'number', step: '0.5',
                                    id: 'prop-line', value: market.start || 49.5 });
    const lineField = el('div', { class: 'field' },
      el('label', { for: 'prop-line', text: 'Line' }), lineInput);
    const gameSelect = el('select', { class: 'select', id: 'prop-game' },
      [el('option', { value: '', text: `All ${games.length} matchups` })].concat(
        games.map(g => el('option', { value: g, text: g }))));
    const teamSelect = el('select', { class: 'select', id: 'prop-team' },
      [el('option', { value: '', text: 'Any team' })].concat(
        teams.map(t => el('option', { value: t, text: t }))));
    const posSelect = el('select', { class: 'select', id: 'prop-pos' },
      [['', 'Any position'], ['skill', 'Skill players only'], ['RB', 'Running backs'],
       ['WR/TE', 'Receivers'], ['QB', 'Quarterbacks']].map(
        ([v, t]) => el('option', { value: v, text: t })));
    const nameInput = el('input', { class: 'input', type: 'search', id: 'prop-name',
                                    placeholder: 'e.g. Nabers' });
    const count = el('span', { class: 'pill' });
    const holder = el('div', { class: 'table-wrap' });

    function draw() {
      market = MARKETS.find(m => m.key === marketSelect.value) || MARKETS[0];
      state.market = market.key;
      const isTd = market.kind === 'td';
      lineInput.disabled = isTd;
      lineField.style.opacity = isTd ? '0.4' : '1';
      let line = Number(lineInput.value);
      if (!Number.isFinite(line)) line = market.start || 49.5;
      const filters = { game: gameSelect.value, team: teamSelect.value,
                        position: posSelect.value, name: nameInput.value };
      // Choosing a matchup and then a team from the other one leaves nothing; say so.
      const table = propsTable(data, market, line, filters);
      const shown = table.querySelectorAll('tbody tr').length;
      count.textContent = shown
        ? `${shown} player${shown === 1 ? '' : 's'}`
        : 'nothing matches these filters';
      holder.replaceChildren(table);
    }
    marketSelect.addEventListener('change', function () {
      const chosen = MARKETS.find(m => m.key === marketSelect.value);
      if (chosen && chosen.start !== undefined) lineInput.value = chosen.start;
      draw();
    });
    for (const control of [lineInput, gameSelect, teamSelect, posSelect, nameInput]) {
      control.addEventListener('input', draw);
      control.addEventListener('change', draw);
    }

    render(
      el('div', { class: 'page-head' },
        el('h1', { text: 'Player props' }),
        el('span', { class: 'pill', text: data.season + ' week ' + data.week }),
        el('span', { class: 'pill',
                     text: data.sims.toLocaleString() + ' sims per game' })),
      el('p', { class: 'sub', text:
        'How often each player cleared the line across every simulated game, with every game '
        + 'steered onto the power ratings’ projected score. Touchdown odds are then corrected '
        + 'for the simulator being too sure of itself, which the props backtest measured; the raw '
        + 'simulation number is shown beside them. Games already kicked off are left out. Nothing '
        + 'free publishes player props, so there is no market column here to compare against — '
        + 'these are the model’s own numbers, to hold up against whatever a book is offering. '
        + 'How they have held up is on the Record page.' }),
      el('section', { class: 'card' },
        el('div', { class: 'whatif', style: 'grid-template-columns:repeat(auto-fit,minmax(150px,1fr))' },
          el('div', { class: 'field' },
            el('label', { for: 'prop-market', text: 'Market' }), marketSelect),
          lineField,
          el('div', { class: 'field' },
            el('label', { for: 'prop-game', text: 'Matchup' }), gameSelect),
          el('div', { class: 'field' },
            el('label', { for: 'prop-team', text: 'Team' }), teamSelect),
          el('div', { class: 'field' },
            el('label', { for: 'prop-pos', text: 'Position' }), posSelect),
          el('div', { class: 'field' },
            el('label', { for: 'prop-name', text: 'Player' }), nameInput)),
        el('p', { class: 'sub', style: 'margin:12px 0 0', text:
          'Fair odds are what the probability is worth with no juice taken out. A book pricing '
          + 'it shorter than that is, by this model, offering a bad number.' })),
      el('section', { class: 'card', style: 'margin-top:14px' },
        el('div', { class: 'row-between', style: 'margin-bottom:8px' },
          el('h2', { style: 'margin:0', text: 'Priced by the model' }), count),
        holder));
    draw();
  } catch (err) {
    showError(err);
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
      el('div', { class: 'page-head', style: 'margin-top:22px' }, el('h2', { text: 'Simulator inputs' })),
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
  const split = years.length < 2 ? null : el('div', { class: 'table-wrap', style: 'margin-top:14px' },
    buildTable(['Season', 'Games', 'Straight up', 'Rate', 'ATS', 'Brier', 'Margin err', 'The line'],
      years.map(y => {
        const m = b.by_season[y];
        return [y, m.games, `${m.straight_up.wins}–${m.straight_up.losses}`,
          pct(m.straight_up.rate),
          m.spread ? pct(m.spread.rate) : '–', num(m.brier, 3),
          num(m.margin_mae, 2), num(m.market_margin_mae, 2)];
      }), { caption: 'Each season on its own' }));

  const comparison = (b.comparison || []).length ? el('div', { class: 'table-wrap', style: 'margin-top:14px' },
    buildTable(['', 'Games', 'Straight up', 'Brier', 'Log loss', 'Margin err', 'Total err', 'ATS'],
      b.comparison.map(c => [c.label, c.games, pct(c.su), num(c.brier, 3), num(c.logloss, 3),
        num(c.mae, 2), num(c.total_mae, 2), c.ats === undefined ? '–' : pct(c.ats)]),
      { caption: 'The same games, three ways (lower is better except straight up and ATS)' })) : null;

  const u = b.upsets;
  const upsets = u ? el('div', { class: 'table-wrap', style: 'margin-top:14px' },
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
      { caption: 'This season, live' })));
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
        ? el('div', { style: 'margin-top:14px' }, predictedVsActual(d.scatter, {
            note: `Every graded game. ${d.games} of them, `
                  + `${pct(d.straight_up ? d.straight_up.rate : 0)} with the right winner.` }))
        : el('section', { class: 'card', style: 'margin-top:14px' },
            el('h2', { text: 'Predicted against actual' }),
            el('p', { class: 'sub', text:
              'Nothing graded yet. Each game becomes a dot here once it has been played.' })),
      (d.seasons && d.seasons.length) ? el('div', { style: 'margin-top:14px' },
        seasonTable(d.seasons)) : null,
      el('div', { class: 'grid grid-2', style: 'margin-top:14px' },
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
      el('div', { style: 'margin-top:14px' }, headToHead(d)),
      el('div', { style: 'margin-top:14px' }, propsHonesty(d)),
      el('div', { style: 'margin-top:14px' }, backtestPanel(d.backtest)),
      el('section', { class: 'card', style: 'margin-top:14px' },
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
    state.sims = Number(e.target.value);
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
