'use client';

import Link from 'next/link';
import * as React from 'react';

import { Badge, LoadingState } from '@exocortex/ui';

import { AI_RULE_MODE_LABELS } from '@/components/document/page-properties-dialog';
import { useAiRules } from '@/lib/api/ai-queries';

/**
 * Which pages of this workspace the assistant treats as rules (D5).
 *
 * A rule is set one page at a time, in that page's properties, which is the
 * right place to set it and the wrong place to find it again: the whole
 * question here is "what is the assistant being told, and by which pages" --
 * and that question had no answer in the browser at all, while `exo_rules_list`
 * had answered it for agents since the catalogue was written (ADR-025).
 *
 * Read-only on purpose. Switching a rule off belongs to the page, next to the
 * text the rule is made of; a list that could quietly disarm one from a
 * distance is how you end up wondering why the assistant changed its mind.
 */
export function AiRulesPanel({ workspaceId }: { workspaceId: string }) {
  const rules = useAiRules(workspaceId);

  if (rules.data === undefined) return <LoadingState label="Regeln werden geladen …" />;

  if (rules.data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Keine Seite ist als Regel markiert. Das geht in den Eigenschaften einer Seite, unter
        „KI-Regel“.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1" data-testid="ai-rules">
      {rules.data.map((rule) => (
        <li
          key={rule.documentId}
          className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2"
          data-testid="ai-rule-entry"
        >
          <Link
            href={`/arbeitsbereich/${workspaceId}/seite/${rule.documentId}`}
            className="text-sm underline-offset-2 hover:underline"
          >
            {rule.title}
          </Link>
          <Badge variant={rule.mode === 'always' ? 'default' : 'secondary'}>
            {AI_RULE_MODE_LABELS[rule.mode]}
          </Badge>
          {rule.trigger === null ? null : (
            <span className="text-xs text-muted-foreground">Auslöser: {rule.trigger}</span>
          )}
          <span className="ms-auto text-xs text-muted-foreground">
            Rang {String(rule.priority)}
          </span>
        </li>
      ))}
    </ul>
  );
}
