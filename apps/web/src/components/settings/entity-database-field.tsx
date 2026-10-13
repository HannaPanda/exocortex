'use client';

import { useQueries } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import {
  type DocumentTreeNode,
  type DocumentTreeResponse,
  type SettingKey,
  type Settings,
} from '@exocortex/contracts';

import { ReferencePicker } from '@/components/settings/reference-picker';
import { apiRequest } from '@/lib/api/client';
import { useDatabaseProperties } from '@/lib/api/database-queries';
import { queryKeys } from '@/lib/api/query-keys';
import { useWorkspaces } from '@/lib/api/workspace-queries';
import { documentHref } from '@/lib/document-href';
import { missingEntityColumns, type ReferenceOption } from '@/lib/setting-references';

/**
 * `entities.databaseId` picked from the databases the administrator can see
 * (issue #171), instead of an id copied out of the address bar.
 *
 * The list is every database in every workspace the reader belongs to, the
 * memory area left out, read from the same tree queries the sidebar uses, so
 * nothing new is asked of the API and nothing the reader may not see can
 * appear. A stored id that is in none of them stays selected and is named as
 * missing. The chosen database's columns are checked against the two the
 * matcher reads, because a database without them yields no names at all.
 */

interface DatabaseEntry {
  id: string;
  workspaceId: string;
  title: string;
  workspaceName: string;
}

function collectionsOf(nodes: readonly DocumentTreeNode[]): DocumentTreeNode[] {
  return nodes.flatMap((node) => [
    ...(node.type === 'COLLECTION' ? [node] : []),
    ...collectionsOf(node.children),
  ]);
}

export function EntityDatabaseField({
  settingKey,
  value,
  onChange,
  described,
  id,
}: {
  settingKey: SettingKey;
  value: string | null;
  onChange: (value: Settings[SettingKey]) => void;
  described: { 'aria-describedby': string; 'aria-invalid': boolean };
  id: string;
}) {
  const t = useTranslations('settings.row.entityDatabase');
  const workspaces = useWorkspaces();
  const visible = (workspaces.data ?? []).filter((workspace) => !workspace.isMemory);
  const trees = useQueries({
    queries: visible.map((workspace) => ({
      queryKey: queryKeys.documentTree(workspace.id),
      queryFn: () =>
        apiRequest<DocumentTreeResponse>(`/api/workspaces/${workspace.id}/documents/tree`),
    })),
  });
  const properties = useDatabaseProperties(value ?? undefined);

  const databases: DatabaseEntry[] = visible.flatMap((workspace, index) =>
    collectionsOf(trees[index]?.data?.nodes ?? []).map((node) => ({
      id: node.id,
      workspaceId: workspace.id,
      title: node.title,
      workspaceName: workspace.name,
    })),
  );
  const loading = workspaces.isPending || trees.some((tree) => tree.isPending);
  const options: ReferenceOption[] = [
    { value: null, label: t('none'), detail: t('noneDetail') },
    ...databases.map((database) => ({
      value: database.id,
      label: database.title.trim() === '' ? t('untitled') : database.title,
      detail: `${database.workspaceName} · ${database.id}`,
    })),
  ];
  const chosen = databases.find((database) => database.id === value);
  const missing = properties.data === undefined ? [] : missingEntityColumns(properties.data);
  const columnsId = `${id}-columns`;

  return (
    <>
      <ReferencePicker
        id={id}
        name={settingKey}
        value={value}
        options={options}
        loading={loading}
        onChange={onChange}
        described={
          missing.length > 0 && chosen !== undefined
            ? { ...described, 'aria-describedby': `${described['aria-describedby']} ${columnsId}` }
            : described
        }
        notListedLabel={t('notListed')}
        missingMessage={loading ? undefined : t('missing', { id: value ?? '' })}
        placeholder={t('placeholder')}
      />
      {chosen === undefined ? null : (
        <p className="text-xs text-muted-foreground">
          <Link
            className="underline underline-offset-2 hover:text-foreground"
            href={documentHref(chosen.workspaceId, chosen.id, 'COLLECTION')}
          >
            {t('open', { title: chosen.title.trim() === '' ? t('untitled') : chosen.title })}
          </Link>
        </p>
      )}
      {chosen !== undefined && missing.length > 0 ? (
        <p id={columnsId} className="text-xs text-destructive-text" data-testid={columnsId}>
          {t('columnsMissing', { columns: missing.join(', ') })}
        </p>
      ) : null}
    </>
  );
}
