'use client';

import {
  ActivityIcon,
  LinkIcon,
  MessageSquareIcon,
  SettingsIcon,
  SparklesIcon,
} from 'lucide-react';
import * as React from 'react';

import { EmptyState, Tabs, TabsContent, TabsList, TabsTrigger } from '@exocortex/ui';

import { AiPanel } from '@/components/ai/ai-panel';
import { useDocument } from '@/lib/api/queries';

export interface ContextPanelProps {
  workspaceId: string | null;
  documentId: string | null;
}

/**
 * Right-hand context panel.
 *
 * Only the AI tab is functional in this version. The remaining tabs exist so
 * comments, backlinks, properties and activity can be added without changing the
 * shell layout (see docs/architecture.md, "Deferred work").
 */
export function ContextPanel({ workspaceId, documentId }: ContextPanelProps) {
  const document = useDocument(documentId ?? undefined);

  return (
    <Tabs defaultValue="ai" className="flex min-h-0 flex-1 flex-col">
      <div className="p-2">
        <TabsList>
          <TabsTrigger value="ai" data-testid="context-tab-ai">
            <SparklesIcon /> KI
          </TabsTrigger>
          <TabsTrigger value="properties">
            <SettingsIcon /> Eigenschaften
          </TabsTrigger>
          <TabsTrigger value="comments">
            <MessageSquareIcon /> Kommentare
          </TabsTrigger>
          <TabsTrigger value="backlinks">
            <LinkIcon /> Verweise
          </TabsTrigger>
          <TabsTrigger value="activity">
            <ActivityIcon /> Aktivität
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="ai" className="flex min-h-0 flex-col">
        <AiPanel workspaceId={workspaceId} documentId={documentId} />
      </TabsContent>

      <TabsContent value="properties" className="overflow-y-auto p-3">
        {document.data === undefined ? (
          <EmptyState
            title="Keine Seite geöffnet"
            description="Öffne eine Seite, um ihre Eigenschaften zu sehen."
            icon={SettingsIcon}
          />
        ) : (
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Typ</dt>
              <dd>{document.data.type === 'PAGE' ? 'Seite' : 'Sammlung'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Zuletzt geändert</dt>
              {/* Timestamps, versions and IDs are values, so they get the
                  instrument face (packages/ui/src/styles.css). */}
              <dd className="exocortex-numeric">
                {new Date(document.data.updatedAt).toLocaleString('de-DE')}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Zuletzt verarbeitet</dt>
              <dd
                className={document.data.materializedAt === null ? undefined : 'exocortex-numeric'}
                data-testid="materialized-at"
              >
                {document.data.materializedAt === null
                  ? 'noch nicht'
                  : new Date(document.data.materializedAt).toLocaleString('de-DE')}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Schema-Version</dt>
              <dd className="exocortex-numeric">{document.data.schemaVersion}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Zugriff</dt>
              <dd>{document.data.access === 'write' ? 'Bearbeiten' : 'Nur lesen'}</dd>
            </div>
          </dl>
        )}
      </TabsContent>

      <TabsContent value="comments" className="p-3">
        <EmptyState
          title="Kommentare folgen"
          description="Die Panelstruktur ist vorbereitet; Kommentare sind in dieser Version noch nicht umgesetzt."
          icon={MessageSquareIcon}
        />
      </TabsContent>

      <TabsContent value="backlinks" className="p-3">
        <EmptyState
          title="Verweise folgen"
          description="Wiki-Links werden bereits gespeichert, die Auswertung als Backlinks kommt später."
          icon={LinkIcon}
        />
      </TabsContent>

      <TabsContent value="activity" className="p-3">
        <EmptyState
          title="Aktivität folgt"
          description="Alle Änderungen werden serverseitig auditiert; die Anzeige kommt später."
          icon={ActivityIcon}
        />
      </TabsContent>
    </Tabs>
  );
}
