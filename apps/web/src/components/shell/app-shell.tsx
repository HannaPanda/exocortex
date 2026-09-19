'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  BrainIcon,
  CircleQuestionMarkIcon,
  InboxIcon,
  KeyIcon,
  LogOutIcon,
  MessagesSquareIcon,
  NetworkIcon,
  PanelLeftIcon,
  PanelRightIcon,
  SearchIcon,
  ShieldIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import * as React from 'react';

import {
  AppBody,
  AppHeader,
  AppMain,
  AppShell as AppShellFrame,
  Button,
  cn,
  ExocortexWordmark,
  ResizablePanel,
  Separator,
  Sheet,
  SheetContent,
  SheetTitle,
  SkipToContentLink,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useIsMobile,
} from '@exocortex/ui';

import { AiSelectionProvider, useAiSelection } from '@/components/ai/ai-selection';
import { CommentAnchorProvider, useCommentAnchor } from '@/components/comments/comment-anchor';
import { SearchCommand } from '@/components/search/search-command';
import { useFeatures } from '@/lib/api/feature-queries';
import { queryKeys, useSessionQuery } from '@/lib/api/queries';
import { signOut } from '@/lib/auth/client';
import { isTypingTarget } from '@/lib/keyboard';
import { useRealtime, useRealtimeEvent } from '@/lib/realtime/realtime-provider';
import { usePersistentState } from '@/lib/use-persistent-state';

import { CaptureDialog } from './capture-dialog';
import { ConnectionStatus } from './connection-status';
import { ContextPanel } from './context-panel';
import { DocumentSessionProvider } from './document-session';
import { JobProgressIndicator } from './job-progress';
import { PageTree } from './page-tree';
import {
  CONTEXT_DEFAULT,
  CONTEXT_STORAGE_KEY,
  type PanelPreference,
  parsePanelPreference,
  SIDEBAR_DEFAULT,
  SIDEBAR_STORAGE_KEY,
} from './panel-preferences';
import { PresenceAvatars } from './presence-avatars';
import { WorkspaceSwitcher } from './workspace-switcher';

