import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/client';

import { replacesPageOnError } from './document-load-failure';

describe('replacesPageOnError (issue #285)', () => {
  it('keeps a page on screen through an outage', () => {
    expect(replacesPageOnError(new ApiError(502, null), true)).toBe(false);
    expect(replacesPageOnError(new TypeError('Failed to fetch'), true)).toBe(false);
  });

  it('takes the page away when the answer is final', () => {
    expect(replacesPageOnError(new ApiError(404, null), true)).toBe(true);
    expect(replacesPageOnError(new ApiError(403, null), true)).toBe(true);
  });

  it('shows the error for a page that never loaded', () => {
    expect(replacesPageOnError(new ApiError(502, null), false)).toBe(true);
  });
});
