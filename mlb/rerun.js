/* Published copy only: ask the PC to simulate again, at the count you pick.

   The published pages are files the PC made, so they cannot simulate. Pick another count in the sims box and a Run button appears beside it;
   Run opens a GitHub issue on this site's repository with the request filled in ("Re-run NFL at 50,000 sims"). The PC
   (sports_dashboard/relay.py, every 5 minutes) sees an issue from the owner's own account, re-simulates that sport at that count, remembers
   the count and publishes. Once something has been asked, one line under the top bar says so until it lands. Built from DOM nodes and
   textContent, never HTML strings. Each sport's static.js sets window.RERUN = { sport, label, repo, counts }. */
(() => {
  'use strict';
  const cfg = window.RERUN;
  const box = document.getElementById('sims');
  const bar = document.querySelector('header.topbar');
  if (!cfg || !window.PUBLISHED_COPY || !box || !bar) return;

  const KEY = `rerun.${cfg.sport}`;
  const WAIT_MS = 90 * 60 * 1000;                   // a request nobody has answered after this long is forgotten
  const POLL_MS = 60 * 1000;
  const fmt = n => Number(n).toLocaleString('en-US');
  const clock = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const store = {
    get() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } },
    set(v) { try { if (v) localStorage.setItem(KEY, JSON.stringify(v)); else localStorage.removeItem(KEY); } catch (e) { /* private window */ } },
  };
  const node = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined) continue;
      if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const kid of kids) if (kid) n.append(kid);
    return n;
  };

  let published = Number(box.value) || null;   // the count the copy on the site was made with; meta.json confirms it
  let generated = null;                        // and when
  let pending = store.get();                   // what this browser asked for: { sims, at, gen }
  let done = null;                             // the request landed: { sims, reload }
  let timer = null;

  document.head.append(node('style', { text: `
    .rerun { border-bottom: 1px solid var(--border, rgba(128,128,128,.25)); padding: 10px 24px; font-size: 13.5px; }
    .rerun p { margin: 0; color: var(--muted, #777); line-height: 1.45; max-width: 70ch; }
    .rerun .rerun-link { background: none; border: 0; padding: 0; margin: 0; font: inherit; color: var(--ink, inherit); text-decoration: underline; cursor: pointer; }
    .rerun[hidden], #rerun-run[hidden], #run-all[hidden] { display: none !important; }   /* the pages' .btn styles would otherwise keep a hidden button on show */
    @media (max-width: 720px) { .rerun { padding: 10px 14px; } }` }));

  // The Run button sits right after the box and only shows while the box holds a count other than the one the copy was made with.
  const run = node('button', { class: 'btn btn-primary', id: 'rerun-run', type: 'button', text: 'Run', hidden: '',
    title: 'Ask your PC to simulate again at this count', onclick: send });
  box.after(run);
  box.addEventListener('change', sync);

  // The one line under the top bar: what was asked, then that it landed.
  const line = node('p', { 'aria-live': 'polite' });
  const strip = node('section', { class: 'rerun', id: 'rerun', 'aria-label': 'Re-run on your PC', hidden: '' }, line);
  bar.after(strip);
  const link = (id, text, onclick) => node('button', { class: 'rerun-link', id, type: 'button', text, onclick });

  // The MLB page's "Simulate all" has nothing to do here (the games are files), and beside Run it would look like the same thing.
  const all = document.getElementById('run-all');
  if (all) all.hidden = true;

  function sync() {
    const n = Number(box.value);
    run.hidden = !(published && n !== published && cfg.counts.includes(n));
  }

  function draw() {
    strip.hidden = !pending && !done;
    line.replaceChildren();
    if (done) {
      line.append(`Done: this copy is now at ${fmt(done.sims)} sims a game.`);
      if (done.reload) line.append(' ', link('rerun-reload', 'Reload for the new numbers', () => location.reload()));
    } else if (pending) {
      line.append(`Asked for ${fmt(pending.sims)} sims at ${clock(pending.at)}. Tap Submit new issue on GitHub if you have not yet. `
        + 'New numbers in about 10 to 15 minutes. ', link('rerun-clear', 'Clear', forget));
    }
  }

  function send() {
    const sims = Number(box.value);
    if (!cfg.counts.includes(sims) || sims === published) return;
    const title = `Re-run ${cfg.label} at ${fmt(sims)} sims`;
    const body = 'Asked for from the published page. Your PC picks this up within about 5 minutes, re-simulates and publishes. '
      + 'It is safe to close this issue afterwards.';
    window.open(`https://github.com/${cfg.repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`, '_blank', 'noopener');
    pending = { sims, at: Date.now(), gen: generated };
    done = null;
    store.set(pending);
    if ([...box.options].some(o => Number(o.value) === published)) box.value = String(published);   // the page still shows the copy it has
    sync();
    watch();
    draw();
  }

  function forget() {
    pending = null;
    done = null;
    store.set(null);
    draw();
  }

  /** Has the PC caught up? A new count has landed when the copy says it and was made after we asked; a re-run at the same count, when it was made again. */
  function landed() {
    return !!pending && published === pending.sims && generated !== pending.gen;
  }

  async function check(first) {
    try {
      const res = await fetch(`data/meta.json?x=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const meta = await res.json();
      published = Number(meta.sims) || published;
      generated = meta.generated || generated;
    } catch (e) { return; }
    if (pending && Date.now() - pending.at > WAIT_MS) forget();
    else if (landed()) {
      done = { sims: published, reload: !first };   // a page opened after it landed already has the new numbers
      pending = null;
      store.set(null);
      draw();
    }
    if (!pending) stop();
  }

  function watch() { if (!timer) timer = setInterval(check, POLL_MS); }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  // Coming back from GitHub, look at once rather than waiting out the minute (a phone pauses a page's timers while it is in the background).
  document.addEventListener('visibilitychange', () => { if (!document.hidden && pending) check(); });
  check(true).then(() => { if (pending) watch(); draw(); });
})();
