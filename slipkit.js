/* Add to slip, for the dashboards' game pages.

   A game page shows each player's projection. This lets someone click the player and put one of his
   lines in the parlay slip without leaving the game. The slip itself - its rules and its pricing -
   lives on the Parlays page, so nothing here prices anything: it asks that page, through the hub that
   holds both (the hub passes messages between its frames), for a game's legs, tells it which one to put
   in, and hears back what the slip now holds.

   Embedded in the hub, every call works. Opened on its own there is no slip to talk to, and the chooser
   says so. The same file is used by the NFL, MLB and NBA pages; edit web/slipkit.js and publish.py
   copies it into each dashboard.

   Everything is built from DOM nodes with textContent, never from HTML strings. */
(() => {
  'use strict';
  if (window.SlipKit) return;

  const embedded = window.parent !== window;
  const listeners = new Set();
  const pending = new Map();           // request id -> function that takes the answer
  const cache = new Map();             // 'sport|gid' -> Promise of that game's legs
  let nextId = 1;
  let state = { count: 0, sigs: [], legs: [], text: '' };

  // ------------------------------------------------------------------ talking to the hub
  const send = msg => window.parent.postMessage({ sim: 'slip', ...msg }, '*');

  function ask(msg, ms) {
    return new Promise(resolve => {
      if (!embedded) { resolve(null); return; }
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); resolve(null); }, ms || 20000);
      pending.set(id, answer => { clearTimeout(timer); resolve(answer); });
      send({ ...msg, id });
    });
  }

  window.addEventListener('message', e => {
    if (e.source !== window.parent) return;
    const m = e.data;
    if (!m || m.sim !== 'slip') return;
    const tell = () => listeners.forEach(f => { try { f(state); } catch (err) { /* a listener must not stop the rest */ } });
    const take = s => {
      state = { count: s.count || 0, sigs: s.sigs || [], p: s.p, fair: s.fair, dk: s.dk, legs: s.legs || [], text: s.text || '' };
      tell();
    };
    if (m.op === 'state') { take(m); return; }
    // An answer can carry the slip as it now stands, which updates it at once; the broadcast follows.
    if (m.state) take(m.state);
    else if (Array.isArray(m.sigs)) { state = { ...state, count: m.sigs.length, sigs: m.sigs }; tell(); }
    const answer = m.id && pending.get(m.id);
    if (answer) { pending.delete(m.id); answer(m); }
  });

  // ------------------------------------------------------------------ what the page can ask for
  /** One game's legs from the Parlays page, or null if it could not be reached. Remembered while
      the page is open: the lines on the board only change when the site republishes. */
  function legs(sport, gid) {
    const key = `${sport}|${gid}`;
    if (!cache.has(key)) {
      const p = ask({ op: 'legs', sport, gid: String(gid) }, 30000).then(r => (r && r.ready !== false ? r.legs : null));
      cache.set(key, p);
      p.then(v => { if (!v || !v.length) cache.delete(key); });          // an empty answer is not worth keeping
    }
    return cache.get(key);
  }

  async function toggle(sig) {
    const r = await ask({ op: 'toggle', sig }, 15000);
    return r || { ok: false, note: 'Could not reach the slip. Open this from the Sports Sim page.' };
  }

  const has = sig => state.sigs.includes(sig);
  const open = () => {
    if (embedded) send({ op: 'open' });
    else window.location.href = new URL('parlays.html', document.baseURI).href;
  };
  function onState(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  // ------------------------------------------------------------------ names
  const NAMES = {
    nfl: { ML: 'Moneyline', SPREAD: 'Spread', ALT_SPREAD: 'Alt spreads', TOTAL: 'Total', ALT_TOTAL: 'Alt totals',
           TEAM_TOTAL: 'Team points', H1_ML: 'Leading at half', H1_SPREAD: '1st-half spread', H1_TOTAL: '1st-half total',
           TEAM_H1: 'Team 1st-half points', TD: 'Anytime TD', TD2: '2+ TDs', QB2: '2+ passing TDs', PTD: 'Passing TDs',
           PASS: 'Passing yards', COMP: 'Completions', ATT: 'Pass attempts', INT: 'Interception',
           RUSH: 'Rushing yards', REC: 'Receiving yards', SCRIM: 'Rushing + receiving yards',
           RECS: 'Receptions', CARRIES: 'Carries' },
    mlb: { ML: 'Moneyline', RUNLINE: 'Run line', TOTAL: 'Total', TEAM_TOTAL: 'Team runs', F5_ML: 'Leading after 5',
           F5_TOTAL: 'First-5 total', NRFI: 'First inning', HIT: '1+ hit', HIT2: '2+ hits', HR: 'Home run',
           TB: 'Total bases', RBI: 'RBIs', RUN: 'Runs', HRR: 'Hits + runs + RBIs', SB: 'Stolen base',
           K: 'Strikeouts', OUTS: 'Outs recorded', HA: 'Hits allowed', ER: 'Runs allowed', PBB: 'Walks' },
    nba: { ML: 'Moneyline', SPREAD: 'Spread', ALT_SPREAD: 'Alt spreads', TOTAL: 'Total', ALT_TOTAL: 'Alt totals',
           PTS: 'Points', REB: 'Rebounds', AST: 'Assists', FG3: '3-pointers', STL: 'Steals', BLK: 'Blocks',
           TOV: 'Turnovers', PR: 'Points + rebounds', PA: 'Points + assists', RA: 'Rebounds + assists',
           PRA: 'Points + rebounds + assists', STLBLK: 'Steals + blocks', DD: 'Double-double', TD3: 'Triple-double' },
  };
  const marketName = (sport, m) => (NAMES[sport] || {})[m] || m;
  const OPEN_FIRST = new Set(['SCRIM', 'RUSH', 'REC', 'TD', 'PASS', 'PTS', 'REB', 'AST', 'FG3', 'HIT', 'TB', 'K',
                              'ML', 'SPREAD', 'TOTAL']);

  const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
  /** The key a leg carries for an NFL player: first initial, surname, team - 'j|gibbs|DET' for both
      "J.Gibbs" and "Jahmyr Gibbs" (picks.py makes the same one). */
  function nameKey(name, team) {
    const parts = String(name).replace(/\./g, ' ').replace(/'/g, '').trim().split(/\s+/)
      .filter(p => p && !SUFFIXES.has(p.toLowerCase().replace(/^,+|,+$/g, '')));
    if (parts.length < 2) return `None|${(parts[0] || '').toLowerCase()}|${team}`;
    return `${parts[0][0].toLowerCase()}|${parts.slice(1).join(' ').toLowerCase()}|${team}`;
  }

  /** The legs of `all` that are about this player (by id or name key) - or, with markets, about the game. */
  function mine(all, who) {
    const w = who || {};
    return all.filter(l => {
      if (w.markets) return w.markets.includes(l.market) && !l.pid && !l.eid && !l.pkey;
      return (w.pid != null && String(l.pid) === String(w.pid))
        || (w.eid != null && l.eid != null && String(l.eid) === String(w.eid))
        || (w.pkey != null && l.pkey === w.pkey);
    });
  }

  // ------------------------------------------------------------------ small DOM helpers
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      n.append(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
    }
    return n;
  }
  const pct = p => `${Math.round(100 * p)}%`;
  const shortBook = b => (b === 'DraftKings' ? 'DK' : (b || ''));
  const fmtOdds = o => (o > 0 ? `+${o}` : `−${-o}`);

  // ------------------------------------------------------------------ styles (the pages' own tokens, with fallbacks)
  const css = `
.sk-chip{position:fixed;right:16px;bottom:16px;z-index:60;display:none;align-items:center;gap:10px;max-width:calc(100vw - 32px);
  background:var(--btn-bg,#0b0b0b);color:var(--btn-ink,#fcfcfb);border:0;border-radius:999px;padding:10px 18px;font:inherit;
  font-size:13.5px;font-weight:600;cursor:pointer;box-shadow:0 10px 30px -6px rgba(0,0,0,.4);transition:transform .2s cubic-bezier(.22,.8,.24,1)}
.sk-chip:hover{transform:translateY(-2px)}
.sk-chip.on{display:inline-flex}
.sk-chip small{font-weight:500;opacity:.8;font-size:12px}
.sk-add{flex:none;width:30px;height:30px;border-radius:50%;border:1px solid var(--border,rgba(0,0,0,.14));background:var(--surface-2,#f2f1ec);
  color:var(--ink,#111);font:inherit;font-size:17px;font-weight:600;line-height:1;cursor:pointer;display:inline-grid;place-items:center;padding:0;
  transition:background .15s,transform .15s}
.sk-add:active{transform:scale(.92)}
.sk-add:hover{background:var(--surface,#fff);border-color:var(--ink-2,#555)}
.sk-add.in{background:var(--accent,#1baf7a);border-color:transparent;color:#fff}
.sk-add:disabled{opacity:.4;cursor:default}
/* The + at the end of a clickable player row: a picture of a button, the row itself is the control. */
.sk-plus{flex:none;width:28px;height:28px;border-radius:50%;border:1px solid var(--border,rgba(0,0,0,.14));background:var(--surface-2,#f2f1ec);
  color:var(--ink-2,#555);font-size:17px;font-weight:600;line-height:1;display:inline-grid;place-items:center;pointer-events:none}
.sk-click:hover .sk-plus{background:var(--accent,#1baf7a);color:#fff;border-color:transparent}
.sk-click{cursor:pointer}
.sk-click:focus-visible{outline:2px solid var(--accent,#1baf7a);outline-offset:2px}
.sk-overlay{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:16px}
.sk-sheet{background:var(--surface,#fff);color:var(--ink,#111);border:1px solid var(--border,rgba(0,0,0,.12));border-radius:22px;
  box-shadow:0 30px 80px -10px rgba(0,0,0,.45);width:min(620px,100%);max-height:min(86vh,800px);display:flex;flex-direction:column;overflow:hidden;
  font-size:14px;line-height:1.4;animation:skpop .28s cubic-bezier(.22,.8,.24,1)}
.sk-overlay{animation:skfade .2s ease}
@keyframes skfade{from{opacity:0}}
@keyframes skpop{from{opacity:0;transform:translateY(14px) scale(.98)}}
@media (prefers-reduced-motion:reduce){.sk-sheet,.sk-overlay,.sk-panel,.sk-toast{animation:none!important}}
.sk-extra{flex:none;padding:4px 18px 8px;border-bottom:1px solid var(--hair,var(--border,rgba(0,0,0,.1)));overflow-x:auto;overflow-y:hidden}
.sk-head{display:flex;align-items:flex-start;gap:12px;padding:18px 18px 12px}
.sk-head h2{margin:0;font-size:18px;letter-spacing:-.015em;font-weight:680}
.sk-head .sk-sub{color:var(--muted,#898781);font-size:12.5px;margin-top:2px}
.sk-x{margin-left:auto;flex:none;border:0;background:none;color:var(--ink-2,#555);font-size:20px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:8px}
.sk-x:hover{background:var(--surface-2,#f2f1ec)}
.sk-body{flex:1 1 auto;min-height:0;overflow:auto;padding:4px 18px 14px}
.sk-group{border-bottom:1px solid var(--hair,var(--border,rgba(0,0,0,.08)));padding:2px 0}
.sk-group:last-child{border-bottom:0}
.sk-group>summary{cursor:pointer;list-style:none;padding:9px 0;font-weight:640;font-size:13.5px;display:flex;justify-content:space-between;gap:8px}
.sk-group>summary::-webkit-details-marker{display:none}
.sk-group>summary::after{content:'+';color:var(--muted,#898781);font-weight:500}
.sk-group[open]>summary::after{content:'\\2212'}
.sk-group>summary small{color:var(--muted,#898781);font-weight:500;margin-left:auto;margin-right:10px}
.sk-legs{list-style:none;margin:0 0 6px;padding:0}
.sk-leg{display:grid;grid-template-columns:1fr auto auto auto;align-items:center;gap:10px;padding:7px 0;border-top:1px solid var(--hair,var(--border,rgba(0,0,0,.08)))}
.sk-leg:first-child{border-top:0}
.sk-what{min-width:0}
.sk-what small{display:block;color:var(--muted,#898781);font-size:11.5px}
.sk-p{font-weight:640;font-variant-numeric:tabular-nums;min-width:38px;text-align:right}
.sk-odds{font-size:12px;color:var(--ink-2,#555);min-width:64px;text-align:right;font-variant-numeric:tabular-nums}
.sk-tag{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:1px 5px;border-radius:5px;
  background:var(--surface-2,#f2f1ec);color:var(--ink-2,#555);margin-left:6px;vertical-align:1px}
.sk-tag.warn{background:color-mix(in srgb,var(--critical,#d03b3b) 14%,transparent);color:var(--ink,#111)}
.sk-leg.dim .sk-what{opacity:.65}
.sk-l5{display:inline-block;margin-left:6px;font-size:10px;font-weight:700;padding:1px 5px;border-radius:5px;background:var(--surface-2,#f2f1ec);
  color:var(--ink-2,#555);vertical-align:1px;cursor:help;white-space:nowrap}
.sk-l5.hot{background:color-mix(in srgb,var(--good-text,#0a0) 16%,transparent);color:var(--good-text,#070)}
.sk-l5.cold{background:color-mix(in srgb,var(--critical,#d03b3b) 14%,transparent);color:var(--critical,#d03b3b)}
.sk-form{color:var(--muted,#898781);font-size:12px;padding:0 0 4px;font-variant-numeric:tabular-nums}
.sk-rowform{color:var(--muted,#898781);font-size:11.5px;margin-left:8px;white-space:nowrap;font-variant-numeric:tabular-nums}
.sk-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:11px 18px;border-top:1px solid var(--hair,var(--border,rgba(0,0,0,.1)));
  color:var(--ink-2,#555);font-size:12.5px}
.sk-foot .sk-note{flex:1 1 200px;min-height:1.2em}
.sk-go{border:0;border-radius:999px;background:var(--btn-bg,#0b0b0b);color:var(--btn-ink,#fcfcfb);font:inherit;font-size:13px;font-weight:600;padding:7px 13px;cursor:pointer}
.sk-msg{padding:22px 4px;color:var(--ink-2,#555);text-align:center}
.sk-toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:120;background:var(--ink,#111);color:var(--page,#fff);
  border-radius:10px;padding:8px 14px;font-size:13px;max-width:calc(100vw - 32px);box-shadow:0 8px 24px rgba(0,0,0,.3)}
.sk-panel{position:fixed;right:16px;bottom:64px;z-index:70;width:min(410px,calc(100vw - 32px));max-height:min(70vh,580px);display:flex;flex-direction:column;
  background:var(--surface,#fff);color:var(--ink,#111);border:1px solid var(--border,rgba(0,0,0,.12));border-radius:20px;box-shadow:0 22px 60px -8px rgba(0,0,0,.4);
  overflow:hidden;font-size:13.5px;line-height:1.4;animation:skpop .24s cubic-bezier(.22,.8,.24,1)}
.sk-phead{display:flex;align-items:center;gap:8px;padding:11px 14px 4px}
.sk-phead strong{font-size:14.5px}
.sk-psum{padding:0 14px 8px;color:var(--ink-2,#555);font-size:12.5px;border-bottom:1px solid var(--border,rgba(0,0,0,.1))}
.sk-plegs{list-style:none;margin:0;padding:2px 14px;overflow:auto;flex:1 1 auto}
.sk-plegs li{display:grid;grid-template-columns:1fr auto auto auto;gap:8px;align-items:center;padding:7px 0;border-top:1px solid var(--hair,var(--border,rgba(0,0,0,.08)))}
.sk-plegs li:first-child{border-top:0}
.sk-pwhat{min-width:0}
.sk-pwhat small{display:block;color:var(--muted,#898781);font-size:11px}
.sk-rm{flex:none;width:26px;height:26px;border-radius:50%;border:1px solid var(--border,rgba(0,0,0,.14));background:var(--surface-2,#f2f1ec);color:var(--ink-2,#555);
  font:inherit;font-size:16px;line-height:1;cursor:pointer;display:inline-grid;place-items:center;padding:0}
.sk-rm:hover{background:var(--critical,#d03b3b);border-color:transparent;color:#fff}
.sk-rm:disabled{opacity:.4;cursor:default}
.sk-pnote{padding:0 14px;color:var(--ink-2,#555);font-size:12.5px;min-height:0}
.sk-pnote:not(:empty){padding-top:6px}
.sk-text{width:100%;font:inherit;font-size:12px;border:1px solid var(--border,rgba(0,0,0,.14));border-radius:8px;background:var(--surface-2,#f2f1ec);color:var(--ink,#111);padding:6px}
.sk-pfoot{display:flex;gap:8px;flex-wrap:wrap;padding:10px 14px;border-top:1px solid var(--border,rgba(0,0,0,.1))}
.sk-btn{border:1px solid var(--border,rgba(0,0,0,.14));background:var(--surface-2,#f2f1ec);color:var(--ink,#111);border-radius:999px;font:inherit;font-size:12.5px;
  font-weight:600;padding:6px 13px;cursor:pointer;transition:background .15s}
.sk-btn:hover{background:var(--surface,#fff)}
.sk-btn.primary{background:var(--btn-bg,#0b0b0b);color:var(--btn-ink,#fcfcfb);border-color:transparent;margin-left:auto}
.sk-cardimg{display:block;max-width:100%;height:auto;border-radius:10px;margin:8px auto}
@media (max-width:640px){.sk-panel{right:0;left:0;bottom:0;width:100%;border-radius:16px 16px 0 0;max-height:80vh}}
@media (max-width:640px){.sk-overlay{align-items:flex-end;padding:0}.sk-sheet{border-radius:16px 16px 0 0;max-height:90vh;width:100%}
  .sk-chip{right:50%;transform:translateX(50%);bottom:12px}.sk-odds{min-width:52px;font-size:11px}.sk-leg{gap:8px}}
`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ------------------------------------------------------------------ the slip chip
  let chipNode = null;
  function paintChip() {
    if (!chipNode) return;
    const n = state.count || 0;
    chipNode.classList.toggle('on', n > 0);
    if (!n) return;
    const bits = [`Slip · ${n} leg${n === 1 ? '' : 's'}`];
    chipNode.replaceChildren(document.createTextNode(bits[0]),
      state.p ? el('small', { text: `${pct(state.p)} · fair ${state.fair || ''}${state.dk ? ` · DK pays ${state.dk}` : ''}` }) : null,
      el('small', { text: 'View ▴' }));
  }
  function mountChip() {
    if (chipNode || !document.body) return;
    chipNode = el('button', { class: 'sk-chip', type: 'button', 'aria-label': 'Show what is in the parlay slip', onclick: () => togglePanel() });
    document.body.appendChild(chipNode);
    paintChip();
  }
  listeners.add(paintChip);

  // ------------------------------------------------------------------ the slip panel
  // What the slip holds, where the game is: each leg with a way to take it out, what they come to, and Copy and
  // Card for the whole slip. The legs and the text arrive from the Parlays page, which owns them.
  let panelNode = null, cardNode = null;
  const flash = (btn, text) => {
    if (!btn.dataset.was) btn.dataset.was = btn.textContent;
    btn.textContent = text;
    setTimeout(() => { btn.textContent = btn.dataset.was; }, 1600);
  };
  function legacyCopy(text) {
    const ta = el('textarea', { readonly: '', style: 'position:fixed;left:-9999px;top:0' });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }
  /** The slip as text, to paste into Pikkit's QuickPickBot or a message. */
  async function copySlip(btn, note) {
    const text = state.text;
    if (!text) return;
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) { ok = legacyCopy(text); }
    if (ok) { flash(btn, 'Copied'); return; }
    note.replaceChildren(el('textarea', { class: 'sk-text', readonly: '', rows: '6', text }));   // no clipboard: select it by hand
    note.querySelector('textarea').select();
  }
  /** The picture to a share sheet (a phone sends it straight to Discord or Messages), else the clipboard, else a download. */
  async function saveImage(png, say) {
    const blob = await (await fetch(png)).blob();
    const name = `slip-${new Date().toISOString().slice(0, 10)}.png`;
    try {
      const file = new File([blob], name, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Slip' });
        say.textContent = 'Shared.';
        return;
      }
    } catch (e) { if (e && e.name === 'AbortError') return; }          // closed the sheet: not a failure
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        say.textContent = 'Copied to the clipboard.';
        return;
      }
    } catch (e) { /* fall through to a download */ }
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    say.textContent = 'Saved.';
  }
  function showCard(png) {
    if (cardNode) cardNode.remove();
    const say = el('span', { class: 'sk-note' });
    const close = () => { if (cardNode) { cardNode.remove(); cardNode = null; } };
    cardNode = el('div', { class: 'sk-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Slip card' },
      el('div', { class: 'sk-sheet' },
        el('div', { class: 'sk-head' }, el('div', {}, el('h2', { text: 'Slip card' }),
          el('div', { class: 'sk-sub', text: 'A picture of your slip, for posting.' })),
          el('button', { class: 'sk-x', type: 'button', 'aria-label': 'Close', text: '\u00d7', onclick: close })),
        el('div', { class: 'sk-body' }, el('img', { class: 'sk-cardimg', src: png, alt: 'Your slip as a card' })),
        el('div', { class: 'sk-foot' }, say,
          el('button', { class: 'sk-go', type: 'button', text: 'Share or save', onclick: () => saveImage(png, say) }))));
    cardNode.addEventListener('click', e => { if (e.target === cardNode) close(); });
    document.body.appendChild(cardNode);
  }
  async function makeCard(btn) {
    flash(btn, 'Drawing\u2026');
    const r = await ask({ op: 'card' }, 25000);
    if (!r || !r.ok || !r.png) { flash(btn, 'Could not make it'); return; }
    showCard(r.png);
  }
  function closePanel() { if (panelNode) { panelNode.remove(); panelNode = null; } }
  function togglePanel(force) {
    if (panelNode && force !== true) { closePanel(); return; }
    if (!state.count) return;
    if (!panelNode) {
      panelNode = el('div', { class: 'sk-panel', role: 'dialog', 'aria-label': 'Your slip' });
      document.body.appendChild(panelNode);
    }
    paintPanel();
  }
  function paintPanel() {
    if (!panelNode) return;
    const n = state.count || 0;
    if (!n) { closePanel(); return; }
    const note = el('div', { class: 'sk-pnote', 'aria-live': 'polite' });
    const copy = el('button', { class: 'sk-btn', type: 'button', text: 'Copy', onclick: () => copySlip(copy, note) });
    const card = el('button', { class: 'sk-btn', type: 'button', text: 'Card', title: 'A picture of this slip, for posting', onclick: () => makeCard(card) });
    let sure = false;
    const clear = el('button', { class: 'sk-btn', type: 'button', text: 'Clear', onclick: async () => {
      if (!sure) { sure = true; clear.textContent = 'Clear all?'; setTimeout(() => { sure = false; clear.textContent = 'Clear'; }, 2500); return; }
      clear.disabled = true;
      await ask({ op: 'clear' }, 15000);
    } });
    const rows = (state.legs || []).map(l => {
      const rm = el('button', { class: 'sk-rm', type: 'button', title: 'Take out of the slip', 'aria-label': `Take ${l.label} out of the slip`, text: '\u00d7',
        onclick: async () => { rm.disabled = true; const r = await toggle(l.sig); if (r && r.ok === false && r.note) note.textContent = r.note; } });
      return el('li', {}, el('div', { class: 'sk-pwhat' }, l.label, el('small', { text: l.game })),
        el('span', { class: 'sk-p', text: pct(l.p) }),
        el('span', { class: 'sk-odds', text: l.odds != null ? `${shortBook(l.book)} ${fmtOdds(l.odds)}`
                                              : (l.est != null ? `${shortBook(l.book)} ${l.rough ? '~' : '\u2248'}${fmtOdds(l.est)}` : '') }), rm);
    });
    panelNode.replaceChildren(
      el('div', { class: 'sk-phead' }, el('strong', { text: `Your slip \u00b7 ${n} leg${n === 1 ? '' : 's'}` }),
        el('button', { class: 'sk-x', type: 'button', 'aria-label': 'Close', text: '\u00d7', onclick: closePanel, style: 'margin-left:auto' })),
      state.p ? el('div', { class: 'sk-psum', text: `${pct(state.p)} to hit \u00b7 fair ${state.fair}${state.dk ? ` \u00b7 DraftKings pays ${state.dk}` : ''}` }) : null,
      el('ul', { class: 'sk-plegs' }, rows), note,
      el('div', { class: 'sk-pfoot' }, copy, card, clear,
        el('button', { class: 'sk-btn primary', type: 'button', text: 'Open slip \u203a', onclick: () => { closePanel(); open(); } })));
  }
  listeners.add(paintPanel);

  // ------------------------------------------------------------------ one add button
  let toastTimer = null;
  function toast(text) {
    if (!text) return;
    let t = document.querySelector('.sk-toast');
    if (!t) { t = el('div', { class: 'sk-toast', role: 'status' }); document.body.appendChild(t); }
    t.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 2800);
  }
  /** A round + button for one leg: it shows a tick while the leg is in the slip, and puts it in or takes it
      out when pressed. `say` is told what happened (default: a small toast). */
  function addButton(leg, say) {
    const btn = el('button', { class: 'sk-add', type: 'button', 'data-sig': leg.sig, text: '+' });
    const paint = () => {
      const on = has(leg.sig);
      btn.classList.toggle('in', on);
      btn.textContent = on ? '✓' : '+';
      btn.setAttribute('aria-label', `${on ? 'Remove' : 'Add'} ${leg.label} ${on ? 'from' : 'to'} the slip`);
    };
    paint();
    if (leg.started) btn.disabled = true;
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      btn.disabled = true;
      const r = await toggle(leg.sig);
      btn.disabled = !!leg.started;
      (say || toast)(r.note || (r.did === 'removed' ? 'Taken out of the slip.' : r.ok ? 'In your slip.' : 'Not added.'));
      paint();
    });
    btn.addEventListener('sk-paint', paint);
    return btn;
  }
  listeners.add(() => document.querySelectorAll('.sk-add').forEach(b => b.dispatchEvent(new Event('sk-paint'))));

  // ------------------------------------------------------------------ the chooser
  let sheetNode = null;
  function closeSheet() {
    if (sheetNode) { sheetNode.remove(); sheetNode = null; }
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') closeSheet(); }

  // Where a player's name ends and the bet begins: "over 99.5", "15+", "anytime TD", "throws an INT", "no INT".
  const BET = /^(.+?)\s+(?=(?:over|under)\s+\d|\d+\+|anytime\s|throws\s|no\s+INT)/i;
  /** "over 99.5 rush yds" with the player's name taken off the front. The name is the one the page gave,
      and where the page knows him by a shorter one ("J.Gibbs" for "Jahmyr Gibbs") the bet is found by
      where it starts. */
  function tail(leg, name) {
    const label = String(leg.label || '');
    let t = label;
    if (name && t.toLowerCase().startsWith(name.toLowerCase())) t = t.slice(name.length).trim();
    else if (leg.pid != null || leg.eid != null || leg.pkey) {
      const m = BET.exec(t);
      if (m) t = t.slice(m[0].length).trim();
    }
    t = t.replace(/^\([^)]*\)\s*/, '');                 // baseball labels carry the team: "Name (LAD) 1+ run"
    return t ? t[0].toUpperCase() + t.slice(1) : label;
  }

  /** How many of the player's last games this leg would have won: leg.f is those games, newest first, as the number
      the bet is settled on, so the leg's own line and side say which it would have won. */
  function formOf(leg) {
    const f = leg.f, line = Number(leg.line);
    if (!Array.isArray(f) || f.length < 3 || leg.line == null || !isFinite(line)) return null;
    const under = leg.side === 'under';
    return { n: f.length, hits: f.filter(v => (under ? v < line : v > line)).length, under };
  }
  function formChip(leg) {
    const fm = formOf(leg);
    if (!fm) return null;
    const r = fm.hits / fm.n;
    return el('span', { class: `sk-l5${r >= 0.8 ? ' hot' : r <= 0.4 ? ' cold' : ''}`,
      title: `${fm.under ? 'Stayed under' : 'Cleared'} this line in ${fm.hits} of his last ${fm.n} games: ${leg.f.join(', ')} (newest first).`,
      text: `${fm.hits}/${fm.n}` });
  }

  function legRow(leg, sport, name, note) {
    const btn = addButton(leg, text => { note.textContent = text; });
    return el('li', { class: `sk-leg${leg.flagged ? ' dim' : ''}` },
      el('span', { class: 'sk-what' }, tail(leg, name), formChip(leg),
        leg.flagged ? el('span', { class: 'sk-tag warn', title: 'The model and DraftKings disagree about this one', text: 'off book' }) : null,
        leg.started ? el('span', { class: 'sk-tag', text: 'started' }) : null),
      el('span', { class: 'sk-p', text: pct(leg.p) }),
      el('span', { class: 'sk-odds', text: leg.odds != null ? `${shortBook(leg.book)} ${fmtOdds(leg.odds)}`.trim()
                                              : (leg.est != null ? `${shortBook(leg.book)} ${leg.rough ? '~' : '\u2248'}${fmtOdds(leg.est)}`.trim()
                                                 : (leg.book ? `${shortBook(leg.book)} line` : '')),
                      title: leg.odds == null && leg.est != null ? 'An estimate from the main line, not DraftKings\' own price' : null }),
      btn);
  }

  /** The chooser: a sheet listing the legs, grouped by market, each with its chance, the book's
      price, and a button that puts it in the slip.
        { sport, gid, who: { pid | eid | pkey | markets }, title, sub, legs? (already in hand), name } */
  async function choose(opts) {
    closeSheet();
    mountChip();
    // A page may put a block of its own above the lines (the NBA page's last five games). It must not stop the sheet opening.
    let extra = null;
    try { extra = typeof opts.extra === 'function' ? opts.extra() : (opts.extra || null); } catch (err) { extra = null; console.error('The extra block failed:', err); }
    const note = el('span', { class: 'sk-note', text: '' });
    const body = el('div', { class: 'sk-body' }, el('p', { class: 'sk-msg', text: 'Loading the lines…' }));
    const goSlip = el('button', { class: 'sk-go', type: 'button', text: 'Open slip ›', onclick: () => { closeSheet(); open(); } });
    const x = el('button', { class: 'sk-x', type: 'button', 'aria-label': 'Close', text: '×', onclick: closeSheet });
    sheetNode = el('div', { class: 'sk-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title || 'Lines' },
      el('div', { class: 'sk-sheet' },
        el('div', { class: 'sk-head' },
          el('div', {}, el('h2', { text: opts.title || 'Lines' }), opts.sub ? el('div', { class: 'sk-sub', text: opts.sub }) : null), x),
        extra ? el('div', { class: 'sk-extra' }, extra) : null,
        body,
        el('div', { class: 'sk-foot' }, note, embedded ? goSlip : null)));
    sheetNode.addEventListener('click', e => { if (e.target === sheetNode) closeSheet(); });
    document.body.appendChild(sheetNode);
    document.addEventListener('keydown', onKey);
    x.focus();
    const keep = sheetNode;

    const all = opts.legs || await legs(opts.sport, opts.gid);
    if (sheetNode !== keep) return;                           // closed while it loaded
    if (all === null) {
      body.replaceChildren(el('p', { class: 'sk-msg', text: embedded
        ? 'The lines are not available yet. The Parlays page is still loading; try again in a few seconds.'
        : 'Open this from the Sports Sim page to put lines in the slip: on its own it has no slip to add to.' }));
      return;
    }
    const list = mine(all, opts.who);
    if (!list.length) {
      body.replaceChildren(el('p', { class: 'sk-msg', text: 'There are no lines on the board for this yet. The board is rebuilt a few times a day, and a player appears once the book lists him.' }));
      return;
    }
    const groups = new Map();
    for (const l of list) (groups.get(l.market) || groups.set(l.market, []).get(l.market)).push(l);
    const order = Object.keys(NAMES[opts.sport] || {});
    const keys = [...groups.keys()].sort((a, b) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b)));
    const first = keys.filter(k => OPEN_FIRST.has(k)).length ? keys.filter(k => OPEN_FIRST.has(k)) : [keys[0]];
    body.replaceChildren(...keys.map(k => {
      const ls = groups.get(k).sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.side === 'under') - (b.side === 'under'));
      const withForm = ls.find(l => Array.isArray(l.f) && l.f.length >= 3);       // every line of a stat shares the player's games
      const avg = withForm ? withForm.f.reduce((a, v) => a + v, 0) / withForm.f.length : null;
      return el('details', { class: 'sk-group', open: first.includes(k) ? '' : null },
        el('summary', {}, marketName(opts.sport, k), el('small', { text: `${ls.length} line${ls.length === 1 ? '' : 's'}` })),
        withForm ? el('div', { class: 'sk-form', text: `Last ${withForm.f.length}, newest first: ${withForm.f.join(' · ')} · average ${avg.toFixed(1)}` }) : null,
        el('ul', { class: 'sk-legs' }, ls.map(l => legRow(l, opts.sport, opts.name, note))));
    }));
  }

  const STAT_WORDS = { scrim_yds: 'rush+rec yds', rush_yds: 'rush yds', rec_yds: 'rec yds', pass_yds: 'pass yds', rec: 'rec', car: 'car',
                       comp: 'comp', att: 'att', pass_td: 'pass TD', td: 'TD', h: 'H', tb: 'TB', hr: 'HR', k: 'K', outs: 'outs',
                       pts: 'pts', reb: 'reb', ast: 'ast' };
  /** A player's recent average on the row itself ("L5 118 rush+rec yds"). The page names the element to put it in
      (formTarget) and the stats to look for, best first (formStats); his last games are found among the game's legs,
      which the Parlays page sends and which carry them (leg.f, newest first). Nothing is shown where he has none. */
  async function annotate(node, get) {
    let o;
    try { o = get(); } catch (err) { return; }
    if (!o || !o.formTarget || !o.formStats) return;
    const all = await legs(o.sport, o.gid);
    if (!all || !node.isConnected) return;
    const list = mine(all, o.who);
    for (const stat of o.formStats) {
      const l = list.find(x => x.stat === stat && Array.isArray(x.f) && x.f.length >= 3);
      if (!l) continue;
      const avg = l.f.reduce((a, v) => a + v, 0) / l.f.length;
      o.formTarget.appendChild(el('span', { class: 'sk-rowform', title: `Last ${l.f.length} games, newest first: ${l.f.join(', ')}`,
        text: `L${l.f.length} ${avg >= 100 ? avg.toFixed(0) : avg.toFixed(1)} ${STAT_WORDS[stat] || stat}` }));
      return;
    }
  }

  /** Make an element open the chooser when clicked (or Enter or Space is pressed on it). `get`
      returns the choose() options when it happens, so they are read at the moment of the click. */
  function attach(node, get) {
    node.classList.add('sk-click');
    if (node.tagName !== 'TR') node.setAttribute('role', 'button');      // a table row keeps its own role
    node.setAttribute('tabindex', '0');
    const go = e => { if (e.target.closest && e.target.closest('a, select, input')) return; choose(get()); };
    node.addEventListener('click', go);
    node.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(e); } });
    if (embedded) annotate(node, get);
  }

  window.SlipKit = { embedded, legs, toggle, has, open, onState, choose, attach, addButton, toast, nameKey, mine, marketName, mountChip, togglePanel };
  if (embedded) send({ op: 'hello' });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountChip);
  else mountChip();
})();
