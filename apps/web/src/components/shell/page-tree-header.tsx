'use client';

import { FolderCodeIcon, LayoutTemplateIcon, PlusIcon, TableIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  SectionRule,
} from '@exocortex/ui';

/**
 * The "Seiten" label and the menu that creates things under it.
 *
 * Its own component because the three entries each carry a test id, an icon and
 * a label, and forty lines of that in the middle of the tree makes the tree
 * harder to read than the menu is worth.
 */
export function PageTreeHeader({
  onCreatePage,
  onCreateFromTemplate,
  onCreateDatabase,
  onCreateProject,
}: {
  onCreatePage: () => void;
  onCreateFromTemplate: () => void;
  onCreateDatabase: () => void;
  onCreateProject: () => void;
}) {
  const t = useTranslations('shell.pageTreeHeader');
  return (
    // The component, not a copy of it. This header drew the square, the label
    // and the hairline by hand with the comment "the same mark the overview
    // uses", which is how a mark stops being a system: the three copies of it
    // had already drifted apart by the time anybody looked.
    <SectionRule
      className="px-2 py-1.5"
      action={
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('create')}
                data-testid="create-root-page"
              >
                <PlusIcon />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem data-testid="create-root-page-item" onClick={onCreatePage}>
              <PlusIcon /> {t('createPage')}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="create-root-from-template"
              onClick={onCreateFromTemplate}
            >
              <LayoutTemplateIcon /> {t('createFromTemplate')}
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="create-root-database" onClick={onCreateDatabase}>
              <TableIcon /> {t('createDatabase')}
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="create-root-project" onClick={onCreateProject}>
              <FolderCodeIcon /> {t('createProject')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      {t('title')}
    </SectionRule>
  );
}
