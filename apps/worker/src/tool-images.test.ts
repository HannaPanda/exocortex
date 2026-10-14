import { describe, expect, it, vi } from 'vitest';

import { describeToolImages } from './tool-images';

const picture = { mimeType: 'image/png' as const, data: 'iVBORw0KGgo=' };
const result = { text: 'Bild diff.png, 800×600 px.', images: [picture] };

describe('describeToolImages (issue #204)', () => {
  it('replaces the picture with what a vision model saw', async () => {
    const describe = vi.fn().mockResolvedValue('Ein roter Rahmen um die Kopfzeile.');
    const described = await describeToolImages({
      result,
      describe,
      label: 'diff.png',
      onFailure: () => undefined,
    });

    expect(describe).toHaveBeenCalledWith(picture, 'diff.png');
    expect(described.images).toBeUndefined();
    expect(described.isError).toBeUndefined();
    expect(described.text).toContain('Bild diff.png, 800×600 px.');
    expect(described.text).toContain('du siehst das Bild nicht selbst');
    expect(described.text).toContain('Ein roter Rahmen um die Kopfzeile.');
  });

  it('says plainly that nobody can look, and marks the call failed', async () => {
    const described = await describeToolImages({
      result,
      describe: null,
      label: 'diff.png',
      onFailure: () => undefined,
    });
    expect(described.isError).toBe(true);
    expect(described.text).toContain('kein Bildmodell eingerichtet');
    expect(described.images).toBeUndefined();
  });

  it('turns a failed or empty description into a failed call', async () => {
    const onFailure = vi.fn();
    const described = await describeToolImages({
      result,
      describe: vi.fn().mockResolvedValue('   '),
      label: 'diff.png',
      onFailure,
    });
    expect(described.isError).toBe(true);
    expect(described.text).toContain('konnte das Bild nicht beschreiben');
    expect(onFailure).toHaveBeenCalledWith('empty description');
  });

  it('leaves a result without pictures alone and never calls the model', async () => {
    const describe = vi.fn();
    const plain = { text: 'nur Text' };
    expect(
      await describeToolImages({ result: plain, describe, label: 'x', onFailure: () => undefined }),
    ).toEqual({ text: 'nur Text', images: undefined });
    expect(describe).not.toHaveBeenCalled();
  });
});
