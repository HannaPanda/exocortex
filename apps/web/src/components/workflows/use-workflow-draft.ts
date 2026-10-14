'use client';

import { useReactFlow } from '@xyflow/react';
import * as React from 'react';

import {
  type AgentProfile,
  validateWorkflowGraph,
  type WorkflowGraph,
  type WorkflowProblem,
  type WorkflowResponse,
} from '@exocortex/contracts';

import { useAgentProfiles } from '@/lib/api/agent-profile-queries';
import { ApiError } from '@/lib/api/client';
import { type useUpdateWorkflow } from '@/lib/api/workflow-queries';
import { useWorkspaceDetail } from '@/lib/api/workspace-queries';

import { viewDuration } from './workflow-canvas';
import { sameGraph } from './workflow-draft';
import { useGraphHistory } from './workflow-history';

/**
 * The draft the workflow editor holds (issues #164, #198).
 *
 * The draft is edited locally and saved as a whole, with the revision it was
 * loaded at, so a second editor's save is refused instead of overwritten
 * (`workflow_revision_conflict`). The contract's own validation runs on every
 * change, which is what lets a problem appear on the node the moment it is
 * made; the server's answer adds what only the database knows (a profile or
 * a page that is not there) when the draft is saved. Every change to the
 * graph goes through one history.
 */

export interface Draft {
  graph: WorkflowGraph;
  name: string;
  description: string;
  /** The revision the draft was loaded at; a save names it. */
  revision: number;
}

export function draftOf(response: WorkflowResponse): Draft {
  return {
    graph: response.draft,
    name: response.workflow.name,
    description: response.workflow.description ?? '',
    revision: response.workflow.draftRevision,
  };
}

export function useWorkflowDraft(
  response: WorkflowResponse,
  update: ReturnType<typeof useUpdateWorkflow>,
) {
  const [draft, setDraft] = React.useState<Draft>(() => draftOf(response));
  const [conflict, setConflict] = React.useState(false);

  // What the server holds now. A save answers with it; the local draft then
  // equals it and is no longer "unsaved".
  const saved = React.useMemo(() => draftOf(response), [response]);
  const dirty =
    !sameGraph(draft.graph, saved.graph) ||
    draft.name.trim() !== saved.name ||
    draft.description.trim() !== saved.description;

  const applyGraph = React.useCallback(
    (graph: WorkflowGraph) => setDraft((current) => ({ ...current, graph })),
    [],
  );
  const history = useGraphHistory(draft.graph, applyGraph);

  // A newer draft on the server (a reload after a conflict) replaces an
  // untouched local one; a touched one is kept, and saving it will say that
  // somebody else got there first.
  const [seenRevision, setSeenRevision] = React.useState(saved.revision);
  if (saved.revision !== seenRevision) {
    setSeenRevision(saved.revision);
    if (!dirty) setDraft(saved);
  }

  const validation = React.useMemo(() => validateWorkflowGraph(draft.graph), [draft.graph]);
  const problems = React.useMemo<WorkflowProblem[]>(
    () => [
      ...validation.problems,
      // Only the database knows these; they hold for what was last saved.
      ...response.problems.filter((problem) => problem.code === 'reference_not_found'),
    ],
    [response.problems, validation.problems],
  );
  const savable = validation.graph !== null && draft.name.trim().length > 0;

  const save = React.useCallback(async (): Promise<void> => {
    if (!savable || !dirty || update.isPending) return;
    try {
      const result = await update.mutateAsync({
        name: draft.name.trim(),
        description: draft.description.trim().length === 0 ? null : draft.description.trim(),
        graph: draft.graph,
        expectedRevision: draft.revision,
      });
      setConflict(false);
      // The next save builds on the revision this one produced.
      setDraft((current) => ({ ...current, revision: result.workflow.draftRevision }));
    } catch (error) {
      if (error instanceof ApiError && error.code === 'workflow_revision_conflict') {
        setConflict(true);
      }
    }
  }, [dirty, draft, savable, update]);

  return {
    draft,
    setDraft,
    dirty,
    history,
    setGraph: history.change,
    validation,
    problems,
    savable,
    save,
    conflict,
    setConflict,
  };
}

/**
 * Brings a point of the graph into view, but only when it is not already (or
 * when asked to). The part of the canvas a floating panel covers does not
 * count as in view: the point is centred in what is left of it. Measured a
 * frame later, because the panel for a node just selected is not drawn yet.
 */
export function useReveal(canvasRef: React.RefObject<HTMLDivElement | null>) {
  const flow = useReactFlow();
  return React.useCallback(
    (position: { x: number; y: number }, always = false) => {
      window.requestAnimationFrame(() => {
        const canvas = canvasRef.current;
        if (canvas === null) return;
        const box = canvas.getBoundingClientRect();
        const panel = document.querySelector('[data-testid="workflow-inspector"]');
        const panelBox = panel?.getBoundingClientRect();
        // A docked panel sits beside the canvas and covers none of it.
        const right =
          panelBox !== undefined && panelBox.left < box.right && panelBox.right > box.left
            ? panelBox.left
            : box.right;
        const centre = { x: position.x + 120, y: position.y + 50 };
        if (!always) {
          const onScreen = flow.flowToScreenPosition(centre);
          const inside =
            onScreen.x > box.left + 40 &&
            onScreen.x < right - 40 &&
            onScreen.y > box.top + 40 &&
            onScreen.y < box.bottom - 40;
          if (inside) return;
        }
        const zoom = Math.max(flow.getZoom(), 0.8);
        // setCenter centres in the whole canvas; shift by half the covered width.
        const covered = box.right - right;
        void flow.setCenter(centre.x + covered / 2 / zoom, centre.y, {
          zoom,
          duration: viewDuration(),
        });
      });
    },
    [canvasRef, flow],
  );
}

/** What the person may do here, and the members and profiles the forms choose from. */
export function useEditorAccess(workspaceId: string) {
  const detail = useWorkspaceDetail(workspaceId);
  const profiles = useAgentProfiles(workspaceId);
  const role = detail.data?.role ?? null;
  const profileList: readonly AgentProfile[] = profiles.data?.profiles ?? [];
  return {
    canManage: role === 'OWNER' || role === 'ADMIN',
    canActivate: role === 'OWNER',
    members: detail.data?.members ?? [],
    profileList,
  };
}
