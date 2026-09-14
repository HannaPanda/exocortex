'use client';

import * as React from 'react';

import { ENTITY_TYPE_LABELS, type EntityCandidate, type EntityType } from '@exocortex/contracts';
import {
  Button,
  EmptyState,
  LoadingState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import {
  useConfirmEntityCandidate,
  useDismissEntityCandidate,
  useEntityCandidates,
} from '@/lib/api/entity-queries';

/**
 * Names that keep turning up and that no entity answers to yet (issue #47).
 *
 * This is the half of the entity layer that had no screen at all and needed one
 * most: the extraction pass proposes phrases on its own, so the list fills up
 * whether or not anybody looks, and every proposal sat there waiting for
 * somebody to call `exo_entity_candidate_confirm` by hand.
 *
 * Two answers, both one click: it is a thing (pick what kind), or it is not
 * (dismissed, and the pass stops offering it). The samples are there so the
 * judgement can be made without opening anything.
 */
export function EntityCandidates() {
  const candidates = useEntityCandidates();
  if (candidates.isPending) return <LoadingState label="Vorschläge werden geladen …" />;

  const rows = candidates.data?.candidates ?? [];
  if (rows.length === 0) {
    return (
      <EmptyState
        title="Keine Vorschläge"
        description={`Namen erscheinen hier, sobald sie auf mindestens ${String(
          candidates.data?.threshold ?? 3,
        )} Seiten vorkommen.`}
      />
    );
  }

  return (
    <ul className="flex flex-col gap-2" data-testid="entity-candidates">
      {rows.map((candidate) => (
        <CandidateRow key={candidate.id} candidate={candidate} />
      ))}
    </ul>
  );
}

function CandidateRow({ candidate }: { candidate: EntityCandidate }) {
  const confirm = useConfirmEntityCandidate();
  const dismiss = useDismissEntityCandidate();
  const [type, setType] = React.useState<EntityType>('other');

  const busy = confirm.isPending || dismiss.isPending;

  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-border p-2"
      data-testid="entity-candidate"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{candidate.phrase}</span>
        <span className="text-xs text-muted-foreground">
          {candidate.documentCount === 1
            ? 'auf 1 Seite'
            : `auf ${String(candidate.documentCount)} Seiten`}
          {candidate.occurrences > candidate.documentCount
            ? ` · ${String(candidate.occurrences)}× genannt`
            : ''}
        </span>
        <div className="ms-auto flex items-center gap-2">
          <Select value={type} onValueChange={(next) => setType(next as EntityType)}>
            <SelectTrigger className="w-36" data-testid="entity-candidate-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(ENTITY_TYPE_LABELS) as EntityType[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {ENTITY_TYPE_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            disabled={busy}
            data-testid="entity-candidate-confirm"
            onClick={() =>
              confirm.mutate({ candidateId: candidate.id, request: { type, aliases: [] } })
            }
          >
            Anlegen
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            data-testid="entity-candidate-dismiss"
            onClick={() => dismiss.mutate(candidate.id)}
          >
            Verwerfen
          </Button>
        </div>
      </div>

      <ul className="flex flex-col gap-0.5">
        {candidate.samples.slice(0, 3).map((sample) => (
          <li key={sample.documentId} className="truncate text-xs text-muted-foreground">
            {sample.title}: {sample.context}
          </li>
        ))}
      </ul>

      {confirm.isError ? (
        <p className="text-xs text-destructive-text">{confirm.error.message}</p>
      ) : null}
    </li>
  );
}
