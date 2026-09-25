'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  DATABASE_ROLLUP_AGGREGATES,
  type DatabasePropertyType,
  type DatabaseRollupAggregate,
  type DocumentTreeNode,
  FORMULA_FUNCTIONS,
  FormulaError,
  parseFormula,
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
import { useDocumentTree } from '@/lib/api/document-queries';

import { apiFormulaError, useFormulaErrorMessage, useFormulaFunctionHint } from './formula-error';
import { usePropertyTypeLabel } from './property-types';

/**
 * The form behind RELATION, ROLLUP and FORMULA (issue #76).
 *
 * These three are the only property types whose whole meaning is in their
 * `config`, so there is no such thing as creating one and configuring it
 * afterwards: the API refuses a column it cannot compute. The same component
 * therefore appears twice -- inside "+ Eigenschaft" before the column exists,
 * and in the column menu to change it later.
 */

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

/**
 * Why the API refused a configuration. A formula or rollup problem is
 * rendered from its code (issue #98); anything else reads as its error code.
 */
export function PropertyConfigErrorMessage({ error }: { error: Error | null }) {
  const formulaErrorMessage = useFormulaErrorMessage();
  if (error === null) return null;
  const formula = apiFormulaError(error);
  return (
    <p role="alert" className="text-xs text-destructive-text" data-testid="property-config-error">
      {formula === null ? error.message : formulaErrorMessage(formula, formula.propertyName)}
    </p>
  );
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
  const t = useTranslations('database.config.relation');

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label>{t('target')}</Label>
        <Select
          value={targetCollectionId}
          onValueChange={(next) => onChange({ targetCollectionId: String(next), allowMultiple })}
        >
          <SelectTrigger className="w-full" data-testid="relation-target-select">
            <SelectValue>
              {() =>
                collections.find((entry) => entry.id === targetCollectionId)?.title ??
                t('chooseDatabase')
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {collections.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.id === documentId ? t('thisDatabase', { title: entry.title }) : entry.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t('hint')}</p>
      </div>
      <label className="flex items-center justify-between gap-2 text-sm">
        {t('allowMultiple')}
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
  const t = useTranslations('database.config.rollup');
  const typeLabel = usePropertyTypeLabel();
  const columnWithType = (property: { name: string; type: DatabasePropertyType }): string =>
    t('columnWithType', { name: property.name, type: typeLabel(property.type) });

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
        <Label>{t('relation')}</Label>
        <Select
          value={relationPropertyId}
          onValueChange={(next) =>
            update({ relationPropertyId: String(next), targetPropertyId: null })
          }
        >
          <SelectTrigger className="w-full" data-testid="rollup-relation-select">
            <SelectValue>
              {() =>
                relations.find((entry) => entry.id === relationPropertyId)?.name ??
                t('chooseColumn')
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
          <p className="text-xs text-muted-foreground">{t('noRelation')}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>{t('aggregate')}</Label>
        <Select
          value={aggregate}
          onValueChange={(next) => update({ aggregate: next as DatabaseRollupAggregate })}
        >
          <SelectTrigger className="w-full" data-testid="rollup-aggregate-select">
            <SelectValue>{() => t(`aggregates.${aggregate}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {DATABASE_ROLLUP_AGGREGATES.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {t(`aggregates.${entry}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {aggregate === 'count' ? null : (
        <div className="flex flex-col gap-1.5">
          <Label>{t('target')}</Label>
          <Select
            value={targetPropertyId ?? ''}
            onValueChange={(next) => update({ targetPropertyId: String(next) })}
          >
            <SelectTrigger className="w-full" data-testid="rollup-target-select">
              <SelectValue>
                {() => {
                  const chosen = targetChoices.find((entry) => entry.id === targetPropertyId);
                  return chosen === undefined ? t('chooseColumn') : columnWithType(chosen);
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {targetChoices.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {columnWithType(entry)}
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
  const t = useTranslations('database.config.formula');
  const functionHint = useFormulaFunctionHint();
  const formulaErrorMessage = useFormulaErrorMessage();
  // Only the syntax is checked here: whether a column exists and what type it
  // has is the API's answer on save, because only the API sees the whole
  // schema. A formula that does not even parse is told while it is typed.
  const syntaxError = React.useMemo(() => {
    if (expression.trim().length === 0) return null;
    try {
      parseFormula(expression);
      return null;
    } catch (error) {
      if (error instanceof FormulaError) return error.detail;
      throw error;
    }
  }, [expression]);

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="formula-expression">{t('label')}</Label>
      <Textarea
        id="formula-expression"
        rows={3}
        className="font-mono text-xs"
        placeholder={t('placeholder')}
        value={expression}
        onChange={(event) => onChange({ expression: event.target.value })}
        data-testid="formula-expression"
        aria-invalid={syntaxError !== null}
        aria-describedby={syntaxError !== null ? 'formula-expression-error' : undefined}
      />
      {syntaxError !== null ? (
        <p id="formula-expression-error" className="text-xs text-destructive-text">
          {formulaErrorMessage(syntaxError)}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {/* The operators are the formula language itself, the same in every
            locale, so they are arguments rather than part of the sentence. */}
        {t.rich('help', {
          code: (chunks) => <code>{chunks}</code>,
          arithmetic: '+ - * / %',
          comparison: '== != < >',
          logical: 'and / or',
        })}
      </p>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">{t('reference')}</summary>
        <p className="mt-1 break-words">
          {(own.data ?? []).map((property) => `prop("${property.name}")`).join(' · ')}
        </p>
        <p className="mt-1 break-words">
          {Object.keys(FORMULA_FUNCTIONS).map(functionHint).join(' · ')}
        </p>
      </details>
    </div>
  );
}
