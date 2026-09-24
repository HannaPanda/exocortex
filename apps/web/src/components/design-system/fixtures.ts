import type {
  AdminOverviewResponse,
  DocumentTreeNode,
  SavedQueryHit,
  Settings,
} from '@exocortex/contracts';

import type { PresenceUser } from '@/components/shell/document-session';
import { presenceColor, SELF_PRESENCE_COLOR } from '@/components/shell/document-session';

/**
 * The styleguide's sample data. Local and deterministic: nothing here is read
 * from an account, a workspace or the API (issue #125), and every id is made
 * up, so a link that is followed lands nowhere real.
 *
 * Timestamps are an offset from the moment the module loads, not a fixed date.
 * The page is prerendered and hydrated later, and a hit shows its age as a
 * relative label: counted from a fixed date, the build would say "vor 4 Tagen"
 * and the browser a week later "vor 11 Tagen", which React reports as a
 * hydration mismatch. Counted from now, both say the same thing.
 */

export const FIXTURE_WORKSPACE_ID = 'dsworkspace000000000000';

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

const STAMP = ago(3 * 24 * 60);

function page(
  id: string,
  title: string,
  parentId: string | null,
  children: DocumentTreeNode[] = [],
  extra: Partial<DocumentTreeNode> = {},
): DocumentTreeNode {
  return {
    id,
    workspaceId: FIXTURE_WORKSPACE_ID,
    parentId,
    type: 'PAGE',
    title,
    icon: null,
    iconColor: null,
    layout: 'narrow',
    overviewMode: 'off',
    coverAttachmentId: null,
    coverPosition: 50,
    orderKey: id,
    createdById: 'dsuser',
    updatedById: 'dsuser',
    createdAt: STAMP,
    updatedAt: STAMP,
    archivedAt: null,
    children,
    ...extra,
  };
}

/** A small workspace: three levels, a database and a project, one long title. */
export const FIXTURE_TREE: DocumentTreeNode[] = [
  page('dsprojekte', 'Projekte', null, [
    page('dsdiss', 'Dissertation', 'dsprojekte', [
      page('dskap1', 'Kapitel 1: Einleitung', 'dsdiss'),
      page('dskap2', 'Kapitel 2: Methoden und Material der Voruntersuchung', 'dsdiss'),
      page('dslatex', 'Satz', 'dsdiss', [], { type: 'PROJECT' }),
    ]),
    page('dsumzug', 'Umzug', 'dsprojekte', [], { icon: '📦' }),
  ]),
  page('dsnotizen', 'Notizen', null, [], { icon: 'lucide:notebook-pen', iconColor: 'blue' }),
  page('dslesen', 'Leseliste', null, [], { type: 'COLLECTION' }),
];

export const FIXTURE_ACTIVE_ID = 'dskap2';

export const FIXTURE_PRESENCE: PresenceUser[] = [
  { clientId: 1, name: 'Du Selbst', color: SELF_PRESENCE_COLOR, self: true },
  { clientId: 2, name: 'Mira Albers', color: presenceColor('mira'), self: false },
  { clientId: 3, name: 'Jonas Keller', color: presenceColor('jonas'), self: false },
];

export const FIXTURE_CROWD: PresenceUser[] = [
  ...FIXTURE_PRESENCE,
  { clientId: 4, name: 'Aylin Demir', color: presenceColor('aylin'), self: false },
  { clientId: 5, name: 'Ben Okafor', color: presenceColor('ben'), self: false },
  { clientId: 6, name: 'Clara Weiß', color: presenceColor('clara'), self: false },
  { clientId: 7, name: 'David Ruiz', color: presenceColor('david'), self: false },
];

function hit(
  documentId: string,
  title: string,
  path: string[],
  snippet: string,
  extra: Partial<SavedQueryHit> = {},
): SavedQueryHit {
  return {
    documentId,
    workspaceId: FIXTURE_WORKSPACE_ID,
    parentId: null,
    title,
    icon: null,
    iconColor: null,
    type: 'PAGE',
    path: path.map((entry, index) => ({ id: `dspath${index}`, title: entry })),
    snippet,
    rank: 1,
    archivedAt: null,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...extra,
  };
}

export const FIXTURE_HITS: SavedQueryHit[] = [
  hit(
    'dshit1',
    'Kapitel 2: Methoden',
    ['Projekte', 'Dissertation'],
    'Die <mark>Messreihe</mark> wurde an drei Tagen wiederholt, jeweils zur selben Uhrzeit.',
    { updatedAt: ago(120) },
  ),
  hit(
    'dshit2',
    'Laborbuch März',
    ['Notizen'],
    'Zweite <mark>Messreihe</mark> verworfen: Temperatur im Raum zu hoch.',
    { icon: 'lucide:flask-conical', iconColor: 'green', updatedAt: ago(26 * 60) },
  ),
  hit('dshit3', 'Geräteliste', [], 'Waage, Thermometer, zwei Stative.', {
    type: 'COLLECTION',
    archivedAt: STAMP,
  }),
];

export const FIXTURE_OVERVIEW: AdminOverviewResponse = {
  userCount: 7,
  adminCount: 1,
  workspaceCount: 4,
  documentCount: 1284,
  attachmentCount: 312,
  aiRunsLast24h: 46,
  aiCostLast24hMicroUsd: 1_830_000,
  aiModelCount: 12,
  enabledAiModelCount: 5,
  apiTokenCount: 3,
};

/**
 * The settings the layout shows, one of each kind of control, in two groups.
 * None of them is a key the settings pattern uses: a row's input id is derived
 * from its key, and one page must not carry the same id twice.
 */
export const FIXTURE_SETTING_GROUPS = {
  ai: {
    'ai.enabled': true,
    'ai.defaultModelSlug': null,
    'ai.untrustedContentPolicy': 'guarded',
    'ai.timeoutMs': 180_000,
  },
  search: {
    'search.semanticEnabled': true,
    'search.semanticWeightPercent': 50,
  },
} satisfies Record<string, Partial<Settings>>;
