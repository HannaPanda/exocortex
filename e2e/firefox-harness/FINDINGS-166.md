# Issue #166: findings, 2026-10-11

Firefox 157.0.1 (release tarball), geckodriver 0.37.1, headless, Ubuntu 24.04.5
(kernel 6.8), on the same host as the harness stack. The report concerns
desktop Firefox on **Windows**; everything below is Linux evidence about
Gecko's shared networking code, not proof about the Windows build.

## Root cause status

**The browser-wide failure was not reproduced.** In 154 fault cycles across
five runs, including a sensitized run with Firefox capped at 20 WebSockets in
total and three eXocortex windows open, the unrelated control origin never
refused a fresh handshake (4,621 of 4,621 succeeded), a brand-new tab opened
WebSockets after every run, and no browser resource grew. Nothing here
supports claiming #166 is fixed.

Two client defects were found, reproduced deterministically and fixed. Both
make the eXocortex tab itself fail after a deploy or an outage; neither was
shown to break other sites.

## What the harness established about Firefox

Measured with standalone experiments in the same Firefox (not eXocortex code):

1. `network.websocket.max-connections` (200) is **browser-wide**: with 200
   sockets open to one host, a new WebSocket to a different host in a
   different tab fails at once and keeps failing.
2. A WebSocket **queued** in Firefox's per-host connect queue holds one of those
   slots without holding an OS socket: 230 never-closed sockets to a
   non-answering host blocked every other site while the network dashboard
   showed 6 sockets.
3. After refused handshakes Firefox delays further attempts to that host
   (measured: 5 ms, 272, 397, 587, 876, 1455 ... 14 967 ms, x1.5 per failure,
   capped at 60 s) and serializes parallel ones: five sockets opened together
   against a host answering 502 closed after 22, 56, 106, 167 and 227 s,
   holding a slot all that time.
4. `close()` on a connecting or queued socket releases its slot correctly.

So a page that keeps _creating_ WebSockets during an outage without closing the
previous ones would exhaust every site's WebSockets, and restarting Firefox is
the only quick way out, which matches the report. eXocortex was measured not
to do that on Linux: at most 2 sockets per tab were connecting at once.

## Defects found and fixed

|                                            | Baseline                          | Candidate        |
| ------------------------------------------ | --------------------------------- | ---------------- |
| cycles that did not reconnect without F5   | 6 of 42 (1 tab), 4 of 28 (3 tabs) | 0 of 42, 0 of 28 |
| `wake-after-close`: live `/collab` sockets | 2 (3 of 3, 1 tab; 2 of 2, 3 tabs) | 1                |
| offline edits missing from the Yjs state   | 0                                 | 0                |
| control origin fresh handshakes failed     | 0 of 1504 / 1052                  | 0 of 1019 / 740  |
| median reconnect after a fault             | 0.5 s                             | 1.0 s            |

1. **A rebuilt connection that gets no ticket never tries again** (91305ce).
   When the revive watchdog or a wake signal rebuilt the collaboration
   connection while the API was unreachable, the ticket request failed before
   any provider existed, so neither the watchdog nor the wake handler was armed.
   The tab kept no socket and made no further request for as long as it stayed
   open. Reproduced in every `api-502` (30 s of 502 on every API route) and every
   `long-outage` (90 s). Now the failed ticket arms the same backoff, and showing
   the tab retries at once; the candidate recovered 16 to 69 s after the outage (the backoff decides).
2. **A destroyed Hocuspocus provider reconnects on its own** (0ddacc2).
   @hocuspocus/provider 4.7.0 schedules `connect()` one second after a connected
   socket closes, and `connect()` re-enables itself even after `destroy()`. A
   provider destroyed in that second (the tab shown again right after a deploy
   closed the socket) became an ownerless retry loop with a socket of its own;
   the collaboration server times it out after about 60 s once it is back up,
   so it does not accumulate across deploys. `retireProvider()` now disables
   the socket's `connect` after destroying.

## Remaining uncertainty and leads

- Windows: the same harness runs against any Firefox binary (`setup-tools.sh`
  downloads, `--headful` for a visible window); `processMetrics()` is the only
  Linux-specific part. Running it on the Windows machine that shows the fault is
  the next step that could change this verdict.
- Long lifetimes: each run lasted about an hour with one page load. A tab open
  for days through dozens of deploys is not covered; the zombie fix removes the
  one mechanism seen that adds sockets per outage.
- Not WebSockets: MEGA failing as well hints at something wider than the
  WebSocket cap (the HTTP connection pool, DNS, a network-change event). The
  dashboard samples (`browser.httpHosts`, `socketsByHost`) showed nothing
  growing here.
- While the watchdog rebuilds, the editor unmounts (the Y.Doc is replaced), so
  typing is impossible until a new ticket arrives; with the API down that is the
  whole outage. Offline editing survives socket loss but not a rebuild. Not
  changed here.

## Reproduce

```bash
bash e2e/firefox-harness/build-web.sh baseline            # at 9bced7c
bash e2e/firefox-harness/run.sh -- --label baseline-1tab --cycles 42
bash e2e/firefox-harness/build-web.sh candidate           # at 0ddacc2
bash e2e/firefox-harness/run.sh --web candidate -- --label candidate-1tab --cycles 42
bash e2e/firefox-harness/run.sh -- --label baseline-sensitized-3tabs --tabs 3 --max-ws 20 --cycles 28
bash e2e/firefox-harness/run.sh --web candidate -- --label candidate-sensitized-3tabs --tabs 3 --max-ws 20 --cycles 28
bash e2e/firefox-harness/run.sh -- --label control-no-exo --no-exo --cycles 14
```

Each run writes `results/<timestamp>-<label>/` with `summary.json`,
`metrics.jsonl` (one sample every 2 s), `events.jsonl`, `proxy-events.jsonl`,
`console.jsonl`, the service logs and `exocortex-dump.txt`.