/**
 * Application shell: header, collapsible navigation, document area and optional
 * context panel. Layout preferences are the only client state that is persisted;
 * everything else is server state owned by TanStack Query.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <DocumentSessionProvider>
      <AiSelectionProvider>
        <CommentAnchorProvider>
          <AppShellInner>{children}</AppShellInner>
        </CommentAnchorProvider>
      </AiSelectionProvider>
    </DocumentSessionProvider>
  );
}

function AppShellInner({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const params = useParams<{ workspaceId?: string; documentId?: string }>();
  const session = useSessionQuery();
  const queryClient = useQueryClient();
  const { subscribe } = useRealtime();

  const workspaceId = params.workspaceId ?? null;
  const documentId = params.documentId ?? null;

  // Below the mobile breakpoint, panels overlay the canvas instead of sharing
  // it, so a first-time visitor should not land with one already covering the
  // screen. Returning visitors keep whatever they last chose, on any device.
  const isMobile = useIsMobile();
  const sidebarFallback = React.useMemo<PanelPreference>(
    () => (isMobile ? { ...SIDEBAR_DEFAULT, open: false } : SIDEBAR_DEFAULT),
    [isMobile],
  );
  const contextFallback = React.useMemo<PanelPreference>(
    () => (isMobile ? { ...CONTEXT_DEFAULT, open: false } : CONTEXT_DEFAULT),
    [isMobile],
  );

  // Layout preferences are the only persisted client state.
  const [sidebar, setSidebar] = usePersistentState(
    SIDEBAR_STORAGE_KEY,
    sidebarFallback,
    parsePanelPreference,
  );
  const [context, setContext] = usePersistentState(
    CONTEXT_STORAGE_KEY,
    contextFallback,
    parsePanelPreference,
  );
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [captureOpen, setCaptureOpen] = React.useState(false);

  const sidebarOpen = sidebar.open;
  const contextOpen = context.open;
  const { selection: pendingAiSelection } = useAiSelection();
  const { request: pendingCommentRequest } = useCommentAnchor();
  const setSidebarOpen = React.useCallback(
    (open: boolean) => setSidebar({ ...sidebar, open }),
    [setSidebar, sidebar],
  );
  const setContextOpen = React.useCallback(
    (open: boolean) => setContext({ ...context, open }),
    [context, setContext],
  );

  // Handing a selection to the AI is pointless while the panel is closed: the
  // chip that says what will be sent would be invisible. The ref keys on the
  // hand-over, not on the selection's content, so re-sending the same passage
  // opens the panel again, and a re-render (setContextOpen is not stable) does
  // not re-open a panel the user has since closed.
  const handledSelectionRequest = React.useRef<number | null>(null);
  React.useEffect(() => {
    const requestId = pendingAiSelection?.requestId ?? null;
    if (requestId === null || handledSelectionRequest.current === requestId) return;
    handledSelectionRequest.current = requestId;
    if (!contextOpen) setContextOpen(true);
  }, [pendingAiSelection, contextOpen, setContextOpen]);

  // Same for commenting a passage, and for clicking a marker in the text: the
  // thread lives in the panel, so the panel has to be there to be looked at.
  const handledCommentRequest = React.useRef<number | null>(null);
  React.useEffect(() => {
    const requestId = pendingCommentRequest?.requestId ?? null;
    if (requestId === null || handledCommentRequest.current === requestId) return;
    handledCommentRequest.current = requestId;
    if (!contextOpen) setContextOpen(true);
  }, [pendingCommentRequest, contextOpen, setContextOpen]);

  // Redirect unauthenticated visitors. The API is the source of truth.
  React.useEffect(() => {
    if (session.isError) router.replace('/anmelden');
    if (session.data !== undefined && session.data.user === null) router.replace('/anmelden');
  }, [router, session.data, session.isError]);

  // Subscribe to the workspace room; the server authorizes the subscription.
  React.useEffect(() => {
    if (workspaceId !== null) subscribe(workspaceId);
  }, [subscribe, workspaceId]);

  // Tree-changing events invalidate the tree query for every browser session.
  const invalidateTree = React.useCallback(() => {
    if (workspaceId === null) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.documentTree(workspaceId) });
  }, [queryClient, workspaceId]);

  /**
   * A page changed as a whole: refresh the tree *and* that page itself.
   *
   * The tree alone is not enough. These events also arrive for a change nobody
   * in this browser made — the built-in AI setting a cover it just drew, an MCP
   * client renaming a page, another person archiving one — and the open page
   * would go on showing the stale properties until someone reloaded it.
   */
  const invalidateDocument = React.useCallback(
    (event: { payload: { document: { id: string } } }) => {
      invalidateTree();
      void queryClient.invalidateQueries({
        queryKey: queryKeys.document(event.payload.document.id),
      });
    },
    [invalidateTree, queryClient],
  );

  // A rename or slug change (this browser's own, another member's, or an MCP
  // client's) affects the switcher list and, if open, the settings page.
  useRealtimeEvent('workspace.updated', (event) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDetail(event.workspaceId) });
  });
  useRealtimeEvent('document.created', invalidateTree);
  useRealtimeEvent('document.updated', invalidateDocument);
  useRealtimeEvent('document.moved', invalidateTree);
  useRealtimeEvent('document.archived', invalidateDocument);
  useRealtimeEvent('document.restored', invalidateDocument);
  useRealtimeEvent('document.materialized', (event) => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.document(event.payload.documentId),
    });
    // Materializing *any* page rewrites its references, which changes who
    // points at the page currently open. The open page's own key would not
    // catch that, so every cached reference list is invalidated instead.
    void queryClient.invalidateQueries({
      predicate: (query) => query.queryKey[0] === 'document' && query.queryKey[2] === 'links',
    });
  });
  // A write from outside the editor (MCP, the built-in AI, the REST endpoint).
  // The text itself arrives through the collaboration socket (ADR-016); what
  // the cache still holds is everything around it, from the version list to the
  // Markdown the context panel reads.
  useRealtimeEvent('document.content.replaced', (event) => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.document(event.payload.documentId),
    });
  });

  // Global keyboard shortcuts.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
      // Strg+B is the editor's bold, and the editor's keymap runs first: this
      // listener could only add a second action to the same keystroke, never
      // replace it, so the page ended up bold *and* the navigation collapsed
      // (issue #81). Formatting wins where text is being written; everywhere
      // else the key is free.
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'b' &&
        !isTypingTarget(event.target)
      ) {
        event.preventDefault();
        setSidebarOpen(!sidebarOpen);
      }
      if ((event.metaKey || event.ctrlKey) && event.key === '.') {
        event.preventDefault();
        setContextOpen(!contextOpen);
      }
      // Capture needs a workspace to land in, so outside one the browser keeps
      // its own Strg+E rather than being robbed of it for a dialog that could
      // not do anything (issue #71).
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'e' &&
        workspaceId !== null
      ) {
        event.preventDefault();
        // Opens only, never toggles: closing runs through the dialog, which is
        // what empties its field. Escape is the way out and always was.
        setCaptureOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [contextOpen, setContextOpen, setSidebarOpen, sidebarOpen, workspaceId]);

  return (
    <AppShellFrame>
      <SkipToContentLink />

      <AppHeader>
        {/* The full lockup, one step below its default height: 1.75rem in a
            3rem header leaves the name room to breathe instead of filling the
            bar. The mark alone was correct by the One Signal Rule and wrong by
            eye -- a bare icon in the corner reads as an unfinished product. The
            lockup earns its amber here because it is the one place the product
            says its own name, and it never repeats inside the page. */}
        <ExocortexWordmark className="mr-1 hidden h-7 sm:block" />

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Navigation ein-/ausblenden"
                aria-pressed={sidebarOpen}
                data-testid="toggle-sidebar"
                onClick={() => setSidebarOpen(!sidebarOpen)}
              >
                <PanelLeftIcon />
              </Button>
            }
          />
          <TooltipContent>Navigation (Strg + B)</TooltipContent>
        </Tooltip>

        <WorkspaceSwitcher activeWorkspaceId={workspaceId} />

        <Button
          variant="outline"
          size="sm"
          className="ml-1 hidden w-56 justify-start gap-2 text-muted-foreground sm:flex"
          data-testid="open-search"
          onClick={() => setSearchOpen(true)}
        >
          <SearchIcon />
          <span className="flex-1 text-left">Suchen …</span>
          <kbd className="exocortex-numeric rounded border border-border px-1 text-[0.625rem]">
            Strg K
          </kbd>
        </Button>

        {workspaceId === null ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Erfassen"
                  data-testid="open-capture"
                  onClick={() => setCaptureOpen(true)}
                >
                  <InboxIcon />
                </Button>
              }
            />
            <TooltipContent>Erfassen (Strg + E)</TooltipContent>
          </Tooltip>
        )}

        <div className="ml-auto flex items-center gap-2">
          <PresenceAvatars />
          <ConnectionStatus />

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Kontextbereich ein-/ausblenden"
                  aria-pressed={contextOpen}
                  data-testid="toggle-context"
                  onClick={() => setContextOpen(!contextOpen)}
                >
                  <PanelRightIcon />
                </Button>
              }
            />
            <TooltipContent>Kontextbereich (Strg + .)</TooltipContent>
          </Tooltip>

          <GlobalLinks />

          <Separator orientation="vertical" className="h-5" />

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Abmelden"
                  data-testid="sign-out"
                  onClick={() => {
                    void signOut().then(() => router.replace('/anmelden'));
                  }}
                >
                  <LogOutIcon />
                </Button>
              }
            />
            <TooltipContent>{session.data?.user?.name ?? 'Konto'} · Abmelden</TooltipContent>
          </Tooltip>
        </div>
      </AppHeader>

      <AppBody>
        {workspaceId !== null ? (
          isMobile ? (
            <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
              <SheetContent side="left" data-testid="sidebar">
                <SheetTitle className="exocortex-sr-only">Navigation</SheetTitle>
                <nav aria-label="Seitennavigation" className="flex min-h-0 flex-1 flex-col">
                  <PageTree workspaceId={workspaceId} />
                </nav>
              </SheetContent>
            </Sheet>
          ) : sidebarOpen ? (
            <ResizablePanel
              width={sidebar.width}
              onWidthChange={(width) => setSidebar({ ...sidebar, width })}
              handle="right"
              minWidth={200}
              maxWidth={420}
              label="Breite der Navigation"
              className="border-r border-border bg-surface"
              data-testid="sidebar"
            >
              <nav aria-label="Seitennavigation" className="flex min-h-0 flex-1 flex-col">
                <PageTree workspaceId={workspaceId} />
              </nav>
            </ResizablePanel>
          ) : null
        ) : null}

        <AppMain>{children}</AppMain>

        {isMobile ? (
          <Sheet open={contextOpen} onOpenChange={setContextOpen}>
            <SheetContent side="right" data-testid="context-panel">
              <SheetTitle className="exocortex-sr-only">Kontextbereich</SheetTitle>
              <aside aria-label="Kontextbereich" className="flex min-h-0 flex-1 flex-col">
                <ContextPanel workspaceId={workspaceId} documentId={documentId} />
              </aside>
            </SheetContent>
          </Sheet>
        ) : contextOpen ? (
          <ResizablePanel
            width={context.width}
            onWidthChange={(width) => setContext({ ...context, width })}
            handle="left"
            minWidth={260}
            maxWidth={520}
            label="Breite des Kontextbereichs"
            className={cn('border-l border-border bg-surface')}
            data-testid="context-panel"
          >
            <aside aria-label="Kontextbereich" className="flex min-h-0 flex-1 flex-col">
              <ContextPanel workspaceId={workspaceId} documentId={documentId} />
            </aside>
          </ResizablePanel>
        ) : null}
      </AppBody>

      <SearchCommand workspaceId={workspaceId} open={searchOpen} onOpenChange={setSearchOpen} />
      {workspaceId === null ? null : (
        <CaptureDialog workspaceId={workspaceId} open={captureOpen} onOpenChange={setCaptureOpen} />
      )}
      <JobProgressIndicator />
    </AppShellFrame>
  );
}

