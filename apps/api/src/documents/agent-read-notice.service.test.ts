import { describe, expect, it, vi } from 'vitest';

import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { type RequestContext, runWithRequestContext } from '../common/correlation';
import { type RealtimeService } from '../realtime/realtime.service';

import { AgentReadNoticeService } from './agent-read-notice.service';

function setup(document: { workspaceId: string } | null = { workspaceId: 'ws1' }) {
  const findUnique = vi.fn().mockResolvedValue(document);
  const emit = vi.fn().mockResolvedValue(undefined);
  const warn = vi.fn();
  const service = new AgentReadNoticeService(
    { document: { findUnique } } as unknown as PrismaClient,
    { emit } as unknown as RealtimeService,
    { warn } as unknown as Logger,
  );
  return { service, findUnique, emit, warn };
}

async function announceIn(
  service: AgentReadNoticeService,
  context: Omit<RequestContext, 'correlationId'>,
): Promise<void> {
  runWithRequestContext({ correlationId: 'c1', ...context }, () => {
    service.announce('doc1');
  });
  // The notice is sent after the read has answered; let it settle.
  await new Promise((resolve) => setImmediate(resolve));
}

describe('AgentReadNoticeService', () => {
  it('announces a read that came with an agent session', async () => {
    const { service, emit } = setup();
    await announceIn(service, { agentSession: { externalId: 's1', clientLabel: 'Claude Code' } });
    expect(emit).toHaveBeenCalledWith('agent.page.read', 'ws1', 'c1', {
      documentId: 'doc1',
      clientLabel: 'Claude Code',
    });
  });

  it('stays quiet for a person in the browser', async () => {
    const { service, emit, findUnique } = setup();
    await announceIn(service, { userId: 'u1' });
    expect(findUnique).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('leaves the built-in AI to its own tool-call events', async () => {
    const { service, emit } = setup();
    await announceIn(service, { agentSession: { externalId: 's1' }, aiRunId: 'run1' });
    expect(emit).not.toHaveBeenCalled();
  });

  it('logs instead of throwing when the page cannot be looked up', async () => {
    const { service, findUnique, emit, warn } = setup();
    findUnique.mockRejectedValue(new Error('down'));
    await announceIn(service, { agentSession: { externalId: 's1' } });
    expect(emit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });
});
