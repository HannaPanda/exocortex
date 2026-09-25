import { describe, expect, it } from 'vitest';

import { agentDisplayName, collaborationApplyRequestSchema } from './collaboration';

describe('agentDisplayName', () => {
  it('drops the version a client appends to its name', () => {
    expect(agentDisplayName('claude-code 2.1.4')).toBe('claude-code');
    expect(agentDisplayName('Hermes v0.9.1-beta')).toBe('Hermes');
  });

  it('keeps a name that carries no version', () => {
    expect(agentDisplayName('eXocortex KI')).toBe('eXocortex KI');
  });

  it('answers null when there is nothing to show', () => {
    expect(agentDisplayName(null)).toBeNull();
    expect(agentDisplayName('   ')).toBeNull();
  });
});

describe('collaborationApplyRequestSchema', () => {
  it('reads a request without a writer as one from a person', () => {
    const parsed = collaborationApplyRequestSchema.parse({
      proseMirrorJson: { type: 'doc', content: [] },
      mode: 'replace',
      correlationId: 'corr',
    });
    expect(parsed.actor).toEqual({ kind: 'person', label: null });
  });
});
