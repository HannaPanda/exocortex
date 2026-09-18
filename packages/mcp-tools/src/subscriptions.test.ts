import { describe, expect, it } from 'vitest';

import { type ApplicationEvent, type DocumentSummary } from '@exocortex/contracts';

import {
  MAX_RESOURCE_SUBSCRIPTIONS,
  ResourceSubscriptions,
  resourceUpdatedNotification,
  resourceUrisForEvent,
} from './subscriptions.js';

const WORKSPACE_ID = 'ws_1';

function summary(overrides: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    id: 'doc_child',
    workspaceId: WORKSPACE_ID,
    parentId: 'doc_parent',
    type: 'PAGE',
    title: 'Eine Seite',
    icon: null,
    iconColor: null,
    layout: 'DEFAULT',
    overviewMode: 'OFF',
    coverAttachmentId: null,
    coverPosition: 50,
    orderKey: 'a0',
    createdById: 'user_1',
    updatedById: 'user_1',
    createdAt: '2026-09-18T10:00:00.000Z',
    updatedAt: '2026-09-18T10:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

function event<TEvent extends ApplicationEvent>(
  type: TEvent['type'],
  payload: TEvent['payload'],
): ApplicationEvent {
  return {
    type,
    workspaceId: WORKSPACE_ID,
    correlationId: 'test',
    emittedAt: '2026-09-18T10:00:00.000Z',
    payload,
  } as ApplicationEvent;
}

describe('ResourceSubscriptions', () => {
  it('accepts a well-formed URI without asking whether the page exists', () => {
    // The whole point: a subscription that failed for a page somebody else
    // owns would answer the question `resources/read` refuses to answer.
    const subscriptions = new ResourceSubscriptions();
    expect(subscriptions.subscribe('exocortex://page/does_not_exist')).toBeNull();
    expect(subscriptions.has('exocortex://page/does_not_exist')).toBe(true);
  });

  it('refuses a URI of a shape this server does not address', () => {
    const subscriptions = new ResourceSubscriptions();
    expect(subscriptions.subscribe('exocortex://nonsense/1')).toBe('unknown-uri');
    expect(subscriptions.size).toBe(0);
  });

  it('caps the set and lets a repeat of a held URI through', () => {
    const subscriptions = new ResourceSubscriptions();
    for (let index = 0; index < MAX_RESOURCE_SUBSCRIPTIONS; index += 1) {
      subscriptions.subscribe(`exocortex://page/doc${String(index)}`);
    }

    expect(subscriptions.subscribe('exocortex://page/another')).toBe('too-many');
    // Already held, so it costs nothing and must not be refused.
    expect(subscriptions.subscribe('exocortex://page/doc0')).toBeNull();
  });

  it('reports the first subscription so a transport can open its channel', () => {
    let opened = 0;
    const subscriptions = new ResourceSubscriptions(() => {
      opened += 1;
    });

    subscriptions.subscribe('exocortex://page/doc_1');
    expect(opened).toBe(1);
    subscriptions.subscribe('exocortex://nope');
    expect(opened).toBe(1);
  });

  it('unsubscribing something it never held is not an error', () => {
    const subscriptions = new ResourceSubscriptions();
    expect(() => {
      subscriptions.unsubscribe('exocortex://page/doc_1');
    }).not.toThrow();
  });

  it('matches in the order the change named them', () => {
    const subscriptions = new ResourceSubscriptions();
    subscriptions.subscribe('exocortex://page/b');
    subscriptions.subscribe('exocortex://page/a');

    expect(
      subscriptions.matching(['exocortex://page/a', 'exocortex://page/c', 'exocortex://page/b']),
    ).toEqual(['exocortex://page/a', 'exocortex://page/b']);
  });
});

describe('resourceUrisForEvent', () => {
  it('names only the page when its body changed', () => {
    expect(
      resourceUrisForEvent(
        event('document.materialized', {
          documentId: 'doc_child',
          schemaVersion: 1,
          materializedAt: '2026-09-18T10:00:00.000Z',
          plainTextLength: 12,
        }),
      ),
    ).toEqual(['exocortex://page/doc_child']);
  });

  it('names the parent too, because a page resource carries its children', () => {
    const uris = resourceUrisForEvent(event('document.created', { document: summary() }));

    expect(uris).toContain('exocortex://page/doc_child');
    expect(uris).toContain('exocortex://page/doc_parent');
    expect(uris).toContain(`exocortex://workspace/${WORKSPACE_ID}/tree`);
  });

  it('names both ends of a move', () => {
    const uris = resourceUrisForEvent(
      event('document.moved', {
        document: summary({ parentId: 'doc_new_parent' }),
        previousParentId: 'doc_old_parent',
      }),
    );

    expect(uris).toContain('exocortex://page/doc_old_parent');
    expect(uris).toContain('exocortex://page/doc_new_parent');
  });

  it('names the whole branch a deletion took with it', () => {
    const uris = resourceUrisForEvent(
      event('document.deleted', {
        documentId: 'doc_child',
        documentIds: ['doc_child', 'doc_grandchild'],
      }),
    );

    expect(uris).toContain('exocortex://page/doc_child');
    expect(uris).toContain('exocortex://page/doc_grandchild');
  });

  it('stays quiet for everything that is not a page', () => {
    expect(
      resourceUrisForEvent(event('ai.run.phase', { runId: 'run_1', phase: 'thinking' } as never)),
    ).toEqual([]);
  });
});

describe('resourceUpdatedNotification', () => {
  it('is a JSON-RPC notification, so it carries no id to answer', () => {
    expect(resourceUpdatedNotification('exocortex://page/doc_1')).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/resources/updated',
      params: { uri: 'exocortex://page/doc_1' },
    });
  });
});
