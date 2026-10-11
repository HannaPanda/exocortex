// The fault scenarios of the Firefox harness (issue #166).
//
// Each one injects a fault, holds it and restores the stack; the cycle loop in
// harness.mjs then waits for recovery and measures. `offline` marks scenarios
// during which a marker is typed into the editor, to prove that offline edits
// reach the canonical state. `ctx` is the harness's live state, read through
// getters because the browser and the tabs only exist once the run has started.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

export function createScenarios(ctx) {
  const { services, proxy, locked, readExo, log, regressionResults, withExo } = ctx;
  const TICKET_TTL_S = Number(process.env.HARNESS_TICKET_TTL ?? 60);
  return {
    'collab-restart': {
      offline: true,
      run: () => services.restart('collab', { downMs: 3000 }),
    },
    'api-restart': {
      run: () => services.restart('api', { downMs: 3000 }),
    },
    deploy: {
      // The order and the gaps of deploy.sh step 6: api, collaboration, web.
      offline: true,
      run: async () => {
        await services.restart('api', { downMs: 2000 });
        await services.restart('collab', { downMs: 2000 });
        await services.restart('web', { downMs: 2000 });
      },
    },
    'crash-collab': {
      offline: true,
      run: () => services.restart('collab', { signal: 'SIGKILL', downMs: 5000 }),
    },
    'kill-sockets': {
      run: async () => {
        proxy.killUpgraded('collab', 'rst');
        proxy.killUpgraded('realtime', 'rst');
      },
    },
    'upgrade-502': {
      offline: true,
      run: async () => {
        proxy.setFault(['collab', 'realtime'], '502');
        proxy.killUpgraded('collab', 'rst');
        proxy.killUpgraded('realtime', 'rst');
        await sleep(30_000);
        proxy.setFault(['collab', 'realtime'], 'pass');
      },
    },
    'ticket-expiry': {
      // Longer than a ticket lives, so the first reconnect must not replay one.
      offline: true,
      run: async () => {
        proxy.setFault('collab', '502');
        proxy.killUpgraded('collab', 'rst');
        await sleep((TICKET_TTL_S + 10) * 1000);
        proxy.setFault('collab', 'pass');
      },
    },
    'ticket-hang': {
      run: async () => {
        proxy.setFault('ticket', 'hang');
        proxy.killUpgraded('collab', 'rst');
        await sleep(30_000);
        proxy.setFault('ticket', 'pass');
      },
    },
    'api-502': {
      run: async () => {
        proxy.setFault(['api', 'ticket', 'realtime', 'realtime-poll'], '502');
        proxy.killUpgraded('collab', 'rst');
        proxy.killUpgraded('realtime', 'rst');
        await sleep(30_000);
        proxy.clearFaults();
      },
    },
    'long-outage': {
      // Past two revive delays (20 s, 40 s) and into the 80 s one.
      offline: true,
      run: async () => {
        await services.stop('collab');
        await services.stop('api');
        await sleep(90_000);
        await services.start('collab');
        await services.start('api');
      },
    },
    'background-deploy': {
      // The tab is in the background for the whole outage and comes back after.
      offline: false,
      run: async () => {
        if (withExo)
          await locked(async () => {
            await ctx.fx.driver.switchTo().window(ctx.exoTabs[0]);
            await ctx.fx.driver.switchTo().newWindow('tab');
            ctx.backgroundHandle = await ctx.fx.driver.getWindowHandle();
            await ctx.fx.driver.get('about:blank');
          });
        await services.restart('api', { downMs: 5000 });
        await services.restart('collab', { downMs: 20_000 });
        await sleep(30_000);
        if (withExo)
          await locked(async () => {
            await ctx.fx.driver.switchTo().window(ctx.backgroundHandle);
            await ctx.fx.driver.close();
            ctx.backgroundHandle = null;
            await ctx.fx.driver.switchTo().window(ctx.exoTabs[0]);
          });
      },
    },
    'wake-after-close': {
      // The regression case for retireProvider: the socket closes, and within
      // the provider's one-second reconnect delay the tab becomes visible again,
      // so the wake handler destroys the provider exactly inside that window.
      // Before the fix the destroyed provider reconnected on its own and the
      // page held two collaboration sockets until the server timed one out.
      regression: 'collab',
      run: async () => {
        if (!withExo) {
          proxy.killUpgraded('collab', 'rst');
          return;
        }
        await locked(async () => {
          await ctx.fx.driver.switchTo().window(ctx.exoTabs[0]);
          await ctx.fx.driver.switchTo().newWindow('tab');
          ctx.backgroundHandle = await ctx.fx.driver.getWindowHandle();
          proxy.killUpgraded('collab', 'rst');
          await sleep(300);
          await ctx.fx.driver.close();
          ctx.backgroundHandle = null;
          await ctx.fx.driver.switchTo().window(ctx.exoTabs[0]);
        });
        const until = now() + 15_000;
        let maxCollab = 0;
        while (now() < until) {
          const state = await readExo(ctx.exoTabs[0]);
          maxCollab = Math.max(maxCollab, state.page?.liveByPath?.collab ?? 0);
          await sleep(250);
        }
        regressionResults.push({
          cycle: ctx.cycle,
          scenario: 'wake-after-close',
          maxLiveCollabSockets: maxCollab,
          ok: maxCollab <= 1,
        });
        log('wake-after-close', { maxLiveCollabSockets: maxCollab });
      },
    },
    'accept-drop': {
      // Every handshake succeeds and dies before the first message, for 20 s.
      // In the provider that path clears the retry canceller on `open` and
      // schedules a second `connect()` on `close`, so two retry loops overlap.
      run: async () => {
        proxy.setFault('collab', 'accept-drop');
        proxy.killUpgraded('collab', 'rst');
        await sleep(20_000);
        proxy.setFault('collab', 'pass');
      },
    },
    flapping: {
      run: async () => {
        for (let i = 0; i < 5; i += 1) {
          proxy.killUpgraded('collab', 'rst');
          proxy.killUpgraded('realtime', 'rst');
          await sleep(2000);
        }
        proxy.setFault(['collab', 'realtime'], '502');
        await sleep(5000);
        proxy.setFault(['collab', 'realtime'], 'pass');
      },
    },
  };
}
