// Published copy of the MLB dashboard: its questions to the server are answered from the data files
// published with it (sports_dashboard/publish.py). What-ifs need the dashboard running on the PC.
(() => {
  const realFetch = window.fetch.bind(window);
  const reply = (status, obj) => new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  async function file(name, what) {
    const res = await realFetch(new URL('data/' + name, document.baseURI), { cache: 'no-cache' });
    if (res.ok) return res;
    return reply(404, { error: `${what} isn't in the published copy (it covers yesterday, today and tomorrow, updated a few times a day).` });
  }
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : (input.url || String(input)), location.href);
    const at = url.pathname.indexOf('/api/');
    if (at < 0) return realFetch(input, init);
    const endpoint = url.pathname.slice(at + 5);
    const q = url.searchParams;
    let body = {};
    if (init && init.body) {
      try { body = JSON.parse(init.body); } catch (e) { body = {}; }
    }
    const date = q.get('date') || body.date || today();
    switch (endpoint) {
      case 'slate':
      case 'refresh':
        return file(`slate/${date}.json`, `The ${date} slate`);
      case 'players':
        return file(`players/${date}.json`, `Home runs and strikeouts for ${date}`);
      case 'record':
        return file('record.json', 'The track record');
      case 'game':
        return file(`game/${date}_${q.get('pk')}.json`, 'That game');
      case 'simulate': {
        const whatIf = (body.starters && Object.values(body.starters).some(Boolean))
          || (body.weather && ['neutral', 'custom'].includes(body.weather.mode));
        if (whatIf) {
          return reply(400, { error: 'What-ifs run on the dashboard on your PC; this published copy shows the saved simulations.' });
        }
        return file(`game/${date}_${body.game_pk}.json`, 'That game');
      }
      default:
        return reply(404, { error: 'unknown endpoint' });
    }
  };
})();
