'use client';

import { Toolbar as ToolbarPrimitive } from '@base-ui/react/toolbar';
import * as React from 'react';

import { cn } from '../../lib/utils';

/**
 * Re-registers the toolbar's items once the toolbar is actually in the document.
 *
 * Base UI builds the roving tabindex from the items' document order and skips
 * every registration whose node is not connected (`isConnected`) — reasonably,
 * because a detached node has no position to sort by. Tiptap's `BubbleMenu`
 * portals its children into a `document.createElement('div')` and only appends
 * that div when its ProseMirror plugin view is created, which is one effect
 * *after* the children have mounted and the composite has already flushed. The
 * result is a toolbar where no item ever gets an index: every control reports
 * `tabindex="-1"`, so `role="toolbar"` promises one Tab stop and delivers none.
 *
 * Remounting the children once the root is connected is enough, because that
 * re-runs the item ref callbacks and the composite flushes again, now with
 * nodes it will not skip. A toolbar that is already in the document when it
 * mounts — every other one in the application — never enters the wait and
 * never remounts.
 *
 * The wait has no deadline, and that is the point (issue #89). `BubbleMenu`
 * appends its div in `show()`, so a selection toolbar stays detached from the
 * moment the editor mounts until the reader first selects text — seconds, or
 * the whole session. A budget of a few frames expires long before that and
 * leaves the bar permanently without a Tab stop, which is a state nothing
 * afterwards corrects: the composite only re-sorts when an item registers or
 * unregisters, and appending the div does neither. A `MutationObserver` costs
 * nothing while nothing moves and stops itself the moment the node lands.
 */
function useConnectedRemountKey(ref: React.RefObject<HTMLDivElement | null>): number {
  const [key, setKey] = React.useState(0);

  React.useEffect(() => {
    const node = ref.current;
    if (node === null || node.isConnected) return undefined;

    // Watching the whole document is what it takes: the node is detached, so it
    // has no ancestor to watch, and only its future parent sees the insertion.
    // Each callback is one `isConnected` read.
    const observer = new MutationObserver(() => {
      if (!node.isConnected) return;
      observer.disconnect();
      setKey((previous) => previous + 1);
    });
    observer.observe(node.ownerDocument, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [ref]);

  return key;
}

/**
 * Floating toolbar surface.
 *
 * Custom primitive: the shadcn registry has no toolbar, but Base UI does, and a
 * formatting bar genuinely needs `role="toolbar"` with a roving tabindex — one
 * Tab stop for the whole bar, arrow keys between the controls. Rebuilding that
 * by hand is exactly the kind of accessibility behaviour docs/ui-system.md says
 * to take from the primitive.
 *
 * Used by the editor selection toolbar and the block action bar.
 */
function Toolbar({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ToolbarPrimitive.Root>) {
  const ref = React.useRef<HTMLDivElement>(null);
  const remountKey = useConnectedRemountKey(ref);

  return (
    <ToolbarPrimitive.Root
      ref={ref}
      data-slot="toolbar"
      className={cn(
        'flex items-center gap-0.5 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md',
        className,
      )}
      {...props}
    >
      <React.Fragment key={remountKey}>{children}</React.Fragment>
    </ToolbarPrimitive.Root>
  );
}

const ToolbarGroup = ToolbarPrimitive.Group;
const ToolbarButton = ToolbarPrimitive.Button;

function ToolbarSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ToolbarPrimitive.Separator>) {
  return (
    <ToolbarPrimitive.Separator
      data-slot="toolbar-separator"
      className={cn('mx-1 h-5 w-px shrink-0 bg-border', className)}
      {...props}
    />
  );
}

export { Toolbar, ToolbarButton, ToolbarGroup, ToolbarSeparator };
