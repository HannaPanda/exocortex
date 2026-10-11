// Driving the real Firefox release and reading what it knows (issue #166).
//
// Three sources of truth, kept apart because they answer different questions:
//
//   page        a BiDi preload script wraps `WebSocket`, the wake listeners and
//               the timers inside the eXocortex page. It sees every socket the
//               page *constructed* and its state, including sockets that are
//               queued inside Firefox and never reach the network.
//   browser     Firefox's own network dashboard (about:networking), read in
//               the chrome context: every socket the browser holds, per host,
//               and its WebSocket and HTTP connection lists.
//   process     /proc for the Firefox process tree: resident memory, file
//               descriptors, threads.
//
// Firefox limits WebSockets per *browser* (network.websocket.max-connections,
// 200), and a WebSocket waiting in its per-host connect queue holds a slot of
// that limit without holding an OS socket. That is why the page counter, not
// the dashboard, is the one that can see an accumulation before it bites.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { BIN_DIR, PROXY_PORT } from './config.mjs';

const require = createRequire(import.meta.url);
const { Builder } = require('selenium-webdriver');
const firefox = require('selenium-webdriver/firefox');
const getScriptManager = require('selenium-webdriver/bidi/scriptManager');
const getLogInspector = require('selenium-webdriver/bidi/logInspector');

/** Runs inside every page before its own scripts; only acts on the eXocortex origin. */
function instrumentPage(port) {
  // Serialized into the page, so its globals are the window's. Named through
  // globalThis because this file is linted as Node code.
  const window = globalThis;
  const { document, location, EventTarget } = globalThis;
  if (location.port !== String(port) || window.__harness) return;
  const NativeWebSocket = window.WebSocket;
  const live = new Set();
  const stats = {
    created: 0,
    opened: 0,
    errored: 0,
    closed: 0,
    closedBeforeOpen: 0,
    byPath: {},
    closeCodes: {},
  };
  const segment = (url) => {
    try {
      return new URL(url, location.href).pathname.split('/')[1] || '/';
    } catch {
      return '?';
    }
  };
  class HarnessWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      const p = segment(url);
      const record = { p, t: Date.now(), opened: false };
      this.__harness = record;
      stats.created += 1;
      (stats.byPath[p] ??= { created: 0, opened: 0, closed: 0 }).created += 1;
      live.add(this);
      super.addEventListener('open', () => {
        record.opened = true;
        stats.opened += 1;
        stats.byPath[p].opened += 1;
      });
      super.addEventListener('error', () => {
        stats.errored += 1;
      });
      super.addEventListener('close', (event) => {
        stats.closed += 1;
        stats.byPath[p].closed += 1;
        if (!record.opened) stats.closedBeforeOpen += 1;
        stats.closeCodes[event.code] = (stats.closeCodes[event.code] ?? 0) + 1;
        live.delete(this);
      });
    }
  }
  window.WebSocket = HarnessWebSocket;

  // Listeners on window and document, per type, de-duplicated like the DOM does.
  const listeners = new Map();
  const key = (target, type) => `${target === window ? 'window' : 'document'}:${type}`;
  // Read through the descriptor: the originals are only ever invoked with
  // `.call(this, ...)` below, so they are never used unbound.
  const add = Object.getOwnPropertyDescriptor(EventTarget.prototype, 'addEventListener').value;
  const remove = Object.getOwnPropertyDescriptor(
    EventTarget.prototype,
    'removeEventListener',
  ).value;
  EventTarget.prototype.addEventListener = function (type, fn, options) {
    if ((this === window || this === document) && fn) {
      const k = key(this, type);
      if (!listeners.has(k)) listeners.set(k, new Set());
      listeners.get(k).add(fn);
    }
    return add.call(this, type, fn, options);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, options) {
    if ((this === window || this === document) && fn) listeners.get(key(this, type))?.delete(fn);
    return remove.call(this, type, fn, options);
  };

  // Pending timeouts and live intervals.
  const timeouts = new Set();
  const intervals = new Set();
  const nativeSetTimeout = window.setTimeout;
  const nativeClearTimeout = window.clearTimeout;
  const nativeSetInterval = window.setInterval;
  const nativeClearInterval = window.clearInterval;
  window.setTimeout = function (fn, ms, ...args) {
    const id = nativeSetTimeout.call(
      window,
      (...a) => {
        timeouts.delete(id);
        if (typeof fn === 'function') fn(...a);
      },
      ms,
      ...args,
    );
    timeouts.add(id);
    return id;
  };
  window.clearTimeout = function (id) {
    timeouts.delete(id);
    return nativeClearTimeout.call(window, id);
  };
  window.setInterval = function (...a) {
    const id = nativeSetInterval.apply(window, a);
    intervals.add(id);
    return id;
  };
  window.clearInterval = function (id) {
    intervals.delete(id);
    return nativeClearInterval.call(window, id);
  };

  window.__harness = () => {
    const byState = [0, 0, 0, 0];
    const liveByPath = {};
    let oldestConnectingMs = 0;
    const now = Date.now();
    for (const ws of live) {
      byState[ws.readyState] += 1;
      const r = ws.__harness;
      liveByPath[r.p] = (liveByPath[r.p] ?? 0) + 1;
      if (ws.readyState === 0) oldestConnectingMs = Math.max(oldestConnectingMs, now - r.t);
    }
    const listenerCounts = {};
    for (const [k, set] of listeners) if (set.size) listenerCounts[k] = set.size;
    return {
      ...structuredClone(stats),
      live: live.size,
      byState: {
        connecting: byState[0],
        open: byState[1],
        closing: byState[2],
        closed: byState[3],
      },
      liveByPath,
      oldestConnectingMs,
      listeners: listenerCounts,
      timeouts: timeouts.size,
      intervals: intervals.size,
      visibility: document.visibilityState,
    };
  };
}

