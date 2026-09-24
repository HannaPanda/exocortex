import * as React from 'react';

import { Badge, cn, SectionRule } from '@exocortex/ui';

import { DsSource } from '../showcase';

/**
 * The frames an experiment is drawn in (issue #126).
 *
 * Every experiment says the same six things in the same places: the problem,
 * the width it is judged at, how to operate it by keyboard, where the product's
 * own component lives, and per variant a name and its trade-offs. The frame
 * draws them so an experiment cannot leave one out, and draws the stage with a
 * dashed rule, the one visual difference from a canonical example.
 */

export const NOT_CANONICAL = 'experimentell, nicht kanonisch';

export function DsExperimentBrief({
  problem,
  width,
  keyboard,
  sources,
}: {
  problem: React.ReactNode;
  width: string;
  keyboard?: string;
  sources: readonly string[];
}) {
  return (
    <div className="flex max-w-measure flex-col gap-3 text-sm">
      <div>
        <Badge variant="outline">{NOT_CANONICAL}</Badge>
      </div>
      <p>{problem}</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-muted-foreground">
        <dt>Zielbreite</dt>
        <dd>{width}</dd>
        {keyboard === undefined ? null : (
          <>
            <dt>Tastatur</dt>
            <dd>{keyboard}</dd>
          </>
        )}
        <dt>Quelle</dt>
        <dd className="flex min-w-0 flex-wrap gap-1.5">
          {sources.map((source) => (
            <span key={source} className="max-w-full min-w-0">
              <DsSource path={source} />
            </span>
          ))}
        </dd>
      </dl>
    </div>
  );
}

export function DsVariant({
  name,
  tradeoffs,
  stageClassName,
  children,
}: {
  name: string;
  tradeoffs: readonly string[];
  stageClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3" data-ds-variant={name}>
      <SectionRule as="h3">{name}</SectionRule>
      <div
        className={cn(
          'min-w-0 rounded-lg border border-dashed border-border-strong bg-background p-4 sm:p-6',
          stageClassName,
        )}
      >
        {children}
      </div>
      <ul className="flex max-w-measure list-disc flex-col gap-1 pl-5 text-meta text-muted-foreground">
        {tradeoffs.map((tradeoff) => (
          <li key={tradeoff}>{tradeoff}</li>
        ))}
      </ul>
    </div>
  );
}

/** Two or three variants side by side where there is room, stacked where there is not. */
export function DsVariants({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={cn('grid gap-8', wide === true ? 'xl:grid-cols-2' : 'lg:grid-cols-2')}>
      {children}
    </div>
  );
}

/**
 * A variant at a real phone width. The product's components switch at the
 * window's breakpoints, not the box's, so a 390 px box on a desktop would show
 * the desktop layout squeezed. An iframe has a window of its own; the page in
 * it is `/design-system/rahmen/<probe>` and shows the probe and nothing else.
 */
export function DsNarrowFrame({
  probe,
  title,
  height = 560,
}: {
  probe: string;
  title: string;
  height?: number;
}) {
  return (
    <iframe
      src={`/design-system/rahmen/${probe}`}
      title={title}
      loading="lazy"
      data-testid={`ds-frame-${probe}`}
      className="w-[390px] max-w-full rounded-md border border-border bg-background"
      style={{ height }}
    />
  );
}