/**
 * The six places that belong to the deployment rather than to a workspace.
 *
 * Its own component only because the shell had grown past its line limit, and
 * a row of identical tooltip links is the part of it that reads as one thing.
 * The three reading rooms are first: a conversation belongs to a person rather
 * than to a workspace and spans all of them (issue #69), an entity's mentions
 * are gathered out of every workspace the reader may see, and a fact belongs to
 * a project, so none of the three fits under `/arbeitsbereich`.
 *
 * The role is not yet part of `CurrentSessionResponse` (see `AdminGuard`'s
 * TODO), so all six render for every signed-in user; `/admin` gates itself
 * against the API's admin check.
 *
 * "Funktionen" carries a count, and it is the only one that does. A feature
 * nobody knows about is the same as a feature nobody built (issue #80), and a
 * list you have to remember to open does not fix that -- the dot is the part
 * that does the work.
 */
function GlobalLinks() {
  const features = useFeatures();
  const newCount = features.data?.newCount ?? 0;
  const links: {
    href: string;
    label: string;
    testId: string;
    icon: typeof KeyIcon;
    badge?: number;
  }[] = [
    {
      href: '/hilfe',
      label: newCount > 0 ? `Hilfe und Funktionen (${newCount} neu)` : 'Hilfe und Funktionen',
      testId: 'open-features',
      // A question mark, because that is the shape people look for when they
      // are stuck. The sparkles this started with said "something AI happens
      // here", which is the one thing this page is not.
      icon: CircleQuestionMarkIcon,
      badge: newCount,
    },
    { href: '/chats', label: 'Chats', testId: 'open-chats', icon: MessagesSquareIcon },
    { href: '/entitaeten', label: 'Entitäten', testId: 'open-entities', icon: NetworkIcon },
    { href: '/gedaechtnis', label: 'Gedächtnis', testId: 'open-memory', icon: BrainIcon },
    { href: '/admin', label: 'Verwaltung', testId: 'open-admin', icon: ShieldIcon },
    {
      href: '/einstellungen/verbindungen',
      label: 'Verbindungen',
      testId: 'open-api-tokens',
      icon: KeyIcon,
    },
  ];

  return (
    <>
      {links.map((link) => (
        <Tooltip key={link.href}>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={link.label}
                data-testid={link.testId}
                render={<Link href={link.href} />}
                className="relative"
              >
                <link.icon />
                {link.badge !== undefined && link.badge > 0 ? (
                  <span
                    aria-hidden
                    data-testid="features-badge"
                    className="absolute right-1 top-1 size-2 rounded-full bg-primary"
                  />
                ) : null}
              </Button>
            }
          />
          <TooltipContent>{link.label}</TooltipContent>
        </Tooltip>
      ))}
    </>
  );
}
