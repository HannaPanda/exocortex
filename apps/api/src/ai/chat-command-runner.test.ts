import { describe, expect, it } from 'vitest';

import { CHAT_COMMANDS } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { serverTranslator } from '@exocortex/i18n/catalog';

import { type SettingsService } from '../platform/settings.service';

import { type AiModelResolverService } from './ai-model-resolver.service';
import { type ChatCommandContext, runChatCommand } from './chat-command-runner';
import { parseChatCommand } from './chat-commands';

/** A context for the listing commands, which only read rules and settings. */
function contextFor(
  content: string,
  rules: { title: string; aiRuleMode: string; aiRuleTrigger: string | null }[] = [],
): ChatCommandContext {
  const command = parseChatCommand(content);
  if (command === null) throw new Error(`not a command: ${content}`);
  return {
    prisma: {
      document: { findMany: () => Promise.resolve(rules) },
    } as unknown as PrismaClient,
    t: serverTranslator('de', 'commands'),
    modelResolver: {} as unknown as AiModelResolverService,
    settings: {
      getForWorkspace: () =>
        Promise.resolve({
          'ai.untrustedContentPolicy': 'guarded',
          'ai.mutatingToolsEnabled': true,
        }),
    } as unknown as SettingsService,
    conversation: {
      id: 'c1',
      workspaceId: 'w1',
      createdById: 'u1',
      documentId: null,
      pageContextEnabled: false,
      modelId: null,
      reasoningLevel: 'NONE',
      model: null,
    },
    command,
    openPageTitle: null,
    requestCompaction: () => Promise.reject(new Error('not used')),
  } as ChatCommandContext;
}

describe('the listing commands answer as a Markdown list (issue #300)', () => {
  it('gives every command of /help its own item, the name as code', async () => {
    const { message } = await runChatCommand(contextFor('/help'));
    const lines = message.split('\n');
    expect(lines).toHaveLength(CHAT_COMMANDS.length);
    expect(lines.every((line) => line.startsWith('- `/'))).toBe(true);
    expect(lines).toContain('- `/new <titel?>`: Neue Unterhaltung starten');
  });

  it('puts one tool on one line', async () => {
    const { message } = await runChatCommand(contextFor('/tools'));
    const items = message.split('\n').filter((line) => line.startsWith('- '));
    expect(items.length).toBeGreaterThan(10);
    expect(items.every((line) => /^- `exo_[a-z_]+`: \S/u.test(line))).toBe(true);
  });

  it('escapes what a person wrote into a rule page', async () => {
    const { message } = await runChatCommand(
      contextFor('/rules', [{ title: 'Stil *fett*', aiRuleMode: 'ALWAYS', aiRuleTrigger: null }]),
    );
    expect(message).toMatch(/^- \*\*Stil \\\*fett\\\*\*\* \(/u);
  });
});
