'use client';

import {
  BellIcon,
  BotIcon,
  BrainIcon,
  ChartColumnIcon,
  CircleQuestionMarkIcon,
  ClipboardListIcon,
  CpuIcon,
  GitPullRequestIcon,
  HandIcon,
  HouseIcon,
  KeyIcon,
  LanguagesIcon,
  LayoutGridIcon,
  LayoutTemplateIcon,
  MessagesSquareIcon,
  NetworkIcon,
  PaletteIcon,
  Settings2Icon,
  Share2Icon,
  ShieldIcon,
  SlidersHorizontalIcon,
  UsersIcon,
  WorkflowIcon,
} from 'lucide-react';
import { type useTranslations } from 'next-intl';
import * as React from 'react';

import {
  fillScreen,
  keywordsOf,
  type PaletteCommand,
  type PaletteContext,
} from './palette-command';

const ICON = 'size-4 text-muted-foreground';

/**
 * Who a place is offered to. `workspace` needs one to be open, because its
 * address has one in it; `admin` is the Verwaltung, which the API refuses to
 * anybody else anyway (`AdminGuard`), so offering it would be a promise the
 * interface knows it cannot keep.
 */
type Audience = 'everyone' | 'workspace' | 'admin';

interface Place {
  /** The key under `shell.paletteCommands.navigation`. */
  key:
    | 'help'
    | 'attention'
    | 'chats'
    | 'entities'
    | 'shares'
    | 'memory'
    | 'connections'
    | 'notifications'
    | 'language'
    | 'workspaces'
    | 'workspaceHome'
    | 'workspaceSearch'
    | 'workspaceShares'
    | 'workItems'
    | 'changesets'
    | 'automations'
    | 'templates'
    | 'workspaceSettings'
    | 'admin'
    | 'adminSettings'
    | 'adminModels'
    | 'adminUsage'
    | 'adminUsers'
    | 'adminAgents'
    | 'designSystem';
  /**
   * The route pattern, written as a literal: `check-palette-coverage.mjs`
   * reads these strings out of this file and holds them against every
   * `page.tsx` there is. A screen nobody can reach by name goes red there.
   */
  screen: string;
  audience: Audience;
  icon: React.ComponentType<{ className?: string }>;
  idle?: boolean;
}

/**
 * Every place in the application a person may want to go to by name.
 *
 * The order is the order of the menus the places also sit in (the account
 * menu, then the workspace, then the Verwaltung), so a reader who knows one
 * finds the other in the same sequence.
 */
const PLACES: readonly Place[] = [
  { key: 'help', screen: '/hilfe', audience: 'everyone', icon: CircleQuestionMarkIcon },
  { key: 'attention', screen: '/wartet', audience: 'everyone', icon: HandIcon },
  { key: 'chats', screen: '/chats', audience: 'everyone', icon: MessagesSquareIcon },
  { key: 'entities', screen: '/entitaeten', audience: 'everyone', icon: NetworkIcon },
  { key: 'shares', screen: '/geteilt', audience: 'everyone', icon: Share2Icon },
  { key: 'memory', screen: '/gedaechtnis', audience: 'everyone', icon: BrainIcon },
  {
    key: 'connections',
    screen: '/einstellungen/verbindungen',
    audience: 'everyone',
    icon: KeyIcon,
  },
  {
    key: 'notifications',
    screen: '/einstellungen/benachrichtigungen',
    audience: 'everyone',
    icon: BellIcon,
  },
  { key: 'language', screen: '/einstellungen/sprache', audience: 'everyone', icon: LanguagesIcon },
  { key: 'workspaces', screen: '/arbeitsbereich', audience: 'everyone', icon: LayoutGridIcon },
  { key: 'workspaceHome', screen: '/arbeitsbereich/:x', audience: 'workspace', icon: HouseIcon },
  {
    key: 'workspaceSearch',
    screen: '/arbeitsbereich/:x/suche',
    audience: 'workspace',
    icon: SlidersHorizontalIcon,
    // Offered before a key is pressed, as it was before the registry existed:
    // the full search page is where a question too big for the palette goes.
    idle: true,
  },
  {
    key: 'workspaceShares',
    screen: '/arbeitsbereich/:x/freigaben',
    audience: 'workspace',
    icon: Share2Icon,
  },
  {
    key: 'workItems',
    screen: '/arbeitsbereich/:x/auftraege',
    audience: 'workspace',
    icon: ClipboardListIcon,
  },
  {
    key: 'changesets',
    screen: '/arbeitsbereich/:x/vorschlaege',
    audience: 'workspace',
    icon: GitPullRequestIcon,
  },
  {
    key: 'automations',
    screen: '/arbeitsbereich/:x/automationen',
    audience: 'workspace',
    icon: WorkflowIcon,
  },
  {
    key: 'templates',
    screen: '/arbeitsbereich/:x/vorlagen',
    audience: 'workspace',
    icon: LayoutTemplateIcon,
  },
  {
    key: 'workspaceSettings',
    screen: '/arbeitsbereich/:x/einstellungen',
    audience: 'workspace',
    icon: Settings2Icon,
  },
  { key: 'admin', screen: '/admin', audience: 'admin', icon: ShieldIcon },
  { key: 'adminSettings', screen: '/admin/einstellungen', audience: 'admin', icon: Settings2Icon },
  { key: 'adminModels', screen: '/admin/ki-modelle', audience: 'admin', icon: CpuIcon },
  { key: 'adminUsage', screen: '/admin/nutzung', audience: 'admin', icon: ChartColumnIcon },
  { key: 'adminUsers', screen: '/admin/nutzer', audience: 'admin', icon: UsersIcon },
  { key: 'adminAgents', screen: '/admin/agenten', audience: 'admin', icon: BotIcon },
  // The styleguide draws with fixtures and touches nobody's data, but it is a
  // workbench for people building the interface, not a place for a reader.
  { key: 'designSystem', screen: '/design-system', audience: 'admin', icon: PaletteIcon },
];

function offered(place: Place, context: PaletteContext): boolean {
  switch (place.audience) {
    case 'everyone':
      return true;
    case 'workspace':
      return context.workspaceId !== null;
    case 'admin':
      return context.role === 'admin';
  }
}

/** The places, as commands that open them (issue #148). */
export function navigationCommands(
  context: PaletteContext,
  t: ReturnType<typeof useTranslations<'shell.paletteCommands.navigation'>>,
): PaletteCommand[] {
  return PLACES.filter((place) => offered(place, context)).map((place) => ({
    id: `navigate-${place.key}`,
    group: 'navigation',
    label: t(`${place.key}.label`),
    icon: <place.icon className={ICON} />,
    keywords: keywordsOf(t(`${place.key}.keywords`)),
    href: fillScreen(place.screen, context.workspaceId),
    idle: place.idle,
  }));
}
