import * as React from 'react';

import { type WorkflowGraph } from '@exocortex/contracts';

/**
 * Undo and redo for a workflow draft (issue #198).
 *
 * The draft is one immutable graph, so the history is simply the graphs it
 * was before. Changes that arrive in quick succession -- the keystrokes of a
 * goal, the nudges of a node moved with the arrow keys -- are folded into
 * one step, because an undo that takes back a single letter is one nobody
 * presses twice. The history lives in the browser and ends with the page: a
 * saved draft is what the server keeps, and its versions are the history
 * that outlasts a session.
 */

const COALESCE_MS = 600;
const DEPTH = 100;

export interface GraphHistory {
  /** Applies a change and records the graph it replaced. */
  change: (next: WorkflowGraph) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Forgets everything, e.g. when a newer draft replaced this one. */
  reset: () => void;
}

export function useGraphHistory(
  graph: WorkflowGraph,
  apply: (graph: WorkflowGraph) => void,
): GraphHistory {
  const [past, setPast] = React.useState<readonly WorkflowGraph[]>([]);
  const [future, setFuture] = React.useState<readonly WorkflowGraph[]>([]);
  const lastChange = React.useRef(0);

  const change = React.useCallback(
    (next: WorkflowGraph) => {
      if (next === graph) return;
      const now = Date.now();
      if (now - lastChange.current > COALESCE_MS) {
        setPast((current) => [...current, graph].slice(-DEPTH));
      }
      lastChange.current = now;
      setFuture([]);
      apply(next);
    },
    [apply, graph],
  );

  const undo = React.useCallback(() => {
    const previous = past.at(-1);
    if (previous === undefined) return;
    lastChange.current = 0;
    setPast(past.slice(0, -1));
    setFuture((current) => [graph, ...current]);
    apply(previous);
  }, [apply, graph, past]);

  const redo = React.useCallback(() => {
    const next = future[0];
    if (next === undefined) return;
    lastChange.current = 0;
    setFuture(future.slice(1));
    setPast((current) => [...current, graph]);
    apply(next);
  }, [apply, future, graph]);

  const reset = React.useCallback(() => {
    setPast([]);
    setFuture([]);
    lastChange.current = 0;
  }, []);

  return {
    change,
    undo,
    redo,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    reset,
  };
}

/** Whether a key press belongs to a field that has its own undo and its own letters. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range'].includes(type);
}
