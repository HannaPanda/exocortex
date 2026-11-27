/**
 * Which AI runs are working on which page right now, as far as this browser
 * has heard (issue #248).
 *
 * Nothing here is stored or asked for: the state is folded from the events
 * this tab already receives (`ai.run.tool_call` with its `subject`, ADR-084,
 * and the run's end), so it says what just happened, never what is going on
 * in a place nobody told us about (ADR-065). A run is on a page from a tool
 * call about that page until its next tool call, its end, or a long silence:
 * a dropped socket must not leave a hint standing for ever.
 *
 * Which runs reach this tab is the gateway's decision, not this module's: a
 * workspace room is joined only by its members (`canSubscribeToWorkspaceRoom`),
 * so a person reading a shared page hears their own runs and never the
 * owner's.
 *
 * Pure, so the rules are tested without a socket.
 */

/** How long a run stays on a page without any sign of life. */
export const RUN_PRESENCE_SILENCE_MS = 3 * 60_000;

const LIFE_SIGN_GRANULARITY_MS = 5_000;

export interface RunPresence {
  /** The page of the run's latest tool call; `null` when that call was about no page. */
  documentId: string | null;
  /** The call changes the page (its target is the page), rather than only reading it. */
  writing: boolean;
  /** The last moment anything was heard from the run. */
  heardAt: number;
}

export type RunPresenceMap = ReadonlyMap<string, RunPresence>;

export const NO_RUN_PRESENCE: RunPresenceMap = new Map();

/** `document:<id>` to `<id>`; anything else is no page. */
function pageOf(reference: string | null | undefined): string | null {
  if (typeof reference !== 'string' || !reference.startsWith('document:')) return null;
  const id = reference.slice('document:'.length);
  return id.length > 0 ? id : null;
}

export interface ToolCallHeard {
  runId: string;
  status: 'started' | 'succeeded' | 'failed' | 'refused';
  target: string | null;
  subject: string | null;
}

/**
 * A tool call: the run is now where this call is. A call that failed or was
 * refused did not reach its page, and one about no page takes the run off
 * the page it was on, the same rule the chat's pulse follows.
 */
export function heardToolCall(
  current: RunPresenceMap,
  call: ToolCallHeard,
  now: number,
): RunPresenceMap {
  const reached = call.status !== 'failed' && call.status !== 'refused';
  const target = pageOf(call.target);
  const documentId = reached ? (target ?? pageOf(call.subject)) : null;
  const next = new Map(current);
  next.set(call.runId, {
    documentId,
    writing: documentId !== null && target === documentId,
    heardAt: now,
  });
  return next;
}

/** Any other sign of life (a phase, a delta): the run stays where it is, for longer. */
export function heardFromRun(current: RunPresenceMap, runId: string, now: number): RunPresenceMap {
  const known = current.get(runId);
  // Deltas arrive many times a second; a few seconds is precise enough for a
  // silence measured in minutes, and spares the page a render per word.
  if (known === undefined || now - known.heardAt < LIFE_SIGN_GRANULARITY_MS) return current;
  const next = new Map(current);
  next.set(runId, { ...known, heardAt: now });
  return next;
}

/** The run ended, however it ended. */
export function runEnded(current: RunPresenceMap, runId: string): RunPresenceMap {
  if (!current.has(runId)) return current;
  const next = new Map(current);
  next.delete(runId);
  return next;
}

/**
 * Whether a run is on this page now, and whether any of them writes. `null`
 * when none is, including one that has been silent too long.
 */
export function presenceOn(
  current: RunPresenceMap,
  documentId: string,
  now: number,
): { writing: boolean } | null {
  let here = false;
  let writing = false;
  for (const presence of current.values()) {
    if (presence.documentId !== documentId) continue;
    if (now - presence.heardAt > RUN_PRESENCE_SILENCE_MS) continue;
    here = true;
    writing ||= presence.writing;
  }
  return here ? { writing } : null;
}
