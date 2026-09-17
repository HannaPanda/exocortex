import { createHash, randomBytes } from 'node:crypto';

import { type APIRequestContext, expect, test } from '@playwright/test';

import { BASIC_AUTH_CREDENTIALS } from '../support/basic-auth';
import { apiSignIn, requireSeedCredentials, signIn } from '../support/fixtures';

/**
 * The whole remote-connector flow, end to end, the way ChatGPT walks it
 * (ADR-018): discovery, self-registration, an authorization code with PKCE that
 * only the consent screen can release, a token exchange, and a tool call with
 * the result.
 *
 * It exists because nothing smaller proves the thing that matters. Every step
 * here is served by `@better-auth/mcp` and the API together, and the better-auth
 * 1.7 migration (issue #64) changed what a token *is*, where the discovery
 * documents live and which endpoint answers the authorization request. A unit
 * test can show that a forged JWT is refused; only this can show that a real
 * client can still get one.
 *
 * Its own cleanup is a disconnect, which is the product's own revocation path
 * and worth asserting anyway. The disabled client row that remains is swept by
 * `pnpm --filter @exocortex/api test-data:prune`.
 */

/** Recognises the clients this suite registers, for the sweep afterwards. */
const CLIENT_NAME_PREFIX = 'E2E Connector';

let anonymousApi: APIRequestContext;
let johannaApi: APIRequestContext;
let origin: string;

interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
}

interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  jwks_uri?: string;
  code_challenge_methods_supported: string[];
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** Reads a JWT's payload without verifying it; the server is what verifies. */
function claimsOf(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  expect(payload, 'the access token is not a JWT').toBeTruthy();
  return JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

test.beforeAll(async ({ playwright, baseURL }) => {
  requireSeedCredentials();
  origin = baseURL as string;
  const httpCredentials = BASIC_AUTH_CREDENTIALS;
  anonymousApi = await playwright.request.newContext({ httpCredentials });
  johannaApi = await playwright.request.newContext({ httpCredentials });
  await apiSignIn(johannaApi, 'johanna', origin);
});

test.afterAll(async () => {
  await anonymousApi.dispose();
  await johannaApi.dispose();
});

test.describe('remote MCP connector over OAuth', () => {
  // One browser, one authorization, several assertions about what came out of
  // it. Splitting them would mean registering a client per test and walking the
  // consent screen four times for no extra coverage.
  test('discovers, registers, asks a human, and gets a token that opens /api/mcp', async ({
    page,
  }) => {
    // 1. Discovery, at the origin root where a client looks (RFC 9728).
    const resourceResponse = await anonymousApi.get(
      `${origin}/.well-known/oauth-protected-resource`,
    );
    expect(resourceResponse.status(), await resourceResponse.text()).toBe(200);
    const resourceMetadata = (await resourceResponse.json()) as ProtectedResourceMetadata;
    expect(resourceMetadata.resource).toBe(`${origin}/api/mcp`);
    expect(resourceMetadata.authorization_servers).toContain(`${origin}/api/auth`);

    const metadataResponse = await anonymousApi.get(
      `${origin}/.well-known/oauth-authorization-server`,
    );
    expect(metadataResponse.status(), await metadataResponse.text()).toBe(200);
    const metadata = (await metadataResponse.json()) as AuthorizationServerMetadata;
    expect(metadata.issuer).toBe(`${origin}/api/auth`);
    // Plain `code_challenge` is refused, which is what makes a public client
    // with no secret safe to hand an authorization code.
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    expect(metadata.registration_endpoint).toBe(`${origin}/api/auth/oauth2/register`);

    // 2. Self-registration (RFC 7591), with no credential at all. This is open
    //    on purpose, and the consent screen is the gate in front of it.
    const redirectUri = `${origin}/e2e-oauth-callback`;
    const registration = await anonymousApi.post(metadata.registration_endpoint as string, {
      data: {
        client_name: `${CLIENT_NAME_PREFIX} ${Date.now().toString(36)}`,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'openid profile email offline_access',
      },
      headers: { origin },
    });
    expect(registration.status(), await registration.text()).toBe(201);
    const client = (await registration.json()) as { client_id: string; client_name: string };
    expect(client.client_id).toBeTruthy();

    // 3. The authorization request. A signed-in browser is not enough on its
    //    own: the API forces `prompt=consent`, so this lands on /verbinden.
    const { verifier, challenge } = pkce();
    const state = randomBytes(8).toString('hex');
    const authorizeUrl = new URL(`${origin}/api/auth/oauth2/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', client.client_id);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('scope', 'openid profile email offline_access');
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('resource', `${origin}/api/mcp`);

    await signIn(page);
    await page.goto(authorizeUrl.toString());
    await page.waitForURL(/\/verbinden\?/, { timeout: 30_000 });
    // The screen names the client, because recognising it is the whole point.
    await expect(page.getByText(client.client_name)).toBeVisible();
    await expect(page.getByText(redirectUri)).toBeVisible();

    await page.getByTestId('consent-accept').click();
    await page.waitForURL(new RegExp('/e2e-oauth-callback\\?'), { timeout: 30_000 });

    const callback = new URL(page.url());
    expect(callback.searchParams.get('state')).toBe(state);
    expect(callback.searchParams.get('iss')).toBe(`${origin}/api/auth`);
    const code = callback.searchParams.get('code');
    expect(code, 'no authorization code came back').toBeTruthy();

    // 4. The token exchange, form-encoded like every OAuth client sends it.
    const tokenResponse = await anonymousApi.post(metadata.token_endpoint, {
      form: {
        grant_type: 'authorization_code',
        code: code as string,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        code_verifier: verifier,
        resource: `${origin}/api/mcp`,
      },
      headers: { origin },
    });
    expect(tokenResponse.status(), await tokenResponse.text()).toBe(200);
    const tokens = (await tokenResponse.json()) as TokenResponse;
    expect(tokens.token_type.toLowerCase()).toBe('bearer');
    expect(tokens.refresh_token, 'offline_access should yield a refresh token').toBeTruthy();

    // 5. The token is a JWT bound to this resource, which is what makes it
    //    unusable anywhere else and verifiable without a database row.
    const claims = claimsOf(tokens.access_token);
    // An array, not a string: the `openid` scope adds the provider's own
    // userinfo endpoint to the audience beside the resource that was asked for.
    // Containment is therefore the assertion, and it is also what the server
    // checks — a token whose audience does not include this resource is refused.
    expect(claims.aud).toContain(`${origin}/api/mcp`);
    expect(claims.iss).toBe(`${origin}/api/auth`);
    expect(claims.client_id).toBe(client.client_id);

    // 6. It opens the MCP endpoint …
    const toolsResponse = await anonymousApi.post(`${origin}/api/mcp`, {
      headers: { authorization: `Bearer ${tokens.access_token}`, origin },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(toolsResponse.status(), await toolsResponse.text()).toBe(200);
    const listed = (await toolsResponse.json()) as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.length).toBeGreaterThan(20);

    // … and nothing else. An OAuth token is not a session.
    const sessionResponse = await anonymousApi.get(`${origin}/api/session`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(sessionResponse.status()).toBe(401);

    // 7. Refreshing works without asking anybody, which is the point of the
    //    thirty-day grant behind the one-hour token.
    const refreshed = await anonymousApi.post(metadata.token_endpoint, {
      form: {
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token as string,
        client_id: client.client_id,
        resource: `${origin}/api/mcp`,
      },
      headers: { origin },
    });
    expect(refreshed.status(), await refreshed.text()).toBe(200);
    const renewed = (await refreshed.json()) as TokenResponse;
    expect(renewed.access_token).not.toBe(tokens.access_token);

    // 8. The connection shows up where a person can end it.
    const connections = await johannaApi.get(`${origin}/api/me/connections`);
    expect(connections.status(), await connections.text()).toBe(200);
    const { applications } = (await connections.json()) as {
      applications: { clientId: string; activeGrantCount: number }[];
    };
    const listedClient = applications.find((entry) => entry.clientId === client.client_id);
    expect(listedClient, 'the connector is not in the connections list').toBeDefined();
    expect(listedClient?.activeGrantCount).toBeGreaterThan(0);

    // 9. Disconnecting ends it for good. There is no token row to delete any
    //    more, so this is the assertion that the `disabled` check on every use
    //    is what revocation now rests on.
    const disconnect = await johannaApi.delete(
      `${origin}/api/me/connections/${client.client_id}`,
      { headers: { origin } },
    );
    expect(disconnect.status(), await disconnect.text()).toBe(200);

    const afterRevocation = await anonymousApi.post(`${origin}/api/mcp`, {
      headers: { authorization: `Bearer ${renewed.access_token}`, origin },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(afterRevocation.status()).toBe(401);
  });

  test('refuses a token minted for a different audience', async () => {
    // Not a hypothetical: before audience binding, any JWT this deployment
    // signed would have opened /api/mcp. `GET /api/auth/token` was the obvious
    // source of one, which is why it is refused outright.
    const sessionJwt = await johannaApi.get(`${origin}/api/auth/token`);
    expect(sessionJwt.status()).toBe(404);
  });
});
