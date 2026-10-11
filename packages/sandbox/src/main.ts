import { createBroker } from './broker';
import { DEFAULT_SANDBOX_SOCKET } from './client';

/**
 * The broker's process (`exocortex-sandbox.service`).
 *
 * On a deployment systemd owns the socket (`exocortex-sandbox.socket`) and
 * hands it over as file descriptor 3, which is what lets the socket belong to
 * the worker's group while the process runs as its own user. Without socket
 * activation -- `pnpm --filter @exocortex/sandbox start` on a development
 * machine -- it listens on `EXOCORTEX_SANDBOX_SOCKET` itself.
 */
const SYSTEMD_FIRST_FD = 3;

const broker = createBroker();

if (process.env.LISTEN_FDS === '1' && process.env.LISTEN_PID === String(process.pid)) {
  broker.server.listen({ fd: SYSTEMD_FIRST_FD });
} else {
  broker.server.listen(process.env.EXOCORTEX_SANDBOX_SOCKET ?? DEFAULT_SANDBOX_SOCKET);
}

broker.server.on('listening', () => {
  process.stdout.write(`${JSON.stringify({ event: 'sandbox.listening' })}\n`);
});

const shutdown = (): void => {
  broker.stopAll();
  broker.server.close();
  // Give `docker kill` a moment to reach the daemon before the cgroup goes.
  setTimeout(() => process.exit(0), 2_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
