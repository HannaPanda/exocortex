// The independent control origin (issue #166).
//
// A WebSocket echo server on a different loopback address than eXocortex, and
// the page that watches it from inside the same Firefox. The page keeps one
// long-lived socket with a heartbeat (latency, drops) and opens a *fresh*
// socket every two seconds (open, echo, close). The fresh handshake is the
// question that matters: the reported failure is that unrelated sites cannot
// open new connections until Firefox restarts, which a long-lived socket that
// happens to survive would never show.
import http from 'node:http';

import { WebSocketServer } from 'ws';

import { CONTROL_HOST, CONTROL_PORT } from './config.mjs';

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>harness control origin</title></head>
<body><pre id="out">starting</pre>
<script>
(() => {
  const url = 'ws://' + location.host + '/echo';
  const state = { fresh: [], beats: [], drops: 0, persistentOpen: false, started: Date.now() };
  window.__control = state;
  const keep = (list, item) => { list.push(item); if (list.length > 5000) list.splice(0, 1000); };

  // One fresh socket every 2 s: open, echo, close. Timeout 8 s.
  const fresh = () => {
    const t0 = performance.now();
    const at = Date.now();
    let settled = false;
    const finish = (ok, why) => {
      if (settled) return;
      settled = true;
      keep(state.fresh, { t: at, ok, why, ms: Math.round(performance.now() - t0) });
      try { ws.close(); } catch {}
    };
    let ws;
    try { ws = new WebSocket(url + '?fresh'); } catch (e) { finish(false, 'throw:' + e.name); return; }
    const timer = setTimeout(() => finish(false, 'timeout'), 8000);
    ws.onopen = () => ws.send('f' + at);
    ws.onmessage = () => { clearTimeout(timer); finish(true, null); };
    ws.onerror = () => { clearTimeout(timer); finish(false, 'error'); };
    ws.onclose = (e) => { clearTimeout(timer); finish(false, 'close:' + e.code); };
  };
  setInterval(fresh, 2000);
  fresh();

  // The long-lived socket and its heartbeat.
  let persistent = null;
  const connect = () => {
    persistent = new WebSocket(url + '?persistent');
    persistent.onopen = () => { state.persistentOpen = true; };
    persistent.onmessage = (e) => {
      const sent = Number(String(e.data).slice(1));
      keep(state.beats, { t: Date.now(), rtt: Math.round(performance.now() - sent) });
    };
    persistent.onclose = () => {
      if (state.persistentOpen) state.drops += 1;
      state.persistentOpen = false;
      setTimeout(connect, 1000);
    };
  };
  connect();
  setInterval(() => {
    if (persistent && persistent.readyState === 1) persistent.send('b' + performance.now());
  }, 1000);

  setInterval(() => {
    const recent = state.fresh.slice(-10);
    document.getElementById('out').textContent =
      'fresh ok ' + recent.filter((r) => r.ok).length + '/' + recent.length + ', drops ' + state.drops;
  }, 1000);
})();
</script></body></html>`;

export function createControlOrigin() {
  const counts = { handshakes: 0, fresh: 0, persistent: 0, messages: 0, open: 0 };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGE);
  });
  const wss = new WebSocketServer({ server, path: '/echo' });
  wss.on('connection', (ws, req) => {
    counts.handshakes += 1;
    counts.open += 1;
    if ((req.url ?? '').includes('fresh')) counts.fresh += 1;
    else counts.persistent += 1;
    ws.on('message', (data) => {
      counts.messages += 1;
      ws.send(data);
    });
    ws.on('close', () => {
      counts.open -= 1;
    });
    ws.on('error', () => {});
  });
  return {
    url: `http://${CONTROL_HOST}:${CONTROL_PORT}/`,
    listen: () => new Promise((resolve) => server.listen(CONTROL_PORT, CONTROL_HOST, resolve)),
    close: () =>
      new Promise((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
    snapshot: () => ({ ...counts }),
  };
}
