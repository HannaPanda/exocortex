import { describe, expect, it } from 'vitest';

import { type ProjectBuild, type ProjectFile } from '@exocortex/contracts';

import { isBuildRunning, resolveOpenPath, resolveShownBuild } from './use-project-workspace';

function file(path: string, kind: ProjectFile['kind'] = 'TEXT'): ProjectFile {
  return {
    path,
    kind,
    byteSize: 10,
    attachmentId: null,
    downloadPath: null,
    mimeType: null,
    updatedAt: '2026-09-16T10:00:00.000Z',
  };
}

function build(id: string, status: ProjectBuild['status']): ProjectBuild {
  return {
    id,
    workspaceId: 'ws',
    projectId: 'project',
    projectTitle: 'Aufsatz',
    rootFile: 'main.tex',
    engine: 'PDFLATEX',
    bibliography: 'NONE',
    status,
    inputHash: 'hash',
    stale: false,
    errorCode: null,
    error: null,
    errorCount: 0,
    warningCount: 0,
    attachmentId: null,
    attachmentByteSize: null,
    downloadPath: null,
    sourceMapAttachmentId: null,
    pageCount: null,
    createdAt: '2026-09-16T10:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    createdById: null,
    createdByName: null,
  };
}

describe('resolveOpenPath', () => {
  const files = [file('assets/logo.png', 'ASSET'), file('kapitel.tex'), file('main.tex')];

  it('keeps the chosen file open', () => {
    expect(resolveOpenPath(files, 'main.tex', 'kapitel.tex')).toBe('kapitel.tex');
  });

  it('falls back to the root file when nothing is chosen', () => {
    expect(resolveOpenPath(files, 'main.tex', null)).toBe('main.tex');
  });

  it('forgets a chosen file that has been deleted', () => {
    // Otherwise the editor column keeps a path that no longer exists, and every
    // keystroke writes to a file the server does not have.
    expect(resolveOpenPath(files, 'main.tex', 'weg.tex')).toBe('main.tex');
  });

  it('takes the first text file when the root file is missing', () => {
    expect(resolveOpenPath(files, 'fehlt.tex', null)).toBe('kapitel.tex');
  });

  it('never opens an asset', () => {
    expect(resolveOpenPath([file('logo.png', 'ASSET')], 'main.tex', null)).toBeNull();
  });

  it('answers null for an empty project', () => {
    expect(resolveOpenPath([], 'main.tex', null)).toBeNull();
  });
});

describe('isBuildRunning', () => {
  it('is true while the build is queued or compiling', () => {
    expect(isBuildRunning(build('b1', 'PENDING'))).toBe(true);
    expect(isBuildRunning(build('b1', 'RUNNING'))).toBe(true);
  });

  it('is false once it has an outcome, and with no build at all', () => {
    expect(isBuildRunning(build('b1', 'COMPLETED'))).toBe(false);
    expect(isBuildRunning(build('b1', 'FAILED'))).toBe(false);
    expect(isBuildRunning(build('b1', 'CANCELLED'))).toBe(false);
    expect(isBuildRunning(null)).toBe(false);
  });
});

describe('resolveShownBuild', () => {
  const builds = [build('newest', 'COMPLETED'), build('older', 'COMPLETED')];

  it('shows the newest build after a reload', () => {
    // Before this fallback the right-hand column came back empty and the PDF
    // that had just been built had no route back to it in the browser.
    expect(resolveShownBuild(builds, null)).toBe('newest');
  });

  it('keeps a chosen build even when the list has not caught up', () => {
    expect(resolveShownBuild(builds, 'just-started')).toBe('just-started');
  });

  it('shows nothing when the project has never been built', () => {
    expect(resolveShownBuild([], null)).toBeNull();
  });
});
