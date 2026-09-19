'use client';

import * as React from 'react';

import {
  DATABASE_ROLLUP_AGGREGATES,
  type DatabasePropertyType,
  type DatabaseRollupAggregate,
  type DocumentTreeNode,
  FORMULA_FUNCTIONS,
  parseFormulaConfig,
  parseRelationConfig,
  parseRollupConfig,
} from '@exocortex/contracts';
import {
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from '@exocortex/ui';

import { useDatabaseProperties } from '@/lib/api/database-queries';
import { useDocumentTree } from '@/lib/api/queries';

import { PROPERTY_TYPE_LABELS } from './property-types';

/**
 * The form behind RELATION, ROLLUP and FORMULA (issue #76).
 *
 * These three are the only property types whose whole meaning is in their
 * `config`, so there is no such thing as creating one and configuring it
 * afterwards: the API refuses a column it cannot compute. The same component
 * therefore appears twice -- inside "+ Eigenschaft" before the column exists,
 * and in the column menu to change it later.
 */

export const ROLLUP_AGGREGATE_LABELS: Record<DatabaseRollupAggregate, string> = {
  count: 'Anzahl verknüpfter Zeilen',
  count_unique: 'Anzahl verschiedener Werte',
  count_not_empty: 'Anzahl gefüllter Werte',
  sum: 'Summe',
  average: 'Durchschnitt',
  min: 'Kleinster Wert',
  max: 'Größter Wert',
  earliest: 'Frühestes Datum',
  latest: 'Spätestes Datum',
};

export type PropertyConfig = Record<string, unknown> | null;

interface EditorProps {
  /** The database the property belongs to. */
  documentId: string;
  workspaceId: string;
  type: DatabasePropertyType;
  config: PropertyConfig;
  onChange: (config: PropertyConfig) => void;
}

/** Whether a config is complete enough to send. The API checks it properly. */
export function isPropertyConfigComplete(
  type: DatabasePropertyType,
  config: PropertyConfig,
): boolean {
  if (type === 'RELATION') return parseRelationConfig(config) !== null;
  if (type === 'ROLLUP') {
    const parsed = parseRollupConfig(config);
    if (parsed === null) return false;
    return parsed.aggregate === 'count' || parsed.targetPropertyId !== null;
  }
  if (type === 'FORMULA') return parseFormulaConfig(config) !== null;
  return true;
}

export function PropertyConfigEditor(props: EditorProps) {
  if (props.type === 'RELATION') return <RelationConfigEditor {...props} />;
  if (props.type === 'ROLLUP') return <RollupConfigEditor {...props} />;
  if (props.type === 'FORMULA') return <FormulaConfigEditor {...props} />;
  return null;
}

// ---------------------------------------------------------------------------
// RELATION
// ---------------------------------------------------------------------------

function flattenCollections(nodes: readonly DocumentTreeNode[]): DocumentTreeNode[] {
  return nodes.flatMap((node) => [
    ...(node.type === 'COLLECTION' ? [node] : []),
    ...flattenCollections(node.children),
  ]);
}

function RelationConfigEditor({ documentId, workspaceId, config, onChange }: EditorProps) {
  const tree = useDocumentTree(workspaceId);
  const collections = flattenCollections(tree.data?.nodes ?? []);
  const current = parseRelationConfig(config);
  const targetCollectionId = current?.targetCollectionId ?? '';
  const allowMultiple = current?.allowMultiple ?? true;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label>Verknüpfte Datenbank</Label>
        <Select
          value={targetCollectionId}
          onValueChange={(next) => onChange({ targetCollectionId: String(next), allowMultiple })}
        >
          <SelectTrigger className="w-full" data-testid="relation-target-select">
            <SelectValue>
              {() =>
                collections.find((entry) => entry.id === targetCollectionId)?.title ??
                'Datenbank wählen'
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {collections.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.id === documentId ? `${entry.title} (diese)` : entry.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Nur Datenbanken aus diesem Arbeitsbereich. Dieselbe Datenbank ist erlaubt, etwa für
          Unteraufgaben.
        </p>
      </div>
      <label className="flex items-center justify-between gap-2 text-sm">
        Mehrere Zeilen erlauben
        <Switch
          checked={allowMultiple}
          onCheckedChange={(next) => onChange({ targetCollectionId, allowMultiple: next })}
        />
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ROLLUP
// ---------------------------------------------------------------------------

function RollupConfigEditor({ documentId, config, onChange }: EditorProps) {
  const own = useDatabaseProperties(documentId);
  const relations = (own.data ?? []).filter((property) => property.type === 'RELATION');
  const current = parseRollupConfig(config);
  const relationPropertyId = current?.relationPropertyId ?? '';
  const aggregate = current?.aggregate ?? 'count';

  const relation = relations.find((entry) => entry.id === relationPropertyId);
  const targetCollectionId = parseRelationConfig(relation?.config)?.targetCollectionId ?? undefined;
  const targets = useDatabaseProperties(targetCollectionId);
  // A rollup aggregates a plain column of the linked database. Another rollup
  // or formula is left out on purpose: see `assertRollupTargetIsUsable`.
  const targetChoices = (targets.data ?? []).filter(
    (property) =>
      property.type !== 'ROLLUP' && property.type !== 'FORMULA' && property.type !== 'RELATION',
  );
  const targetPropertyId = current?.targetPropertyId ?? null;

  const update = (
    patch: Partial<{
      relationPropertyId: string;
      targetPropertyId: string | null;
      aggregate: DatabaseRollupAggregate;
    }>,
  ): void => onChange({ relationPropertyId, targetPropertyId, aggregate, ...patch });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label>Verknüpfung</Label>
        <Select
          value={relationPropertyId}
          onValueChange={(next) =>
            update({ relationPropertyId: String(next), targetPropertyId: null })
          }
        >
          <SelectTrigger className="w-full" data-testid="rollup-relation-select">
            <SelectValue>
              {() =>
                relations.find((entry) => entry.id === relationPropertyId)?.name ?? 'Spalte wählen'
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {relations.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {relations.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Diese Datenbank hat noch keine Verknüpfungsspalte. Lege zuerst eine an.
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Berechnung</Label>
        <Select
          value={aggregate}
          onValueChange={(next) => update({ aggregate: next as DatabaseRollupAggregate })}
        >
          <SelectTrigger className="w-full" data-testid="rollup-aggregate-select">
            <SelectValue>{() => ROLLUP_AGGREGATE_LABELS[aggregate]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {DATABASE_ROLLUP_AGGREGATES.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {ROLLUP_AGGREGATE_LABELS[entry]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {aggregate === 'count' ? null : (
        <div className="flex flex-col gap-1.5">
          <Label>Spalte in der verknüpften Datenbank</Label>
          <Select
            value={targetPropertyId ?? ''}
            onValueChange={(next) => update({ targetPropertyId: String(next) })}
          >
            <SelectTrigger className="w-full" data-testid="rollup-target-select">
              <SelectValue>
                {() => {
                  const chosen = targetChoices.find((entry) => entry.id === targetPropertyId);
                  return chosen === undefined
                    ? 'Spalte wählen'
                    : `${chosen.name} (${PROPERTY_TYPE_LABELS[chosen.type]})`;
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {targetChoices.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.name} ({PROPERTY_TYPE_LABELS[entry.type]})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FORMULA
// ---------------------------------------------------------------------------

function FormulaConfigEditor({ documentId, config, onChange }: EditorProps) {
  const own = useDatabaseProperties(documentId);
  const expression = parseFormulaConfig(config)?.expression ?? '';

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="formula-expression">Formel</Label>
      <Textarea
        id="formula-expression"
        rows={3}
        className="font-mono text-xs"
        placeholder={'prop("Preis") * prop("Menge")'}
        value={expression}
        onChange={(event) => onChange({ expression: event.target.value })}
        data-testid="formula-expression"
      />
      <p className="text-xs text-muted-foreground">
        Spalten schreibst du als <code>prop(&quot;Name&quot;)</code>. Rechnen mit + - * / %,
        vergleichen mit == != &lt; &gt;, verknüpfen mit and / or.
      </p>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Spalten und Funktionen</summary>
        <p className="mt-1 break-words">
          {(own.data ?? []).map((property) => `prop("${property.name}")`).join(' · ')}
        </p>
        <p className="mt-1 break-words">
          {Object.values(FORMULA_FUNCTIONS)
            .map((spec) => spec.hint)
            .join(' · ')}
        </p>
      </details>
    </div>
  );
}
