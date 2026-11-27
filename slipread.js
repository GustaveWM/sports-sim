/* Reads a slip from text: which leg on the board each line is.

   The Parlays page hands this the text of a picture (read on the device) or lines someone typed, and the legs it already holds, and gets
   back the legs it found and the lines it could not place. There is no page in here, so the same file runs under node (the tests).
   Edit web/slipread.js; publish.py copies it to the site.

     const index = SlipRead.makeIndex([{ sport: 'nba', legs: [...], names: { BOS: 'Boston Celtics', ... } }, ...]);
     const { found, missed } = SlipRead.readSlip(text, index);
     found:  [{ text, leg, how, at }]        how: 'name' | 'misread' (a letter or two off) | 'surname' (surname only); at: its place in the text
     missed: [{ text, why, near: [leg...], want, at }]
             a line that looked like a bet and was not placed, with the closest lines the board does have. `want` (or null) is what a page that can price any
             line from a game's own numbers needs for a bet the board does not list at that line:
             { kind: 'player' | 'team_total' | 'spread' | 'total', line, side, stat (a player's), base: a leg of that game on the board }
*/
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ text
  const fold = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’‛ʼ`´]/g, "'").replace(/[−–—‒]/g, '-').toLowerCase();
  // The words of a name or a line, as letters and digits only: "Day’'Ron" is "dayron", "Karl-Anthony" is "karl anthony".
  const TOKEN = /[a-z0-9']*[a-z0-9][a-z0-9']*/g;
  function tokens(f) {
    const out = [];
    let m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(f))) out.push({ w: m[0].replace(/'/g, ''), start: m.index, end: m.index + m[0].length });
    return out;
  }
  const wordsOf = s => tokens(fold(s)).map(t => t.w);
  // Suffixes a picture drops or misreads: "Jr.", "III" (which comes back "Ill" or "lll").
  const SUFFIX = /^(?:jr|ir|sr|iv|v|[il]{2,4})$/;
  const bare = ws => { const w = ws.slice(); while (w.length > 2 && SUFFIX.test(w[w.length - 1])) w.pop(); return w; };

  // The edit distance between two strings, or max + 1 once it is certain to be over.
  function distance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let low = i;
      for (let j = 1; j <= b.length; j++) {
        const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        cur.push(v);
        if (v < low) low = v;
      }
      if (low > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  // ------------------------------------------------------------------ the board
  // The player is everything in a label before the bet starts (the same cut the Parlays page uses, and "no INT" too).
  const PLAYER_TAIL = / \(| (?:over|under)\b| \d+(?:\+| or fewer)| (?:anytime|throws|home run|stolen base|double-double|triple-double|no int)\b/i;
  const GAME_MARKETS = new Set(['ML', 'SPREAD', 'ALT_SPREAD', 'TOTAL', 'ALT_TOTAL', 'TEAM_TOTAL', 'H1_ML', 'H1_SPREAD', 'H1_TOTAL', 'TEAM_H1',
                                'F5_ML', 'F5_TOTAL', 'RUNLINE', 'NRFI']);
  const TWO_WORD_NICKNAMES = new Set(['trail blazers', 'red sox', 'white sox', 'blue jays', 'golden knights', 'maple leafs', 'blue jackets',
                                      'red wings', 'red devils', 'tar heels', 'blue devils', 'fighting irish', 'crimson tide', 'golden bears']);

  /** sports: [{ sport, legs, names }] - every leg on the board and its sport's team names ({ BOS: 'Boston Celtics' }). */
  function makeIndex(sports) {
    const byName = new Map();          // "jalen brunson" -> [player]   (a player: { name, sport, team, legs })
    const byLast = new Map();          // "brunson" -> [player]
    const players = new Map();         // "nba|jalen brunson" -> player
    const teams = new Map();           // "celtics" -> [{ sport, code }]
    const codes = new Map();           // "bos" -> [{ sport, code }]
    const gameLegs = [];
    const have = new Set();
    for (const s of sports) {
      for (const l of s.legs || []) {
        if (l.team) have.add(s.sport + '|' + l.team);
        if (GAME_MARKETS.has(l.market)) { gameLegs.push(l); continue; }
        const who = String(l.label || '').split(PLAYER_TAIL)[0].trim();
        if (!who || who === l.label) continue;
        const ws = bare(wordsOf(who));
        if (ws.length < 2) continue;
        const key = ws.join(' ');
        const pk = s.sport + '|' + key;
        let p = players.get(pk);
        if (!p) {
          p = { name: who, sport: s.sport, team: l.team || null, key, last: ws[ws.length - 1], legs: [] };
          players.set(pk, p);
          (byName.get(key) || byName.set(key, []).get(key)).push(p);
          (byLast.get(p.last) || byLast.set(p.last, []).get(p.last)).push(p);
        }
        p.legs.push(l);
      }
      const names = s.names || {};
      const codesHere = new Set(Object.keys(names));
      for (const l of s.legs || []) {
        if (l.team) codesHere.add(l.team);
        for (const c of String(l.game || '').split(/\s*@\s*|\//)) if (/^[A-Z0-9()-]{2,6}$/.test(c.trim())) codesHere.add(c.trim());
      }
      for (const code of codesHere) {
        const entry = { sport: s.sport, code };
        (codes.get(code.toLowerCase()) || codes.set(code.toLowerCase(), []).get(code.toLowerCase())).push(entry);
        const ws = wordsOf(names[code] || '');
        if (!ws.length) continue;
        const keys = new Set([ws.join(' ')]);
        if (ws.length >= 2) keys.add(ws[ws.length - 1]);
        if (ws.length >= 3 && TWO_WORD_NICKNAMES.has(ws.slice(-2).join(' '))) keys.add(ws.slice(-2).join(' '));
        for (const k of keys) (teams.get(k) || teams.set(k, []).get(k)).push(entry);
      }
    }
    return { byName, byLast, players, teams, codes, gameLegs, nameKeys: [...byName.keys()], have };
  }

  // ------------------------------------------------------------------ what a bet says
  const W = { pts: '(?:pts?|points?)', reb: '(?:rebs?|rebounds?)', ast: '(?:asts?|assists?)', stl: '(?:stls?|steals?)', blk: '(?:blks?|blocks?)' };
  const JOIN = '\\s*(?:\\+|&|and|plus)\\s*';
  const sum = (...ws) => new RegExp('\\b' + ws.map(w => W[w]).join(JOIN) + '\\b');
  // The stat a line names, most specific first (a sum holds the plain words).
  const STATS = [
    ['pra', sum('pts', 'reb', 'ast')], ['pr', sum('pts', 'reb')], ['pa', sum('pts', 'ast')], ['ra', sum('reb', 'ast')], ['stlblk', sum('stl', 'blk')],
    ['hrr', /\bhits\s*(?:\+|&|and)\s*runs\s*(?:\+|&|and)\s*rbis?\b/],
    ['td3', /\btriple[\s-]*doubles?\b/], ['dd', /\bdouble[\s-]*doubles?\b/],
    ['tpm', /\b(?:3|three)[\s-]*(?:pt|pts|pointers?|points?)(?:\s*made)?\b|\bthrees?\b|\b3s\b/],
    ['pts', new RegExp('\\b' + W.pts + '\\b')], ['reb', new RegExp('\\b' + W.reb + '\\b')], ['ast', new RegExp('\\b' + W.ast + '\\b')],
    ['stl', new RegExp('\\b' + W.stl + '\\b')], ['blk', new RegExp('\\b' + W.blk + '\\b')],
    ['scrim_yds', /\brush(?:ing)?\s*(?:\+|&|and)\s*rec(?:eiving)?(?:\s*(?:yds?|yards?))?\b/],
    ['pass_td', /\bpass(?:ing)?\s*(?:tds?|touchdowns?)\b/],
    ['pass_yds', /\bpass(?:ing)?\s*(?:yds?|yards?)\b/], ['rush_yds', /\brush(?:ing)?\s*(?:yds?|yards?)\b/], ['rec_yds', /\brec(?:eiving)?\s*(?:yds?|yards?)\b/],
    ['car', /\b(?:rush(?:ing)?\s*attempts?|carries)\b/], ['comp', /\b(?:pass\s*)?completions?\b/], ['att', /\bpass\s*attempts?\b/],
    ['rec', /\breceptions?\b/], ['int', /\b(?:interceptions?(?:\s*thrown)?|int)\b/],
    ['td', /\b(?:anytime\s*)?(?:tds?|touchdowns?)(?:\s*scorer)?\b|\bto score a touchdown\b/],
    ['k', /\bstrikeouts?\b/], ['outs', /\bouts\s*recorded\b/], ['ha', /\bhits\s*allowed\b/], ['er', /\bearned\s*runs?\s*allowed\b/],
    ['pbb', /\bwalks\s*allowed\b/], ['hr', /\bhome\s*runs?\b/], ['tb', /\btotal\s*bases\b/], ['rbi', /\brbis?\b/], ['sb', /\bstolen\s*bases?\b/],
    ['r', /\bruns\s*scored\b/], ['h', /\bhits\b/],
  ];
  const NO_NUMBER = new Set(['dd', 'td3', 'td', 'int', 'hr', 'sb']);   // "double double", "anytime touchdown", "no INT": a line of 0.5 with nothing written
  const ODDS = /(^|\s)[+-]\s?\d{3,5}(?=\s|$)/g;                  // -115, +1200: a price, never a line
  // The words a bet is written in. A word a picture misread by a letter (Rebounas, Assits) is put right before the line is looked up.
  const VOCAB = ['points', 'rebounds', 'assists', 'steals', 'blocks', 'threes', 'pointers', 'double', 'triple', 'rushing', 'receiving', 'passing',
                 'yards', 'receptions', 'completions', 'attempts', 'carries', 'touchdown', 'touchdowns', 'interceptions', 'thrown', 'anytime', 'scorer',
                 'moneyline', 'spread', 'total', 'strikeouts', 'recorded', 'allowed', 'stolen', 'bases'];
  const VOCAB_SET = new Set(VOCAB);
  const WORD_OK = new Set(['point', 'rebound', 'assist', 'steal', 'block', 'three', 'pointer', 'carry', 'strikeout', 'base', 'yard', 'reception', 'completion',
                           'attempt', 'interception', 'touch', 'total', 'rush', 'pass', 'score', 'record', 'player', 'made', 'alternate', 'first', 'game']);
  function repair(t) {
    return t.replace(/[a-z]{5,}/g, w => {
      if (VOCAB_SET.has(w) || WORD_OK.has(w)) return w;
      const tol = w.length >= 8 ? 2 : 1;
      let best = null;
      for (const v of VOCAB) {
        if (Math.abs(v.length - w.length) > tol) continue;
        const d = distance(w, v, tol);
        if (d <= tol && (!best || d < best.d)) best = { v, d };
      }
      return best ? best.v : w;
    });
  }
  // "O/U" ends a DraftKings line (a picture may give "o/uU"): it names no line, so it goes before it can be taken for "o" or "u" and a number.
  // The period an abbreviation carries is not part of the word: "Rec. Yards" is "rec yards" ("39.5" has digits on both sides of its point, so it stays).
  const ABBREV = /\b([a-z]{2,6})\.(?=\s|$)/g;
  const clean = f => repair(f.replace(ODDS, ' ').replace(/\bo\/u+\b/g, ' ').replace(/(\d),(\d)\b(?!\d)/g, '$1.$2').replace(ABBREV, '$1').replace(/\s+/g, ' ').trim());
  // What a stat is called on the board, for telling someone what the board has when a line names none it knows.
  const STAT_WORDS = { pts: 'points', reb: 'rebounds', ast: 'assists', tpm: 'threes', stl: 'steals', blk: 'blocks', pra: 'points + rebounds + assists', pr: 'points + rebounds',
                       pa: 'points + assists', ra: 'rebounds + assists', stlblk: 'steals + blocks', dd: 'double-double', td3: 'triple-double', pass_yds: 'passing yards',
                       rush_yds: 'rushing yards', rec_yds: 'receiving yards', scrim_yds: 'rushing + receiving yards', rec: 'receptions', car: 'carries', comp: 'completions',
                       att: 'pass attempts', pass_td: 'passing TDs', int: 'interceptions', td: 'touchdowns', k: 'strikeouts', outs: 'outs recorded', ha: 'hits allowed',
                       er: 'earned runs', pbb: 'walks allowed', hr: 'home runs', tb: 'total bases', rbi: 'RBIs', sb: 'stolen bases', r: 'runs', h: 'hits', hrr: 'hits + runs + RBIs' };
  const OVER_UNDER = /\b(over|under|o|u)\s*(\d+(?:\.\d+)?)\b/;
  const PLUS = /(\d+(?:\.\d+)?)\s*\+(?!\s*\d{3,5}\b)/;                // "25+", not "24.5 +120" (a price)
  const same = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;

  function statOf(t) {
    for (const [s, re] of STATS) if (re.test(t)) return s;
    return null;
  }
  // The line and side a text asks for: "25+" is over 24.5, "Over 24.5" and "O 24.5" are what they say.
  function lineOf(t) {
    const a = OVER_UNDER.exec(t), b = PLUS.exec(t);
    if (a && (!b || a.index <= b.index)) return { line: Number(a[2]), side: a[1][0] === 'u' ? 'under' : 'over', how: 'ou' };
    if (b) return { line: Number(b[1]) - 0.5, side: 'over', how: 'plus' };
    return null;
  }
  const dangling = f => /(?:\+|&|\band|\bplus)\s*$/.test(clean(f));        // "Points +" - the stat goes on to the next line
  const continues = f => /^\s*(?:\+|&|and\b|plus\b)/.test(f);

  // ------------------------------------------------------------------ players in a line
  function playersIn(L, index) {
    const ws = L.tok.map(t => t.w);
    const taken = [];
    const free = (i, j) => taken.every(r => j <= r.i || i >= r.j);
    const out = [];
    for (let n = Math.min(4, ws.length); n >= 2; n--) {
      for (let i = 0; i + n <= ws.length; i++) {
        if (!free(i, i + n)) continue;
        const key = bare(ws.slice(i, i + n)).join(' ');
        const hit = index.byName.get(key);
        if (hit) { out.push({ i, j: i + n, players: hit, how: 'name' }); taken.push({ i, j: i + n }); }
      }
    }
    if (out.length) return out;
    if (!L.evidence) return out;
    // a letter or two off (a picture misreads): the closest name that is near enough
    let best = null;
    for (let n = Math.min(4, ws.length); n >= 2; n--) {
      for (let i = 0; i + n <= ws.length; i++) {
        const cand = bare(ws.slice(i, i + n)).join(' ');
        if (cand.length < 7) continue;
        const tol = cand.length >= 16 ? 2 : cand.length >= 9 ? 1 : 0;
        if (!tol) continue;
        for (const key of index.nameKeys) {
          const d = distance(cand, key, tol);
          if (d <= tol && (!best || d < best.d || (d === best.d && n > best.n))) best = { d, n, i, j: i + n, players: index.byName.get(key) };
        }
      }
    }
    if (best) return [{ i: best.i, j: best.j, players: best.players, how: 'misread' }];
    // the surname alone, if only one player on the board has it (or the first initial settles it); a word that is part of a team's name on the
    // line ("Washington" in "Washington Wizards", "Boston" in "Boston Celtics") is the team's
    const inTeam = new Set();
    for (const e of teamsIn(L, index)) if (e.via === 'name') for (let q = e.ti; q < e.ti + e.n; q++) inTeam.add(q);
    for (let i = 0; i < ws.length; i++) {
      if (ws[i].length < 4 || inTeam.has(i)) continue;
      const hit = index.byLast.get(ws[i]);
      if (!hit) continue;
      let ps = hit;
      const before = ws[i - 1];
      if (ps.length > 1 && before && before.length <= 2) ps = ps.filter(p => p.name[0].toLowerCase() === before[0]);
      if (ps.length === 1) return [{ i, j: i + 1, players: ps, how: 'surname' }];
      if (ps.length > 1) return [{ i, j: i + 1, players: ps, how: 'surname', ambiguous: true }];
    }
    return out;
  }

  // ------------------------------------------------------------------ teams in a line
  function teamsIn(L, index) {
    const padded = ' ' + L.tok.map(t => t.w).join(' ') + ' ';
    const found = [];
    const spans = [];
    const keys = [...index.teams.keys()].sort((a, b) => b.length - a.length);       // the full name before its nickname
    for (const k of keys) {
      const at = padded.indexOf(' ' + k + ' ');
      if (at < 0) continue;
      if (spans.some(s => at >= s[0] && at < s[1] - 1)) continue;          // inside a name already found; one that starts right after it (it shares the space) is another team
      spans.push([at, at + k.length + 2]);
      const ti = (padded.slice(0, at).match(/ /g) || []).length;                       // the word the name starts at, and how many words it has
      for (const e of index.teams.get(k)) if (index.have.has(e.sport + '|' + e.code)) found.push({ ...e, at, ti, n: k.split(' ').length, via: 'name' });
    }
    // codes: only as capitals in the line itself (BOS, NYK), the way a game line or a typed line writes them
    const coded = new Set();
    for (const m of L.raw.matchAll(/\b[A-Z][A-Z0-9&]{1,4}\b/g)) {            // (TA&M is Texas A&M's)
      for (const e of index.codes.get(m[0].toLowerCase()) || []) {
        if (!index.have.has(e.sport + '|' + e.code)) continue;
        coded.add(e.sport + '|' + e.code);
        if (!found.some(x => x.sport === e.sport && x.code === e.code)) found.push({ ...e, at: m.index, via: 'code' });
      }
    }
    // A nickname that a dozen schools share ("Pirates", "Wildcats") is the one whose code stands beside it: "HAMP Pirates @ GT Jackets".
    if (coded.size) {
      const groups = new Map();
      for (const e of found) if (e.via === 'name') (groups.get(e.at) || groups.set(e.at, []).get(e.at)).push(e);
      for (const list of groups.values()) {
        const keep = list.filter(e => coded.has(e.sport + '|' + e.code));
        if (keep.length && keep.length < list.length) for (const e of list) if (!keep.includes(e)) found.splice(found.indexOf(e), 1);
      }
    }
    return found.sort((a, b) => a.at - b.at);
  }

  // One leg out of the ones that fit. The game line under a bet narrows them; a team that plays on two days of the board (a moneyline
  // tonight and another on the 4th) takes the earlier game, and says the later is there too.
  function choose(cands, gameTeams) {
    let list = cands;
    if (gameTeams && gameTeams.length >= 2) {
      const codes = gameTeams.map(e => e.code);
      const g = list.filter(l => codes.every(c => String(l.game).split(' @ ').includes(c)));
      if (g.length) list = g;
    }
    if (list.length > 1 && new Set(list.map(l => l.gid + '|' + l.date)).size === 1) {          // the same game: its main line over an alternate
      const main = list.filter(l => !/^ALT_/.test(l.market));
      if (main.length) list = main;
    }
    if (list.length === 1) return { leg: list[0] };
    const when = l => String(l.date || '');
    const sorted = list.slice().sort((a, b) => when(a).localeCompare(when(b)));
    if (sorted.length > 1 && when(sorted[0]) !== when(sorted[1])) {
      const later = [...new Set(sorted.slice(1).map(when))].filter(Boolean);
      return { leg: sorted[0], note: later.length ? `Also on the board for ${later.join(', ')}` : null };
    }
    return null;
  }

  // A leg of the game a line is about, for a bet the board does not list at that line: the page prices it from that game's own numbers (the one the game line or heading
  // names, else the earliest game the team or player has on the board).
  function baseOf(list, gameTeams) {
    let pool = list;
    if (gameTeams && gameTeams.length >= 2) {
      const codes = gameTeams.map(e => e.code);
      const g = pool.filter(l => codes.every(c => String(l.game).split(' @ ').includes(c)));
      if (g.length) pool = g;
    }
    return pool.slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))[0] || null;
  }

  // The teams of a game line ("BKN Nets @ HOU Rockets"): when a nickname is a pro team and a college team too, the sport that has TWO of the line's teams is the game.
  function gameTeamsOf(entries) {
    const named = new Set(entries.filter(e => e.via === 'name').map(e => e.sport));      // a team called by name outranks one that only has its code in the line
    if (named.size) entries = entries.filter(e => named.has(e.sport));
    const bySport = new Map();
    for (const e of entries) (bySport.get(e.sport) || bySport.set(e.sport, []).get(e.sport)).push(e);
    const both = [...bySport.values()].filter(list => new Set(list.map(e => e.code)).size >= 2);
    if (both.length > 1) {
      const byName = list => new Set(list.filter(e => e.via === 'name').map(e => e.code)).size;
      const best = Math.max(...both.map(byName));
      const top = both.filter(list => byName(list) === best);
      if (top.length === 1) return top[0];
    }
    return both.length === 1 ? both[0] : entries;
  }

  // ------------------------------------------------------------------ reading
  const CHROME = /^(?:betslip|bet slip|single|parlay|round robin|total odds|stake|wager|to win|payout|place bet|same game parlay|sgp|my bets|cash out|open|settled|odds|boost|login)\b/i;
  function readSlip(text, index) {
    const lines = String(text == null ? '' : text).split(/\r?\n/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).map(raw => {
      const f = fold(raw);
      const L = { raw, f, c: clean(f), tok: tokens(f), used: false, at: raw.includes('@') || /\bvs\.?\b/.test(f) };
      L.lineish = OVER_UNDER.test(L.c) || PLUS.test(L.c);
      L.evidence = L.lineish || statOf(L.c) !== null || ODDS.test(f);
      ODDS.lastIndex = 0;
      return L;
    });
    for (const L of lines) L.players = L.at && !L.lineish ? [] : playersIn(L, index);
    // DraftKings groups legs under their game: "CHI Bulls @ PHI 76ers · Today 7:40 PM" is a heading (an "@" and a clock time), and what comes after it is about that game
    // until the next heading. A game line with no time on it (under a leg, in a typed list) belongs to the leg above it, as before.
    let above = null;
    for (const L of lines) {
      L.heading = L.at && /\b\d{1,2}:\d{2}\s*[ap]m\b/i.test(L.raw);
      L.ctx = above;
      if (L.heading) above = gameTeamsOf(teamsIn(L, index));
    }
    const results = [];                                             // in the order they come

    // ---- a player's bet: his line, and the lines under it until it is complete
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      if (L.used || !L.players.length) continue;
      const P = L.players[0];
      const win = [L];
      // what a line says about the bet is on both sides of the name: "Over 3.5 | Tyrese Maxey Rebounds O/U" (DraftKings' own slip) or "Tyrese Maxey over 3.5 rebounds"
      const nameAt = L.tok[P.i].start, nameEnd = L.tok[P.j - 1].end;
      const tailOf = (X, k) => (k === 0 ? `${X.f.slice(0, nameAt)} ${X.f.slice(nameEnd)}` : X.f);
      const textOf = () => clean(win.map((X, k) => tailOf(X, k)).join(' '));
      for (let j = i; ; j++) {
        const t = textOf();
        const stat = statOf(t), ln = lineOf(t);
        const done = stat && (ln || NO_NUMBER.has(stat));
        const last = win[win.length - 1];
        const next = lines[j + 1];
        const more = !done || dangling(last.f) || (next && continues(next.f));
        if (!more || !next || next.players.length || next.used || next.heading || win.length >= 4) break;
        win.push(next);
      }
      win.forEach(X => { X.used = true; });
      const t = textOf();
      const stat = statOf(t);
      let ln = lineOf(t);
      if (!ln && stat && NO_NUMBER.has(stat)) ln = { line: 0.5, side: stat === 'int' && /\b(?:no|not|without)\b/.test(t) ? 'under' : 'over', how: 'none' };
      const shown = win.map(X => X.raw).join(' ');
      // A surname that is also a school ("Boston College Eagles -19.5") with no stat on the line is a team's bet, which the team pass below reads.
      if (!stat && P.how === 'surname' && win.some(X => teamsIn(X, index).length)) { win.forEach(X => { X.used = false; }); L.players = []; continue; }
      if (P.ambiguous) { results.push({ at: i, miss: { text: shown, why: `Which ${P.players[0].last}? ${P.players.map(p => p.name).join(', ')}`, near: [] } }); continue; }
      if (!stat) {
        const has = [...new Set(P.players.flatMap(p => p.legs.map(l => l.stat)).filter(Boolean))].map(s => STAT_WORDS[s] || s);
        results.push({ at: i, miss: { text: shown, why: 'No stat found on this line' + (has.length ? ` (the board has ${P.players[0].name}: ${has.join(', ')})` : ''), near: [] } });
        continue;
      }
      if (!ln) { results.push({ at: i, miss: { text: shown, why: 'No line found on this line', near: [] } }); continue; }
      let legs = [];
      for (const p of P.players) legs = legs.concat(p.legs.filter(l => l.stat === stat));
      const exact = legs.filter(l => l.line != null && same(l.line, ln.line) && (l.side === 'under' ? 'under' : 'over') === ln.side);
      if (exact.length) {
        const gl = win.find(X => X.at);
        const one = choose(exact, gl ? gameTeamsOf(teamsIn(gl, index)) : L.ctx);
        if (one) results.push({ at: i, ok: { text: shown, leg: one.leg, how: P.how, note: one.note || null } });
        else results.push({ at: i, miss: { text: shown, why: 'More than one line on the board fits this', near: exact.slice(0, 3) } });
        continue;
      }
      const sideLegs = legs.filter(l => (l.side === 'under' ? 'under' : 'over') === ln.side)
        .sort((a, b) => Math.abs(a.line - ln.line) - Math.abs(b.line - ln.line)).slice(0, 3);
      // `want`: what the page prices when the board has no such line (the player, his game, the stat and the line asked for)
      const gl2 = win.find(X => X.at);
      const base = baseOf(legs.length ? legs : P.players.flatMap(p => p.legs), gl2 ? gameTeamsOf(teamsIn(gl2, index)) : L.ctx);
      results.push({ at: i, miss: { text: shown, why: legs.length ? 'That line is not on the board' : `${P.players[0].name} has no ${STAT_WORDS[stat] || stat} line on the board`, near: sideLegs,
                                    want: base ? { kind: 'player', stat, line: ln.line, side: ln.side, base } : null } });
    }

    // ---- a team's bet: moneyline, spread, or a game total
    const GAME_TOTAL = /\b(?:game\s+)?total\s*(?:points|pts|runs)?\b/g;                     // "Total Points" is the bet, not a player's stat
    const isTotalStart = X => X.lineish && !statOf(X.c.replace(GAME_TOTAL, ' ')) && OVER_UNDER.test(X.c);
    const side = l => (l.side === 'under' ? 'under' : 'over');
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      if (L.used || L.players.length) continue;
      // a bet starts at a team's name, or at "Over 220.5" (the game it is for comes on the line below, or on this one)
      if (!(L.at ? [] : teamsIn(L, index)).length && !isTotalStart(L)) continue;
      const win = [L];
      for (let j = i; win.length < 4; j++) {
        const next = lines[j + 1];
        if (!next || next.used || next.players.length || next.heading || win[win.length - 1].at) break;
        if (!next.at && ((teamsIn(next, index).length) || isTotalStart(next))) break;          // the next bet starts here
        win.push(next);
      }
      win.forEach(X => { X.used = true; });
      const shown = win.map(X => X.raw).join(' ');
      const t = clean(win.map(X => X.f).join(' '));
      const gameLine = win.find(X => X.at);
      let gameTeams = gameLine ? gameTeamsOf(teamsIn(gameLine, index)) : [];
      if (gameTeams.length < 2 && L.ctx && L.ctx.length >= 2) gameTeams = L.ctx;          // no game line of its own: the heading above says which game
      const said = win.filter(X => !X.at).map(X => teamsIn(X, index)).find(a => a.length) || [];
      const first = said.filter(e => e.at === said[0].at);                       // one team, or the same nickname in two sports
      const total = lineOf(t);
      const spread = /(^|\s)([+-])\s?(\d+(?:\.\d+)?)(?![\d.]*\s*\+)/.exec(t.replace(OVER_UNDER, ' '));
      const ml = /\b(?:moneyline|money line|ml)\b|\bto win\b/.test(t);
      const teamTotal = /\bteam total\b/.test(t);
      const sports = new Set(first.concat(gameTeams).map(e => e.sport));
      const board = names => index.gameLegs.filter(l => names.includes(l.market) && sports.has(l.sport));
      const mine = l => first.some(e => e.sport === l.sport && e.code === l.team);
      let cands = [], why = 'Not on the board', near = [], want = null;
      const closest = (list, line, wantSide) => list.filter(l => !wantSide || side(l) === wantSide).sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line)).slice(0, 3);
      if (total && !teamTotal && (gameTeams.length >= 2 || !first.length || /\btotal\b/.test(t))) {
        const codes = (gameTeams.length >= 2 ? gameTeams : said).map(e => e.code);
        const all = codes.length >= 2 ? board(['TOTAL', 'ALT_TOTAL']).filter(l => codes.every(c => String(l.game).split(' @ ').includes(c))) : [];
        cands = all.filter(l => same(l.line, total.line) && side(l) === total.side);
        near = closest(all, total.line, total.side);
        why = codes.length < 2 ? 'Which game is this total for?' : 'That total is not on the board';
        want = all.length ? { kind: 'total', line: total.line, side: total.side, base: baseOf(all, gameTeams) } : null;
      } else if (first.length && teamTotal && total) {
        const tts = board(['TEAM_TOTAL']).filter(mine);
        cands = tts.filter(l => same(l.line, total.line) && side(l) === total.side);
        near = closest(tts, total.line, total.side);
        why = 'That team total is not on the board';
        want = tts.length ? { kind: 'team_total', line: total.line, side: total.side, base: baseOf(tts, gameTeams) } : null;
      } else if (first.length && spread && !ml) {
        const line = (spread[2] === '-' ? -1 : 1) * Number(spread[3]);
        const all = board(['SPREAD', 'ALT_SPREAD']).filter(mine);
        cands = all.filter(l => same(l.line, line));
        near = closest(all, line);
        why = 'That spread is not on the board';
        want = all.length ? { kind: 'spread', line, base: baseOf(all, gameTeams) } : null;
      } else if (first.length) {
        cands = board(['ML']).filter(mine);
        why = 'That moneyline is not on the board';
      } else continue;
      const one = cands.length ? choose(cands, gameTeams) : null;
      if (one) results.push({ at: i, ok: { text: shown, leg: one.leg, how: 'name', note: one.note || null } });
      else results.push({ at: i, miss: { text: shown, why: cands.length ? 'More than one line on the board fits this' : why, near: cands.length ? cands.slice(0, 3) : near, want: cands.length ? null : want } });
    }

    // ---- anything else that reads like a bet and was not placed
    lines.forEach((L, i) => {
      if (L.used || CHROME.test(L.f) || L.at) return;
      const words = L.tok.filter(t => /^[a-z]{3,}$/.test(t.w));
      if (words.length >= 2 && (L.lineish || statOf(L.c))) results.push({ at: i, miss: { text: L.raw, why: 'Not on tonight’s board', near: [] } });
    });

    results.sort((a, b) => a.at - b.at);
    return { found: results.filter(r => r.ok).map(r => ({ ...r.ok, at: r.at })), missed: results.filter(r => r.miss).map(r => ({ ...r.miss, at: r.at })) };
  }

  const api = { makeIndex, readSlip, fold, wordsOf, internals: { teamsIn, gameTeamsOf, tokens, fold } };      // internals: for the tests and for debugging a slip
  root.SlipRead = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
