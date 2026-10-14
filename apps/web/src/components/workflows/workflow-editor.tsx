'use client';

import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type WorkflowNodeType,
  type WorkflowProblem,
  type WorkflowResponse,
} from '@exocortex/contracts';
import { ErrorState, LoadingState, Tabs, TabsContent, TabsList, TabsTrigger } from '@exocortex/ui';

import { useUpdateWorkflow, useWorkflow } from '@/lib/api/workflow-queries';

import { browserTimeZone } from '../automations/automation-schedule-fields';
import { useUnsavedChangesGuard } from '../settings/unsaved-changes-guard';

import { draftOf, useEditorAccess, useReveal, useWorkflowDraft } from './use-workflow-draft';
import { viewDuration, WorkflowCanvas, type WorkflowSelection } from './workflow-canvas';
import { addNode, duplicateNode, removeNodes, tidyGraph } from './workflow-draft';
import { WorkflowEditorHeader } from './workflow-editor-header';
import {
  EditorCanvasTools,
  EditorNotices,
  EditorPanel,
  SettingsToggle,
  useEditorKeys,
} from './workflow-editor-parts';
import { EdgeInspector, NodeInspector, WorkflowInspector } from './workflow-inspector';
import { WorkflowPalette } from './workflow-palette';
import { WorkflowRunsTab } from './workflow-runs-tab';
import { useNodeDecorations } from './workflow-summaries';
import { WorkflowVersionsTab } from './workflow-versions-tab';

function panelFor(
  node: unknown,
  edge: unknown,
  settingsOpen: boolean,
): 'node' | 'edge' | 'settings' | null {
  if (node !== undefined) return 'node';
  if (edge !== undefined) return 'edge';
  return settingsOpen ? 'settings' : null;
}

/**
 * The workflow editor (issues #164, #198): the draft as a graph that fills
 * the screen, a narrow rail to add to it, a panel for whatever is selected
 * (or the workflow's own settings, on request), and beside the draft its runs
 * and its published versions.
 *
 * The canvas is the work surface; everything else appears when it is asked
 * for. The panel opens beside the canvas where there is room and over its
 * edge where there is not, and closes with Escape. Every change to the graph
 * goes through one history, so a deletion or a tidy-up is one Ctrl+Z away.
 *
 * The draft is edited locally and saved as a whole, with the revision it was
 * loaded at, so a second editor's save is refused instead of overwritten
 * (`workflow_revision_conflict`). The contract's own validation runs on every
 * change, which is what lets a problem appear on the node the moment it is
 * made; the server's answer adds what only the database knows (a profile or
 * a page that is not there) when the draft is saved.
 */

export function WorkflowEditor({
  workspaceId,
  workflowId,
}: {
  workspaceId: string;
  workflowId: string;
}) {
  const t = useTranslations('workflows.editor');
  const workflow = useWorkflow(workflowId);
  if (workflow.isPending) {
    return <LoadingState variant="skeleton" rows={6} label={t('loading')} className="p-6" />;
  }
  if (workflow.isError) {
    return (
      <ErrorState
        className="p-6"
        title={t('loadFailed')}
        description={workflow.error.message}
        onRetry={() => void workflow.refetch()}
      />
    );
  }
  return (
    <ReactFlowProvider>
      <LoadedEditor workspaceId={workspaceId} response={workflow.data} refetch={workflow.refetch} />
    </ReactFlowProvider>
  );
}

