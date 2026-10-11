import { describe, expect, it } from 'vitest';

import { sandboxArguments } from './container-sandbox';
import { buildRunArguments as projectArguments } from './project/latexmk-runner';
import { buildRunArguments as renderArguments } from './render/latex-runner';

const HARDENING = [
  '--network=none',
  '--security-opt=no-new-privileges',
  '--cap-drop=ALL',
  '--user=65534:65534',
  '--read-only',
  '--env=HOME=/tmp',
];

/** Everything before the image name: the flags `docker run` reads. */
function flagsBeforeImage(args: string[], image: string): string[] {
  return args.slice(0, args.indexOf(image));
}

describe('sandboxArguments', () => {
  it('makes /tmp the only writable place, sized out of the memory budget', () => {
    const args = sandboxArguments({ memory: '2g', scratch: '1g' });
    expect(args).toEqual(expect.arrayContaining([...HARDENING, '--memory=2g']));
    expect(args).toContain('--tmpfs=/tmp:rw,exec,nosuid,nodev,size=1g,mode=1777');
  });
});

describe('both LaTeX runners', () => {
  it('start the render container hardened', () => {
    const args = renderArguments({
      image: 'img',
      markdown: '',
      metadataYaml: '',
      template: null,
      assets: [],
      tableOfContents: false,
      timeoutMs: 1000,
      maxArtifactBytes: 1000,
    });
    expect(flagsBeforeImage(args, 'img')).toEqual(expect.arrayContaining(HARDENING));
    expect(args).not.toContain('--privileged');
  });

  it('start the project container hardened', () => {
    const args = projectArguments({
      image: 'img',
      files: [],
      rootFile: 'main.tex',
      engine: 'PDFLATEX',
      bibliography: 'AUTO',
      timeoutMs: 1000,
      maxArtifactBytes: 1000,
    });
    expect(flagsBeforeImage(args, 'img')).toEqual(expect.arrayContaining(HARDENING));
    expect(args).not.toContain('--privileged');
  });
});
