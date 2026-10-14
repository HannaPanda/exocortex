'use client';

import { PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { type WorkflowNodeType } from '@exocortex/contracts';
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@exocortex/ui';

import { NodeTypeMark, WorkflowAddMenu } from './workflow-add-menu';
import { WORKFLOW_NODE_MIME } from './workflow-canvas';
import { NODE_GROUPS } from './workflow-draft';
import { useWorkflowWording } from './workflow-labels';

/**
 * The node rail (issues #164, #198): a narrow column beside the canvas, so
 * the graph keeps the width. At the top the `+` opens the searchable list
 * (also on `A`); below it one mark per node type, in the order a workflow is
 * read. A press adds the node after the selected one and wires it in, a drag
 * puts it where it is dropped, and each mark names itself in a tooltip with
 * what the type does. The press is the whole feature, the drag a convenience.
 */
export function WorkflowPalette({
  onAdd,
  disabled,
  menuOpen,
  onMenuOpenChange,
  hasSelection,
}: {
  onAdd: (type: WorkflowNodeType) => void;
  disabled: boolean;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  hasSelection: boolean;
}) {
  const t = useTranslations('workflows.palette');
  const wording = useWorkflowWording();
  return (
    <nav
      aria-label={t('label')}
      className="flex h-full w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border bg-surface py-2"
      data-testid="workflow-palette"
    >
      <Popover open={menuOpen} onOpenChange={onMenuOpenChange}>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <Button
                    size="icon"
                    disabled={disabled}
                    aria-label={t('add')}
                    aria-keyshortcuts="A"
                    data-testid="workflow-add"
                  >
                    <PlusIcon />
                  </Button>
                }
              />
            }
          />
          <TooltipContent side="right">
            {t('add')} <kbd className="ml-1 font-mono text-micro text-muted-foreground">A</kbd>
          </TooltipContent>
        </Tooltip>
        <PopoverContent side="right" align="start" className="p-2">
          <WorkflowAddMenu
            withTriggers
            context={hasSelection ? t('addAfterSelection') : null}
            onPick={(type) => {
              onMenuOpenChange(false);
              onAdd(type);
            }}
          />
        </PopoverContent>
      </Popover>

      {NODE_GROUPS.map((group) => (
        <ul
          key={group.key}
          aria-label={wording.group(group.key)}
          className="mt-1 flex flex-col items-center gap-0.5 border-t border-border pt-1.5"
        >
          {group.types.map((type) => (
            <li key={type}>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      disabled={disabled}
                      draggable={!disabled}
                      aria-label={wording.type(type)}
                      aria-description={wording.typeHint(type)}
                      onDragStart={(event) => {
                        event.dataTransfer.setData(WORKFLOW_NODE_MIME, type);
                        event.dataTransfer.effectAllowed = 'copy';
                      }}
                      onClick={() => onAdd(type)}
                      data-testid={`workflow-palette-${type}`}
                      className="grid size-9 place-items-center rounded-md hover:bg-accent-solid disabled:pointer-events-none disabled:opacity-50"
                    >
                      <NodeTypeMark type={type} />
                    </button>
                  }
                />
                <TooltipContent side="right" className="max-w-64">
                  <span className="block font-medium text-foreground">{wording.type(type)}</span>
                  <span className="block text-muted-foreground">{wording.typeHint(type)}</span>
                  <span className="mt-1 block text-muted-foreground">
                    {hasSelection ? t('pressAfter') : t('pressAppend')}
                  </span>
                </TooltipContent>
              </Tooltip>
            </li>
          ))}
        </ul>
      ))}
    </nav>
  );
}
