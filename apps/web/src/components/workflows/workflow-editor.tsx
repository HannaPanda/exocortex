'use client';

import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { ArrowLeftIcon } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type AgentProfile,
  validateWorkflowGraph,
  type WorkflowGraph,
  type WorkflowNodeType,
  type WorkflowProblem,
  type WorkflowResponse,
} from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Button,
  ErrorState,
  LoadingState,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@exocortex/ui';

import { useAgentProfiles } from '@/lib/api/agent-profile-queries';
import { ApiError } from '@/lib/api/client';
import { useUpdateWorkflow, useWorkflow } from '@/lib/api/workflow-queries';
import { useWorkspaceDetail } from '@/lib/api/workspace-queries';

import { browserTimeZone } from '../automations/automation-schedule-fields';

import { WorkflowCanvas, type WorkflowSelection } from './workflow-canvas';
import { addNode, duplicateNode, removeNodes, sameGraph } from './workflow-draft';
import { WorkflowEditorHeader } from './workflow-editor-header';
import { EdgeInspector, NodeInspector, WorkflowInspector } from './workflow-inspector';
import { WorkflowPalette } from './workflow-palette';
import { WorkflowProblemList } from './workflow-problems';
import { WorkflowRunsTab } from './workflow-runs-tab';
import { useNodeDecorations } from './workflow-summaries';
import { WorkflowVersionsTab } from './workflow-versions-tab';

/**
 * The workflow editor (issue #164): the draft as a graph, a palette to add
 * to it, a panel for whatever is selected, and beside the draft its runs and
 * its published versions.
 *
 * The draft is edited locally and saved as a whole, with the revision it was
 * loaded at, so a second editor's save is refused instead of overwritten
 * (`workflow_revision_conflict`). The contract's own validation runs on every
 * change, which is what lets a problem appear on the node the moment it is
 * made; the server's answer adds what only the database knows (a profile or
 * a page that is not there) when the draft is saved.
 */

interface Draft {
  graph: WorkflowGraph;
  name: string;
  description: string;
  /** The revision the draft was loaded at; a save names it. */
  revision: number;
}

