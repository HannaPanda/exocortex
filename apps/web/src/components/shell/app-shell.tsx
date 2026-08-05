'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  LogOutIcon,
  PanelLeftIcon,
  PanelRightIcon,
  SearchIcon,
} from 'lucide-react';
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
  Sheet,
  SheetContent,
  SheetTitle,
  SkipToContentLink,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useIsMobile,
} from '@exocortex/ui';

import { SearchCommand } from '@/components/search/search-command';
import { queryKeys, useSessionQuery } from '@/lib/api/queries';
import { signOut } from '@/lib/auth/client';
import { useRealtime, useRealtimeEvent } from '@/lib/realtime/realtime-provider';
import { usePersistentState } from '@/lib/use-persistent-state';

import { ConnectionStatus } from './connection-status';
import { ContextPanel } from './context-panel';
import { DocumentSessionProvider } from './document-session';
import { JobProgressIndicator } from './job-progress';
import { PageTree } from './page-tree';
import { PresenceAvatars } from './presence-avatars';
import { WorkspaceSwitcher } from './workspace-switcher';

const SIDEBAR_STORAGE_KEY = 'exocortex.sidebar';
const CONTEXT_STORAGE_KEY = 'exocortex.context';

interface PanelPreference {
  open: boolean;
  width: number;
}

const SIDEBAR_DEFAULT: PanelPreference = { open: true, width: 272 };
const CONTEXT_DEFAULT: PanelPreference = { open: true, width: 336 };

function parsePanelPreference(raw: string): PanelPreference {
  const parsed = JSON.parse(raw) as Partial<PanelPreference>;
  return {
    open: typeof parsed.open === 'boolean' ? parsed.open : true,
    width: typeof parsed.width === 'number' ? parsed.width : 272,
  };
}

/**
 * Application shell: header, collapsible navigation, document area and optional
 * context panel. Layout preferences are the only client state that is persisted;
 * everything else is server state owned by TanStack Query.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <DocumentSessionProvider>
      <AppShellInner>{children}</AppShellInner>
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

  const sidebarOpen = sidebar.open;
  const contextOpen = context.open;
  const setSidebarOpen = React.useCallback(
    (open: boolean) => setSidebar({ ...sidebar, open }),
    [setSidebar, sidebar],
  );
  const setContextOpen = React.useCallback(
    (open: boolean) => setContext({ ...context, open }),
    [context, setContext],
  );

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

  useRealtimeEvent('document.created', invalidateTree);
  useRealtimeEvent('document.updated', invalidateTree);
  useRealtimeEvent('document.moved', invalidateTree);
  useRealtimeEvent('document.archived', invalidateTree);
  useRealtimeEvent('document.restored', invalidateTree);
  useRealtimeEvent('document.materialized', (event) => {
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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        setSidebarOpen(!sidebarOpen);
      }
      if ((event.metaKey || event.ctrlKey) && event.key === '.') {
        event.preventDefault();
        setContextOpen(!contextOpen);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [contextOpen, setContextOpen, setSidebarOpen, sidebarOpen]);

  return (
    <AppShellFrame>
      <SkipToContentLink />

      <AppHeader>
        <ExocortexWordmark className="mr-1 hidden sm:flex" />

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
            <TooltipContent>
              {session.data?.user?.name ?? 'Konto'} · Abmelden
            </TooltipContent>
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
      <JobProgressIndicator />
    </AppShellFrame>
  );
}
