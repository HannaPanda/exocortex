import { describe, expect, it } from 'vitest';

import {
  apiTokenHashesMatch,
  generateApiToken,
  hashApiToken,
  readBearerToken,
  requiredScopeForRequest,
  tokenHasScope,
} from './api-token';

describe('generateApiToken', () => {
  it('returns a secret that hashes to the stored hash', () => {
    const generated = generateApiToken();
    expect(generated.secret.startsWith('exo_')).toBe(true);
    expect(hashApiToken(generated.secret)).toBe(generated.tokenHash);
    expect(generated.prefix).toBe(generated.secret.slice(0, 12));
  });

  it('never repeats a secret', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateApiToken().secret));
    expect(secrets.size).toBe(50);
  });
});

describe('apiTokenHashesMatch', () => {
  it('matches a hash against itself and rejects anything else', () => {
    const hash = hashApiToken('exo_whatever');
    expect(apiTokenHashesMatch(hash, hash)).toBe(true);
    expect(apiTokenHashesMatch(hash, hashApiToken('exo_something-else'))).toBe(false);
    expect(apiTokenHashesMatch(hash, hash.slice(0, 10))).toBe(false);
  });
});

describe('readBearerToken', () => {
  it('reads the token regardless of header casing and spacing', () => {
    expect(readBearerToken({ authorization: 'Bearer exo_abc' })).toBe('exo_abc');
    expect(readBearerToken({ authorization: 'bearer   exo_abc  ' })).toBe('exo_abc');
    expect(readBearerToken({ Authorization: 'Bearer exo_abc' })).toBe('exo_abc');
  });

  it('returns null when there is nothing usable', () => {
    expect(readBearerToken({})).toBeNull();
    expect(readBearerToken({ authorization: 'Basic dXNlcjpwYXNz' })).toBeNull();
    expect(readBearerToken({ authorization: 'Bearer ' })).toBeNull();
  });
});

describe('requiredScopeForRequest', () => {
  it('asks only for read on safe methods', () => {
    expect(requiredScopeForRequest('GET', '/api/workspaces')).toBe('read');
    expect(requiredScopeForRequest('HEAD', '/api/documents/abc')).toBe('read');
    expect(requiredScopeForRequest('get', '/api/search')).toBe('read');
  });

  it('asks for write on anything that changes state', () => {
    expect(requiredScopeForRequest('POST', '/api/workspaces')).toBe('write');
    expect(requiredScopeForRequest('PATCH', '/api/documents/abc')).toBe('write');
    expect(requiredScopeForRequest('DELETE', '/api/attachments/abc')).toBe('write');
  });

  it('asks for admin on the admin API, reading it included', () => {
    expect(requiredScopeForRequest('GET', '/api/admin/overview')).toBe('admin');
    expect(requiredScopeForRequest('PATCH', '/api/admin/settings')).toBe('admin');
  });

  it('asks for admin on token management, so a token cannot widen itself', () => {
    expect(requiredScopeForRequest('GET', '/api/me/api-tokens')).toBe('admin');
    expect(requiredScopeForRequest('POST', '/api/me/api-tokens')).toBe('admin');
    expect(requiredScopeForRequest('DELETE', '/api/me/api-tokens/abc')).toBe('admin');
  });

  it('does not confuse a lookalike path with the admin API', () => {
    expect(requiredScopeForRequest('GET', '/api/me')).toBe('read');
    expect(requiredScopeForRequest('POST', '/api/documents/admin-notes')).toBe('write');
  });
});

describe('tokenHasScope', () => {
  it('treats scopes as cumulative', () => {
    expect(tokenHasScope(['admin'], 'read')).toBe(true);
    expect(tokenHasScope(['admin'], 'write')).toBe(true);
    expect(tokenHasScope(['admin'], 'admin')).toBe(true);
    expect(tokenHasScope(['write'], 'read')).toBe(true);
    expect(tokenHasScope(['write'], 'write')).toBe(true);
  });

  it('refuses to climb upwards', () => {
    expect(tokenHasScope(['read'], 'write')).toBe(false);
    expect(tokenHasScope(['read'], 'admin')).toBe(false);
    expect(tokenHasScope(['write'], 'admin')).toBe(false);
  });

  it('grants nothing for an empty or unknown list, so it fails closed', () => {
    expect(tokenHasScope([], 'read')).toBe(false);
    expect(tokenHasScope(['nonsense'], 'read')).toBe(false);
    expect(tokenHasScope(['Admin'], 'admin')).toBe(false);
  });

  it('takes the strongest scope in the list', () => {
    expect(tokenHasScope(['read', 'write'], 'write')).toBe(true);
    expect(tokenHasScope(['read', 'nonsense'], 'write')).toBe(false);
  });
});
