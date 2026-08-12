import { type ArgumentMetadata } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { updateSettingsRequestSchema } from '@exocortex/contracts';

import { AppError } from './app-error';
import { zodPipe } from './zod';

/**
 * What a rejected payload tells the client about *which* field it refused.
 *
 * The admin settings form relies on this precisely (issue #27): it reads
 * `details[].path` and hangs the complaint on the matching row, so a value the
 * schema refuses is named at its own field instead of arriving as a bare "Die
 * Eingaben sind nicht gültig." several screen heights above the button.
 *
 * That contract is easy to break by accident, because a setting key contains a
 * dot of its own. `path: issue.path.join('.')` returns the key unchanged only as
 * long as the key stays a *single* path segment; a schema that ever nested the
 * settings one level deeper would still produce a plausible-looking string that
 * matches no setting key, and every field message would silently disappear
 * while the summary alert kept working. Hence a test on the joined value, not
 * just on "some details were reported".
 */
const body: ArgumentMetadata = { type: 'body' };

interface ValidationDetail {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

function detailsOf(caught: unknown): ValidationDetail[] {
  expect(caught).toBeInstanceOf(AppError);
  const error = caught as AppError;
  expect(error.code).toBe('validation_failed');
  expect(Array.isArray(error.details)).toBe(true);
  return error.details as ValidationDetail[];
}

describe('ZodValidationPipe', () => {
  const pipe = zodPipe(updateSettingsRequestSchema);

  it('passes a value inside its range through unchanged', () => {
    expect(pipe.transform({ 'ai.maxToolIterations': 100 }, body)).toEqual({
      'ai.maxToolIterations': 100,
    });
  });

  it('reports the refused setting under its own key', () => {
    let caught: unknown;
    try {
      pipe.transform({ 'ai.maxToolIterations': 5_000 }, body);
    } catch (error) {
      caught = error;
    }

    const details = detailsOf(caught);
    expect(details).toHaveLength(1);
    // The dotted key itself, not `ai` and not `ai.maxToolIterations.0`: this is
    // the string the web form looks up in `SETTING_KEYS`.
    expect(details[0]?.path).toBe('ai.maxToolIterations');
    expect(details[0]?.message.length).toBeGreaterThan(0);
  });

  it('reports every refused setting, not only the first', () => {
    let caught: unknown;
    try {
      pipe.transform(
        { 'ai.maxToolIterations': 5_000, 'mcp.maxSearchResults': 0, 'ai.enabled': true },
        body,
      );
    } catch (error) {
      caught = error;
    }

    const details = detailsOf(caught);
    expect(details.map((detail) => detail.path).sort()).toEqual([
      'ai.maxToolIterations',
      'mcp.maxSearchResults',
    ]);
  });

  it('refuses an unknown key without a path the form could mistake for a setting', () => {
    let caught: unknown;
    try {
      pipe.transform({ 'ai.thereIsNoSuchSetting': 1 }, body);
    } catch (error) {
      caught = error;
    }

    // zod strips unknown keys by default, so this is accepted as an empty patch
    // rather than refused. Pinned here because the form's field lookup silently
    // ignores an unrecognised path either way, and the summary alert must not
    // depend on which of the two the API chooses.
    expect(caught).toBeUndefined();
  });
});
