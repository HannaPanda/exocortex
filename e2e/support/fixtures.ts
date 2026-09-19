import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
} from '@playwright/test';

import { BASIC_AUTH_CREDENTIALS } from './basic-auth';
import { loadRepositoryEnv } from './env';
import { storageStatePath } from './global-setup';

// Before `SEED_USERS` below reads them. Idempotent, and an already-set variable
// always wins.
loadRepositoryEnv();

/**
 * Shared helpers for the end-to-end suite.
 *
 * The two accounts are seeded test users in the "Exocortex Team" workspace, not
 * the person who owns the deployment: a run creates and deletes pages, and it
 * must never do that in somebody's real workspace. They are ordinary users
 * globally — `invitations.spec.ts` asserts exactly that, so making one of them a
 * global admin would break the suite rather than enable it.
 *
 * Credentials come from the environment, and the repository's `.env` is where
 * they sit on this host. Never hardcode a password here.
 */
export const SEED_USERS = {
  johanna: {
    email: 'johanna@exocortex.app',
    name: 'Johanna',
    password: process.env.SEED_JOHANNA_PASSWORD ?? '',
  },
  stefan: {
    email: 'stefan@exocortex.app',
    name: 'Stefan',
    password: process.env.SEED_STEFAN_PASSWORD ?? '',
  },
} as const;

export type SeedUserKey = keyof typeof SEED_USERS;

export function requireSeedCredentials(): void {
  for (const [key, user] of Object.entries(SEED_USERS)) {
    if (user.password.length === 0) {
      throw new Error(
        `Missing password for seed user "${key}". Put SEED_JOHANNA_PASSWORD and ` +
          'SEED_STEFAN_PASSWORD in the repository .env; `pnpm db:provision-user ' +
          '--email <address> --reset-password` issues a new one ' +
          '(see docs/local-development.md).',
      );
    }
  }
}

/** Signs in through the real login form. */
export async function signIn(page: Page, user: SeedUserKey = 'johanna'): Promise<void> {
  const credentials = SEED_USERS[user];
  await page.goto('/anmelden');
  await page.getByLabel('E-Mail-Adresse').fill(credentials.email);
  await page.getByLabel('Passwort').fill(credentials.password);
  await page.getByTestId('signin-submit').click();
  // Not a bare `/arbeitsbereich`: that URL matches the moment the form
  // redirects, but it is only a landing page that resolves the workspace and
  // replaces itself client-side (`workspace-landing.tsx`). A caller reading the
  // workspace id right after this would race that replacement and find no id.
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 30_000 });
}

/**
 * Opens a browser context that is already signed in, using the session stored by
 * the global setup. This keeps the suite off the sign-in rate limiter.
 */
export async function createSignedInContext(
  browser: Browser,
  user: SeedUserKey,
  baseURL: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL,
    storageState: storageStatePath(user),
    httpCredentials: BASIC_AUTH_CREDENTIALS,
  });
  const page = await context.newPage();
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
  return { context, page };
}

/**
 * Waits until the collaboration socket for the open document is connected.
 *
 * Typing before that point is silently lost for the pipeline: the editor takes
 * the keystrokes, but nothing is sent, nothing is persisted and no
 * materialization job is ever enqueued. A test that types and then waits for a
 * background job has to wait for this first.
 */
export async function waitForCollaboration(page: Page): Promise<void> {
  // Not the badge's label: "Verbunden" is also what a page with no document
  // open shows, so waiting for that text passed while the editor was still
  // unconnected and the keystrokes that followed went nowhere. The attribute
  // reports the collaboration channel on its own, and `none` when there is no
  // document to connect at all.
  await expect(page.getByTestId('connection-status')).toHaveAttribute(
    'data-collaboration',
    'connected',
    { timeout: 60_000 },
  );
}

/**
 * The one browser global this suite touches, typed here rather than by giving
 * the whole suite a DOM.
 *
 * Everything else in `e2e/` runs in Node, and that is deliberate: a spec that
 * could write `document.querySelector` and still typecheck would be a spec
 * that fails at run time instead of at build time. An init script genuinely
 * runs in the page, so it gets the narrow declaration it needs and no more.
 */
interface BrowserLocalStorage {
  localStorage: { setItem(key: string, value: string): void };
}

/**
 * Pins one of the two layout panels to a width before the app boots.
 *
 * Both panels are resizable, and a panel is at its most fragile at its minimum
 * width -- which is exactly the width nobody tests at, because the browser
 * opens at the comfortable default. A spec that cares about a narrow panel
 * says so here instead of dragging a handle.
 */
export async function presetPanelPreference(
  page: Page,
  storageKey: string,
  preference: { open: boolean; width: number },
): Promise<void> {
  await page.addInitScript(
    ([key, value]: [string, string]) => {
      (globalThis as unknown as BrowserLocalStorage).localStorage.setItem(key, value);
    },
    [storageKey, JSON.stringify(preference)] as [string, string],
  );
}

