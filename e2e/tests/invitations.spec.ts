import { type APIRequestContext, expect, test } from '@playwright/test';

import { BASIC_AUTH_CREDENTIALS } from '../support/basic-auth';
import { recordWorkspace } from '../support/created-workspaces';
import { apiSignIn, requireSeedCredentials } from '../support/fixtures';

/**
 * Invitations end to end (issue #3).
 *
 * Registration is closed, so this is the whole path by which anybody new arrives:
 * somebody invites, an anonymous browser opens the link, an account exists and is
 * signed in. The assertions worth having are the ones about what a token is *not*
 * worth -- a second use, a use after withdrawal -- and those run over HTTP,
 * because that is where they are enforced. Hidden buttons are not a mechanism.
 *
 * Everything here goes through the **workspace** route
 * (`/api/workspaces/:workspaceId/invitations`), not the admin one. The seeded
 * accounts are ordinary users: the only global admin on a real deployment is the
 * operator's own account, whose password the suite does not have and should not.
 * A workspace OWNER may invite into their own workspace, which is exactly the
 * authority these tests need — and it is the more interesting half anyway, since
 * it is the path a person uses rather than the operator.
 *
 * The two admin-only halves of the feature (switching an account off, deleting
 * one) therefore have no browser coverage. They are covered by
 * `apps/api/src/admin/admin.service.test.ts` against the real database.
 *
 * The accounts this suite creates are left behind, for the same reason the
 * workspaces used to be: nothing reachable from a seeded session can remove a
 * user. Each run invents fresh addresses, so nothing collides. To sweep them:
 *
 *   psql … -c "DELETE FROM \"user\" WHERE email LIKE 'e2e-invite-%@exocortex.test';"
 */
let ownerApi: APIRequestContext;
let anonymousApi: APIRequestContext;
let origin: string;
let workspaceId: string;

function throwawayEmail(label: string): string {
  return `e2e-invite-${label}-${Date.now().toString(36)}@exocortex.test`;
}

interface InvitationWithLink {
  invitation: { id: string; email: string; status: string; lastSentAt: string | null };
  url: string;
  emailSent: boolean;
}

/** The raw token out of an invitation URL. */
function tokenFrom(url: string): string {
  return decodeURIComponent(url.split('/einladung/')[1] as string);
}

