import { describe, expect, it } from 'vitest';

import { writeModeMessage } from './write-mode';

describe('writeModeMessage', () => {
  it('names the reporting tools in every restricted mode (issue #144)', () => {
    for (const mode of ['read_only', 'propose'] as const) {
      const content = writeModeMessage(mode)?.content ?? '';
      expect(content).toContain('exo_work_item_update');
      expect(content).toContain('nur im Chat');
    }
    expect(writeModeMessage('direct')).toBeNull();
  });
});
