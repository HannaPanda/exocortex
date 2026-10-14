'use client';

import { Panel } from '@xyflow/react';
import {
  CircleAlertIcon,
  CircleCheckIcon,
  LayoutGridIcon,
  PlusIcon,
  Redo2Icon,
  Settings2Icon,
  Undo2Icon,
  XIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type WorkflowGraph, type WorkflowProblem } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@exocortex/ui';

import { CanvasButton, CanvasControls, CanvasDivider } from './workflow-canvas-controls';
import { type GraphHistory, isTypingTarget } from './workflow-history';
import { WorkflowProblemList } from './workflow-problems';

/**
 * The pieces of the workflow editor around the graph (issue #198): what
 * floats on the canvas, the panel beside it, the notices above it, and the
 * editor's keys.
 */

/**
 * The canvas's own tools: view and history in the lower left, the
 * workflow's settings in the upper right, the problems in the lower right,
 * and -- only while there is none -- a way to add the trigger at the top.
 */
export function EditorCanvasTools({
  readOnly,
  history,
  canTidy,
  onTidy,
  settingsOpen,
  onToggleSettings,
  problems,
  graph,
  onSelectProblem,
  onAddTrigger,
}: {
  readOnly: boolean;
  history: GraphHistory;
  canTidy: boolean;
  onTidy: () => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  problems: readonly WorkflowProblem[];
  graph: WorkflowGraph;
  onSelectProblem: (problem: WorkflowProblem) => void;
  onAddTrigger: (() => void) | null;
}) {
  const t = useTranslations('workflows.editor');
  return (
    <>
      <CanvasControls>
        {readOnly ? null : (
          <>
            <CanvasDivider />
            <CanvasButton
              label={t('undo')}
              shortcut="Strg+Z"
              disabled={!history.canUndo}
              onClick={history.undo}
              testId="workflow-undo"
            >
              <Undo2Icon />
            </CanvasButton>
            <CanvasButton
              label={t('redo')}
              shortcut="Strg+Umschalt+Z"
              disabled={!history.canRedo}
              onClick={history.redo}
              testId="workflow-redo"
            >
              <Redo2Icon />
            </CanvasButton>
            <CanvasDivider />
            <CanvasButton
              label={t('tidy')}
              disabled={!canTidy}
              onClick={onTidy}
              testId="workflow-tidy"
            >
              <LayoutGridIcon />
            </CanvasButton>
          </>
        )}
      </CanvasControls>
      <Panel position="top-right">
        <Button
          variant={settingsOpen ? 'secondary' : 'outline'}
          size="sm"
          className="bg-popover shadow-md"
          aria-pressed={settingsOpen}
          onClick={onToggleSettings}
          data-testid="workflow-open-settings"
        >
          <Settings2Icon />
          {t('settings')}
        </Button>
      </Panel>
      <Panel position="bottom-right">
        <ProblemsButton problems={problems} graph={graph} onSelect={onSelectProblem} />
      </Panel>
      {onAddTrigger === null ? null : (
        <Panel position="top-center">
          <Button size="sm" onClick={onAddTrigger}>
            <PlusIcon />
            {t('addTrigger')}
          </Button>
        </Panel>
      )}
    </>
  );
}

/**
 * The panel for what is selected, or for the workflow's settings. Beside
 * the canvas where there is room, over its right edge where there is not:
 * never below it, where it would be off screen the moment something is
 * selected. Escape inside it closes it.
 */
export function EditorPanel({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  const t = useTranslations('workflows.editor');
  return (
    <aside
      aria-label={t('inspectorLabel')}
      data-testid="workflow-inspector"
      className={[
        'absolute inset-y-3 right-3 z-10 flex w-88 max-w-[calc(100%-4.5rem)] flex-col rounded-lg border border-border-strong bg-popover shadow-lg',
        '@4xl:static @4xl:w-88 @4xl:max-w-none @4xl:rounded-none @4xl:border-0 @4xl:border-l @4xl:border-border @4xl:bg-surface @4xl:shadow-none',
      ].join(' ')}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        // A menu opened from the panel lives in a portal; its Escape is its own.
        if (!event.currentTarget.contains(event.target as Node)) return;
        onClose();
      }}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute top-3 right-3 z-10"
        aria-label={t('closePanel')}
        onClick={onClose}
        data-testid="workflow-inspector-close"
      >
        <XIcon />
      </Button>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">{children}</div>
    </aside>
  );
}

/**
 * The editor's keys: Ctrl+S saves anywhere; on the draft, Ctrl+Z and
 * Ctrl+Shift+Z (or Ctrl+Y) walk the history and `A` opens the add list. A
 * text field keeps its own undo and its own letters, and a dialog or a menu
 * keeps its keys.
 */
export function useEditorKeys({
  save,
  history,
  active,
  onAdd,
}: {
  save: () => Promise<void>;
  history: GraphHistory;
  active: boolean;
  onAdd: () => void;
}): void {
  const onKey = React.useEffectEvent((event: KeyboardEvent): void => {
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (mod && key === 's') {
      event.preventDefault();
      void save();
      return;
    }
    if (!active || isTypingTarget(event.target) || insideOverlay(event.target)) return;
    if (mod && !event.altKey && (key === 'z' || key === 'y')) {
      event.preventDefault();
      if (key === 'y' || event.shiftKey) history.redo();
      else history.undo();
      return;
    }
    if (!mod && !event.altKey && !event.shiftKey && key === 'a') {
      event.preventDefault();
      onAdd();
    }
  });
  React.useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Whether a key press comes from inside a dialog, a menu or a list that owns its keys. */
function insideOverlay(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]') !== null
  );
}

export function EditorNotices({
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

/**
 * The problems as one counted mark in the canvas's corner (issue #198): the
 * single next step while anything blocks publishing, opening the list that
 * leads to each one. With none it says so, quietly.
 */
export function ProblemsButton({
  problems,
  graph,
  onSelect,
}: {
  problems: readonly WorkflowProblem[];
  graph: WorkflowGraph;
  onSelect: (problem: WorkflowProblem) => void;
}) {
  const t = useTranslations('workflows.editor');
  const [open, setOpen] = React.useState(false);
  if (problems.length === 0) {
    return (
      <p
        role="status"
        className="flex items-center gap-1.5 rounded-md border border-border bg-popover px-2.5 py-1.5 text-meta text-muted-foreground shadow-md"
        data-testid="workflow-no-problems"
      >
        <CircleCheckIcon className="size-3.5 text-success" aria-hidden />
        {t('noProblemsHint')}
      </p>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="destructive"
            size="sm"
            className="shadow-md"
            data-testid="workflow-problems-open"
          >
            <CircleAlertIcon />
            {t('problemsTitle', { count: problems.length })}
          </Button>
        }
      />
      <PopoverContent side="top" align="end" className="w-96 max-w-[calc(100vw-2rem)] p-2">
        <WorkflowProblemList
          problems={problems}
          graph={graph}
          onSelect={(problem) => {
            setOpen(false);
            onSelect(problem);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
