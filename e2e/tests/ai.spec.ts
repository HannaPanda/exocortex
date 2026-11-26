import { expect, test } from '@playwright/test';

import {
  AI_RUN_FINISH_TIMEOUT_MS,
  AI_TEST_TIMEOUT_MS,
  recordAiRun,
  waitForAiRun,
} from '../support/ai-run';
import { createPage, requireSeedCredentials, waitForMaterialization } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

// Reuse the session created by the global setup instead of logging in again:
// sign-in is rate limited by design.
test.use({ storageState: storageStatePath('johanna') });

/**
 * What the runner *declared* the deployment's provider to be, if anything.
 *
 * `AI_PROVIDER` is read by the worker, out of the server's `.env`. The
 * Playwright process does not load that file, so this used to default to
 * `'mock'` and then assert the mock's echo against a deployment happily
 * running OpenRouter: a green pipeline's worth of nothing, and a red test for
 * an answer that was entirely correct.
 *
 * Absent now means "read it off the answer" instead of guessing, and a
 * declared `mock` is enforced rather than assumed.
 */
const declaredProvider = process.env.AI_PROVIDER ?? null;

/** The mock names itself in every answer it writes; no real provider does. */
const MOCK_MARKER = 'Mock-Anbieters';

test.beforeAll(() => {
  requireSeedCredentials();
});

