'use client';

import {
  BellIcon,
  BrainIcon,
  CircleQuestionMarkIcon,
  KeyIcon,
  LogOutIcon,
  MessagesSquareIcon,
  NetworkIcon,
  Share2Icon,
  ShieldIcon,
  UserRoundIcon,
} from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { type UserRole } from '@exocortex/contracts';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@exocortex/ui';

import { useFeatures } from '@/lib/api/feature-queries';

interface GlobalLink {
  href: string;
  label: string;
  testId: string;
  icon: typeof KeyIcon;
  badge?: number;
  /** A rule the entry ends a group on, drawn as a separator above the next. */
  group: 'help' | 'rooms' | 'settings' | 'deployment';
}

/**
 * The places that belong to the person rather than to the workspace.
 *
 * That is the line the header is now cut along. Which workspace one is in, and
 * what one does inside it, lives on the left of the bar: the switcher, the
 * tree, search, capture. Everything here spans workspaces or sits above them --
 * a conversation belongs to a person and spans all of them (issue #69), an
 * entity's mentions are gathered out of every workspace the reader may see, a
 * fact belongs to a project, an API token belongs to an account -- so none of
 * them fits under `/arbeitsbereich`, and none of them belongs in the same row
 * as the page one is writing.
 *
 * "Hilfe und Funktionen" is first and carries a count, and it is the only one
 * that does. A feature nobody knows about is the same as a feature nobody
 * built (issue #80), and a list you have to remember to open does not fix that
 * -- the dot is the part that does the work, which is why it also rides on the
 * closed trigger.
 *
 * "Verwaltung" is offered only to an account that may enter it. Before the
 * session carried `role`, it was shown to everybody and answered a non-admin
 * with "Kein Zugriff", which is an interface promising something it knows it
 * cannot deliver. The API refuses the route regardless (`AdminGuard`); this
 * only stops the promise being made.
 */
function globalLinks(newCount: number, role: UserRole): GlobalLink[] {
  const links: GlobalLink[] = [
    {
      href: '/hilfe',
      label: newCount > 0 ? `Hilfe und Funktionen (${newCount} neu)` : 'Hilfe und Funktionen',
      testId: 'open-features',
      // A question mark, because that is the shape people look for when they
      // are stuck. The sparkles this started with said "something AI happens
      // here", which is the one thing this page is not.
      icon: CircleQuestionMarkIcon,
      badge: newCount,
      group: 'help',
    },
    {
      href: '/chats',
      label: 'Chats',
      testId: 'open-chats',
      icon: MessagesSquareIcon,
      group: 'rooms',
    },
    {
      href: '/entitaeten',
      label: 'Entitäten',
      testId: 'open-entities',
      icon: NetworkIcon,
      group: 'rooms',
    },
    // Both directions of sharing. The incoming half is the only way to a page
    // somebody shared with this account: the reader is not a member of that
    // workspace, so no tree will ever show it (issue #83). The outgoing half is
    // the only place that lists every grant this account made, whatever the
    // workspace.
    {
      href: '/geteilt',
      label: 'Freigaben',
      testId: 'open-shared',
      icon: Share2Icon,
      group: 'rooms',
    },
    {
      href: '/gedaechtnis',
      label: 'Gedächtnis',
      testId: 'open-memory',
      icon: BrainIcon,
      group: 'rooms',
    },
    {
      href: '/einstellungen/verbindungen',
      label: 'Verbindungen',
      testId: 'open-api-tokens',
      icon: KeyIcon,
      group: 'settings',
    },
    // Its own entry rather than a corner of "Verbindungen": since issue #105
    // this is where both halves of being notified are decided, and the other
    // page is about programs one lets in.
    {
      href: '/einstellungen/benachrichtigungen',
      label: 'Benachrichtigungen',
      testId: 'open-notifications',
      icon: BellIcon,
      group: 'settings',
    },
  ];

  if (role === 'admin') {
    links.push({
      href: '/admin',
      label: 'Verwaltung',
      testId: 'open-admin',
      icon: ShieldIcon,
      group: 'deployment',
    });
  }

  return links;
}

/**
 * The right end of the topbar: one button, at every width.
 *
 * It used to be a row of eight icons plus a ninth for signing out above `lg`,
 * and the same entries as a menu below it. Two shapes were two answers to one
 * question, and the wide one was the wrong answer: nine abstract glyphs, none
 * of them reached more than a few times a week, standing permanently beside the
 * page somebody is writing. PRODUCT.md calls competing calls to attention a
 * defect rather than a taste question, and the narrow shape had already
 * demonstrated, since issue #100, that words in a menu beat icons in a row.
 * `global-links.tsx` argued that in its own comment; the argument does not stop
 * holding at 1024 pixels.
 *
 * The trigger is a person rather than a hamburger, because a hamburger next to
 * a navigation toggle would be two controls claiming the same meaning, and
 * because the menu's contents really are one thing: the account's places. It is
 * not an avatar: `PresenceAvatars` stands a few pixels to the left and already
 * shows this face when the reader is editing, and the same initials twice in
 * one bar say two different people are here.
 *
 * It carries no name either. The account name arrives with the session query,
 * so a labelled trigger would be one width on the first painted frame and
 * another a moment later, in the bar that is the first thing on screen. The
 * name is inside the menu, on the entry it belongs to.
 */
export function GlobalLinks({
  accountLabel,
  role,
  onSignOut,
}: {
  accountLabel: string;
  role: UserRole;
  onSignOut: () => void;
}) {
  const features = useFeatures();
  const newCount = features.data?.newCount ?? 0;
  const links = globalLinks(newCount, role);
  const [open, setOpen] = React.useState(false);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      {/* No tooltip, although the four icons to its left carry one. Theirs
          carry a keyboard shortcut, which is information the button cannot
          show otherwise; this one would only repeat its own `aria-label`,
          which is the case `tooltip.tsx` documents as the useless one. What it
          is opens with one click and then says every word. */}
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="relative"
            aria-label={
              newCount > 0
                ? `Konto und Bereiche (${newCount} neue Funktionen)`
                : 'Konto und Bereiche'
            }
            data-testid="open-global-menu"
          >
            <UserRoundIcon />
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

      <DropdownMenuContent align="end" className="min-w-56">
        {links.map((link, index) => (
          <React.Fragment key={link.href}>
            {index > 0 && links[index - 1]?.group !== link.group ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              data-testid={`menu-${link.testId}`}
              render={<Link href={link.href} />}
              onClick={() => setOpen(false)}
            >
              <link.icon /> {link.label}
            </DropdownMenuItem>
          </React.Fragment>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem data-testid="menu-sign-out" onClick={onSignOut}>
          <LogOutIcon /> {accountLabel} abmelden
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
