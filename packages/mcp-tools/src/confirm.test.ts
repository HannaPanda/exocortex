import { describe, expect, it } from 'vitest';

import { stableStringify, WriteConfirmationGate } from './confirm.js';

describe('stableStringify', () => {
  it('sorts object keys recursively', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

describe('WriteConfirmationGate', () => {
  it('requires confirmation before the operation runs', () => {
    const gate = new WriteConfirmationGate();
    const input = { toolName: 'exo_page_write', target: 'document:1', payload: { markdown: 'hi' } };

    const first = gate.check(input);
    expect(first.state).toBe('pending');

    const second = gate.check(input);
    expect(second.state).toBe('confirmed');
  });

  it('requires a fresh confirmation when the payload changes', () => {
    const gate = new WriteConfirmationGate();
    const target = { toolName: 'exo_page_write', target: 'document:1' };

    const first = gate.check({ ...target, payload: { markdown: 'a' } });
    expect(first.state).toBe('pending');

    const changedPayload = gate.check({ ...target, payload: { markdown: 'b' } });
    expect(changedPayload.state).toBe('pending');

    const confirmOriginal = gate.check({ ...target, payload: { markdown: 'a' } });
    expect(confirmOriginal.state).toBe('confirmed');
  });

  it('expires a pending entry after the TTL', () => {
    const gate = new WriteConfirmationGate({ ttlMs: 10 });
    const input = { toolName: 'exo_page_write', target: 'document:1', payload: { markdown: 'hi' } };

    const first = gate.check(input);
    expect(first.state).toBe('pending');

    gate.prune(Date.now() + 1_000);
    const afterExpiry = gate.check(input);
    expect(afterExpiry.state).toBe('pending');
  });

  it('consumes the pending entry once confirmed', () => {
    const gate = new WriteConfirmationGate();
    const input = { toolName: 'exo_page_write', target: 'document:1', payload: { markdown: 'hi' } };

    gate.check(input);
    expect(gate.check(input).state).toBe('confirmed');
    // Consumed: calling again with the same payload starts a new pending cycle.
    expect(gate.check(input).state).toBe('pending');
  });
});
