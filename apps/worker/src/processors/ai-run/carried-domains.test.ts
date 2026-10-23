import { describe, expect, it } from 'vitest';

import { domainsFromToolCalls } from './carried-domains';

function call(toolName: string, status = 'succeeded', openedDomain?: string): unknown {
  return {
    iteration: 1,
    toolName,
    status,
    target: null,
    resultChars: 10,
    resultTruncated: false,
    untrustedOrigin: null,
    repeated: false,
    pausedRun: false,
    failureCode: null,
    ...(openedDomain === undefined ? {} : { openedDomain }),
  };
}

/**
 * What a conversation's earlier runs hand on to the next one (issue #206).
 * The case that named it: a run opened `lifecycle` and archived a page, and
 * the next message of the same conversation was not offered archiving again.
 */
describe('domainsFromToolCalls', () => {
  it('carries the domain of a tool that was used and the one the toolbox opened', () => {
    expect(
      domainsFromToolCalls([
        call('exo_toolbox', 'succeeded', 'attachments'),
        call('exo_page_archive'),
        call('exo_page_read'),
      ]),
    ).toEqual(['lifecycle', 'attachments']);
  });

  it('leaves out what every run has, and calls that never reached their tool', () => {
    expect(
      domainsFromToolCalls([
        call('exo_page_read'),
        call('exo_search'),
        call('exo_database_query', 'refused'),
        call('exo_render_start', 'undelivered'),
      ]),
    ).toEqual([]);
  });

  it('carries a failed call, which still says what the task reached for', () => {
    expect(domainsFromToolCalls([call('exo_page_trash', 'failed')])).toEqual(['lifecycle']);
  });

  it('ignores rows it cannot read and tools that no longer exist', () => {
    expect(domainsFromToolCalls([{ toolName: 3 }, call('exo_gone_since_last_week')])).toEqual([]);
  });
});