function LoadedEditor({
  workspaceId,
  response,
  refetch,
}: {
  workspaceId: string;
  response: WorkflowResponse;
  refetch: () => Promise<{ data?: WorkflowResponse | undefined }>;
}) {
  const t = useTranslations('workflows.editor');
  const params = useSearchParams();
  const workflowId = response.workflow.id;
  const update = useUpdateWorkflow(workspaceId, workflowId);
  const flow = useReactFlow();
  const canvasRef = React.useRef<HTMLDivElement>(null);

  const { canManage, canActivate, members, profileList } = useEditorAccess(workspaceId);

  const [selection, setSelection] = React.useState<WorkflowSelection>(null);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [addOpen, setAddOpen] = React.useState(false);
  const [tab, setTabState] = React.useState(() => params.get('tab') ?? 'entwurf');

  // The tab is part of the address, so a reload or a shared link lands on it.
  const setTab = React.useCallback((value: string) => {
    setTabState(value);
    const url = new URL(window.location.href);
    if (value === 'entwurf') url.searchParams.delete('tab');
    else url.searchParams.set('tab', value);
    window.history.replaceState(window.history.state, '', url);
  }, []);

  const {
    draft,
    setDraft,
    dirty,
    history,
    setGraph,
    validation,
    problems,
    savable,
    save,
    conflict,
    setConflict,
  } = useWorkflowDraft(response, update);

  const unsavedGuard = useUnsavedChangesGuard(dirty ? 1 : 0, t('unsavedLeave'));

  const decorations = useNodeDecorations({
    graph: draft.graph,
    problems,
    envelope: response.envelope,
    profiles: profileList,
    members,
  });
  const problemEdgeIds = React.useMemo(
    () => new Set(problems.flatMap((problem) => (problem.edgeId === null ? [] : [problem.edgeId]))),
    [problems],
  );

  const reveal = useReveal(canvasRef);

  const add = (
    type: WorkflowNodeType,
    options: { position?: { x: number; y: number }; after?: string; handle?: string } = {},
  ): void => {
    const after = options.after ?? (selection?.kind === 'node' ? selection.id : null);
    const result = addNode(draft.graph, type, {
      ...(options.position === undefined ? { after } : { position: options.position }),
      ...(options.handle === undefined ? {} : { handle: options.handle }),
      timeZone: browserTimeZone(),
    });
    setGraph(result.graph);
    setSettingsOpen(false);
    setSelection({ kind: 'node', id: result.nodeId });
    const placed = result.graph.nodes.find((node) => node.id === result.nodeId)?.position;
    if (options.position === undefined && placed != null) reveal(placed);
  };

  const focusProblem = (problem: WorkflowProblem): void => {
    setSettingsOpen(false);
    if (problem.nodeId !== null) {
      setSelection({ kind: 'node', id: problem.nodeId });
      const node = draft.graph.nodes.find((candidate) => candidate.id === problem.nodeId);
      if (node?.position != null) reveal(node.position, true);
    } else if (problem.edgeId !== null) {
      setSelection({ kind: 'edge', id: problem.edgeId });
    }
  };

  const tidy = (): void => {
    setGraph(tidyGraph(draft.graph));
    window.setTimeout(
      () => void flow.fitView({ padding: 0.15, maxZoom: 1, duration: viewDuration() }),
      0,
    );
  };

  const readOnly = !canManage;
  const closePanel = (): void => {
    setSelection(null);
    setSettingsOpen(false);
  };

  useEditorKeys({
    save,
    history,
    active: tab === 'entwurf' && !readOnly,
    onAdd: () => setAddOpen(true),
  });

  const selectedNode =
    selection?.kind === 'node'
      ? draft.graph.nodes.find((node) => node.id === selection.id)
      : undefined;
  const selectedEdge =
    selection?.kind === 'edge'
      ? draft.graph.edges.find((edge) => edge.id === selection.id)
      : undefined;
  const panel = panelFor(selectedNode, selectedEdge, settingsOpen);
  const shared = {
    graph: draft.graph,
    problems,
    readOnly,
    onGraphChange: setGraph,
    onSelectProblem: focusProblem,
  };
  const hasTrigger = draft.graph.nodes.some((node) => node.type.startsWith('trigger.'));

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(String(value))}
      className="@container flex min-h-0 flex-1 flex-col gap-0"
    >
      <div className="flex flex-col gap-2 border-b border-border px-4 pt-3 pb-2.5 @3xl:px-6">
        <WorkflowEditorHeader
          workspaceId={workspaceId}
          response={response}
          name={draft.name}
          dirty={dirty}
          savable={savable}
          saving={update.isPending}
          problems={problems}
          canManage={canManage}
          canActivate={canActivate}
          profiles={profileList}
          onSave={() => void save()}
          onOpenRuns={() => setTab('laeufe')}
          tools={
            tab === 'entwurf' ? (
              <SettingsToggle
                open={panel === 'settings'}
                onToggle={() => {
                  setSelection(null);
                  setSettingsOpen(panel !== 'settings');
                }}
              />
            ) : null
          }
          tabs={
            <TabsList className="w-fit">
              <TabsTrigger value="entwurf" data-testid="workflow-tab-draft">
                {t('tabDraft')}
              </TabsTrigger>
              <TabsTrigger value="laeufe" data-testid="workflow-tab-runs">
                {t('tabRuns')}
              </TabsTrigger>
              <TabsTrigger value="versionen" data-testid="workflow-tab-versions">
                {t('tabVersions')}
              </TabsTrigger>
            </TabsList>
          }
        />
        <EditorNotices
          conflict={conflict}
          saveError={update.error}
          unsavable={validation.graph === null}
          onReload={() => {
            setConflict(false);
            void refetch().then(({ data }) => {
              if (data !== undefined) {
                setDraft(draftOf(data));
                history.reset();
              }
            });
          }}
        />
      </div>

      <TabsContent value="entwurf" className="relative flex min-h-80 flex-1">
        <WorkflowPalette
          onAdd={(type) => add(type)}
          disabled={readOnly}
          menuOpen={addOpen}
          onMenuOpenChange={setAddOpen}
          hasSelection={selectedNode !== undefined}
        />
        <div
          ref={canvasRef}
          className="relative min-w-0 flex-1"
          data-testid="workflow-canvas"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && panel !== null) closePanel();
          }}
        >
          <WorkflowCanvas
            graph={draft.graph}
            mode={readOnly ? 'view' : 'edit'}
            selection={selection}
            onSelect={(next) => {
              setSelection(next);
              if (next !== null) setSettingsOpen(false);
            }}
            decorations={decorations}
            problemEdgeIds={problemEdgeIds}
            onGraphChange={setGraph}
            onDropType={(type, position) => add(type, { position })}
            onAddFrom={(source, handle, type) => add(type, { after: source, handle })}
            label={t('canvasLabel', { name: draft.name })}
          >
            <EditorCanvasTools
              readOnly={readOnly}
              history={history}
              canTidy={draft.graph.nodes.length > 1}
              onTidy={tidy}
              problems={problems}
              graph={draft.graph}
              onSelectProblem={focusProblem}
              onAddTrigger={hasTrigger || readOnly ? null : () => add('trigger.manual')}
            />
          </WorkflowCanvas>
        </div>

        {panel === null ? null : (
          <EditorPanel onClose={closePanel}>
            {panel === 'node' && selectedNode !== undefined ? (
              <NodeInspector
                key={selectedNode.id}
                node={selectedNode}
                workspaceId={workspaceId}
                envelope={response.envelope}
                profiles={profileList}
                members={members}
                onDuplicate={() => {
                  const copied = duplicateNode(draft.graph, selectedNode.id);
                  if (copied === null) return;
                  setGraph(copied.graph);
                  setSelection({ kind: 'node', id: copied.nodeId });
                }}
                onDelete={() => {
                  setGraph(removeNodes(draft.graph, [selectedNode.id]));
                  setSelection(null);
                }}
                {...shared}
              />
            ) : panel === 'edge' && selectedEdge !== undefined ? (
              <EdgeInspector edgeId={selectedEdge.id} {...shared} />
            ) : (
              <WorkflowInspector
                name={draft.name}
                description={draft.description}
                onNameChange={(name) => setDraft((current) => ({ ...current, name }))}
                onDescriptionChange={(description) =>
                  setDraft((current) => ({ ...current, description }))
                }
                envelope={response.envelope}
                onAddTrigger={() => add('trigger.manual')}
                {...shared}
              />
            )}
          </EditorPanel>
        )}
      </TabsContent>

      <TabsContent value="laeufe" className="min-h-0 flex-1 overflow-y-auto p-6 pt-4">
        <WorkflowRunsTab workspaceId={workspaceId} workflowId={workflowId} />
      </TabsContent>
      <TabsContent value="versionen" className="min-h-0 flex-1 overflow-y-auto p-6 pt-4">
        <WorkflowVersionsTab workflow={response.workflow} active={tab === 'versionen'} />
      </TabsContent>
      {unsavedGuard}
    </Tabs>
  );
}
