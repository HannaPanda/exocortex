'use client';

import {
  ClipboardPlusIcon,
  FilePlusIcon,
  FolderCodeIcon,
  LayoutTemplateIcon,
  ListFilterIcon,
  TableIcon,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type CreatableDocumentType, type DocumentTemplate } from '@exocortex/contracts';

import { DocumentIcon } from '@/components/document/document-icon';
import { useCreateDocument } from '@/lib/api/document-queries';
import { useCreateProject } from '@/lib/api/project-queries';
import { useInstantiateTemplate, useTemplates } from '@/lib/api/template-queries';
import { documentHref } from '@/lib/document-href';

import { useLatest } from './contributions';
import { keywordsOf, type PaletteCommand } from './palette-command';

const ICON = 'size-4 text-muted-foreground';

/**
 * Making something new at the top of the open workspace (issue #148).
 *
 * The same three things the page tree's "+" menu makes, with the same titles,
 * so the palette and the tree cannot disagree about what "neue Datenbank"
 * produces. Beneath the open page is the page's own business and lives in
 * `page-commands.tsx`; capture and a new chat come from the shell, which owns
 * the dialog and the panel they open.
 */
export function useCreateCommands(workspaceId: string | null, open: boolean): PaletteCommand[] {
  const t = useTranslations('shell.paletteCommands.create');
  const tTree = useTranslations('shell.pageTree');
  const router = useRouter();
  const createDocument = useCreateDocument(workspaceId ?? undefined);
  const createProject = useCreateProject(workspaceId ?? '');
  const instantiate = useInstantiateTemplate(workspaceId ?? '');
  // Only while the palette is open: not worth a request on every page load.
  const templates = useTemplates(open && workspaceId !== null ? workspaceId : undefined);
  const latest = useLatest({ createDocument, createProject, instantiate, router });

  return React.useMemo(() => {
    if (workspaceId === null) return [];

    // "Seite aus Vorlage erstellen → Besprechung". The copy goes where the
    // template suggests, with the title its pattern makes, exactly as the
    // picker in the page tree does when its title field is left empty.
    const fromTemplate = (template: DocumentTemplate): PaletteCommand => ({
      id: `create-from-template-${template.document.id}`,
      group: 'create',
      label: template.document.title,
      hint: template.description ?? undefined,
      icon: (
        <DocumentIcon
          icon={template.document.icon}
          iconColor={template.document.iconColor}
          type="PAGE"
          className="text-muted-foreground"
        />
      ),
      keywords: keywordsOf(t('fromTemplateKeywords')),
      run: () => {
        void latest.current.instantiate
          .mutateAsync({ documentId: template.document.id, request: {} })
          .then((result) =>
            latest.current.router.push(documentHref(workspaceId, result.document.id, 'PAGE')),
          );
      },
    });
    const templateList = templates.data?.templates;

    const create = (type: CreatableDocumentType, title: string): void => {
      void latest.current.createDocument
        .mutateAsync({ title, type, parentId: null })
        .then((document) =>
          latest.current.router.push(documentHref(workspaceId, document.id, type)),
        );
    };

    return [
      {
        id: 'create-page',
        group: 'create',
        // Offered before a key is pressed, as it was before the registry.
        idle: true,
        label: t('page'),
        icon: <FilePlusIcon className={ICON} />,
        keywords: keywordsOf(t('pageKeywords')),
        run: () => create('PAGE', tTree('untitledPage')),
      },
      {
        id: 'create-database',
        group: 'create',
        label: t('database'),
        icon: <TableIcon className={ICON} />,
        keywords: keywordsOf(t('databaseKeywords')),
        run: () => create('COLLECTION', tTree('untitledDatabase')),
      },
      {
        id: 'create-project',
        group: 'create',
        label: t('project'),
        icon: <FolderCodeIcon className={ICON} />,
        keywords: keywordsOf(t('projectKeywords')),
        // Its own route, like the tree's: a project needs its sidecar row and
        // a first file (ADR-027).
        run: () => {
          void latest.current.createProject
            .mutateAsync({ title: tTree('untitledProject'), parentId: null })
            .then(({ project }) =>
              latest.current.router.push(documentHref(workspaceId, project.id, 'PROJECT')),
            );
        },
      },
      {
        id: 'create-saved-query',
        group: 'create',
        label: t('savedQuery'),
        hint: t('savedQueryHint'),
        icon: <ListFilterIcon className={ICON} />,
        keywords: keywordsOf(t('savedQueryKeywords')),
        // A saved search is a search somebody decided to keep, so it is made
        // where searches are built and saved.
        href: `/arbeitsbereich/${workspaceId}/suche`,
      },
      {
        id: 'create-work-item',
        group: 'create',
        label: t('workItem'),
        hint: t('workItemHint'),
        icon: <ClipboardPlusIcon className={ICON} />,
        keywords: keywordsOf(t('workItemKeywords')),
        // The list opens with its dialog, so the new item lands where it will
        // be looked for afterwards (issue #138).
        href: `/arbeitsbereich/${workspaceId}/auftraege?new=1`,
      },
      {
        id: 'create-from-template',
        group: 'create',
        label: t('fromTemplate'),
        placeholder: t('fromTemplatePlaceholder'),
        empty: templateList === undefined ? t('templatesLoading') : t('templatesEmpty'),
        icon: <LayoutTemplateIcon className={ICON} />,
        keywords: keywordsOf(t('fromTemplateKeywords')),
        searchable: true,
        children: () => (templateList ?? []).map(fromTemplate),
      },
    ];
  }, [latest, t, templates.data, tTree, workspaceId]);
}
