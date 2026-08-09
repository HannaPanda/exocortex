'use client';

import {
  ActivityIcon,
  LinkIcon,
  MessageSquareIcon,
  SettingsIcon,
  SparklesIcon,
} from 'lucide-react';
import * as React from 'react';

import {
  EmptyState,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@exocortex/ui';

import { AiPanel } from '@/components/ai/ai-panel';
import { ActivityPanel } from '@/components/shell/activity-panel';
import { BacklinksPanel } from '@/components/shell/backlinks-panel';
import { PanelErrorBoundary } from '@/components/shell/panel-error-boundary';
import { PropertiesPanel } from '@/components/shell/properties-panel';

export interface ContextPanelProps {
  workspaceId: string | null;
  documentId: string | null;
}

/**
 * A tab whose label collapses to `sr-only` below the panel's icon-only
 * threshold (see `TabsList`'s `@container` below) and reappears as a tooltip,
 * so the tab keeps its name for screen readers and hovering mouse users even
 * when the panel is too narrow to print it (issue #9).
 */
function ContextTab({
  value,
  icon,
  label,
  ...props
}: {
  value: string;
  icon: React.ReactNode;
  label: string;
} & Omit<React.ComponentProps<typeof TabsTrigger>, 'value' | 'children'>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <TabsTrigger value={value} {...props}>
            {icon}
            <span className="sr-only @min-[420px]:not-sr-only">{label}</span>
          </TabsTrigger>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Right-hand context panel.
 *
 * AI, Eigenschaften, Verweise and Aktivität are functional. Kommentare stays a
 * placeholder so the shell layout does not need to change when it is built
 * (see docs/architecture.md, "Deferred work").
 */
export function ContextPanel({ workspaceId, documentId }: ContextPanelProps) {
  return (
    <Tabs defaultValue="ai" className="flex min-h-0 flex-1 flex-col">
      <div className="p-2">
        {/* `@container`: below 420px the tab bar shows icons only (see
            `ContextTab`); the panel is resizable down to 260px
            (`app-shell.tsx`), where five labelled tabs never fit. */}
        <TabsList className="@container">
          <ContextTab value="ai" icon={<SparklesIcon />} label="KI" data-testid="context-tab-ai" />
          <ContextTab
            value="properties"
            icon={<SettingsIcon />}
            label="Eigenschaften"
            data-testid="context-tab-properties"
          />
          <ContextTab value="comments" icon={<MessageSquareIcon />} label="Kommentare" />
          <ContextTab value="backlinks" icon={<LinkIcon />} label="Verweise" />
          <ContextTab
            value="activity"
            icon={<ActivityIcon />}
            label="Aktivität"
            data-testid="context-tab-activity"
          />
        </TabsList>
      </div>

      <TabsContent value="ai" className="flex min-h-0 flex-col">
        <PanelErrorBoundary
          title="KI-Panel nicht verfügbar"
          description="Der Chat konnte nicht angezeigt werden. Ein laufender KI-Lauf arbeitet weiter; nach dem Neuladen ist der Verlauf vollständig."
        >
          <AiPanel workspaceId={workspaceId} documentId={documentId} />
        </PanelErrorBoundary>
      </TabsContent>

      <TabsContent value="properties" className="overflow-y-auto p-3">
        <PanelErrorBoundary
          title="Eigenschaften nicht verfügbar"
          description="Die Eigenschaften konnten nicht angezeigt werden."
        >
          <PropertiesPanel workspaceId={workspaceId} documentId={documentId} />
        </PanelErrorBoundary>
      </TabsContent>

      <TabsContent value="comments" className="p-3">
        <EmptyState
          title="Kommentare folgen"
          description="Die Panelstruktur ist vorbereitet; Kommentare sind in dieser Version noch nicht umgesetzt."
          icon={MessageSquareIcon}
        />
      </TabsContent>

      <TabsContent value="backlinks" className="overflow-y-auto p-3">
        <PanelErrorBoundary
          title="Verweise nicht verfügbar"
          description="Der Verweisindex konnte nicht angezeigt werden. Die Verweise selbst stehen weiterhin im Text der Seite."
        >
          <BacklinksPanel workspaceId={workspaceId} documentId={documentId} />
        </PanelErrorBoundary>
      </TabsContent>

      <TabsContent value="activity" className="overflow-y-auto p-3">
        <PanelErrorBoundary
          title="Aktivität nicht verfügbar"
          description="Der Verlauf dieser Seite konnte nicht angezeigt werden."
        >
          <ActivityPanel workspaceId={workspaceId} documentId={documentId} />
        </PanelErrorBoundary>
      </TabsContent>
    </Tabs>
  );
}