export async function launchFirefox({ headless = true, maxWebSockets, logFile, binary } = {}) {
  const options = new firefox.Options()
    .setBinary(binary ?? path.join(BIN_DIR, 'firefox/firefox'))
    .enableBidi()
    .setPreference('app.update.enabled', false)
    .setPreference('app.update.auto', false)
    .setPreference('browser.shell.checkDefaultBrowser', false)
    .setPreference('datareporting.healthreport.uploadEnabled', false)
    .setPreference('datareporting.policy.dataSubmissionEnabled', false)
    .setPreference('toolkit.telemetry.enabled', false)
    .setPreference('browser.aboutwelcome.enabled', false)
    // No background traffic to Mozilla: it would show up in the socket counts
    // and make two runs differ for reasons that have nothing to do with us.
    .setPreference('network.captive-portal-service.enabled', false)
    .setPreference('network.connectivity-service.enabled', false)
    .setPreference('services.settings.server', 'http://127.0.0.1:1/remote-settings-disabled')
    .setPreference('browser.safebrowsing.malware.enabled', false)
    .setPreference('browser.safebrowsing.phishing.enabled', false)
    .setPreference('browser.safebrowsing.downloads.enabled', false)
    .setPreference('extensions.update.enabled', false)
    .setPreference('extensions.getAddons.cache.enabled', false);
  if (headless) options.addArguments('-headless');
  if (maxWebSockets !== undefined)
    options.setPreference('network.websocket.max-connections', maxWebSockets);
  const service = new firefox.ServiceBuilder(path.join(BIN_DIR, 'geckodriver')).addArguments(
    '--allow-system-access',
  );
  if (logFile) service.setStdio(['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')]);

  const driver = await new Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(options)
    .setFirefoxService(service)
    .build();
  await driver.manage().setTimeouts({ script: 60_000, pageLoad: 60_000 });
  const caps = await driver.getCapabilities();
  const scripts = await getScriptManager([], driver);
  await scripts.addPreloadScript(`() => (${instrumentPage.toString()})(${PROXY_PORT})`);
  const consoleLines = [];
  const logs = await getLogInspector(driver, []);
  await logs.onConsoleEntry((entry) => {
    consoleLines.push({
      t: Date.now(),
      level: entry.level,
      text: String(entry.text).slice(0, 2000),
    });
    if (consoleLines.length > 20_000) consoleLines.splice(0, 5_000);
  });

  const pid = caps.get('moz:processID');
  return {
    driver,
    pid,
    version: caps.get('browserVersion'),
    consoleLines,

    /**
     * Evaluates an expression in one tab over BiDi and returns its JSON value.
     *
     * No window switch: selecting a tab through the classic protocol brings it
     * to the front, which would make a background tab visible and fire the
     * very wake signal a scenario is trying to hold back.
     */
    async evalJson(handle, expression) {
      const result = await scripts.evaluateFunctionInBrowsingContext(
        handle,
        `JSON.stringify(${expression})`,
        true,
      );
      if (result.resultType !== 'success') {
        throw new Error(
          `evaluate failed: ${JSON.stringify(result.exceptionDetails?.text ?? result)}`,
        );
      }
      return result.result.value === undefined ? null : JSON.parse(result.result.value);
    },

    /** Runs a function body in the chrome context and comes back to the content context. */
    async chrome(body) {
      const handle = await driver.getWindowHandle();
      await driver.setContext(firefox.Context.CHROME);
      try {
        return await driver.executeAsyncScript(body);
      } finally {
        await driver.setContext(firefox.Context.CONTENT);
        await driver.switchTo().window(handle);
      }
    },

    async dashboard() {
      return this.chrome(`
        const done = arguments[arguments.length - 1];
        const dash = Cc['@mozilla.org/network/dashboard;1'].getService(Ci.nsIDashboard);
        const out = { maxWebSockets: Services.prefs.getIntPref('network.websocket.max-connections') };
        dash.requestSockets((s) => {
          const sockets = s.sockets || [];
          out.sockets = sockets.length;
          out.socketsByHost = {};
          for (const k of sockets) {
            const h = k.host + ':' + k.port;
            out.socketsByHost[h] = (out.socketsByHost[h] || 0) + 1;
          }
          dash.requestWebsocketConnections((w) => {
            out.websockets = (w.websockets || []).length;
            dash.requestHttpConnections((h) => {
              out.httpHosts = (h.connections || []).map((c) => ({ host: c.host + ':' + c.port, active: (c.active || []).length, idle: (c.idle || []).length }));
              done(out);
            });
          });
        });
      `);
    },

    /** Memory, descriptors and threads of the whole Firefox process tree. */
    processMetrics() {
      const parents = new Map();
      for (const entry of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
          const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
          parents.set(Number(entry), ppid);
        } catch {
          // The process exited between readdir and read; it is not ours to count.
        }
      }
      const tree = new Set([pid]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const [p, pp] of parents)
          if (!tree.has(p) && tree.has(pp)) {
            tree.add(p);
            grew = true;
          }
      }
      let rssKb = 0;
      let fds = 0;
      let threads = 0;
      for (const p of tree) {
        try {
          const status = fs.readFileSync(`/proc/${p}/status`, 'utf8');
          rssKb += Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
          threads += Number(/Threads:\s+(\d+)/.exec(status)?.[1] ?? 0);
          fds += fs.readdirSync(`/proc/${p}/fd`).length;
        } catch {
          // A content process that exited while being measured.
        }
      }
      return { processes: tree.size, rssMb: Math.round(rssKb / 1024), fds, threads };
    },

    quit: () => driver.quit(),
  };
}
