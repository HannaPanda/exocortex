# Firefox WebSocket harness

Issue #166: Firefox reportedly ends up unable to open connections to
_unrelated_ sites (WhatsApp Web, Twitch chat, MEGA) after an eXocortex tab was
open during a deploy or an outage, until the whole browser is restarted. This
harness reproduces deploys and outages against an isolated eXocortex, in a real
Firefox release, and watches an independent WebSocket origin in the same
browser while it does.

## One command

```bash
bash e2e/firefox-harness/run.sh -- --label baseline --cycles 36
```

That fetches the tools if they are missing, builds the harness web app if it
is missing, starts Postgres and Redis in their own compose project, migrates,
provisions a test account, runs the cycles, writes the results and removes the
containers again (also on Ctrl-C). It touches no live unit, database, Redis or
bucket: see "Isolation" below.

Useful variants:

```bash
# negative control: same faults, no eXocortex tab in the browser
bash e2e/firefox-harness/run.sh -- --label control --no-exo --cycles 24
# several eXocortex windows at once
bash e2e/firefox-harness/run.sh -- --label tabs3 --tabs 3 --cycles 24
# sensitized: Firefox allows only 20 WebSockets in total, so a handful of
# leaked or queued sockets already breaks the control origin
bash e2e/firefox-harness/run.sh -- --label sensitized --tabs 3 --max-ws 20 --cycles 24
# a subset of scenarios
bash e2e/firefox-harness/run.sh -- --label quick --cycles 4 --scenarios kill-sockets,deploy
# compare a change: build it under its own label, run it under that label
bash e2e/firefox-harness/build-web.sh candidate
bash e2e/firefox-harness/run.sh --web candidate -- --label candidate --cycles 36
```

`--headful` runs Firefox with a window; wrap the command in `xvfb-run -a` on a
host without a display.

## Setup

Everything lands inside this directory and needs no root:

| What                                   | Where from                                                     | Installed by                             |
| -------------------------------------- | -------------------------------------------------------------- | ---------------------------------------- |
| Firefox release                        | `download.mozilla.org` tarball (latest, or `FIREFOX_VERSION`)  | `setup-tools.sh` into `.bin/firefox`     |
| geckodriver                            | GitHub release (latest, or `GECKODRIVER_VERSION`)              | `setup-tools.sh` into `.bin/geckodriver` |
| selenium-webdriver, ws                 | npm, pinned in `package.json` / `package-lock.json`            | `setup-tools.sh` (`npm ci`)              |
| Playwright Firefox (supplemental only) | `pnpm --filter @exocortex/e2e exec playwright install firefox` | by hand                                  |

The harness's npm dependencies are deliberately _not_ part of the pnpm
workspace: adding selenium to `e2e/package.json` re-resolved peer dependencies
across the whole lockfile.

Also required: Docker, the built `apps/api/dist` and `apps/collaboration/dist`
(the deploy leaves them there), and pnpm (for the migration and the web build).

## What one cycle does

The scenarios run in rotation; each injects a fault, holds it, restores the
stack, then the harness waits for both channels of every eXocortex tab to be
`connected` again (`[data-testid="connection-status"]`) and checks that a
marker typed into the editor reached the canonical Yjs state in Postgres.

| Scenario            | Fault                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `collab-restart`    | collaboration server SIGTERM, 3 s down (marker typed while down)                                                                                |
| `api-restart`       | API SIGTERM, 3 s down                                                                                                                           |
| `deploy`            | API, collaboration, web restarted in deploy.sh order, 2 s gaps                                                                                  |
| `crash-collab`      | collaboration server SIGKILL, 5 s down                                                                                                          |
| `kill-sockets`      | every upgraded socket reset at the proxy, no close frame                                                                                        |
| `upgrade-502`       | `/collab` and `/realtime` upgrades answered 502 for 30 s                                                                                        |
| `ticket-expiry`     | `/collab` refused for longer than a ticket lives                                                                                                |
| `ticket-hang`       | ticket requests hang for 30 s while the socket is gone                                                                                          |
| `api-502`           | every API route answers 502 for 30 s                                                                                                            |
| `long-outage`       | API and collaboration down for 90 s (past two revive delays)                                                                                    |
| `background-deploy` | tab in the background for the whole outage, then shown                                                                                          |
| `flapping`          | five socket resets in ten seconds, then 5 s of 502                                                                                              |
| `wake-after-close`  | socket reset, tab hidden and shown again within the provider's 1 s reconnect delay; regression check: never more than one live `/collab` socket |
| `accept-drop`       | every `/collab` handshake answered 101 and dropped before the first message, for 20 s                                                           |

## What it measures

Every two seconds, into `metrics.jsonl`:

- **page** (per eXocortex tab, from a BiDi preload script): every WebSocket the
  page constructed, opened, closed, by path and close code, and the _live_ ones
  by `readyState`; listeners on `window`/`document` by type; pending timeouts
  and live intervals; the provider count from the connection log.
- **browser** (Firefox's network dashboard, read in the chrome context):
  sockets per host, WebSocket and HTTP connection lists, and
  `network.websocket.max-connections`.
- **process** (`/proc`, the whole Firefox process tree): RSS, file
  descriptors, threads.
- **control origin**: fresh handshakes since the last sample (ok, failed, why,
  slowest), heartbeat latency, drops of the long-lived socket.
- **proxy**: requests, upgrades, refusals and open upgraded sockets per route,
  which is the server-side view to compare the page's against.

At the end: a brand-new tab on the control origin (the user's complaint is
about _new_ connections), the `window.exocortex.dump()` of the first tab, and
`summary.json` with per-cycle recovery and integrity, start/end resource
deltas and a verdict block.

Why the page counter matters more than the dashboard: Firefox caps WebSockets
for the **whole browser** at `network.websocket.max-connections` (200), and a
WebSocket waiting in Firefox's per-host connect queue holds one of those slots
without holding an OS socket. After a few refused handshakes Firefox delays
further attempts to that host (x1.5 per failure, up to 60 s) and serializes
them, so a page that keeps creating sockets during an outage can fill the cap
while the dashboard shows a handful of sockets.

## Isolation

- Infrastructure: compose project `exocortex-ffharness`, Postgres on 5437 and
  Redis on 6384, tmpfs, no restart, `down -v` on exit.
- Services: `apps/api/dist`, `apps/collaboration/dist` and the harness web
  build run as children of `harness.mjs` on 4311-4313 behind the fault proxy on
  4310, with a complete environment and a working directory outside the
  repository, so no `.env` is loaded; object storage and SMTP point at port 1.
  Only PIDs the harness spawned are ever signalled.
- Web: `build-web.sh <label>` builds `apps/web/.next-harness-<label>` with the
  harness origin inlined; the deployed `.next`/`.next-live` are not touched.
- Control origin: `127.0.0.2:4320`, a different host from Firefox's view.

## Limits

The harness runs Firefox for Linux, headless, on the same host as the servers.
The reported failure is desktop Firefox on Windows. Nothing here is Linux
specific except `processMetrics()` and the downloaded binary, so the same
harness can be pointed at a Windows Firefox, but a clean Linux run is evidence
about Gecko's shared code, not proof about the Windows build.
