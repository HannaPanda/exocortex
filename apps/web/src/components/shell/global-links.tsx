'use client';

import {
  BrainIcon,
  CircleQuestionMarkIcon,
  KeyIcon,
  LogOutIcon,
  MenuIcon,
  MessagesSquareIcon,
  NetworkIcon,
  Share2Icon,
  ShieldIcon,
} from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Separator,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@exocortex/ui';

import { useFeatures } from '@/lib/api/feature-queries';

interface GlobalLink {
  href: string;
  label: string;
  testId: string;
  icon: typeof KeyIcon;
  badge?: number;
}

/**
 * The seven places that belong to the deployment rather than to a workspace,
 * plus signing out.
 *
 * The three reading rooms are first: a conversation belongs to a person rather
 * than to a workspace and spans all of them (issue #69), an entity's mentions
 * are gathered out of every workspace the reader may see, and a fact belongs to
 * a project, so none of the three fits under `/arbeitsbereich`.
 *
 * The role is not yet part of `CurrentSessionResponse` (see `AdminGuard`'s
 * TODO), so all seven render for every signed-in user; `/admin` gates itself
 * against the API's admin check.
 *
 * "Hilfe und Funktionen" carries a count, and it is the only one that does. A
 * feature nobody knows about is the same as a feature nobody built (issue #80),
 * and a list you have to remember to open does not fix that -- the dot is the
 * part that does the work.
 */
function globalLinks(newCount: number): GlobalLink[] {
  return [
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
    // The only way to a page somebody shared with this account: the reader is
    // not a member of that workspace, so no tree will ever show it (issue #83).
    { href: '/geteilt', label: 'Mit mir geteilt', testId: 'open-shared', icon: Share2Icon },
    { href: '/gedaechtnis', label: 'Gedächtnis', testId: 'open-memory', icon: BrainIcon },
    { href: '/admin', label: 'Verwaltung', testId: 'open-admin', icon: ShieldIcon },
    {
      href: '/einstellungen/verbindungen',
      label: 'Verbindungen',
      testId: 'open-api-tokens',
      icon: KeyIcon,
    },
  ];
}

/**
 * The right end of the topbar, in two shapes.
 *
 * Above `lg` it is the row of icons it has always been. Below it, the same
 * entries plus signing out are one button that opens a menu, because the row
 * had quietly outgrown a phone: every new surface (`/hilfe`, `/geteilt`,
 * `/chats`, `/entitaeten`) added an icon, and at 360 CSS pixels ten buttons of
 * 1.75rem simply hang out of the screen (issue #100). Scaling them down or
 * letting the bar scroll sideways would only move the edge to the next button.
 *
 * The same answer the context panel got at its narrowest width: no row of
 * labelled targets in a narrow line, actions into a menu
 * (`exocortex-context-panel-narrow`). The entries carry words there, which is
 * what an icon tooltip never manages to be on a touch screen.
 *
 * Both shapes are rendered and one is hidden by a media query rather than by a
 * width the client has to measure: a hook would make the first painted frame
 * the wrong one on every page load, and this bar is the first thing on screen.
 */
export function GlobalLinks({
  accountLabel,
  onSignOut,
}: {
  accountLabel: string;
  onSignOut: () => void;
}) {
  const features = useFeatures();
  const newCount = features.data?.newCount ?? 0;
  const links = globalLinks(newCount);

  return (
    <>
      <div className="hidden items-center gap-2 lg:flex">
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

        <Separator orientation="vertical" className="h-5" />

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Abmelden"
                data-testid="sign-out"
                onClick={onSignOut}
              >
                <LogOutIcon />
              </Button>
            }
          />
          <TooltipContent>{accountLabel} · Abmelden</TooltipContent>
        </Tooltip>
      </div>

      <GlobalLinksMenu
        links={links}
        newCount={newCount}
        accountLabel={accountLabel}
        onSignOut={onSignOut}
      />
    </>
  );
}

/**
 * The narrow shape. The dot rides on the trigger, so the one thing the row was
 * saying without being opened keeps saying it; the number is in the label,
 * because a dot cannot be read aloud.
 */
function GlobalLinksMenu({
  links,
  newCount,
  accountLabel,
  onSignOut,
}: {
  links: GlobalLink[];
  newCount: number;
  accountLabel: string;
  onSignOut: () => void;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="relative lg:hidden"
            aria-label={newCount > 0 ? `Menü (${newCount} neue Funktionen)` : 'Menü'}
            data-testid="open-global-menu"
          >
            <MenuIcon />
            {newCount > 0 ? (
              <span
                aria-hidden
                data-testid="global-menu-badge"
                className="absolute right-1 top-1 size-2 rounded-full bg-primary"
              />
            ) : null}
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {links.map((link) => (
          <DropdownMenuItem
            key={link.href}
            data-testid={`menu-${link.testId}`}
            render={<Link href={link.href} />}
            onClick={() => setOpen(false)}
          >
            <link.icon /> {link.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem data-testid="menu-sign-out" onClick={onSignOut}>
          <LogOutIcon /> {accountLabel} abmelden
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
