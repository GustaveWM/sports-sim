// Published copy of the NFL dashboard: its questions to the server are answered from the data files
// published with it (sports_dashboard/publish.py). What-ifs need the dashboard running on the PC.
(() => {
  const realFetch = window.fetch.bind(window);
  const WHAT_IF = ['qb_away', 'qb_home', 'neutral', 'temp', 'wind', 'rain'];
  const reply = (status, obj) => new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  async function file(name, what) {
    const res = await realFetch(new URL('data/' + name, document.baseURI), { cache: 'no-cache' });
    if (res.ok) return res;
    return reply(404, { error: `${what} isn't in the published copy (it has this week, updated a few times a day).` });
  }
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : (input.url || String(input)), location.href);
    const at = url.pathname.indexOf('/api/');
    if (at < 0) return realFetch(input, init);
    const endpoint = url.pathname.slice(at + 5);
    const q = url.searchParams;
    switch (endpoint) {
      case 'health':
        return reply(200, { ok: true, published: true });
      case 'week':
        return file('week.json', 'That week');
      case 'weeks':
        return file('weeks.json', 'The list of weeks');
      case 'game':
        if (WHAT_IF.some(k => q.get(k))) {
          return reply(400, { error: 'What-ifs run on the dashboard on your PC; this published copy shows the saved simulations.' });
        }
        return file(`game/${q.get('id')}.json`, 'That game');
      case 'props':
        return file('props.json', 'The props');
      case 'teams':
        return file('teams.json', 'Team ratings');
      case 'power':
        return file('power.json', 'Power ratings');
      case 'quarterbacks':
        return file('quarterbacks.json', 'Quarterbacks');
      case 'record':
        return file('record.json', 'The record');
      case 'config':
        return file('config.json', 'Settings');
      default:
        return reply(404, { error: 'unknown endpoint' });
    }
  };
})();
