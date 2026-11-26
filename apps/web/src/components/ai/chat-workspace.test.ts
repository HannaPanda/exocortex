import { describe, expect, it } from 'vitest';

import { type ChatWorkspaceCandidate, resolveChatWorkspace } from './chat-workspace';

const own: ChatWorkspaceCandidate = { id: 'own', name: 'Meins', isMemory: false };
const second: ChatWorkspaceCandidate = { id: 'second', name: 'Projekt', isMemory: false };
const memory: ChatWorkspaceCandidate = { id: 'memory', name: 'Memory', isMemory: true };

const base = {
  routeWorkspaceId: null,
  documentId: 'page',
  documentWorkspaceId: 'theirs',
  workspaces: [own, second],
  remembered: null,
} as const;

describe('resolveChatWorkspace', () => {
  it('keeps the workspace the route names', () => {
    expect(resolveChatWorkspace({ ...base, routeWorkspaceId: 'own' })).toEqual({
      kind: 'member',
      workspaceId: 'own',
    });
  });

  it('has nothing to run in without a page and without a workspace', () => {
    expect(resolveChatWorkspace({ ...base, documentId: null })).toEqual({ kind: 'none' });
  });

  it('runs nowhere when the shared page cannot be read any more', () => {
    expect(resolveChatWorkspace({ ...base, documentWorkspaceId: null })).toEqual({ kind: 'none' });
  });

  it('waits for the page and the workspace list', () => {
    expect(resolveChatWorkspace({ ...base, documentWorkspaceId: undefined })).toEqual({
      kind: 'pending',
    });
    expect(resolveChatWorkspace({ ...base, workspaces: undefined })).toEqual({ kind: 'pending' });
  });

  it("runs a shared page's chat in the reader's first own workspace", () => {
    expect(resolveChatWorkspace(base)).toEqual({
      kind: 'shared',
      workspaceId: 'own',
      workspaceName: 'Meins',
      choices: [
        { id: 'own', name: 'Meins' },
        { id: 'second', name: 'Projekt' },
      ],
    });
  });

  it('follows the workspace the reader chose last time', () => {
    expect(resolveChatWorkspace({ ...base, remembered: 'second' })).toMatchObject({
      kind: 'shared',
      workspaceId: 'second',
    });
  });

  it('ignores a remembered workspace the reader no longer belongs to', () => {
    expect(resolveChatWorkspace({ ...base, remembered: 'gone' })).toMatchObject({
      kind: 'shared',
      workspaceId: 'own',
    });
  });

  it('never runs a chat in an agent memory area', () => {
    expect(resolveChatWorkspace({ ...base, workspaces: [memory, second] })).toMatchObject({
      kind: 'shared',
      workspaceId: 'second',
      choices: [{ id: 'second', name: 'Projekt' }],
    });
    expect(resolveChatWorkspace({ ...base, workspaces: [memory] })).toEqual({
      kind: 'no_own_workspace',
    });
  });

  it("uses the page's own workspace when the reader is a member there", () => {
    expect(
      resolveChatWorkspace({
        ...base,
        workspaces: [own, { id: 'theirs', name: 'Deren', isMemory: false }],
      }),
    ).toEqual({ kind: 'member', workspaceId: 'theirs' });
  });
});
