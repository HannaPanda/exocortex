'use client';

import Link from 'next/link';
import * as React from 'react';

import { type MemoryFact, type MemoryFactStatus } from '@exocortex/contracts';
import {
  AppPage,
  Badge,
  Button,
  EmptyState,
  Input,
  Label,
  LoadingState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { formatMoment } from '@/components/render/render-labels';
import { useMemoryFacts, usePromoteMemoryFact } from '@/lib/api/memory-queries';
import { useWorkspaces } from '@/lib/api/workspace-queries';

/**
 * What the agent memory holds to be true (issue #46, ADR-021).
 *
 * Facts sit above session notes: a nightly job judges notes against them,
 * confidence fades with silence rather than notes expiring by age, and a
 * contradiction is marked rather than resolved by weight. All three of those
 * are visible here, because a memory nobody can inspect is a memory nobody can
 * correct.
 *
 * Promotion is the one action, and ADR-021 calls it a human act. It had no
 * human surface: `exo_memory_fact_promote` existed, and the person whose
 * judgement it is had to ask an agent to press the button for them.
 */

const STATUS_LABELS: Record<MemoryFactStatus, string> = {
  current: 'gilt',
  superseded: 'überholt',
  conflicted: 'widersprüchlich',
};

const STATUSES: MemoryFactStatus[] = ['current', 'conflicted', 'superseded'];

export function MemoryFactsPage() {
  const [project, setProject] = React.useState('');
  const [status, setStatus] = React.useState<MemoryFactStatus>('current');
  const workspaces = useWorkspaces();
  const [target, setTarget] = React.useState<string | null>(null);

  const trimmed = project.trim();
  const facts = useMemoryFacts({ project: trimmed.length === 0 ? null : trimmed, status });
  const chosenTarget = target ?? workspaces.data?.[0]?.id ?? null;

  return (
    <AppPage maxWidth="max-w-3xl">
      <div>
        <h1 className="exocortex-page-title">Gedächtnis</h1>
        <p className="mt-1 max-w-measure text-sm text-muted-foreground">
          Was die Agenten aus ihren Sitzungsnotizen destilliert haben. Jeder Satz ist eine eigene
          Seite im Memory-Arbeitsbereich.
        </p>
      </div>

      <div className="mt-6 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="memory-project">Projekt</Label>
          <Input
            id="memory-project"
            value={project}
            placeholder="alle"
            className="w-56"
            data-testid="memory-project"
            onChange={(event) => setProject(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="memory-status">Zustand</Label>
          <Select value={status} onValueChange={(next) => setStatus(next as MemoryFactStatus)}>
            <SelectTrigger id="memory-status" className="w-44" data-testid="memory-status">
              <SelectValue>{() => STATUS_LABELS[status]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {STATUS_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="memory-target">Übernehmen nach</Label>
          <Select value={chosenTarget ?? ''} onValueChange={setTarget}>
            <SelectTrigger id="memory-target" className="w-56" data-testid="memory-target">
              <SelectValue>
                {() =>
                  workspaces.data?.find((workspace) => workspace.id === chosenTarget)?.name ??
                  'Arbeitsbereich wählen'
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(workspaces.data ?? []).map((workspace) => (
                <SelectItem key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-6">
        {facts.isPending ? (
          <LoadingState label="Fakten werden geladen …" />
        ) : (
          <FactList facts={facts.data?.facts ?? []} targetWorkspaceId={chosenTarget} />
        )}
      </div>

      {(facts.data?.omitted ?? 0) === 0 ? null : (
        <p className="mt-3 text-xs text-muted-foreground">
          {String(facts.data?.omitted)} weitere Fakten in diesem Projekt hat der Filter weggelassen.
        </p>
      )}
    </AppPage>
  );
}

function FactList({
  facts,
  targetWorkspaceId,
}: {
  facts: readonly MemoryFact[];
  targetWorkspaceId: string | null;
}) {
  if (facts.length === 0) {
    return (
      <EmptyState
        title="Keine Fakten"
        description="Die Verdichtung läuft nachts. Ohne Sitzungsnotizen gibt es nichts zu destillieren."
      />
    );
  }
  return (
    <ul className="flex flex-col gap-2" data-testid="memory-facts">
      {facts.map((fact) => (
        <FactRow key={fact.id} fact={fact} targetWorkspaceId={targetWorkspaceId} />
      ))}
    </ul>
  );
}

function FactRow({
  fact,
  targetWorkspaceId,
}: {
  fact: MemoryFact;
  targetWorkspaceId: string | null;
}) {
  const promote = usePromoteMemoryFact();

  return (
    <li
      className="flex flex-col gap-1 rounded-md border border-border p-2"
      data-testid="memory-fact"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/arbeitsbereich/${fact.workspaceId}/seite/${fact.documentId}`}
          className="text-sm font-medium underline-offset-2 hover:underline"
        >
          {fact.statement}
        </Link>
        <Badge variant={fact.status === 'conflicted' ? 'destructive' : 'secondary'}>
          {STATUS_LABELS[fact.status]}
        </Badge>
        <span className="text-xs text-muted-foreground">{fact.projectKey}</span>
      </div>

      {fact.detail.length === 0 ? null : (
        <p className="text-xs text-muted-foreground">{fact.detail}</p>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {fact.confirmations === 1
            ? '1 Bestätigung'
            : `${String(fact.confirmations)} Bestätigungen`}
        </span>
        <span>Gewicht {fact.confidence.toFixed(2)}</span>
        <span>zuletzt {formatMoment(fact.lastConfirmedAt)}</span>
        <span>
          {fact.sourceNoteIds.length === 1
            ? 'aus 1 Notiz'
            : `aus ${String(fact.sourceNoteIds.length)} Notizen`}
        </span>
        <div className="ms-auto flex items-center gap-2">
          {fact.promotedDocumentId === null ? (
            <Button
              variant="outline"
              size="sm"
              disabled={targetWorkspaceId === null || promote.isPending}
              data-testid="memory-fact-promote"
              onClick={() => {
                if (targetWorkspaceId === null) return;
                promote.mutate({
                  factId: fact.id,
                  request: { workspaceId: targetWorkspaceId, parentId: null },
                });
              }}
            >
              Übernehmen
            </Button>
          ) : (
            <Link
              href={`/arbeitsbereich/${targetWorkspaceId ?? fact.workspaceId}/seite/${fact.promotedDocumentId}`}
              className="underline"
              data-testid="memory-fact-promoted"
            >
              übernommen
            </Link>
          )}
        </div>
      </div>

      {promote.isError ? (
        <p role="alert" className="text-xs text-destructive-text">
          {promote.error.message}
        </p>
      ) : null}
    </li>
  );
}
