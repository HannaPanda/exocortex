import * as React from 'react';

import { cn, SectionRule } from '@exocortex/ui';

/**
 * The frames the styleguide puts around real components.
 *
 * These are the only things on `/design-system` that are not product code, and
 * they are allowed to exist because they show a component rather than imitate
 * one (issue #125): a section with a heading, an example with a name, a row of
 * states. Nothing inside a frame is styled by the frame.
 */

export function DsSection({
  id,
  title,
  lead,
  children,
}: {
  id: string;
  title: string;
  lead?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="scroll-mt-6 border-t border-border pt-10"
    >
      <h2 id={`${id}-title`} className="text-section">
        <a href={`#${id}`} className="hover:underline">
          {title}
        </a>
      </h2>
      {lead === undefined ? null : (
        <p className="mt-2 max-w-measure text-sm text-muted-foreground">{lead}</p>
      )}
      <div className="mt-8 flex flex-col gap-10">{children}</div>
    </section>
  );
}

/** Where the canonical implementation lives, as the repository spells it. */
export function DsSource({ path }: { path: string }) {
  return (
    <code className="exocortex-numeric rounded-sm bg-sunken px-1.5 py-0.5 text-meta break-words text-muted-foreground">
      {path}
    </code>
  );
}

export function DsExample({
  id,
  title,
  source,
  note,
  stageClassName,
  children,
}: {
  id?: string;
  title: string;
  source?: string;
  note?: React.ReactNode;
  stageClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <div id={id} className="flex scroll-mt-6 flex-col gap-3">
      <SectionRule as="h3">{title}</SectionRule>
      {note === undefined && source === undefined ? null : (
        <div className="flex max-w-measure flex-col gap-1.5 text-sm text-muted-foreground">
          {note === undefined ? null : <p>{note}</p>}
          {source === undefined ? null : (
            <p>
              <DsSource path={source} />
            </p>
          )}
        </div>
      )}
      {/* The stage is the page surface, because that is where almost every
          component in the product sits. A component that belongs elsewhere
          says so with `stageClassName`. */}
      <div
        className={cn('rounded-lg border border-border bg-background p-4 sm:p-6', stageClassName)}
      >
        {children}
      </div>
    </div>
  );
}

/** One labelled cell in a row of states: the label says which state is shown. */
export function DsState({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <span className="text-meta text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

export function DsStates({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-start gap-x-8 gap-y-6', className)}>{children}</div>
  );
}
