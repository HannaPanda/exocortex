import { describe, expect, it } from 'vitest';

import { typistOf } from './typist';

describe('typistOf (issue #235)', () => {
  it('names the account behind a connection', () => {
    const origin = { source: 'connection', connection: { context: { userId: 'u1' } } };
    expect(typistOf(origin)).toBe('u1');
  });

  it('names nobody for a write the server made itself', () => {
    expect(typistOf({ source: 'local', context: { userId: 'u1' } })).toBeNull();
  });

  it('names nobody for a change relayed from another instance', () => {
    expect(typistOf({ source: 'redis' })).toBeNull();
  });

  it('names nobody when the origin is unknown or the context has no account', () => {
    expect(typistOf(undefined)).toBeNull();
    expect(typistOf('some-string')).toBeNull();
    expect(typistOf({ source: 'connection', connection: { context: {} } })).toBeNull();
    expect(typistOf({ source: 'connection', connection: { context: { userId: '' } } })).toBeNull();
  });
});
