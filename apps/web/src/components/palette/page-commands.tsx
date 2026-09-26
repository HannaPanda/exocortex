'use client';

import {
  BotIcon,
  DownloadIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderInputIcon,
  FolderTreeIcon,
  ImageIcon,
  LayoutDashboardIcon,
  LayoutTemplateIcon,
  LinkIcon,
  PaperclipIcon,
  PencilIcon,
  RotateCcwIcon,
  RulerIcon,
  Share2Icon,
  SlidersHorizontalIcon,
  SmileIcon,
  SparklesIcon,
  TableIcon,
  TrashIcon,
  UploadIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type DocumentDetail,
  type DocumentLayout,
  type DocumentTreeNode,
} from '@exocortex/contracts';

import { DocumentIcon } from '@/components/document/document-icon';

import { useLatest, usePaletteContribution } from './contributions';
import { keywordsOf, type PaletteCommand } from './palette-command';
import { type PaletteRequest } from './palette-requests';

const ICON = 'size-4 text-muted-foreground';

type PageT = ReturnType<typeof useTranslations<'shell.paletteCommands.page'>>;

const LAYOUTS: readonly { layout: DocumentLayout; key: 'Narrow' | 'Wide' | 'Full' }[] = [
  { layout: 'narrow', key: 'Narrow' },
  { layout: 'wide', key: 'Wide' },
  { layout: 'full', key: 'Full' },
];

export interface PageBodyHandlers {
  ask: (request: PaletteRequest) => void;
  setLayout: (layout: DocumentLayout) => void;
  setOverview: (on: boolean) => void;
  openProperties: () => void;
  createChild: (type: 'PAGE' | 'COLLECTION') => void;
  copyLink: () => void;
  exportMarkdown: () => void;
  openRender: () => void;
  openImport: () => void;
}

function command(
  id: string,
  label: string,
  keywords: string,
  icon: React.ReactNode,
  run: () => void,
): PaletteCommand {
  return { id: `page-${id}`, group: 'page', label, icon, keywords: keywordsOf(keywords), run };
}

/** The same, under "Erstellen": it makes something new beneath the page. */
function creating(pageCommand: PaletteCommand): PaletteCommand {
  return { ...pageCommand, group: 'create' };
}

/**
 * What can be done to the open page from its body: its title, symbol, cover,
 * width, overview, properties, children and files (issue #148).
 *
 * Offered only where it would work: a page somebody may only read gets the
 * link and the export, an archived page nothing that changes it. Every `run`
 * goes through `handlers`, which the page keeps current, so the list itself
 * only changes when the page does.
 */
