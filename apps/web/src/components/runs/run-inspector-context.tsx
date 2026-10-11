'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { type AiRunInspection } from '@exocortex/contracts';
import { Badge, Readout, SectionRule } from '@exocortex/ui';

import { type RunFormat } from './run-inspector-format';

type Context = NonNullable<AiRunInspection['context']>;
type Section = Context['sections'][number];
type Source = Section['sources'][number];

function SourceLine({
  source,
  workspaceId,
  format,
}: {
  source: Source;
  workspaceId: string;
  format: RunFormat;
}) {
  const t = useTranslations('runInspector.context');
  const tOrigin = useTranslations('runInspector.origins');
  const name =
    source.title === null ? (
      <span className="text-muted-foreground italic">{t('unnamedSource')}</span>
    ) : source.documentId !== null && source.savedQueryId === null ? (
      <Link
        href={`/arbeitsbereich/${workspaceId}/seite/${source.documentId}`}
        className="hover:underline"
      >
        {source.title}
      </Link>
    ) : (
      <span>{source.title}</span>
    );
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-meta">
      {name}
      <span className="exocortex-numeric text-muted-foreground">
        {source.fullChars !== null && source.fullChars > source.chars
          ? t('sourceCharsOf', {
              chars: format.count(source.chars),
              full: format.count(source.fullChars),
            })
          : t('sourceChars', { chars: format.count(source.chars) })}
      </span>
      {source.mode === null ? null : <Badge variant="muted">{t(`modes.${source.mode}`)}</Badge>}
      {source.truncated ? <Badge variant="outline">{t('truncated')}</Badge> : null}
      {source.origin === 'internal' ? null : (
        <Badge variant="outline">{tOrigin(source.origin)}</Badge>
      )}
    </li>
  );
}

function SectionRow({
  section,
  largest,
  workspaceId,
  format,
}: {
  section: Section;
  largest: number;
  workspaceId: string;
  format: RunFormat;
}) {
  const t = useTranslations('runInspector.context');
  const share = largest === 0 ? 0 : Math.max(2, Math.round((section.chars / largest) * 100));
  const note = [
    ...(section.items === null ? [] : [t('items', { count: section.items })]),
    ...(section.truncated ? [t('truncated')] : []),
  ].join(' · ');
  return (
    <li className="flex flex-col gap-1" data-testid={`run-context-${section.key}`}>
      <Readout
        label={t(`sections.${section.key}`)}
        value={t('sectionValue', {
          chars: format.count(section.chars),
          tokens: format.count(section.estimatedTokens),
        })}
        note={note.length === 0 ? undefined : note}
      />
      {/* The bar says which part weighs most; the number beside the label is the measurement. */}
      <span className="h-0.5 w-full bg-muted" aria-hidden>
        <span className="block h-full bg-signal-line" style={{ width: `${String(share)}%` }} />
      </span>
      {section.sources.length === 0 ? null : (
        <ul className="flex flex-col gap-0.5 pl-3">
          {section.sources.map((source, index) => (
            <SourceLine
              key={`${source.documentId ?? source.savedQueryId ?? 'source'}-${String(index)}`}
              source={source}
              workspaceId={workspaceId}
              format={format}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** What the prompt was built from before the first turn, part by part (issue #145). */
export function ContextComposition({
  inspection,
  format,
}: {
  inspection: AiRunInspection;
  format: RunFormat;
}) {
  const t = useTranslations('runInspector.context');
  const context = inspection.context;
  const largest = Math.max(0, ...(context?.sections.map((section) => section.chars) ?? []));
  return (
    <section className="flex flex-col gap-3" data-testid="run-context">
      <SectionRule
        trailing={
          context === null
            ? undefined
            : t('total', {
                chars: format.count(context.chars),
                tokens: format.count(context.estimatedTokens),
              })
        }
      >
        {t('heading')}
      </SectionRule>
      {context === null ? (
        <p className="text-sm text-muted-foreground">{t('none')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {context.sections.map((section) => (
            <SectionRow
              key={section.key}
              section={section}
              largest={largest}
              workspaceId={inspection.run.workspaceId}
              format={format}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** What tool answers added to the context while the run went on, by where the text came from. */
export function ToolResults({
  inspection,
  format,
}: {
  inspection: AiRunInspection;
  format: RunFormat;
}) {
  const t = useTranslations('runInspector.toolResults');
  const tOrigin = useTranslations('runInspector.origins');
  if (inspection.toolResults.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <SectionRule>{t('heading')}</SectionRule>
      <div className="flex flex-col gap-1.5">
        {inspection.toolResults.map((entry) => (
          <Readout
            key={entry.origin}
            label={tOrigin(entry.origin)}
            value={t('row', { calls: entry.calls, chars: format.count(entry.chars) })}
          />
        ))}
      </div>
    </section>
  );
}
