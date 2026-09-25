'use client';

import {
  ChevronsDownUpIcon,
  FolderCodeIcon,
  LayoutTemplateIcon,
  PlusIcon,
  TableIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  SectionRule,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
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
  canCollapseAll,
  onCollapseAll,
}: {
  onCreatePage: () => void;
  onCreateFromTemplate: () => void;
  onCreateDatabase: () => void;
  onCreateProject: () => void;
  /** False when folding everything would leave the tree as it is. */
  canCollapseAll: boolean;
  onCollapseAll: () => void;
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
        <div className="flex items-center gap-0.5">
          {/* Visible rather than in the menu: a tree that has grown over the
              course of a day is the everyday case, and the way back to a
              readable one should be one click. Unfolding everything has no
              button, because in a deep workspace it produces a list nobody can
              read; it lives on the keyboard (`*`, Shift + right). */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('collapseAll')}
                  disabled={!canCollapseAll}
                  onClick={onCollapseAll}
                  data-testid="tree-collapse-all"
                >
                  <ChevronsDownUpIcon />
                </Button>
              }
            />
            <TooltipContent>{t('collapseAll')}</TooltipContent>
          </Tooltip>
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
        </div>
      }
    >
      {t('title')}
    </SectionRule>
  );
}