export function pageBodyCommands(
  detail: DocumentDetail,
  writable: boolean,
  handlers: React.RefObject<PageBodyHandlers>,
  t: PageT,
): PaletteCommand[] {
  const h = (): PageBodyHandlers => handlers.current;
  const commands: PaletteCommand[] = [
    command('copy-link', t('copyLink'), t('copyLinkKeywords'), <LinkIcon className={ICON} />, () =>
      h().copyLink(),
    ),
    command(
      'properties',
      t('properties'),
      t('propertiesKeywords'),
      <SlidersHorizontalIcon className={ICON} />,
      () => h().openProperties(),
    ),
    command(
      'export',
      t('exportMarkdown'),
      t('exportMarkdownKeywords'),
      <DownloadIcon className={ICON} />,
      () => h().exportMarkdown(),
    ),
    command('render', t('render'), t('renderKeywords'), <FileTextIcon className={ICON} />, () =>
      h().openRender(),
    ),
  ];
  if (!writable) return commands;

  commands.push(
    command('rename', t('rename'), t('renameKeywords'), <PencilIcon className={ICON} />, () =>
      h().ask('rename'),
    ),
    command('icon', t('changeIcon'), t('changeIconKeywords'), <SmileIcon className={ICON} />, () =>
      h().ask('change-icon'),
    ),
    command(
      'cover-upload',
      detail.coverAttachmentId === null ? t('addCover') : t('replaceCover'),
      t('coverKeywords'),
      <ImageIcon className={ICON} />,
      () => h().ask('upload-cover'),
    ),
    command(
      'cover-generate',
      t('generateCover'),
      t('generateCoverKeywords'),
      <SparklesIcon className={ICON} />,
      () => h().ask('generate-cover'),
    ),
  );

  // "Layout ändern → Breit". The width the page has is listed as the current
  // one, so the menu answers "which is it now" as well.
  const layouts = LAYOUTS.map(({ layout, key }) => ({
    ...command(
      `layout-${layout}`,
      t(`layout${key}`),
      t('layoutKeywords'),
      <RulerIcon className={ICON} />,
      () => {
        if (layout !== detail.layout) h().setLayout(layout);
      },
    ),
    hint: layout === detail.layout ? t('current') : undefined,
  }));
  commands.push(
    {
      id: 'page-layout',
      group: 'page',
      label: t('layout'),
      placeholder: t('layoutPlaceholder'),
      icon: <RulerIcon className={ICON} />,
      keywords: keywordsOf(t('layoutKeywords')),
      searchable: true,
      children: () => layouts,
    },
    command(
      'overview',
      detail.overviewMode === 'off' ? t('overviewOn') : t('overviewOff'),
      t('overviewKeywords'),
      <LayoutDashboardIcon className={ICON} />,
      () => h().setOverview(detail.overviewMode === 'off'),
    ),
    // The rule is a field of the properties dialog, so the command opens it
    // there rather than a second editor for the same three choices.
    command('ai-rule', t('aiRule'), t('aiRuleKeywords'), <BotIcon className={ICON} />, () =>
      h().openProperties(),
    ),
    command(
      'import',
      t('importMarkdown'),
      t('importMarkdownKeywords'),
      <UploadIcon className={ICON} />,
      () => h().openImport(),
    ),
    creating(
      command(
        'create-child',
        t('createChild'),
        t('createChildKeywords'),
        <FilePlusIcon className={ICON} />,
        () => h().createChild('PAGE'),
      ),
    ),
    creating(
      command(
        'create-child-database',
        t('createChildDatabase'),
        t('createChildDatabaseKeywords'),
        <TableIcon className={ICON} />,
        () => h().createChild('COLLECTION'),
      ),
    ),
  );

  // A file lands in the text, so only where there is an editor.
  if (detail.type === 'PAGE') {
    commands.push(
      creating(
        command(
          'upload-file',
          t('uploadFile'),
          t('uploadFileKeywords'),
          <PaperclipIcon className={ICON} />,
          () => h().ask('upload-file'),
        ),
      ),
    );
  }
  return commands;
}

export interface PageMenuHandlers {
  openTemplate: () => void;
  openShare: () => void;
  file: () => void;
  moveTo: (target: { parentId: string | null; title: string }) => void;
  archive: () => void;
  restore: () => void;
}

/**
 * The page's actions menu in the top bar, as commands: the dialogs it opens
 * live in `DocumentTopBar`, so that is where these are offered from.
 */
export function pageMenuCommands(
  detail: DocumentDetail,
  archived: boolean,
  handlers: React.RefObject<PageMenuHandlers>,
  t: PageT,
  tree?: readonly DocumentTreeNode[],
): PaletteCommand[] {
  const h = (): PageMenuHandlers => handlers.current;
  if (archived) {
    return detail.access === 'write'
      ? [
          command(
            'restore',
            t('restore'),
            t('restoreKeywords'),
            <RotateCcwIcon className={ICON} />,
            () => h().restore(),
          ),
        ]
      : [];
  }

  const commands: PaletteCommand[] = [];
  if (detail.canShare) {
    commands.push(
      command('share', t('share'), t('shareKeywords'), <Share2Icon className={ICON} />, () =>
        h().openShare(),
      ),
    );
  }
  if (detail.access !== 'write') return commands;

  commands.push(
    command(
      'template',
      t('template'),
      t('templateKeywords'),
      <LayoutTemplateIcon className={ICON} />,
      () => h().openTemplate(),
    ),
    // Asking where it belongs: the candidates are the suggestion's, the
    // choice is the reader's.
    command(
      'suggest-parent',
      t('suggestParent'),
      t('suggestParentKeywords'),
      <FolderTreeIcon className={ICON} />,
      () => h().file(),
    ),
    command('archive', t('archive'), t('archiveKeywords'), <TrashIcon className={ICON} />, () =>
      h().archive(),
    ),
  );
  // Choosing the place yourself, by walking the tree. Only with the tree at
  // hand, which a page opened through a share does not have.
  if (tree !== undefined) commands.push(moveMenu(detail, tree, h, t));
  return commands;
}