/** Waits until the page tree contains a node with the given title. */
export async function expectTreeContains(page: Page, title: string): Promise<void> {
  await expect(page.getByTestId('page-tree').getByText(title, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Waits for the browser to arrive at a document page that is not the one it was
 * already on.
 *
 * A bare `/\/seite\/[a-z0-9]+/` matches instantly when a document is already
 * open, so the id read straight afterwards is the *previous* document's. Calling
 * `createPage` twice in a row then returned the same id twice, and the test that
 * did so compared a page with itself.
 */
async function waitForNewDocumentUrl(page: Page, previousUrl: string): Promise<string> {
  await page.waitForURL(
    (url) => url.toString() !== previousUrl && /\/seite\/[a-z0-9]+/.test(url.pathname),
    { timeout: 30_000 },
  );
  return new URL(page.url()).pathname.split('/').pop() as string;
}

/**
 * Creates a page from the sidebar's "Anlegen" menu and returns its document id.
 *
 * The trigger (`create-root-page`) opens a menu with "Seite anlegen" and
 * "Datenbank anlegen" — see `createDatabase` below for the latter.
 *
 * Returns only once the page is genuinely usable, collaboration socket
 * included: a caller that types straight away would otherwise lose the
 * keystrokes to a provider that has not connected yet.
 */
export async function createPage(page: Page, title: string): Promise<string> {
  const previousUrl = page.url();
  await page.getByTestId('create-root-page').click();
  await page.getByTestId('create-root-page-item').click();
  const documentId = await waitForNewDocumentUrl(page, previousUrl);
  const titleInput = page.getByTestId('document-title');
  // The URL changes before Next finishes swapping in the new route's content
  // (it keeps the previous page's DOM, including its title input, visible
  // during the transition). Racing straight into `.fill()` here can land on
  // the *previous* document's still-mounted input and rename that one
  // instead. Waiting for the known default title makes sure this is really
  // the new, empty document.
  await expect(titleInput).toHaveValue('Unbenannte Seite', { timeout: 15_000 });
  await titleInput.fill(title);
  await titleInput.blur();
  await expectTreeContains(page, title);
  await waitForCollaboration(page);
  return documentId;
}

/** Creates a database (a COLLECTION document) from the sidebar and returns its document id. */
export async function createDatabase(page: Page, title: string): Promise<string> {
  const previousUrl = page.url();
  await page.getByTestId('create-root-page').click();
  await page.getByTestId('create-root-database').click();
  const documentId = await waitForNewDocumentUrl(page, previousUrl);
  const titleInput = page.getByTestId('document-title');
  // See the comment in `createPage`: wait for the new document's own default
  // title before touching the input, so a fast second creation never renames
  // whatever document was open before this one.
  await expect(titleInput).toHaveValue('Unbenannte Datenbank', { timeout: 15_000 });
  await titleInput.fill(title);
  await titleInput.blur();
  await expectTreeContains(page, title);
  // No `waitForCollaboration` here, unlike `createPage`: a database renders its
  // views rather than the editor, so it never opens a collaboration connection
  // and waiting for one would wait forever.
  return documentId;
}

/** Reads the active workspace id from the URL. */
export function workspaceIdFrom(page: Page): string {
  const match = /\/arbeitsbereich\/([a-z0-9]+)/.exec(new URL(page.url()).pathname);
  if (match === null) throw new Error(`No workspace id in URL: ${page.url()}`);
  return match[1] as string;
}

/** Signs in through the API and returns an authenticated request context. */
export async function apiSignIn(
  request: APIRequestContext,
  user: SeedUserKey,
  baseURL: string,
): Promise<void> {
  const credentials = SEED_USERS[user];
  const response = await request.post(`${baseURL}/api/auth/sign-in/email`, {
    data: { email: credentials.email, password: credentials.password },
    headers: { origin: baseURL },
  });
  expect(response.status(), await response.text()).toBe(200);
}

/**
 * Waits until the collaboration server has persisted the document and the
 * materialization job has derived Markdown containing `expected`.
 *
 * Persistence is debounced on purpose (see ADR-005), so a test that reads
 * derived data right after typing would race the pipeline.
 *
 * This asks the export endpoint rather than watching the job-progress
 * indicator, which is what it used to do. The indicator was never a reliable
 * signal here and has since stopped being one at all: `job-progress.tsx` holds
 * a card back for a second and drops it again on `job.completed`, so a
 * materialization that takes tens of milliseconds shows nothing whatsoever.
 * The derived Markdown is the thing the caller actually needs, and unlike a
 * toast it stays true.
 *
 * What `ai.spec.ts` covers is therefore that silence, not an appearance. That
 * the card *does* appear for a slow or failed job has no browser-level
 * coverage: neither state can be provoked from the UI.
 *
 * `expected` has to be something only the *body* can contain. The exported
 * Markdown carries frontmatter, so a caller waiting for a marker that is also
 * in the page title is told "ready" while the body is still empty.
 */
export async function waitForMaterialization(
  page: Page,
  documentId: string,
  expected: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/api/documents/${documentId}/export/markdown`);
        if (!response.ok()) return '';
        return ((await response.json()) as { markdown: string }).markdown;
      },
      { timeout: 60_000, intervals: [500] },
    )
    .toContain(expected);
}
