'use client';

import {
  ActivityIcon,
  LinkIcon,
  MessageSquareIcon,
  SettingsIcon,
  SparklesIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
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

/** The panel's tabs; the shell holds which one is shown, so the palette can pick one. */
export const CONTEXT_TABS = ['ai', 'properties', 'comments', 'backlinks', 'activity'] as const;
export type ContextTab = (typeof CONTEXT_TABS)[number];

function isContextTab(value: unknown): value is ContextTab {
  return CONTEXT_TABS.some((tab) => tab === value);
}

export interface ContextPanelProps {
  workspaceId: string | null;
  documentId: string | null;
  tab: ContextTab;
  onTabChange: (tab: ContextTab) => void;
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
 *
 * Four of the five describe a page, so on a screen that is not a page — the
 * workspace overview — they have nothing to describe and the bar is four
 * controls that answer "nothing here" when pressed. The panel drops to the
 * assistant alone there, and drops the bar with it: a single tab is not a
 * choice. Same reasoning as `formatPulse` in the overview, which omits a zero
 * rather than printing one; an interface that reports absences makes the reader
 * filter them out every time.
 */
export function ContextPanel({ workspaceId, documentId, tab, onTabChange }: ContextPanelProps) {
  const t = useTranslations('shell.contextPanel');
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
    onTabChange('comments');
  }, [commentRequest, onTabChange]);

  if (documentId === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col pt-2">
        <PanelErrorBoundary title={t('aiErrorTitle')} description={t('aiErrorDescription')}>
          <AiPanel workspaceId={workspaceId} documentId={null} />
        </PanelErrorBoundary>
      </div>
    );
  }

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        if (isContextTab(value)) onTabChange(value);
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="p-2">
        {/* `@container`: below 420px the tab bar shows icons only (see
            `ContextTab`); the panel is resizable down to 260px
            (`app-shell.tsx`), where five labelled tabs never fit. */}
        <TabsList className="@container">
          <ContextTab
            value="ai"
            icon={<SparklesIcon />}
            label={t('aiTab')}
            data-testid="context-tab-ai"
          />
          <ContextTab
            value="properties"
            icon={<SettingsIcon />}
            label={t('propertiesTab')}
            data-testid="context-tab-properties"
          />
          <ContextTab
            value="comments"
            icon={<MessageSquareIcon />}
            label={t('commentsTab')}
            data-testid="context-tab-comments"
          />
          <ContextTab value="backlinks" icon={<LinkIcon />} label={t('backlinksTab')} />
          <ContextTab
            value="activity"
            icon={<ActivityIcon />}
            label={t('activityTab')}
            data-testid="context-tab-activity"
          />
        </TabsList>
      </div>

      <TabsContent value="ai" className="flex min-h-0 flex-col">
        <PanelErrorBoundary title={t('aiErrorTitle')} description={t('aiErrorDescription')}>
          <AiPanel workspaceId={workspaceId} documentId={documentId} />
        </PanelErrorBoundary>
      </TabsContent>

      <TabsContent value="properties" className="overflow-y-auto p-3">
        <PanelErrorBoundary
          title={t('propertiesErrorTitle')}
          description={t('propertiesErrorDescription')}
        >
          <PropertiesPanel workspaceId={workspaceId} documentId={documentId} />
        </PanelErrorBoundary>
      </TabsContent>

      <TabsContent value="comments" className="overflow-y-auto p-3">
        <PanelErrorBoundary
          title={t('commentsErrorTitle')}
          description={t('commentsErrorDescription')}
        >
          <CommentsPanel workspaceId={workspaceId} documentId={documentId} />
        </PanelErrorBoundary>
      </TabsContent>

      <TabsContent value="backlinks" className="overflow-y-auto p-3">
        <PanelErrorBoundary
          title={t('backlinksErrorTitle')}
          description={t('backlinksErrorDescription')}
        >
          <BacklinksPanel workspaceId={workspaceId} documentId={documentId} />
        </PanelErrorBoundary>
      </TabsContent>

      <TabsContent value="activity" className="overflow-y-auto p-3">
        <PanelErrorBoundary
          title={t('activityErrorTitle')}
          description={t('activityErrorDescription')}
        >
          <ActivityPanel workspaceId={workspaceId} documentId={documentId} />
        </PanelErrorBoundary>
      </TabsContent>
    </Tabs>
  );
}
