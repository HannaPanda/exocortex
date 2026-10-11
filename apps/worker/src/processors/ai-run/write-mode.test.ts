import { describe, expect, it } from 'vitest';

import { writeModeMessage } from './write-mode';

describe('writeModeMessage', () => {
  it('names the reporting tools in every restricted mode on a work item (issue #144)', () => {
    for (const mode of ['read_only', 'propose'] as const) {
      const content = writeModeMessage(mode, true)?.content ?? '';
      expect(content).toContain('exo_work_item_update');
      expect(content).toContain('nur im Chat');
    }
    expect(writeModeMessage('direct', true)).toBeNull();
  });

  it('leaves them out where there is no work item to report on (issue #146)', () => {
    for (const mode of ['read_only', 'propose'] as const) {
      const content = writeModeMessage(mode, false)?.content ?? '';
      expect(content).not.toContain('exo_work_item_update');
      expect(content.length).toBeGreaterThan(0);
    }
  });
});
