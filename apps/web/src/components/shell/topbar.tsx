'use client';

import { InboxIcon, PanelLeftIcon, PanelRightIcon, SearchIcon } from 'lucide-react';
import * as React from 'react';

import {
  AppHeader,
  Button,
  ExocortexWordmark,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@exocortex/ui';

import { useSessionQuery } from '@/lib/api/session-queries';

import { ConnectionStatus } from './connection-status';
import { GlobalLinks } from './global-links';
import { PresenceAvatars } from './presence-avatars';
import { WorkspaceSwitcher } from './workspace-switcher';

/**
 * The application header.
 *
 * What it shows is a claim about what matters, and it used to make the claim
 * badly: above `lg` it carried sixteen controls, nine of which were an icon row
 * of deployment-wide places nobody visits more than a few times a week. Every
 * one of them was a call to attention beside the page being written, which
 * PRODUCT.md calls a defect rather than a taste question.
 *
 * It is now cut along the line the product is actually organised on:
 *
 * - **Left, the workspace.** Which one you are in (the switcher), how you move
 *   inside it (the navigation toggle), and the two things you do here every
 *   day: find something, and put something down. Those two carry `outline`;
 *   the toggle is ghost, because furniture for a panel is not an action.
 * - **Right, the moment.** Who else is on this page, whether the connection
 *   holds, the panel that answers about this page, and the account -- one
 *   button behind which every deployment-wide place stands with its name on it.
 *
 * The same hierarchy at every width. Only two things change shape: the wordmark
 * steps out below `sm`, and search trades its field for its glyph.
 */
export function Topbar({
  workspaceId,
  sidebarOpen,
  onSidebarOpenChange,
  contextOpen,
  onContextOpenChange,
  onOpenSearch,
  onOpenCapture,
  onSignOut,
}: {
  workspaceId: string | null;
  sidebarOpen: boolean;
  onSidebarOpenChange: (open: boolean) => void;
  contextOpen: boolean;
  onContextOpenChange: (open: boolean) => void;
  onOpenSearch: () => void;
  onOpenCapture: () => void;
  onSignOut: () => void;
}) {
  const session = useSessionQuery();

  return (
    <AppHeader data-testid="topbar">
      {/* The full lockup, one step below its default height: 1.75rem in a
          3rem header leaves the name room to breathe instead of filling the
          bar. The mark alone was correct by the One Signal Rule and wrong by
          eye -- a bare icon in the corner reads as an unfinished product. The
          lockup earns its amber here because it is the one place the product
          says its own name, and it never repeats inside the page. */}
      {/* The one cap in pixels in this bar, and deliberately so: at 200 % text
          zoom everything else here doubles because it is text, and the lockup
          would double with it into a 490-pixel logo that takes a whole row of
          its own. WCAG 1.4.4 is about text being resizable; which application
          you are in is the least urgent thing on this bar to read twice as
          large. */}
      <ExocortexWordmark className="mr-1 hidden h-7 max-h-[28px] shrink-0 sm:block" />

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Navigation ein-/ausblenden"
              aria-pressed={sidebarOpen}
              data-testid="toggle-sidebar"
              onClick={() => onSidebarOpenChange(!sidebarOpen)}
            >
              <PanelLeftIcon />
            </Button>
          }
        />
        <TooltipContent>Navigation (Strg + B)</TooltipContent>
      </Tooltip>

      <WorkspaceSwitcher activeWorkspaceId={workspaceId} />

      {/* Retrieval is half of what this product is for (PRODUCT.md), so it
          keeps a named field wherever one fits and collapses to its own glyph
          where one does not -- it used to disappear entirely below `sm`, which
          left a phone with no way into search at all, since Strg + K is not a
          key anybody can press there. Two shapes, one hidden by a media query
          rather than by a measured width: a hook would paint the wrong one
          first, and this bar is the first thing on screen. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Suchen"
              data-testid="open-search-compact"
              className="ml-1 shrink-0 sm:hidden"
              onClick={onOpenSearch}
            >
              <SearchIcon />
            </Button>
          }
        />
        <TooltipContent>Suchen (Strg + K)</TooltipContent>
      </Tooltip>

      <Button
        variant="outline"
        size="sm"
        // Second in line to give way, after the workspace name: between the
        // phone and the desktop the field is narrower, and it truncates rather
        // than pushing the icons off the right edge (issue #100). Wider than it
        // was above `lg`, because the eight glyphs it used to make room for are
        // gone and search is what the room is worth.
        className="ml-1 hidden w-40 min-w-0 shrink justify-start gap-2 text-muted-foreground sm:flex lg:w-72"
        data-testid="open-search"
        onClick={onOpenSearch}
      >
        <SearchIcon />
        <span className="flex-1 truncate text-left">Suchen …</span>
        <kbd className="exocortex-numeric rounded-sm border border-border px-1 text-nano">
          Strg K
        </kbd>
      </Button>

      {/* Outline rather than ghost, and that is the whole of the header's
          weighting: capture and search are the two things somebody does here
          every day, the panel toggles are furniture for the panels they stand
          beside. Not a filled button -- it would be the loudest thing on every
          screen, and the page being written has first claim on that. (Review
          finding E2.) */}
      {workspaceId === null ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="icon-sm"
                className="shrink-0"
                aria-label="Erfassen"
                data-testid="open-capture"
                onClick={onOpenCapture}
              >
                <InboxIcon />
              </Button>
            }
          />
          <TooltipContent>Erfassen (Strg + E)</TooltipContent>
        </Tooltip>
      )}

      {/* Never squeezed: everything to its left gives way first, which is what
          keeps the bar inside a 360-pixel viewport (issue #100). */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
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
                onClick={() => onContextOpenChange(!contextOpen)}
              >
                <PanelRightIcon />
              </Button>
            }
          />
          <TooltipContent>Kontextbereich (Strg + .)</TooltipContent>
        </Tooltip>

        <GlobalLinks
          accountLabel={session.data?.user?.name ?? 'Konto'}
          // Until the session answers, the menu is an ordinary account's. An
          // administration entry that appears a moment later is a menu growing
          // by one line; one that appeared and then vanished would be the
          // interface taking something back.
          role={session.data?.user?.role ?? 'user'}
          onSignOut={onSignOut}
        />
      </div>
    </AppHeader>
  );
}