test.describe('AI side panel', () => {
  test('streams a response through the realtime channel', async ({ page }) => {
    // Waits for one real provider call (issue #90).
    test.setTimeout(AI_TEST_TIMEOUT_MS);
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    await createPage(page, `KI ${Date.now().toString(36)}`);

    await page.getByTestId('context-tab-ai').click();
    await page.getByTestId('ai-input').fill('Was ist eXocortex?');
    await page.getByTestId('ai-send').click();

    // Whether the model calls a tool before it answers is the model's decision,
    // not this deployment's, so nothing here may depend on it (issue #87).
    // Pinning `.first()` used to do exactly that: with a tool call the first
    // assistant message is the call itself, and the answer stands in the
    // second. Measuring every bubble at once is independent of how many turns
    // the model took to get there.
    const answers = page.getByTestId('ai-answer');
    const visibleAnswerLength = async (): Promise<number> =>
      (await answers.allInnerTexts()).join('').trim().length;
    const activity = page.getByTestId('ai-run-activity');

    const sentAt = Date.now();
    await expect(answers.first()).toBeVisible({ timeout: AI_RUN_FINISH_TIMEOUT_MS });
    // Text arrives at all: the run reached the worker, the provider and the
    // socket back into this browser.
    await expect
      .poll(visibleAnswerLength, { timeout: AI_RUN_FINISH_TIMEOUT_MS })
      .toBeGreaterThan(0);
    recordAiRun('ai:stream-first-text', Date.now() - sentAt);

    // The visible text only ever grows while the run is live: a re-render that
    // fell back to an earlier buffer, or a streamed bubble replaced by a
    // shorter persisted one, would show up between two samples here.
    const deadline = Date.now() + AI_RUN_FINISH_TIMEOUT_MS;
    let seen = await visibleAnswerLength();
    while (Date.now() < deadline && (await activity.isVisible())) {
      const current = await visibleAnswerLength();
      expect(current).toBeGreaterThanOrEqual(seen);
      seen = current;
      await page.waitForTimeout(250);
    }

    // Judge who answered only once the run is over, so a marker that has
    // merely not streamed in yet is never read as "a real provider". The
    // answer is the last bubble: anything the model said before a tool call
    // stands above it.
    await expect(activity).toBeHidden({ timeout: AI_RUN_FINISH_TIMEOUT_MS });
    recordAiRun('ai:stream-total', Date.now() - sentAt);
    const answer = answers.last();
    const servedByMock =
      declaredProvider === 'mock' ||
      (declaredProvider === null && (await answer.innerText()).includes(MOCK_MARKER));

    if (servedByMock) {
      // The mock echoes the question back, which proves the payload reached it
      // intact. A declared mock that stops echoing fails here rather than
      // quietly dropping to the weaker assertions above.
      await expect(answer).toContainText('Was ist eXocortex?', { timeout: 60_000 });
      await expect(answer).toContainText(MOCK_MARKER, { timeout: 60_000 });
    }
  });

  /**
   * Issue #195, ADR-087: the thinking arrives live, only in the asker's
   * browser, and folds above the answer once the run is over.
   *
   * Depends on the deployment's default model streaming its reasoning, which
   * DeepSeek V4.1 Flash does on OpenRouter and on Cline (measured 2026-10-14).
   * A default model that does not stream any fails here by name rather than
   * passing on activities alone, because then this test no longer proves what
   * it is about.
   */
  test('shows the model thinking live and folds it above the answer', async ({ page }) => {
    test.setTimeout(AI_TEST_TIMEOUT_MS);
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    await createPage(page, `Denken ${Date.now().toString(36)}`);

    await page.getByTestId('context-tab-ai').click();
    // A new conversation starts at "aus", which since 2026-10-14 really is no
    // thinking; ask for some, the way a person would.
    await page.getByTestId('ai-input').fill('/think low');
    await page.getByTestId('ai-send').click();
    await expect(page.getByTestId('ai-input')).toHaveValue('', { timeout: 30_000 });
    await page
      .getByTestId('ai-input')
      .fill(
        'Ein Zug fährt um 9:14 los und braucht 2 h 53 min mit 17 min Verspätung. Ein zweiter fährt 41 min später und ist 12 % schneller. Wer ist zuerst da? Antworte in einem Satz, ohne Werkzeuge.',
      );
    // Watched from inside the page: at low effort the thinking can arrive in
    // one burst a few hundred milliseconds before the run ends (measured
    // 2026-11-26), which a polling `expect` steps over. A mutation observer
    // sees every frame, so "it was there while the run was live" is a fact
    // rather than a race.
    await page.evaluate(() => {
      // The e2e workspace compiles without the DOM library, so the page's
      // globals are named here (see `narrow-and-touch.spec.ts`).
      interface PageGlobals {
        __thinkingSeenLive?: boolean;
        document: { body: object; querySelector: (selector: string) => object | null };
        MutationObserver: new (callback: () => void) => {
          observe: (target: object, options: { childList: boolean; subtree: boolean }) => void;
        };
      }
      const globals = globalThis as unknown as PageGlobals;
      globals.__thinkingSeenLive = false;
      const check = (): void => {
        const live = globals.document.querySelector('[data-testid="ai-run-activity"]') !== null;
        const thinking =
          globals.document.querySelector('[data-testid="ai-run-trace-reasoning"]') !== null;
        if (live && thinking) globals.__thinkingSeenLive = true;
      };
      new globals.MutationObserver(check).observe(globals.document.body, {
        childList: true,
        subtree: true,
      });
    });
    await page.getByTestId('ai-send').click();

    const trace = page.getByTestId('ai-run-trace');
    const toggle = page.getByTestId('ai-run-trace-toggle');
    await expect(page.getByTestId('ai-run-activity')).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (globalThis as unknown as { __thinkingSeenLive?: boolean }).__thinkingSeenLive ===
              true,
          ),
        {
          message: 'the default model streamed no reasoning; see the comment above this test',
          timeout: AI_RUN_FINISH_TIMEOUT_MS,
        },
      )
      .toBe(true);
    // Thinking that arrived names the trace. Its open state is not asked
    // here: a one-sentence answer can be over, and the trace folded, between
    // two assertions.
    await expect(toggle).toContainText('Gedankengang');

    // The run may well be over by now: a one-sentence answer takes a few
    // seconds, and `waitForAiRun` would wait for an activity that already
    // came and went.
    await expect(page.getByTestId('ai-run-activity')).toBeHidden({
      timeout: AI_RUN_FINISH_TIMEOUT_MS,
    });
    // Folded once the run is over, and standing right above the answer.
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('ai-run-trace-reasoning')).toHaveCount(0);
    await expect(trace).toHaveCount(1);
    const traceBox = await trace.boundingBox();
    const answerBox = await page.getByTestId('ai-answer').last().boundingBox();
    expect(traceBox !== null && answerBox !== null && traceBox.y < answerBox.y).toBe(true);

    await toggle.click();
    await expect(page.getByTestId('ai-run-trace-reasoning').first()).toBeVisible();
    await expect(trace).toContainText('nicht gespeichert');
  });

  /**
   * Issue #242: the transcript follows an answer only until the reader
   * scrolls up, and two jumps lead back to the start of the answer and to
   * the end. The answer is long on purpose, so that it outgrows the panel
   * while it is still arriving.
   */
  test('stops following when the reader scrolls up, and jumps back', async ({ page }) => {
    test.setTimeout(AI_TEST_TIMEOUT_MS);
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    await createPage(page, `Mitlesen ${Date.now().toString(36)}`);

    await page.getByTestId('context-tab-ai').click();
    await page
      .getByTestId('ai-input')
      .fill(
        'Schreibe eine nummerierte Liste mit 60 Punkten, je ein Satz über Wolken. Ohne Werkzeuge, ohne Einleitung.',
      );
    await page.getByTestId('ai-send').click();

    const transcript = page.getByTestId('ai-transcript');
    const metrics = (): Promise<{ top: number; distance: number; overflow: number }> =>
      transcript.evaluate((element) => ({
        top: element.scrollTop,
        distance: element.scrollHeight - element.scrollTop - element.clientHeight,
        overflow: element.scrollHeight - element.clientHeight,
      }));

    // Following: while the answer outgrows the panel, the end stays in view.
    await expect
      .poll(async () => (await metrics()).overflow, { timeout: AI_RUN_FINISH_TIMEOUT_MS })
      .toBeGreaterThan(400);
    await expect.poll(async () => (await metrics()).distance).toBeLessThan(40);
    await expect(page.getByTestId('ai-jump-end')).toBeHidden();

    // The reader scrolls up: the position stays where they put it. A wheel,
    // because a position set from a script is not a reader and does not stop
    // the transcript from following.
    await transcript.hover();
    await page.mouse.wheel(0, -100_000);
    await expect(page.getByTestId('ai-jump-end')).toBeVisible();
    await page.waitForTimeout(1_500);
    expect((await metrics()).top).toBeLessThan(5);

    // Back to the end, which follows again.
    await page.getByTestId('ai-jump-end').click();
    await expect.poll(async () => (await metrics()).distance).toBeLessThan(40);
    await expect(page.getByTestId('ai-jump-end')).toBeHidden();

    await expect(page.getByTestId('ai-run-activity')).toBeHidden({
      timeout: AI_RUN_FINISH_TIMEOUT_MS,
    });

    // A little way up, the start of the answer lies above: one jump to it.
    await transcript.hover();
    await page.mouse.wheel(0, -300);
    const toStart = page.getByTestId('ai-jump-answer-start');
    await expect(toStart).toBeVisible();
    await toStart.click();
    await expect
      .poll(async () => {
        const question = await page.getByTestId('ai-question').last().boundingBox();
        const box = await transcript.boundingBox();
        return question !== null && box !== null ? Math.abs(question.y - box.y) : 999;
      })
      .toBeLessThan(40);
  });

  /**
   * Issue #282: a reader who chose to stay at the answer's start sees the
   * question brought to the top once, and then the view stays put while a
   * long answer grows out of sight below it, also when the run ends and the
   * panel below the transcript changes. The choice is made in the panel's
   * menu and lands on the account, which is put back afterwards, because the
   * test above expects the default.
   */
  test.describe('staying at the answer start', () => {
    test.afterEach(async ({ request, baseURL }) => {
      await request.patch('/api/me/preferences', {
        data: { chatScroll: 'follow' },
        headers: { origin: baseURL as string },
      });
    });

    test('brings the question to the top once and stays there', async ({ page }) => {
      test.setTimeout(AI_TEST_TIMEOUT_MS);
      await page.goto('/arbeitsbereich');
      await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
      await createPage(page, `Antwortanfang ${Date.now().toString(36)}`);

      await page.getByTestId('context-tab-ai').click();
      await page.getByTestId('ai-panel-menu').click();
      const toggle = page.getByTestId('ai-stay-at-answer-start');
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('Escape');
      await expect
        .poll(async () => {
          const response = await page.request.get('/api/me/preferences');
          return ((await response.json()) as { chatScroll: string }).chatScroll;
        })
        .toBe('answerStart');

      await page
        .getByTestId('ai-input')
        .fill(
          'Schreibe eine nummerierte Liste mit 60 Punkten, je ein Satz über Wolken. Ohne Werkzeuge, ohne Einleitung.',
        );
      await page.getByTestId('ai-send').click();

      const transcript = page.getByTestId('ai-transcript');
      const question = page.getByTestId('ai-question').last();
      /** How far the question stands below the transcript's upper edge. */
      const questionOffset = async (): Promise<number> => {
        const box = await question.boundingBox();
        const frame = await transcript.boundingBox();
        return box !== null && frame !== null ? box.y - frame.y : 999;
      };
      const below = (): Promise<number> =>
        transcript.evaluate(
          (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
        );

      // The question goes to the top once it is there ...
      await expect.poll(questionOffset, { timeout: AI_RUN_FINISH_TIMEOUT_MS }).toBeLessThan(40);
      await expect.poll(questionOffset).toBeGreaterThanOrEqual(0);

      // ... and stays there while the answer grows out of sight below it.
      await expect.poll(below, { timeout: AI_RUN_FINISH_TIMEOUT_MS }).toBeGreaterThan(300);
      expect(await questionOffset()).toBeLessThan(40);
      await expect(page.getByTestId('ai-jump-end')).toBeVisible();

      // The run ends, the activity line goes and the trace folds: the
      // question has not moved.
      await expect(page.getByTestId('ai-run-activity')).toBeHidden({
        timeout: AI_RUN_FINISH_TIMEOUT_MS,
      });
      await page.waitForTimeout(500);
      expect(Math.abs(await questionOffset())).toBeLessThan(40);

      // The end is one press away, as in the other mode.
      await page.getByTestId('ai-jump-end').click();
      await expect.poll(below).toBeLessThan(40);
    });
  });

  test('keeps quiet while a fast background job is materialized', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    // `createPage` returns only once the collaboration socket is connected;
    // without that the keystrokes below would land before the Yjs provider is
    // there, nothing would be persisted and no job would ever be enqueued.
    const documentId = await createPage(page, `Fortschritt ${Date.now().toString(36)}`);
    const marker = `hintergrundjob${Date.now().toString(36)}`;
    await page.getByTestId('editor-surface').click();
    await page.keyboard.type(`Diese Änderung löst einen Hintergrundjob aus: ${marker}.`);

    // The indicator is deliberately silent for a job that succeeds quickly:
    // `job-progress.tsx` waits `SHOW_DELAY_MS` (1s) before revealing anything
    // and cancels that reveal on `job.completed`, so a materialization that
    // takes tens of milliseconds must never flash a card. This used to assert
    // the opposite and had been failing ever since that rule was introduced.
    //
    // A window several times the reveal delay: if the card were coming, it
    // would be here.
    const appeared = await page
      .waitForSelector('[data-testid="job-progress"]', { state: 'attached', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    expect(appeared).toBe(false);

    // Without this the assertion above would also pass for a pipeline that did
    // nothing at all. The derived Markdown is the job's own output, so it
    // proves the job really ran and really finished.
    await waitForMaterialization(page, documentId, marker);
  });

  test('draws the /clear cut where it happened and never stacks it', async ({ page }) => {
    // Waits for two real provider calls (issue #90).
    test.setTimeout(AI_TEST_TIMEOUT_MS);
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    await createPage(page, `Schnitt ${Date.now().toString(36)}`);
    await page.getByTestId('context-tab-ai').click();

    const boundary = page.getByTestId('ai-context-boundary');

    /** Sends a question and returns once its run has finished. */
    const ask = async (content: string): Promise<void> => {
      await page.getByTestId('ai-input').fill(content);
      await page.getByTestId('ai-send').click();
      // The composer stays disabled for the whole run, so this is also the
      // gate that keeps the next `/clear` from being swallowed.
      await waitForAiRun(page, 'ai:ask');
    };

    /** Sends a slash command, which starts no run. */
    const command = async (content: string): Promise<void> => {
      await page.getByTestId('ai-input').fill(content);
      await page.getByTestId('ai-send').click();
    };

    await ask('Erste Frage.');
    await command('/clear');
    await expect(boundary).toHaveCount(1, { timeout: 30_000 });
    await expect(boundary).toContainText('Kontext geleert');

    // The cut stays where it was made: the next question appears *below* it,
    // which is the part that used to be wrong (issue #25).
    await ask('Zweite Frage.');
    await expect(page.getByTestId('ai-question')).toHaveCount(2, { timeout: 30_000 });
    await expect(boundary).toHaveCount(1);
    // Cuts and questions in document order: the newest question has to be the
    // last of them, i.e. below the cut rather than above it.
    const cutsAndQuestions = page.locator(
      '[data-testid="ai-context-boundary"], [data-testid="ai-question"]',
    );
    await expect(cutsAndQuestions.last()).toHaveAttribute('data-testid', 'ai-question');

    // A second `/clear` moves the single cut along instead of adding one.
    await command('/clear');
    await expect(boundary).toHaveCount(1, { timeout: 30_000 });
  });

  test('summarises the history on /compact although the window is nearly empty', async ({
    page,
  }) => {
    // One answer and one summary, both real provider calls (issue #287).
    test.setTimeout(AI_TEST_TIMEOUT_MS);
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    await createPage(page, `Verdichten ${Date.now().toString(36)}`);
    await page.getByTestId('context-tab-ai').click();

    await page.getByTestId('ai-input').fill('Nenne drei Farben.');
    await page.getByTestId('ai-send').click();
    await waitForAiRun(page, 'ai:ask');

    await page.getByTestId('ai-input').fill('/compact');
    await page.getByTestId('ai-send').click();
    // The command says it started and that it was not needed yet: one
    // question is nowhere near the automatic threshold.
    const transcript = page.getByTestId('ai-transcript');
    await expect(transcript).toContainText('zusammengefasst', { timeout: 30_000 });
    await expect(transcript).toContainText('Nötig gewesen wäre das noch nicht');

    // The summary arrives from the worker and takes the old messages' place
    // in the context; the cut above it says so, not "Kontext geleert".
    const boundary = page.getByTestId('ai-context-boundary');
    await expect(boundary).toHaveCount(1, { timeout: AI_RUN_FINISH_TIMEOUT_MS });
    await expect(boundary).toContainText('Älterer Verlauf zusammengefasst');
    // And the composer, held while the summary was written, is free again.
    await expect(page.getByTestId('ai-input')).toBeEnabled({ timeout: 30_000 });
  });

  /**
   * The promise the chip row makes (issue #75): a pinned source stays until it
   * is taken away, which is exactly what tells it apart from the open page.
   * Only a browser can check that, because "walking to another page" is a route
   * change and a re-render, not a function call.
   */
  test('keeps a pinned source across a page switch and drops it on demand', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });

    const suffix = Date.now().toString(36);
    const pinnedTitle = `Quelle ${suffix}`;
    await createPage(page, pinnedTitle);
    const otherTitle = `Anderswo ${suffix}`;
    await createPage(page, otherTitle);

    await page.getByTestId('context-tab-ai').click();
    await page.getByTestId('ai-pin-add').click();
    await page.getByPlaceholder('Seite, Datenbank oder gespeicherte Suche').fill(pinnedTitle);
    // The title reaches the search index through materialization and the
    // indexing job, so the entry appears a moment after the page does.
    const entry = page.getByRole('option', { name: new RegExp(pinnedTitle) });
    await expect(entry.first()).toBeVisible({ timeout: 60_000 });
    await entry.first().click();

    const chips = page.getByTestId('ai-pinned-chip');
    await expect(chips).toHaveCount(1, { timeout: 30_000 });
    await expect(chips.first()).toContainText(pinnedTitle);
    // Pinned as a name first: nothing is paid for until that is chosen.
    await expect(chips.first()).toContainText('nur genannt');

    // The point of the feature: another page, same chip.
    await page.getByRole('link', { name: otherTitle }).first().click();
    await page.waitForURL(/\/seite\/[a-z0-9]+/, { timeout: 30_000 });
    await page.getByTestId('context-tab-ai').click();
    await expect(chips).toHaveCount(1, { timeout: 30_000 });
    await expect(chips.first()).toContainText(pinnedTitle);

    // Switching the mode is what makes it cost something, and the chip says so.
    await page.getByTestId('ai-pinned-menu').first().click();
    await page.getByTestId('ai-pinned-mode-item').click();
    await expect(chips.first()).not.toContainText('nur genannt', { timeout: 30_000 });

    await page.getByTestId('ai-pinned-menu').first().click();
    await page.getByTestId('ai-pinned-remove-item').click();
    await expect(chips).toHaveCount(0, { timeout: 30_000 });
  });

  /**
   * What is marked is offered, what is taken goes once (issue #249). Only a
   * browser can check it: the offer lives on ProseMirror keeping its
   * selection while the focus is in the chat, and on the chip row telling the
   * two apart.
   */
  test('offers the marked text, sends it once and forgets it afterwards', async ({ page }) => {
    // Waits for one real provider call (issue #90).
    test.setTimeout(AI_TEST_TIMEOUT_MS);
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    await createPage(page, `Markierung ${Date.now().toString(36)}`);
    await page.getByTestId('editor-surface').click();
    const passage = 'Der Satz, um den es geht.';
    await page.keyboard.type(passage);
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');

    await page.getByTestId('context-tab-ai').click();
    const offer = page.getByTestId('ai-selection-add');
    const chip = page.getByTestId('ai-selection-chip');
    // Marked is not yet taken: an offer, and nothing that would be sent.
    await expect(offer).toContainText(passage, { timeout: 15_000 });
    await expect(chip).toHaveCount(0);

    await offer.click();
    await expect(chip).toContainText(passage);
    await expect(offer).toHaveCount(0);

    // Removable before sending, and the marked text is offered again.
    await page.getByTestId('ai-selection-remove').click();
    await expect(chip).toHaveCount(0);
    await expect(offer).toBeVisible();
    await offer.click();

    await page.getByTestId('ai-input').fill('Was meint dieser Satz?');
    await page.getByTestId('ai-send').click();
    // In the transcript, before the question it belongs to.
    await expect(page.getByTestId('ai-transcript')).toContainText('Ausgewählter Abschnitt', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('ai-transcript')).toContainText(passage);
    // One hand-over, one message: neither chip nor offer for the next one.
    await expect(chip).toHaveCount(0);
    await expect(offer).toHaveCount(0);
    await waitForAiRun(page, 'ai:ask');
  });
});