async function invite(email: string): Promise<InvitationWithLink> {
  const response = await ownerApi.post(`${origin}/api/workspaces/${workspaceId}/invitations`, {
    data: { email },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as InvitationWithLink;
}

test.beforeAll(async ({ playwright, baseURL }) => {
  requireSeedCredentials();
  origin = baseURL as string;
  const httpCredentials = BASIC_AUTH_CREDENTIALS;
  ownerApi = await playwright.request.newContext({ httpCredentials });
  anonymousApi = await playwright.request.newContext({ httpCredentials });
  await apiSignIn(ownerApi, 'johanna', origin);

  // A workspace of this suite's own, so an invited account does not turn up as a
  // member of the seeded one and the teardown can remove it afterwards.
  const created = await ownerApi.post(`${origin}/api/workspaces`, {
    data: { name: `Einladungen ${Date.now().toString(36)}` },
  });
  expect(created.ok(), await created.text()).toBe(true);
  workspaceId = ((await created.json()) as { id: string }).id;
  recordWorkspace(workspaceId);
});

test.afterAll(async () => {
  // Withdraw anything still open, so the addresses are free again.
  const response = await ownerApi.get(`${origin}/api/workspaces/${workspaceId}/invitations`);
  if (response.ok()) {
    const body = (await response.json()) as { invitations: { id: string; status: string }[] };
    for (const invitation of body.invitations) {
      if (invitation.status === 'pending') {
        await ownerApi.delete(
          `${origin}/api/workspaces/${workspaceId}/invitations/${invitation.id}`,
        );
      }
    }
  }
  await ownerApi.dispose();
  await anonymousApi.dispose();
});

test.describe('invitations', () => {
  test('an invited person creates an account through the link and lands in the app', async ({
    browser,
  }) => {
    const email = throwawayEmail('ui');
    const { url, invitation, emailSent } = await invite(email);

    // The mail either went out or it did not, but the answer must not contradict
    // itself: `emailSent` and `lastSentAt` are two views of one fact.
    expect(invitation.lastSentAt === null).toBe(!emailSent);

    const context = await browser.newContext({ httpCredentials: BASIC_AUTH_CREDENTIALS });
    const page = await context.newPage();
    // The link exactly as it arrives in the mail, origin included.
    await page.goto(url);

    // The address is shown and not editable: the invitation decides it, so a
    // valid token cannot be used to register somebody else's address.
    await expect(page.getByLabel('E-Mail-Adresse')).toHaveValue(email);
    await expect(page.getByLabel('E-Mail-Adresse')).toBeDisabled();

    await page.getByTestId('invitation-name').fill('E2E Eingeladen');
    await page.getByTestId('invitation-password').fill('ein-sehr-langes-passwort');
    await page.getByTestId('accept-invitation-submit').click();

    // Signed in immediately: the password was just chosen, so asking for it a
    // second time would be friction with no purpose.
    await page.waitForURL(/\/arbeitsbereich/, { timeout: 30_000 });
    await expect(page.getByTestId('workspace-switcher')).toBeVisible();
    await context.close();

    // The membership came with the invitation, which is the whole point of
    // carrying a workspace on it: an invited person does not land on an empty
    // application.
    const detail = await ownerApi.get(`${origin}/api/workspaces/${workspaceId}`);
    const members = ((await detail.json()) as { members: { email: string; role: string }[] })
      .members;
    expect(members.map((member) => member.email)).toContain(email);
    expect(members.find((member) => member.email === email)?.role).toBe('MEMBER');

    // And the invitation is spent, not still on the list as open.
    const list = await ownerApi.get(`${origin}/api/workspaces/${workspaceId}/invitations`);
    const rows = ((await list.json()) as { invitations: { email: string; status: string }[] })
      .invitations;
    expect(rows.find((row) => row.email === email)?.status).toBe('accepted');
  });

  test('a token is worth nothing twice', async () => {
    const { url } = await invite(throwawayEmail('reuse'));
    const token = tokenFrom(url);

    const accepted = await anonymousApi.post(`${origin}/api/invitations/accept`, {
      data: { token, name: 'Einmal', password: 'ein-sehr-langes-passwort' },
    });
    expect(accepted.ok(), await accepted.text()).toBe(true);

    const again = await anonymousApi.post(`${origin}/api/invitations/accept`, {
      data: { token, name: 'Nochmal', password: 'ein-sehr-langes-passwort' },
    });
    expect(again.status()).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('invitation_already_used');
  });

  test('a withdrawn invitation looks exactly like one that never existed', async () => {
    const { url, invitation } = await invite(throwawayEmail('withdraw'));

    const revoked = await ownerApi.delete(
      `${origin}/api/workspaces/${workspaceId}/invitations/${invitation.id}`,
    );
    expect(revoked.ok()).toBe(true);

    const afterRevoke = await anonymousApi.post(`${origin}/api/invitations/preview`, {
      data: { token: tokenFrom(url) },
    });
    // 404 and `invitation_invalid`, the same as an unknown token: a withdrawn
    // invitation must not confirm that it ever existed.
    expect(afterRevoke.status()).toBe(404);
    expect(((await afterRevoke.json()) as { code: string }).code).toBe('invitation_invalid');
  });

  test('re-sending rotates the token, so the first link dies', async () => {
    const { url, invitation } = await invite(throwawayEmail('rotate'));

    const resent = await ownerApi.post(
      `${origin}/api/workspaces/${workspaceId}/invitations/${invitation.id}/resend`,
    );
    expect(resent.ok(), await resent.text()).toBe(true);
    const fresh = (await resent.json()) as InvitationWithLink;
    expect(fresh.url).not.toBe(url);

    const old = await anonymousApi.post(`${origin}/api/invitations/preview`, {
      data: { token: tokenFrom(url) },
    });
    expect(old.status()).toBe(404);

    const current = await anonymousApi.post(`${origin}/api/invitations/preview`, {
      data: { token: tokenFrom(fresh.url) },
    });
    expect(current.ok(), await current.text()).toBe(true);
  });

  test('registration stays shut and the admin routes stay closed', async () => {
    // The premise of the whole feature: there is no self-service way in.
    const signUp = await anonymousApi.post(`${origin}/api/auth/sign-up/email`, {
      data: {
        email: throwawayEmail('selfservice'),
        name: 'Self service',
        password: 'ein-sehr-langes-passwort',
      },
      headers: { origin },
    });
    expect(signUp.ok()).toBe(false);

    // Anonymous callers get nowhere near the invitation lists.
    expect((await anonymousApi.get(`${origin}/api/admin/invitations`)).status()).toBe(401);
    expect(
      (await anonymousApi.get(`${origin}/api/workspaces/${workspaceId}/invitations`)).status(),
    ).toBe(401);

    // And a signed-in ordinary user is not a global admin, so the deployment-wide
    // list stays out of reach even with a valid session.
    expect((await ownerApi.get(`${origin}/api/admin/invitations`)).status()).toBe(403);
  });

  test('a nonsense token is rejected the same way everywhere', async () => {
    for (const token of ['exoinv_totalerquatschaberlangenug', 'gar-kein-token-aber-lang-genug']) {
      const response = await anonymousApi.post(`${origin}/api/invitations/preview`, {
        data: { token },
      });
      expect(response.status()).toBe(404);
      expect(((await response.json()) as { code: string }).code).toBe('invitation_invalid');
    }
  });
});
