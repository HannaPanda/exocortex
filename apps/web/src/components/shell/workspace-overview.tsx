'use client';

import { FileTextIcon, PlusIcon, SettingsIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import {
  AppPage,
  Button,
  Card,
  CardContent,
  EmptyState,
  LoadingState,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';
import { useCreateDocument, useDocumentTree } from '@/lib/api/queries';

/** Landing view of a workspace: recent pages and the entry point to create one. */
export function WorkspaceOverview({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const tree = useDocumentTree(workspaceId);
  const createDocument = useCreateDocument(workspaceId);

  if (tree.isPending) return <LoadingState label="Seiten werden geladen …" />;

  const flat = (tree.data?.nodes ?? []).flatMap((node) => [node, ...node.children]);

  return (
    <AppPage maxWidth="max-w-3xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Übersicht</h1>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Arbeitsbereich-Einstellungen"
                  data-testid="open-workspace-settings"
                  render={<Link href={`/arbeitsbereich/${workspaceId}/einstellungen`} />}
                >
                  <SettingsIcon />
                </Button>
              }
            />
            <TooltipContent>Einstellungen</TooltipContent>
          </Tooltip>
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
                  <DocumentIcon
                    icon={document.icon}
                    iconColor={document.iconColor}
                    type={document.type}
                    className="size-5 text-base text-muted-foreground"
                  />
                  {/* An anchor, not a button: the card goes somewhere, so
                      middle click, Strg-/Cmd-click and „Link in neuem Tab
                      öffnen“ have to work without this component doing
                      anything for it (issue #29). */}
                  <Link
                    href={`/arbeitsbereich/${workspaceId}/seite/${document.id}`}
                    className="min-w-0 flex-1 cursor-pointer truncate text-left text-sm"
                    data-testid={`overview-page-${document.id}`}
                  >
                    {document.title}
                  </Link>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </AppPage>
  );
}
