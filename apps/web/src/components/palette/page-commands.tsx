'use client';

import {
  BotIcon,
  DownloadIcon,
  FilePlusIcon,
  FileTextIcon,
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

import { type DocumentDetail, type DocumentLayout } from '@exocortex/contracts';

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

  // The two widths the page does not have; the one it has is not a change.
  for (const { layout, key } of LAYOUTS) {
    if (layout === detail.layout) continue;
    commands.push(
      command(
        `layout-${layout}`,
        t(`layout${key}`),
        t('layoutKeywords'),
        <RulerIcon className={ICON} />,
        () => h().setLayout(layout),
      ),
    );
  }

  commands.push(
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
    // Filing is the one way to move a page by choosing where it goes; the
    // candidates are the suggestion's, the choice is the reader's.
    command('move', t('move'), t('moveKeywords'), <FolderTreeIcon className={ICON} />, () =>
      h().file(),
    ),
    command('archive', t('archive'), t('archiveKeywords'), <TrashIcon className={ICON} />, () =>
      h().archive(),
    ),
  );
  return commands;
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
): void {
  const t = useTranslations('shell.paletteCommands.page');
  const latest = useLatest(handlers);
  const commands = React.useMemo(
    () => pageMenuCommands(detail, archived, latest, t),
    [archived, detail, latest, t],
  );
  usePaletteContribution('page-menu', commands);
}
