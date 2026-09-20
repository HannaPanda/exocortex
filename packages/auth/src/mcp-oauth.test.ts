import { exportJWK, generateKeyPair, type JSONWebKeySet, type JWK, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { authIssuer, mcpResourceIdentifier } from './auth';
import { readMcpAccessTokenClaims } from './mcp-oauth';

/**
 * The cryptographic half of MCP token verification, against a key pair made
 * here rather than against the `jwks` rows of a running deployment. Everything
 * these tests reject is something a connector could present on purpose.
 */
const APP_URL = 'https://exocortex.test';
const KEY_ID = 'test-key';

/**
 * `CryptoKey` is a global value in Node's types but not a global type, so the
 * keys are named by what produced them.
 */
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

let privateKey: SigningKey;
let jwks: JSONWebKeySet;
let foreignPrivateKey: SigningKey;

interface TokenOverrides {
  issuer?: string;
  audience?: string;
  type?: string;
  expiresInSeconds?: number;
  signWith?: SigningKey;
  claims?: Record<string, unknown>;
}

async function token(overrides: TokenOverrides = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    client_id: 'chatgpt',
    azp: 'chatgpt',
    scope: 'openid profile offline_access',
    ...overrides.claims,
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: KEY_ID, typ: overrides.type ?? 'at+jwt' })
    .setSubject('user-1')
    .setIssuer(overrides.issuer ?? authIssuer(APP_URL))
    .setAudience(overrides.audience ?? mcpResourceIdentifier(APP_URL))
    .setIssuedAt(now)
    .setExpirationTime(now + (overrides.expiresInSeconds ?? 3600))
    .sign(overrides.signWith ?? privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  privateKey = pair.privateKey;
  jwks = {
    keys: [{ ...((await exportJWK(pair.publicKey)) as JWK), alg: 'EdDSA', kid: KEY_ID }],
  };
  foreignPrivateKey = (await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }))
    .privateKey;
});

describe('readMcpAccessTokenClaims', () => {
  it('reads subject, client and scopes from a token this server issued', async () => {
    const claims = await readMcpAccessTokenClaims(jwks, await token(), APP_URL);
    expect(claims).toMatchObject({
      subject: 'user-1',
      clientId: 'chatgpt',
      scopes: 'openid profile offline_access',
    });
  });

  it('tells an expired token apart from an invalid one', async () => {
    // The distinction is the whole difference between a connector that
    // refreshes quietly and one that drags a person through consent again.
    expect(await readMcpAccessTokenClaims(jwks, await token({ expiresInSeconds: -60 }), APP_URL)) //
      .toBe('expired');
  });

  it('refuses a token signed by somebody else', async () => {
    const forged = await token({ signWith: foreignPrivateKey });
    expect(await readMcpAccessTokenClaims(jwks, forged, APP_URL)).toBe('invalid');
  });

  it('refuses a token minted for another audience', async () => {
    // Audience binding (RFC 8707) is what stops a token issued for some other
    // resource on this host being replayed against /api/mcp.
    const elsewhere = await token({ audience: 'https://exocortex.test/api/something-else' });
    expect(await readMcpAccessTokenClaims(jwks, elsewhere, APP_URL)).toBe('invalid');
  });

  it('refuses a token from another issuer', async () => {
    const elsewhere = await token({ issuer: 'https://someone-else.test/api/auth' });
    expect(await readMcpAccessTokenClaims(jwks, elsewhere, APP_URL)).toBe('invalid');
  });

  it('refuses a JWT that is not an access token', async () => {
    // An id token is signed by the same key and carries the same subject. The
    // `typ` header is what says which of the two a bearer value is.
    expect(await readMcpAccessTokenClaims(jwks, await token({ type: 'JWT' }), APP_URL)) //
      .toBe('invalid');
  });

  it('refuses a token that names no client', async () => {
    const anonymous = await token({ claims: { client_id: undefined, azp: undefined } });
    expect(await readMcpAccessTokenClaims(jwks, anonymous, APP_URL)).toBe('invalid');
  });

  it('refuses everything when no key is published', async () => {
    expect(await readMcpAccessTokenClaims({ keys: [] }, await token(), APP_URL)).toBe('invalid');
  });
});
