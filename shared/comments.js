/* Comments left by visitors, shared by the comment wall (comments/index.html)
   and the phone page it hands out by QR code (comments/send.html).

   A phone is not on the exhibition PC's network, so the two meet through a
   public relay, ntfy.sh: the phone posts the text to a topic, the wall
   listens to that topic. The relay only keeps messages for about 12 hours,
   so the wall writes every comment it sees into its own keeping as well —
   the local server (/api/comments) when it runs on one, and this browser's
   storage either way.

     XGComments.send(text)          -> Promise, from the phone
     XGComments.load()              -> Promise<[{id, text, time}]>, everything kept so far
     XGComments.listen(onComment)   -> calls onComment({id, text, time}) for each new one
     XGComments.sendUrl()           the phone page's address, for the QR code */
(function () {
  'use strict';

  const RELAY = 'https://ntfy.sh/';
  // hard to guess, so only these two pages write to and read from it
  const TOPIC = 'xg-outerchord-ppn6w9kc6yay26e78j';
  const PUBLIC_BASE = 'https://parkkiran04-spec.github.io/OUTERCHORD/';
  const MAX = 140;
  const LOCAL_KEY = 'xg.comments';

  const clean = t => String(t || '').replace(/\s+/g, ' ').trim().slice(0, MAX);
  const fromRelay = m => ({ id: String(m.id), text: clean(m.message), time: (m.time || 0) * 1000 });

  function sendUrl() {
    const local = !/^https?:$/.test(location.protocol) ||
      /^(localhost|127\.|\[::1\]|192\.168\.|10\.)/.test(location.hostname);
    return (local ? PUBLIC_BASE : new URL('../', location.href).href) + 'comments/send.html';
  }

  async function send(text) {
    const t = clean(text);
    if (!t) throw new Error('empty');
    const r = await fetch(RELAY + TOPIC, { method: 'POST', body: t });
    if (!r.ok) throw new Error('relay ' + r.status);
    return fromRelay(await r.json());
  }

  /* ---------------- keeping ---------------- */
  function localAll() {
    try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); } catch (e) { return []; }
  }
  function localAdd(c) {
    try {
      const all = localAll();
      if (!all.some(x => x.id === c.id)) { all.push(c); localStorage.setItem(LOCAL_KEY, JSON.stringify(all)); }
    } catch (e) { /* storage blocked or full */ }
  }
  // the server sits at the site root; the wall is one folder down
  const api = () => new URL('../api/comments', location.href).href;

  async function load() {
    const byId = new Map();
    for (const c of localAll()) byId.set(c.id, c);
    try {
      const r = await fetch(api(), { cache: 'no-store' });
      if (r.ok) for (const c of await r.json()) byId.set(c.id, c);
    } catch (e) { /* no local server (the public copy) */ }
    // whatever reached the relay while the wall was closed
    try {
      const r = await fetch(RELAY + TOPIC + '/json?poll=1&since=12h', { cache: 'no-store' });
      if (r.ok) {
        for (const line of (await r.text()).split('\n')) {
          if (!line.trim()) continue;
          const m = JSON.parse(line);
          if (m.event !== 'message' || byId.has(String(m.id))) continue;
          const c = fromRelay(m);
          if (c.text) { byId.set(c.id, c); keep(c); }
        }
      }
    } catch (e) { /* offline */ }
    return [...byId.values()].filter(c => c.text).sort((a, b) => a.time - b.time);
  }

  function keep(c) {
    localAdd(c);
    fetch(api(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c) })
      .catch(() => {});
  }

  function listen(onComment) {
    const seen = new Set();
    let es = null;
    const open = () => {
      es = new EventSource(RELAY + TOPIC + '/sse');
      es.onmessage = e => {
        let m; try { m = JSON.parse(e.data); } catch (err) { return; }
        if (m.event !== 'message' || seen.has(m.id)) return;
        seen.add(m.id);
        const c = fromRelay(m);
        if (!c.text) return;
        keep(c);
        onComment(c);
      };
      // EventSource retries by itself; this covers the case where it gives up
      es.onerror = () => { if (es.readyState === 2) setTimeout(open, 5000); };
    };
    open();
    return () => es && es.close();
  }

  window.XGComments = { send, load, listen, sendUrl, MAX };
})();
