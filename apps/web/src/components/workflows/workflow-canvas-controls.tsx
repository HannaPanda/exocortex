'use client';

import { Panel, useReactFlow } from '@xyflow/react';
import { MaximizeIcon, MinusIcon, PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type * as React from 'react';

import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@exocortex/ui';

import { viewDuration } from './workflow-canvas';

/**
 * Zoom, fit and whatever else the screen adds (undo, tidy), as one row of
 * the product's own icon buttons in the canvas's lower left corner. Each says
 * its name in a tooltip and to a screen reader.
 */
export function CanvasControls({ children }: { children?: React.ReactNode }) {
  const t = useTranslations('workflows.canvas');
  const flow = useReactFlow();
  return (
    <Panel position="bottom-left">
      <div
        role="toolbar"
        aria-label={t('a11y.controls')}
        className="flex items-center gap-0.5 rounded-lg border border-border-strong bg-popover p-1 shadow-md"
        data-testid="workflow-canvas-controls"
      >
        <CanvasButton
          label={t('a11y.zoomIn')}
          onClick={() => void flow.zoomIn({ duration: viewDuration(120) })}
        >
          <PlusIcon />
        </CanvasButton>
        <CanvasButton
          label={t('a11y.zoomOut')}
          onClick={() => void flow.zoomOut({ duration: viewDuration(120) })}
        >
          <MinusIcon />
        </CanvasButton>
        <CanvasButton
          label={t('a11y.fitView')}
          testId="workflow-fit-view"
          onClick={() => void flow.fitView({ padding: 0.15, maxZoom: 1, duration: viewDuration() })}
        >
          <MaximizeIcon />
        </CanvasButton>
        {children}
      </div>
    </Panel>
  );
}

export function CanvasButton({
  label,
  shortcut,
  onClick,
  disabled,
  testId,
  children,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            aria-keyshortcuts={shortcut}
            disabled={disabled}
            onClick={onClick}
            data-testid={testId}
          >
            {children}
          </Button>
        }
      />
      <TooltipContent>
        {label}
        {shortcut === undefined ? null : (
          <kbd className="ml-2 font-mono text-micro text-muted-foreground">{shortcut}</kbd>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export function CanvasDivider() {
  return <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />;
}
