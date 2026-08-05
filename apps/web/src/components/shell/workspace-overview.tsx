'use client';

import { FileTextIcon, PlusIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button, Card, CardContent, EmptyState, LoadingState } from '@exocortex/ui';

import { useCreateDocument, useDocumentTree } from '@/lib/api/queries';

/** Landing view of a workspace: recent pages and the entry point to create one. */
export function WorkspaceOverview({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const tree = useDocumentTree(workspaceId);
  const createDocument = useCreateDocument(workspaceId);

  if (tree.isPending) return <LoadingState label="Seiten werden geladen …" />;

  const flat = (tree.data?.nodes ?? []).flatMap((node) => [node, ...node.children]);

  return (
    <div className="mx-auto w-full max-w-3xl overflow-y-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Übersicht</h1>
        <Button
          size="sm"
          data-testid="overview-create-page"
          onClick={() => {
            void createDocument
              .mutateAsync({ title: 'Unbenannte Seite', type: 'PAGE', parentId: null })
              .then((document) =>
                router.push(`/arbeitsbereich/${workspaceId}/seite/${document.id}`),
              );
          }}
        >
          <PlusIcon /> Neue Seite
        </Button>
      </div>

      {flat.length === 0 ? (
        <EmptyState
          title="Noch keine Seiten"
          description="Lege deine erste Seite an."
          icon={FileTextIcon}
        />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {flat.slice(0, 12).map((document) => (
            <li key={document.id}>
              <Card className="transition-colors hover:border-border-strong">
                <CardContent className="flex items-center gap-2 py-3">
                  <span aria-hidden className="text-base">
                    {document.icon ?? '📄'}
                  </span>
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-sm"
                    onClick={() =>
                      router.push(`/arbeitsbereich/${workspaceId}/seite/${document.id}`)
                    }
                  >
                    {document.title}
                  </button>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
