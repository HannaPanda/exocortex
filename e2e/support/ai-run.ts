import { appendFileSync } from 'node:fs';

import { expect, type Page } from '@playwright/test';

/**
 * How long an AI run is given in the browser (issue #90).
 *
 * These numbers used to be `60_000` written out at four call sites, and the one
 * in `chats.spec.ts` went red in the full run on 2026-09-19 while the same test
 * passed on its own a minute later. A run here is a real call to a real
 * provider: its duration depends on provider load, on the model and on how many
 * tool turns the loop takes before it answers, none of which the suite
 * controls. A limit therefore has to sit far above the normal case, and what it
 * still catches is a run that never finishes at all -- a stuck worker, a lost
 * socket event -- not a provider having a slow minute.
 *
 * Measured over four full runs on 2026-09-20, against the live deployment and
 * OpenRouter:
 *
 * | label                  | n | min    | max    |
 * | ---------------------- | - | ------ | ------ |
 * | `chats:first-question` | 4 | 28.0 s | 39.1 s |
 * | `ai:stream-total`      | 4 | 16.3 s | 31.0 s |
 * | `ai:ask`               | 8 | 5.3 s  | 12.9 s |
 *
 * So the normal case is under 40 seconds, the known bad case is over 60, and
 * the limit below is three times the worst thing that has been seen and four
 * and a half times the worst thing that has been measured. Re-measure
 * before changing it: `E2E_MEASURE_FILE=<path> pnpm test:e2e` appends one JSON
 * line per run to that file, and `E2E_MEASURE=1` additionally lifts every limit
 * out of the way so a measuring run records real durations rather than the
 * limit it was about to hit.
 */
const measuring = process.env.E2E_MEASURE === '1';

/** The run has been accepted and the indicator has appeared. */
export const AI_RUN_START_TIMEOUT_MS = 30_000;

/** The indicator has gone again: the run finished, failed or was cut off. */
export const AI_RUN_FINISH_TIMEOUT_MS = measuring ? 300_000 : 180_000;

/**
 * What a test that waits for AI runs gives itself, in place of the suite's
 * ordinary 90 seconds. Several runs plus the rest of a loop have to fit: the
 * `/clear` test spends two, and `chats.spec.ts` needs about six seconds beyond
 * its one run for the search, the reading, the continuing and the deleting.
 */
export const AI_TEST_TIMEOUT_MS = measuring ? 900_000 : 600_000;

/** Records one measured duration; does nothing unless a target file is named. */
export function recordAiRun(label: string, milliseconds: number): void {
  const target = process.env.E2E_MEASURE_FILE;
  if (target === undefined || target.length === 0) return;
  const line = JSON.stringify({ label, milliseconds, at: new Date().toISOString() });
  appendFileSync(target, `${line}\n`);
}

/**
 * Waits for the run that was just sent to start and to finish, and answers with
 * how long the finish took. The composer stays disabled for the whole run, so
 * this is also the gate that keeps the next message from being swallowed.
 */
export async function waitForAiRun(page: Page, label: string): Promise<number> {
  const activity = page.getByTestId('ai-run-activity');
  await expect(activity).toBeVisible({ timeout: AI_RUN_START_TIMEOUT_MS });
  const startedAt = Date.now();
  await expect(activity).toBeHidden({ timeout: AI_RUN_FINISH_TIMEOUT_MS });
  const elapsed = Date.now() - startedAt;
  recordAiRun(label, elapsed);
  return elapsed;
}
