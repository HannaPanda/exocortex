// The harness's stand-in for nginx, with fault injection (issue #166).
//
// It routes exactly like deploy/nginx/exocortex.app.conf (/collab to the
// collaboration server, /realtime, /api/, /health/ and /docs to the API,
// everything else to the web app) and, like nginx, answers 502 when the
// upstream refuses the connection -- which is what a browser sees during a
// deploy. On top of that every route class can be switched into a fault:
//
//   pass    forward normally
//   502     answer 502 at once (an upgrade gets a raw 502 response)
//   hang    accept the request and never answer
//   reset   destroy the client socket without a response
//   accept-drop  (upgrades only) answer 101, then drop the connection
//
// and the upgraded sockets of a class can be killed abruptly (`rst`) or
// closed (`fin`). It also counts what it saw, which is the server-side view
// the browser-side counters are compared against.
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

import { API_PORT, COLLAB_PORT, HOST, PROXY_PORT, WEB_PORT } from './config.mjs';

/** Which class a request belongs to, and which upstream port serves it. */
export function classify(url, isUpgrade) {
  const pathname = url.split('?')[0];
  if (pathname.startsWith('/collab')) return { route: 'collab', port: COLLAB_PORT };
  if (pathname.startsWith('/realtime'))
    return { route: isUpgrade ? 'realtime' : 'realtime-poll', port: API_PORT };
  if (/^\/api\/documents\/[^/]+\/collaboration-ticket$/.test(pathname))
    return { route: 'ticket', port: API_PORT };
  if (
    pathname.startsWith('/api/') ||
    pathname.startsWith('/health/') ||
    pathname.startsWith('/docs')
  ) {
    return { route: 'api', port: API_PORT };
  }
  return { route: 'web', port: WEB_PORT };
}

const ROUTES = ['collab', 'realtime', 'realtime-poll', 'ticket', 'api', 'web'];

export function createProxy() {
  const faults = Object.fromEntries(ROUTES.map((r) => [r, 'pass']));
  const upgraded = Object.fromEntries(ROUTES.map((r) => [r, new Set()]));
  const hung = new Set();
  const stats = Object.fromEntries(
    ROUTES.map((r) => [r, { requests: 0, upgrades: 0, upgradesOk: 0, refused502: 0, faulted: 0 }]),
  );
  const events = [];
  const note = (event) => {
    events.push({ t: Date.now(), ...event });
    if (events.length > 20_000) events.splice(0, 5_000);
  };

  const server = http.createServer((req, res) => {
    const { route, port } = classify(req.url ?? '/', false);
    stats[route].requests += 1;
    const fault = faults[route];
    if (fault !== 'pass') {
      stats[route].faulted += 1;
      note({ kind: 'http-fault', route, fault, url: req.url });
      if (fault === '502') {
        res.writeHead(502, { 'content-type': 'text/plain', connection: 'close' });
        res.end('harness: 502');
      } else if (fault === 'hang') {
        hung.add(req.socket);
        req.socket.on('close', () => hung.delete(req.socket));
      } else {
        req.socket.destroy();
      }
      return;
    }
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'http' },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      stats[route].refused502 += 1;
      note({ kind: 'upstream-down', route, url: req.url });
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('harness: upstream unavailable');
    });
    req.pipe(upstream);
  });

  server.on('upgrade', (req, client, head) => {
    const { route, port } = classify(req.url ?? '/', true);
    stats[route].upgrades += 1;
    client.on('error', () => {});
    const fault = faults[route];
    if (fault !== 'pass') {
      stats[route].faulted += 1;
      note({ kind: 'upgrade-fault', route, fault });
      if (fault === '502')
        client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      else if (fault === 'hang') {
        hung.add(client);
        client.on('close', () => hung.delete(client));
      } else if (fault === 'accept-drop') {
        // A valid 101, then the connection dies before any message: the
        // browser fires `open`, then `close`, and the client never got far
        // enough to authenticate. A server going down mid-handshake looks
        // like this.
        const accept = createHash('sha1')
          .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64');
        client.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        setTimeout(() => client.destroy(), 50);
      } else client.destroy();
      return;
    }
    const upstream = net.connect(port, '127.0.0.1');
    let connected = false;
    upstream.on('error', () => {
      if (!connected) {
        stats[route].refused502 += 1;
        note({ kind: 'upgrade-upstream-down', route });
        client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      } else client.destroy();
    });
    upstream.on('connect', () => {
      connected = true;
      stats[route].upgradesOk += 1;
      const headers = Object.entries(req.headers).map(
        ([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`,
      );
      upstream.write(
        `${req.method} ${req.url} HTTP/1.1\r\n${headers.join('\r\n')}\r\nx-forwarded-for: 127.0.0.1\r\n\r\n`,
      );
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
      upgraded[route].add(client);
      const done = () => {
        upgraded[route].delete(client);
        upstream.destroy();
      };
      client.on('close', done);
      upstream.on('close', () => client.destroy());
    });
  });

  return {
    listen: () => new Promise((resolve) => server.listen(PROXY_PORT, HOST, resolve)),
    close: () =>
      new Promise((resolve) => {
        for (const set of Object.values(upgraded)) for (const s of set) s.destroy();
        for (const s of hung) s.destroy();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
    /** Sets the fault of one or more route classes. `pass` also releases hung requests of that class. */
    setFault(routes, fault) {
      for (const route of [routes].flat()) faults[route] = fault;
      note({ kind: 'fault', routes, fault });
      if (fault === 'pass') for (const s of hung) s.destroy();
    },
    clearFaults() {
      for (const route of ROUTES) faults[route] = 'pass';
      for (const s of hung) s.destroy();
      note({ kind: 'fault', routes: 'all', fault: 'pass' });
    },
    /** Kills every upgraded socket of a class, without a close frame. */
    killUpgraded(route, how = 'rst') {
      let n = 0;
      for (const s of upgraded[route]) {
        n += 1;
        if (how === 'fin') s.end();
        else if (typeof s.resetAndDestroy === 'function') s.resetAndDestroy();
        else s.destroy();
      }
      note({ kind: 'kill', route, how, n });
      return n;
    },
    snapshot() {
      return {
        faults: { ...faults },
        activeUpgraded: Object.fromEntries(ROUTES.map((r) => [r, upgraded[r].size])),
        hung: hung.size,
        stats: structuredClone(stats),
      };
    },
    events,
  };
}
