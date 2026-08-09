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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@exocortex/ui';

import { AiPanel } from '@/components/ai/ai-panel';
import { useCommentAnchor } from '@/components/comments/comment-anchor';
import { ActivityPanel } from '@/components/shell/activity-panel';
import { BacklinksPanel } from '@/components/shell/backlinks-panel';
import { CommentsPanel } from '@/components/shell/comments-panel';
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
 * All five tabs are functional: KI, Eigenschaften, Kommentare, Verweise and
 * Aktivität. The tab bar is controlled rather than uncontrolled so the editor
 * can bring a tab forward — commenting a passage has to land where the composer
 * is (issue #18).
 */
export function ContextPanel({ workspaceId, documentId }: ContextPanelProps) {
  const [tab, setTab] = React.useState('ai');
  const { request: commentRequest } = useCommentAnchor();

  // Commenting from the editor has to land where the composer is, otherwise the
  // click appears to do nothing. Keyed on the request id, so asking twice for
  // the same block switches back to the tab a second time.
  const handledCommentRequest = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (commentRequest === null || handledCommentRequest.current === commentRequest.requestId) {
      return;
    }
    handledCommentRequest.current = commentRequest.requestId;
    setTab('comments');
  }, [commentRequest]);

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(String(value))}
      className="flex min-h-0 flex-1 flex-col"
    >
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
          <ContextTab
            value="comments"
            icon={<MessageSquareIcon />}
            label="Kommentare"
            data-testid="context-tab-comments"
          />
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

      <TabsContent value="comments" className="overflow-y-auto p-3">
        <PanelErrorBoundary
          title="Kommentare nicht verfügbar"
          description="Die Kommentare konnten nicht angezeigt werden. Der Text der Seite ist davon unberührt."
        >
          <CommentsPanel workspaceId={workspaceId} documentId={documentId} />
        </PanelErrorBoundary>
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
