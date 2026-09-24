'use client';

import * as React from 'react';

import { type RenderTemplate } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  AppPage,
  Badge,
  Button,
  EmptyState,
  LoadingState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exocortex/ui';

import { useDeleteRenderTemplate, useRenderTemplates } from '@/lib/api/render-queries';
import { useWorkspaceDetail } from '@/lib/api/workspace-queries';

import { RenderTemplateDialog } from './render-template-dialog';

/**
 * The workspace's render templates (issue #44, ADR-026).
 *
 * Its own page rather than a section of the settings form for the reason the
 * automations page is one: a template has a body somebody edits, and a LaTeX
 * preamble in a settings row would be a text field in a list of switches.
 *
 * Writing needs ADMIN. Everybody else sees the same page read-only, because
 * knowing which templates exist is how anybody picks one in the render dialog.
 */
export function RenderTemplatesPage({ workspaceId }: { workspaceId: string }) {
  const detail = useWorkspaceDetail(workspaceId);
  const templates = useRenderTemplates(workspaceId);
  const remove = useDeleteRenderTemplate(workspaceId);

  const [editing, setEditing] = React.useState<RenderTemplate | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);

  if (detail.isPending || templates.isPending || templates.data === undefined) {
    return <LoadingState label="Vorlagen werden geladen …" />;
  }

  const role = detail.data?.role;
  const canEdit = role === 'ADMIN' || role === 'OWNER';

  return (
    <AppPage maxWidth="max-w-4xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="exocortex-page-title">Vorlagen</h1>
          <p className="mt-1 max-w-measure text-sm text-muted-foreground">
            Womit sich Seiten dieses Arbeitsbereichs als PDF veröffentlichen lassen. Der Satz läuft
            über Pandoc und LaTeX; der Inhalt der Seiten bleibt dabei unberührt.
          </p>
        </div>
        {canEdit ? (
          <Button
            data-testid="render-template-new"
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            Neue Vorlage
          </Button>
        ) : null}
      </div>

      {templates.data.enabledForWorkspace ? null : (
        <Alert className="mt-6" data-testid="render-disabled">
          <AlertDescription>
            Die PDF-Ausgabe ist für diesen Arbeitsbereich abgeschaltet. Die Vorlagen unten bleiben
            erhalten, es lässt sich aber nichts damit bauen. Umschalten lässt sich das über die
            Einstellung <code className="mx-1">render.enabled</code>; hat die Installation sie
            global abgeschaltet, kann ein Arbeitsbereich sie nicht selbst wieder einschalten.
          </AlertDescription>
        </Alert>
      )}

      <section className="mt-8 flex flex-col gap-3">
        {templates.data.templates.length === 0 ? (
          <EmptyState
            title="Noch keine Vorlagen"
            description="Eine Vorlage ohne eigenen Quelltext benutzt die eingebaute Vorlage Eisvogel und braucht keine Zeile LaTeX."
          />
        ) : (
          <Table data-testid="render-templates">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Satz</TableHead>
                <TableHead>Variablen</TableHead>
                {canEdit ? <TableHead className="w-px" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.data.templates.map((template) => (
                <TableRow key={template.id} data-testid="render-template">
                  <TableCell>
                    <div className="font-medium">{template.name}</div>
                    {template.description.length === 0 ? null : (
                      <div className="text-xs text-muted-foreground">{template.description}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {template.source === null ? (
                      <Badge variant="muted">Eisvogel (eingebaut)</Badge>
                    ) : (
                      <Badge variant="outline">Eigener Quelltext</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {template.variables.length === 0
                      ? '–'
                      : template.variables.map((variable) => variable.name).join(', ')}
                  </TableCell>
                  {canEdit ? (
                    <TableCell className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditing(template);
                          setDialogOpen(true);
                        }}
                      >
                        Bearbeiten
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void remove.mutateAsync(template.id)}
                      >
                        Löschen
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      {canEdit ? (
        <RenderTemplateDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          workspaceId={workspaceId}
          template={editing}
        />
      ) : null}
    </AppPage>
  );
}
