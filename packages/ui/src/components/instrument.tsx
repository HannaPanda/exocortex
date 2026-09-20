import * as React from 'react';

import { cn } from '../lib/utils';

/**
 * The instrument vocabulary: the two marks that give a screen its structure
 * without enclosing anything in a box.
 *
 * Both are drawn in `--signal-line`, the structural step of the amber scale.
 * That colour exists so the lines that describe a screen can be warm without
 * spending the signal: amber still means "interactive or happening", and a rule
 * is neither. The difference between the two marks is mass, not colour -- a
 * solid square against a hairline -- which is what keeps them legible as
 * different things while sharing one hue.
 */

/**
 * The typography of the mark, on its own.
 *
 * `SectionRule` is the whole device -- square, label, hairline -- and most
 * places want the whole device. Two do not: the disclosure that opens the
 * technical properties is a *control* rather than a section announcement, and
 * the day headings inside the activity list are markers inside a section rather
 * than sections of their own. Both still have to look like the same family, and
 * both used to say so by copying these four utilities, which is how one of them
 * ended up at `0.12em` while the component was at `0.14em`. One definition, so
 * a change to the mark reaches everything wearing it.
 */
export const sectionLabelClassName =
  'text-micro font-medium tracking-[0.14em] text-muted-foreground uppercase';

/**
 * A hairline rule with a small label riding on it, opened by a square mark.
 *
 * The instrument-panel alternative to a card header: it separates without
 * enclosing. It is deliberately the same at every scale in the product, so the
 * workspace overview, the backlinks panel and the properties panel all announce
 * a section the same way and the reader learns the mark once.
 *
 * `trailing` is for a count or another short readout that belongs to the
 * section rather than to a row inside it; it sits after the rule, at the right
 * edge, where the eye ends up anyway. `action` is the same position for
 * something you can press, and it is a separate slot because a count is set in
 * the numeric face and a control must not be.
 */
export function SectionRule({
  children,
  trailing,
  action,
  className,
  as: Heading = 'h2',
  ...props
}: React.ComponentPropsWithoutRef<'div'> & {
  trailing?: React.ReactNode;
  action?: React.ReactNode;
  /** Heading level, so the rule fits the document outline it appears in. */
  as?: 'h2' | 'h3';
}) {
  return (
    <div className={cn('flex items-center gap-2.5', className)} {...props}>
      <span className="size-1 shrink-0 bg-signal-line" aria-hidden />
      <Heading className={cn('min-w-0 truncate', sectionLabelClassName)}>{children}</Heading>
      {/* Short and fixed, not a full-width divider. A rule that crosses the
          whole column competes with the leaders in the rows underneath, and two
          systems of horizontal line on one screen read as stripes. This is a
          scale mark that ends: it labels a section without cutting the page. */}
      <span className="h-px w-6 shrink-0 bg-signal-line" aria-hidden />
      {trailing === undefined ? null : (
        <span className="exocortex-numeric shrink-0 text-micro text-muted-foreground">
          {trailing}
        </span>
      )}
      {action === undefined ? null : <span className="shrink-0">{action}</span>}
    </div>
  );
}

/**
 * The dotted leader that carries the eye from a label across to its value.
 *
 * A two-column list of a name and a number fails at exactly the width where it
 * becomes useful: the further apart the two are, the harder it is to be sure
 * which number belongs to which name. A table of contents solved this a long
 * time ago, and the solution is a row of dots.
 *
 * Expects to sit between two items in a `flex items-baseline` row: the offset
 * lifts the rule off the baseline to where a leader belongs, under the
 * x-height rather than through it.
 */
export function Leader({ className, ...props }: React.ComponentPropsWithoutRef<'span'>) {
  return (
    <span
      aria-hidden
      className={cn(
        // Dotted, not dashed, and held back to 70%: a dash long enough to be
        // read as a dash stops leading the eye and starts being a rule. At six
        // rows on one screen that is the difference between a table of contents
        // and a striped page.
        'min-w-4 flex-1 translate-y-[-0.25em] border-b border-dotted border-signal-line/70',
        className,
      )}
      {...props}
    />
  );
}

/**
 * A label carried across to its value, with an optional line of context under
 * it. The row `Leader` was drawn for, given a name.
 *
 * This is what the product uses instead of a metric tile. A grid of identical
 * boxes, each with a caption and a big number, is the shape `PRODUCT.md` rules
 * out by name, and it carries no ranking: "Nutzer" and "KI-Kosten (24 h)" are
 * not equally important and a grid draws them identically. A list of readouts
 * under a `SectionRule` says which group a figure belongs to, and the order
 * inside the group says which one is read first.
 *
 * `tone="live"` marks the figures that are about what just happened rather than
 * what is stored, which is the one place on such a screen where amber means
 * what it means everywhere else: something is happening here.
 */
export function Readout({
  label,
  value,
  note,
  tone = 'default',
  className,
  ...props
}: Omit<React.ComponentPropsWithoutRef<'div'>, 'children'> & {
  label: React.ReactNode;
  value: React.ReactNode;
  note?: React.ReactNode;
  tone?: 'default' | 'live';
}) {
  return (
    <div className={cn('flex flex-col', className)} {...props}>
      <span className="flex items-baseline gap-2">
        <span className="truncate text-sm">{label}</span>
        <Leader />
        <span
          className={cn(
            'exocortex-numeric shrink-0 text-sm font-medium',
            tone === 'live' ? 'text-primary-text' : 'text-foreground',
          )}
        >
          {value}
        </span>
      </span>
      {note === undefined ? null : (
        <span className="mt-0.5 text-meta text-muted-foreground">{note}</span>
      )}
    </div>
  );
}