/**
 * "Seite verschieben → Projekte → eXocortex → Architektur" (issue #148).
 *
 * The page tree one level at a time. A page with pages under it is a menu
 * whose first choice is the page itself, so every level can be the answer;
 * typing searches the whole tree below the level shown. The page and what
 * hangs under it are left out, because a page cannot move into itself, and
 * so are databases and projects, whose children are rows and files.
 */
function moveMenu(
  detail: DocumentDetail,
  tree: readonly DocumentTreeNode[],
  h: () => PageMenuHandlers,
  t: PageT,
): PaletteCommand {
  const current = (parentId: string | null): string | undefined =>
    parentId === detail.parentId ? t('current') : undefined;
  const targets = (nodes: readonly DocumentTreeNode[]): PaletteCommand[] =>
    nodes
      .filter((node) => node.id !== detail.id && node.type === 'PAGE')
      .map((node) => {
        const title = node.title.trim() === '' ? t('untitled') : node.title;
        const icon = (
          <DocumentIcon
            icon={node.icon}
            iconColor={node.iconColor}
            type={node.type}
            className="text-muted-foreground"
          />
        );
        const here: PaletteCommand = {
          id: `page-move-to-${node.id}`,
          group: 'page',
          label: title,
          hint: current(node.id) ?? t('moveHere'),
          icon,
          keywords: [],
          run: () => {
            if (node.id !== detail.parentId) h().moveTo({ parentId: node.id, title });
          },
        };
        const below = node.children.filter(
          (child) => child.id !== detail.id && child.type === 'PAGE',
        );
        if (below.length === 0) return here;
        return {
          id: `page-move-into-${node.id}`,
          group: 'page',
          label: title,
          icon,
          keywords: [],
          children: () => [here, ...targets(node.children)],
        };
      });

  return {
    id: 'page-move',
    group: 'page',
    label: t('move'),
    placeholder: t('movePlaceholder'),
    empty: t('moveEmpty'),
    icon: <FolderInputIcon className={ICON} />,
    keywords: keywordsOf(t('moveKeywords')),
    children: () => [
      {
        id: 'page-move-root',
        group: 'page',
        label: t('moveRoot'),
        hint: current(null) ?? t('moveRootHint'),
        icon: <FolderInputIcon className={ICON} />,
        keywords: [],
        run: () => {
          if (detail.parentId !== null) h().moveTo({ parentId: null, title: t('moveRoot') });
        },
      },
      ...targets(tree),
    ],
  };
}

const NONE: readonly PaletteCommand[] = [];

/** Offers the body's commands while the page is open; `detail` is absent while it loads. */
export function usePageBodyCommands(
  detail: DocumentDetail | undefined,
  handlers: PageBodyHandlers,
): void {
  const t = useTranslations('shell.paletteCommands.page');
  const latest = useLatest(handlers);
  const writable = detail !== undefined && detail.archivedAt === null && detail.access === 'write';
  const commands = React.useMemo(
    () => (detail === undefined ? NONE : pageBodyCommands(detail, writable, latest, t)),
    [detail, latest, t, writable],
  );
  usePaletteContribution('page-body', commands);
}

/** Offers the actions menu's commands while the top bar is mounted. */
export function usePageMenuCommands(
  detail: DocumentDetail,
  archived: boolean,
  handlers: PageMenuHandlers,
  tree: readonly DocumentTreeNode[] | undefined,
): void {
  const t = useTranslations('shell.paletteCommands.page');
  const latest = useLatest(handlers);
  const commands = React.useMemo(
    () => pageMenuCommands(detail, archived, latest, t, tree),
    [archived, detail, latest, t, tree],
  );
  usePaletteContribution('page-menu', commands);
}
