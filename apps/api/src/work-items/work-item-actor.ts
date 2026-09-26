import { type VerifiedSession } from '@exocortex/auth';
import { type WorkItemParticipantKind } from '@exocortex/contracts';

import { currentAgentSession } from '../common/correlation';

/**
 * Who is making a change to a work item, as far as the history is concerned.
 *
 * The account alone does not say it: Johanna's own token behind Claude Code is
 * her account, and so is the built-in AI acting for her. So the kind is read
 * from how the request arrived -- a service token is the worker's tool loop
 * (the assistant), a named agent session is an external agent (ADR-022), and
 * everything else is a person at the keyboard. None of this is used for a
 * permission; it is provenance, shown to whoever reads the history.
 */
export interface WorkItemActor {
  kind: WorkItemParticipantKind;
  userId: string;
  /** The agent client's own name for itself, unverified. */
  agentLabel: string | null;
}

/** `SessionGuard` gives a service token a session id of this shape. */
const SERVICE_SESSION_PREFIX = 'service:';

export function workItemActorOf(session: VerifiedSession): WorkItemActor {
  if (session.sessionId.startsWith(SERVICE_SESSION_PREFIX)) {
    return { kind: 'assistant', userId: session.userId, agentLabel: null };
  }
  const agent = currentAgentSession();
  if (agent !== undefined) {
    return { kind: 'agent', userId: session.userId, agentLabel: agent.clientLabel ?? null };
  }
  return { kind: 'human', userId: session.userId, agentLabel: null };
}
