import { describe, expect, it } from 'vitest';

import { TOOL_DOMAINS } from './tool.js';
import {
  domainsFromProbabilities,
  ROUTED_DOMAINS,
  routingQuestions,
  routingState,
} from './tool-routing.js';

/**
 * The question the worker asks Jev (issue #206, ADR-089). Its words are a
 * measured router, so these tests pin what a change to them would move.
 */
describe('tool routing questions', () => {
  it('asks about every domain except the ones every run has and the external one', () => {
    expect([...ROUTED_DOMAINS].sort()).toEqual(
      TOOL_DOMAINS.filter((domain) => !['core', 'pages', 'external'].includes(domain)).sort(),
    );
  });

  it('asks each one as the yes/no question that was measured', () => {
    expect(routingQuestions().lifecycle).toEqual({
      kind: 'yesNo',
      instructions:
        'Does fulfilling the `request` require tools to archive a page, move it to the trash, or delete it permanently?',
    });
  });

  it('tells the engine what the page carries, and leaves context out when it knows nothing', () => {
    expect(routingState('Was zeigt diese Skizze?', { pageAttachments: ['image'] })).toMatchObject({
      request: 'Was zeigt diese Skizze?',
      context: { pageCarries: ['pictures'] },
    });
    expect(routingState('Hallo')).not.toHaveProperty('context');
  });
});

describe('domainsFromProbabilities', () => {
  it('offers the yes answers from the threshold on, in catalogue order, plus what is required', () => {
    expect(
      domainsFromProbabilities({ web: 0.5, attachments: 0.97, lifecycle: 0.49 }, ['databases']),
    ).toEqual(['core', 'pages', 'databases', 'attachments', 'web']);
  });

  it('ignores an answer for something that is not a routed domain', () => {
    expect(domainsFromProbabilities({ external: 1, nonsense: 1 })).toEqual(['core', 'pages']);
  });
});
