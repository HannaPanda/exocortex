/**
 * The guard that stands between an integration test and the live deployment.
 *
 * Loaded as a `setupFiles` entry by every workspace that has integration tests.
 * It runs before each test file in that workspace, decides from the file name
 * whether the file is allowed to touch infrastructure at all, and for the ones
 * that are, refuses the run unless the connection it would open is the
 * throwaway stack from `docker-compose.test.yml`.
 *
 * Why the check is an equality against an exported URL rather than a blocklist
 * of production hosts: a blocklist has to be right about every address this
 * deployment might ever use, and it is wrong the day one is added. The runner
 * knows exactly which database it just created, so it says so -- and anything
 * that is not literally that database is refused, whatever it is. A test run
 * that was started by hand has nothing exported, fails the first check, and is
 * told which script to use.
 *
 * It cannot be satisfied by accident. `EXOCORTEX_TEST_INFRA` is set nowhere but
 * in `scripts/test-integration.sh`, and it is deliberately not read from `.env`
 * -- `loadDotEnv` never overwrites a variable that is already set, which is the
 * same property that lets the runner's URLs win over the repository's.
 */
import { beforeAll, expect } from 'vitest';

/** Set by `scripts/test-integration.sh`, and by nothing else. */
const INFRA_FLAG = 'EXOCORTEX_TEST_INFRA';

/**
 * The database the throwaway Postgres is created with. Checked in addition to
 * the URL equality below, so that a hand-assembled pair of variables still
 * cannot name the deployment's database.
 */
const REQUIRED_DATABASE_NAME = 'exocortex_test';

const START = 'Run them with `pnpm test:integration`, which brings up the throwaway stack';
const WHY =
  'An integration test opens a real connection, and on this host the repository ' +
  'configuration points at the live database and the live Redis.';

function refuse(reason: string): never {
  throw new Error(
    `Integration tests refused: ${reason}\n\n${WHY}\n${START}, migrates it and removes it again.`,
  );
}

function databaseNameOf(url: string): string | null {
  try {
    // `URL` parses a postgres:// address fine; the path is `/<database>`.
    return new URL(url).pathname.replace(/^\//, '') || null;
  } catch {
    return null;
  }
}

/**
 * Vitest hands the setup file the path of the test file it is setting up. A
 * file that needs no infrastructure is none of this guard's business, and most
 * files in these workspaces are that kind.
 */
function isIntegrationTestFile(): boolean {
  const path = expect.getState().testPath;
  if (typeof path !== 'string') {
    // Defensive: a Vitest that stops reporting the path would otherwise turn
    // the guard off silently. Better to check every file in a workspace that
    // has integration tests than to check none.
    return true;
  }
  return path.includes('.integration.test.');
}

beforeAll(() => {
  if (!isIntegrationTestFile()) return;

  if (process.env[INFRA_FLAG] !== '1') {
    refuse(
      `${INFRA_FLAG} is not set, so this run was not started against isolated infrastructure.`,
    );
  }

  const expectedDatabaseUrl = process.env.EXOCORTEX_TEST_DATABASE_URL;
  const expectedRedisUrl = process.env.EXOCORTEX_TEST_REDIS_URL;
  if (expectedDatabaseUrl === undefined || expectedRedisUrl === undefined) {
    refuse(
      `${INFRA_FLAG} is set but EXOCORTEX_TEST_DATABASE_URL / EXOCORTEX_TEST_REDIS_URL are not. ` +
        'The flag alone proves nothing about where the connection goes.',
    );
  }

  if (process.env.DATABASE_URL !== expectedDatabaseUrl) {
    refuse('DATABASE_URL is not the throwaway database the test stack created.');
  }
  if (process.env.REDIS_URL !== expectedRedisUrl) {
    refuse('REDIS_URL is not the throwaway Redis the test stack created.');
  }

  const databaseName = databaseNameOf(expectedDatabaseUrl);
  if (databaseName !== REQUIRED_DATABASE_NAME) {
    refuse(
      `the database is named "${databaseName ?? '(unparseable)'}" rather than "${REQUIRED_DATABASE_NAME}".`,
    );
  }
});