function draftOf(response: WorkflowResponse): Draft {
  return {
    graph: response.draft,
    name: response.workflow.name,
    description: response.workflow.description ?? '',
    revision: response.workflow.draftRevision,
  };
}

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
  const detail = useWorkspaceDetail(workspaceId);
  const profiles = useAgentProfiles(workspaceId);
  const update = useUpdateWorkflow(workspaceId, workflowId);
  const flow = useReactFlow();

  const role = detail.data?.role ?? null;
  const canManage = role === 'OWNER' || role === 'ADMIN';
  const canActivate = role === 'OWNER';
  const members = detail.data?.members ?? [];
  const profileList: readonly AgentProfile[] = profiles.data?.profiles ?? [];

  const [draft, setDraft] = React.useState<Draft>(() => draftOf(response));
  const [selection, setSelection] = React.useState<WorkflowSelection>(null);
  const [tab, setTab] = React.useState(() => params.get('tab') ?? 'entwurf');
  const [conflict, setConflict] = React.useState(false);

  // What the server holds now. A save answers with it; the local draft then
  // equals it and is no longer "unsaved".
  const saved = React.useMemo(() => draftOf(response), [response]);
  const dirty =
    !sameGraph(draft.graph, saved.graph) ||
    draft.name.trim() !== saved.name ||
    draft.description.trim() !== saved.description;

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

  const setGraph = React.useCallback(
    (graph: WorkflowGraph) => setDraft((current) => ({ ...current, graph })),
    [],
  );

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

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  React.useEffect(() => {
    if (!dirty) return;
    const onLeave = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty]);

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

  const add = (type: WorkflowNodeType, position?: { x: number; y: number }): void => {
    const after = selection?.kind === 'node' ? selection.id : null;
    const result = addNode(draft.graph, type, {
      ...(position === undefined ? { after } : { position }),
      timeZone: browserTimeZone(),
    });
    setGraph(result.graph);
    setSelection({ kind: 'node', id: result.nodeId });
    // A node added from the palette lands right of the graph; bring it into
    // view once React Flow has measured it, so the next choice is visible.
    if (position === undefined) {
      window.setTimeout(() => void flow.fitView({ padding: 0.2, maxZoom: 1, duration: 200 }), 60);
    }
  };

  const focusProblem = (problem: WorkflowProblem): void => {
    if (problem.nodeId !== null) {
      setSelection({ kind: 'node', id: problem.nodeId });
      const node = draft.graph.nodes.find((candidate) => candidate.id === problem.nodeId);
      if (node?.position != null) {
        void flow.setCenter(node.position.x + 120, node.position.y + 40, { duration: 200 });
      }
    } else if (problem.edgeId !== null) {
      setSelection({ kind: 'edge', id: problem.edgeId });
    }
  };

  const selectedNode =
    selection?.kind === 'node'
      ? draft.graph.nodes.find((node) => node.id === selection.id)
      : undefined;
  const readOnly = !canManage;
  const shared = {
    graph: draft.graph,
    problems,
    readOnly,
    onGraphChange: setGraph,
    onSelectProblem: focusProblem,
  };

  // Three columns only where the main area itself is wide enough: with the
  // sidebar and the chat open, a wide window leaves the canvas too little.
  return (
    <div className="@container flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex flex-col gap-3 border-b border-border px-6 pt-5 pb-3">
        <Link
          href={`/arbeitsbereich/${workspaceId}/workflows`}
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" />
          {t('back')}
        </Link>
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
        />
        <EditorNotices
          conflict={conflict}
          saveError={update.error}
          unsavable={validation.graph === null}
          onReload={() => {
            setConflict(false);
            void refetch().then(({ data }) => {
              if (data !== undefined) setDraft(draftOf(data));
            });
          }}
        />
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(String(value))}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="px-6 pt-3">
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
        </div>

        <TabsContent
          value="entwurf"
          className="flex min-h-0 flex-1 flex-col gap-4 p-6 pt-3 @5xl:flex-row"
        >
          <aside className="order-2 shrink-0 @5xl:order-none @5xl:w-48 @5xl:overflow-y-auto">
            <WorkflowPalette onAdd={(type) => add(type)} disabled={readOnly} />
          </aside>
          <div
            className="order-1 h-[60dvh] min-h-80 overflow-hidden rounded-lg border border-border @5xl:order-none @5xl:h-auto @5xl:min-h-0 @5xl:flex-1"
            data-testid="workflow-canvas"
          >
            <WorkflowCanvas
              graph={draft.graph}
              mode={readOnly ? 'view' : 'edit'}
              selection={selection}
              onSelect={setSelection}
              decorations={decorations}
              problemEdgeIds={problemEdgeIds}
              onGraphChange={setGraph}
              onDropType={(type, position) => add(type, position)}
              label={t('canvasLabel', { name: draft.name })}
            />
          </div>
          <aside
            className="order-3 flex shrink-0 flex-col gap-5 @5xl:w-80 @5xl:overflow-y-auto @5xl:pr-1"
            aria-label={t('inspectorLabel')}
          >
            {selectedNode !== undefined ? (
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
            ) : selection?.kind === 'edge' ? (
              <EdgeInspector edgeId={selection.id} {...shared} />
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
            <ProblemsSection problems={problems} graph={draft.graph} onSelect={focusProblem} />
          </aside>
        </TabsContent>

        <TabsContent value="laeufe" className="min-h-0 flex-1 overflow-y-auto p-6 pt-3">
          <WorkflowRunsTab workspaceId={workspaceId} workflowId={workflowId} />
        </TabsContent>
        <TabsContent value="versionen" className="min-h-0 flex-1 overflow-y-auto p-6 pt-3">
          <WorkflowVersionsTab workflow={response.workflow} active={tab === 'versionen'} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function EditorNotices({
  conflict,
  saveError,
  unsavable,
  onReload,
}: {
  conflict: boolean;
  saveError: Error | null;
  unsavable: boolean;
  onReload: () => void;
}) {
  const t = useTranslations('workflows.editor');
  return (
    <>
      {conflict ? (
        <Alert variant="destructive" data-testid="workflow-conflict">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('conflict')}
            <Button variant="outline" size="sm" onClick={onReload}>
              {t('reload')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {saveError !== null && !conflict ? (
        <Alert variant="destructive">
          <AlertDescription>{saveError.message}</AlertDescription>
        </Alert>
      ) : null}
      {unsavable ? (
        <Alert variant="destructive">
          <AlertDescription>{t('unsavable')}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

function ProblemsSection({
  problems,
  graph,
  onSelect,
}: {
  problems: readonly WorkflowProblem[];
  graph: WorkflowGraph;
  onSelect: (problem: WorkflowProblem) => void;
}) {
  const t = useTranslations('workflows.editor');
  return (
    <section className="flex flex-col gap-2 border-t border-border pt-4">
      <h2 className="text-sm font-medium">
        {problems.length === 0 ? t('noProblems') : t('problemsTitle', { count: problems.length })}
      </h2>
      {problems.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('noProblemsHint')}</p>
      ) : (
        <WorkflowProblemList problems={problems} graph={graph} onSelect={onSelect} />
      )}
    </section>
  );
}
