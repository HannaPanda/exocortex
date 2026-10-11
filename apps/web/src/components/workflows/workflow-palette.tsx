'use client';

import { useTranslations } from 'next-intl';

import { type WorkflowNodeType } from '@exocortex/contracts';
import { SectionRule } from '@exocortex/ui';

import { WORKFLOW_NODE_MIME } from './workflow-canvas';
import { NODE_GROUPS } from './workflow-draft';
import { NODE_ICONS, useWorkflowWording } from './workflow-labels';

/**
 * The node palette (issue #164): triggers, work and control, in the order a
 * workflow is read. A press adds the node after the selected one and wires it
 * in; a drag puts it where it is dropped. The press is the whole feature, the
 * drag a convenience.
 */
export function WorkflowPalette({
  onAdd,
  disabled,
}: {
  onAdd: (type: WorkflowNodeType) => void;
  disabled: boolean;
}) {
  const t = useTranslations('workflows.palette');
  const wording = useWorkflowWording();
  return (
    <nav aria-label={t('label')} className="flex flex-col gap-4" data-testid="workflow-palette">
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
      {NODE_GROUPS.map((group) => (
        <section key={group.key} className="flex flex-col gap-1">
          <SectionRule as="h3">{wording.group(group.key)}</SectionRule>
          <ul className="flex flex-col">
            {group.types.map((type) => {
              const Icon = NODE_ICONS[type];
              return (
                <li key={type}>
                  <button
                    type="button"
                    disabled={disabled}
                    draggable={!disabled}
                    onDragStart={(event) => {
                      event.dataTransfer.setData(WORKFLOW_NODE_MIME, type);
                      event.dataTransfer.effectAllowed = 'copy';
                    }}
                    onClick={() => onAdd(type)}
                    title={wording.typeHint(type)}
                    data-testid={`workflow-palette-${type}`}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate">{wording.type(type)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </nav>
  );
}
