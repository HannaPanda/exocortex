// The three eXocortex processes of the harness stack (issue #166).
//
// Started from the deployed build artefacts (apps/api/dist, apps/collaboration/
// dist) and the harness's own web build, as children of this process, with a
// complete environment and a working directory *outside* the repository so no
// `.env` is ever read. Only PIDs this module spawned are ever signalled; never
// match processes by pattern on this host, the live units look the same.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { API_PORT, COLLAB_PORT, ROOT_DIR, serviceEnvironment, WEB_PORT } from './config.mjs';

const CWD = path.join(os.tmpdir(), 'exocortex-ffharness-cwd');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpOk(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'manual' });
    return res.status < 500;
  } catch {
    return false;
  }
}

function tcpOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

export function createServices({ logDir, webLabel }) {
  fs.mkdirSync(CWD, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const webDist = `.next-harness-${webLabel}`;
  if (!fs.existsSync(path.join(ROOT_DIR, 'apps/web', webDist, 'BUILD_ID'))) {
    throw new Error(`no harness web build ${webDist}; run build-web.sh ${webLabel}`);
  }
  const SPECS = {
    api: {
      args: [path.join(ROOT_DIR, 'apps/api/dist/main.js')],
      // `/health/live`, not `/ready`: readiness includes the object storage,
      // which the harness deliberately does not have.
      ready: () => httpOk(`http://127.0.0.1:${API_PORT}/health/live`),
    },
    collab: {
      args: [path.join(ROOT_DIR, 'apps/collaboration/dist/main.js')],
      ready: () => tcpOpen(COLLAB_PORT),
    },
    web: {
      args: [
        path.join(ROOT_DIR, 'apps/web/node_modules/next/dist/bin/next'),
        'start',
        path.join(ROOT_DIR, 'apps/web'),
        '--port',
        String(WEB_PORT),
        '--hostname',
        '127.0.0.1',
      ],
      env: { EXOCORTEX_WEB_DIST_DIR: webDist },
      ready: () => httpOk(`http://127.0.0.1:${WEB_PORT}/anmelden`),
    },
  };
  const children = {};
  const restarts = { api: 0, collab: 0, web: 0 };

  async function start(name) {
    if (children[name]) throw new Error(`${name} already running`);
    const spec = SPECS[name];
    const log = fs.openSync(path.join(logDir, `${name}.log`), 'a');
    const child = spawn(process.execPath, spec.args, {
      cwd: CWD,
      env: { ...serviceEnvironment(), ...spec.env },
      stdio: ['ignore', log, log],
    });
    children[name] = child;
    child.on('exit', () => {
      if (children[name] === child) delete children[name];
    });
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (!children[name])
        throw new Error(`${name} exited during start; see ${logDir}/${name}.log`);
      if (await spec.ready()) return;
      await sleep(250);
    }
    throw new Error(`${name} not ready after 90 s; see ${logDir}/${name}.log`);
  }

  /** Stops one service: `SIGTERM` is what systemd sends on a restart, `SIGKILL` a crash. */
  async function stop(name, signal = 'SIGTERM') {
    const child = children[name];
    if (!child) return;
    const exited = new Promise((r) => child.once('exit', r));
    child.kill(signal);
    const timeout = sleep(15_000).then(() => 'timeout');
    if ((await Promise.race([exited, timeout])) === 'timeout') {
      child.kill('SIGKILL');
      await exited;
    }
    delete children[name];
  }

  async function restart(name, { signal = 'SIGTERM', downMs = 0 } = {}) {
    await stop(name, signal);
    if (downMs > 0) await sleep(downMs);
    await start(name);
    restarts[name] += 1;
  }

  return {
    start,
    stop,
    restart,
    startAll: async () => {
      await start('collab');
      await start('api');
      await start('web');
    },
    stopAll: async () => {
      for (const name of ['web', 'api', 'collab']) await stop(name);
    },
    pids: () => Object.fromEntries(Object.entries(children).map(([k, c]) => [k, c.pid])),
    restarts,
  };
}
