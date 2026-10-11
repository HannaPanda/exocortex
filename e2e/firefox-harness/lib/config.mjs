// Addresses and paths of the harness (issue #166). Mirrors ports.sh.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = (name, fallback) => process.env[name] ?? fallback;

export const HARNESS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const ROOT_DIR = path.resolve(HARNESS_DIR, '../..');
export const BIN_DIR = path.join(HARNESS_DIR, '.bin');

export const HOST = env('HARNESS_HOST', '127.0.0.1');
export const PROXY_PORT = Number(env('HARNESS_PROXY_PORT', 4310));
export const API_PORT = Number(env('HARNESS_API_PORT', 4311));
export const COLLAB_PORT = Number(env('HARNESS_COLLAB_PORT', 4312));
export const WEB_PORT = Number(env('HARNESS_WEB_PORT', 4313));
export const CONTROL_HOST = env('HARNESS_CONTROL_HOST', '127.0.0.2');
export const CONTROL_PORT = Number(env('HARNESS_CONTROL_PORT', 4320));
export const PG_PORT = Number(env('HARNESS_PG_PORT', 5437));
export const REDIS_PORT = Number(env('HARNESS_REDIS_PORT', 6384));

export const ORIGIN = `http://${HOST}:${PROXY_PORT}`;
export const CONTROL_ORIGIN = `http://${CONTROL_HOST}:${CONTROL_PORT}`;
export const DATABASE_URL = `postgresql://ffharness:ffharness@127.0.0.1:${PG_PORT}/ffharness?schema=public`;
export const REDIS_URL = `redis://127.0.0.1:${REDIS_PORT}`;

/** Ports a harness URL may never point at: the deployment's own. */
export const PRODUCTION_PORTS = new Set([3210, 3211, 3212, 5433, 6380, 9110]);

export const TEST_USER = {
  email: 'firefox-harness@exocortex.test',
  name: 'Firefox Harness',
  workspace: 'Firefox Harness',
};

/**
 * The environment every harness service starts with. Complete on purpose: the
 * services run with a working directory outside the repository, so
 * `loadDotEnv` finds no `.env`, and anything missing here is missing rather
 * than silently taken from production.
 */
export function serviceEnvironment() {
  for (const port of [API_PORT, COLLAB_PORT, WEB_PORT, PROXY_PORT, PG_PORT, REDIS_PORT]) {
    if (PRODUCTION_PORTS.has(port)) throw new Error(`harness port ${port} is a production port`);
  }
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'production',
    LOG_LEVEL: env('HARNESS_LOG_LEVEL', 'warn'),
    APP_URL: ORIGIN,
    BETTER_AUTH_URL: ORIGIN,
    BETTER_AUTH_SECRET: 'firefox-harness-secret-not-a-real-one-000000',
    PUBLIC_API_URL: ORIGIN,
    PUBLIC_COLLABORATION_URL: `ws://${HOST}:${PROXY_PORT}/collab`,
    DATABASE_URL,
    REDIS_URL,
    API_PORT: String(API_PORT),
    COLLABORATION_PORT: String(COLLAB_PORT),
    COLLABORATION_INTERNAL_URL: `http://127.0.0.1:${COLLAB_PORT}`,
    COLLABORATION_TICKET_SECRET: 'firefox-harness-ticket-secret-not-real-0000',
    COLLABORATION_TICKET_TTL_SECONDS: env('HARNESS_TICKET_TTL', '60'),
    // Nothing listens on port 1: an attachment or a mail fails instead of
    // reaching the deployment's bucket or relay.
    S3_ENDPOINT: 'http://127.0.0.1:1',
    S3_BUCKET: 'ffharness',
    S3_ACCESS_KEY_ID: 'ffharness',
    S3_SECRET_ACCESS_KEY: 'ffharness',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1',
    SMTP_FROM: 'harness@exocortex.test',
    AI_PROVIDER: 'mock',
    OTEL_TRACES_ENABLED: 'false',
  };
}
