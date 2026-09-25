'use client';

import { type HocuspocusProvider } from '@hocuspocus/provider';
import { Extension } from '@tiptap/core';
import { isChangeOrigin } from '@tiptap/extension-collaboration';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { type Editor } from '@tiptap/react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { BLOCK_ID_ATTRIBUTE, isValidBlockId } from '@exocortex/editor';

import {
  type AgentEditState,
  blocksAtSelection,
  markerStates,
  readEditNotice,
} from '@/components/editor/agent-edit-state';

/**
 * Markers for changes that did not come from this editor (issue #112).
 *
 * When an agent -- or somebody using the API -- writes to a page, the
 * collaboration server tells every open editor which blocks changed and who
 * changed them. Without that, text moves under the reader with no explanation.
 * With it, the changed block carries a wash and a small label naming the
 * writer, for a few seconds, and then settles.
 *
 * Three states:
 *  * `changed`: the write landed and this block differs now.
 *  * `conflict`: the same, while the reader was typing inside that very block.
 *    Their text is safe -- Yjs merges both -- but a sentence may now read
 *    differently than they left it, and that is worth a stronger signal.
 *  * `failed`: the write aimed at this block was refused, so nothing changed
 *    here; said so that nobody takes the next change for this one.
 *
 * There is deliberately no "editing" state. An agent's write is one
 * transaction that lasts milliseconds; there is no stretch of time in which it
 * is "working on" a block that a marker could honestly describe. What a reader
 * can be told is what just happened, and by whom.
 *
 * Like the comment markers these are decorations, never marks: the document
 * does not know they exist, nothing is stored, a snapshot captures none of
 * them, and nothing is locked -- every block stays editable throughout.
 */

interface AgentEditMarker {
  state: AgentEditState;
  /** The whole label, already in the reader's language. */
  label: string;
  /** Set for the last beat, while the wash decays. */
  settling: boolean;
  /** Distinguishes two markers on one block, so the newer one is redrawn. */
  serial: number;
}

type AgentEditMarkers = ReadonlyMap<string, AgentEditMarker>;

const agentEditKey = new PluginKey<AgentEditMarkers>('exocortexAgentEdits');

/** How long a marker stands before it starts to settle, per state. */
const HOLD_MS: Readonly<Record<AgentEditState, number>> = {
  changed: 6000,
  failed: 8000,
  conflict: 10_000,
};

/** The decay, matching `--duration-settle` in `packages/ui/src/tokens.css`. */
const SETTLE_MS = 480;

/**
 * How recently the reader must have typed for a change in the block under
 * their cursor to count as a conflict. A cursor resting in a paragraph while
 * its owner reads elsewhere is not somebody working there.
 */
const TYPING_WINDOW_MS = 5000;

/** The label, drawn as plain DOM because ProseMirror renders widgets, not React. */
function renderLabel(marker: AgentEditMarker): HTMLElement {
  const label = document.createElement('span');
  label.className = 'exocortex-agent-edit-label';
  label.contentEditable = 'false';
  label.textContent = marker.label;
  return label;
}

/** The ProseMirror half: draws whatever markers it is handed, nothing else. */
export function createAgentEditMarkers(): Extension {
  return Extension.create({
    name: 'exocortexAgentEdits',

    addProseMirrorPlugins() {
      return [
        new Plugin<AgentEditMarkers>({
          key: agentEditKey,
          state: {
            init: () => new Map<string, AgentEditMarker>(),
            apply: (transaction, value) =>
              (transaction.getMeta(agentEditKey) as AgentEditMarkers | undefined) ?? value,
          },
          props: {
            decorations(state) {
              const markers = agentEditKey.getState(state);
              if (markers === undefined || markers.size === 0) return DecorationSet.empty;

              const decorations: Decoration[] = [];
              state.doc.descendants((node, position) => {
                const id: unknown = node.attrs[BLOCK_ID_ATTRIBUTE];
                const marker = isValidBlockId(id) ? markers.get(id) : undefined;
                if (marker === undefined) return true;
                decorations.push(
                  Decoration.node(position, position + node.nodeSize, {
                    class: marker.settling
                      ? 'exocortex-agent-edit exocortex-agent-edit-settling'
                      : 'exocortex-agent-edit',
                    'data-agent-edit': marker.state,
                    // A leaf (an image, a divider) has no inside to hold the
                    // label, so it carries the words as a tooltip instead.
                    title: marker.label,
                  }),
                );
                if (!node.isLeaf) {
                  decorations.push(
                    Decoration.widget(position + 1, () => renderLabel(marker), {
                      side: -1,
                      key: `agent-edit-${String(id)}-${marker.serial}-${marker.settling}`,
                      ignoreSelection: true,
                    }),
                  );
                }
                // The innermost changed block is the one named, so nothing
                // inside a marked block needs a marker of its own.
                return false;
              });
              return DecorationSet.create(state.doc, decorations);
            },
          },
        }),
      ];
    },
  });
}

/**
 * The React half: listens on the document's socket, decides the state of each
 * marker, and takes it away again.
 *
 * Renders nothing. It lives in the editor chrome for the same reason as
 * `CommentMarkers`: it holds effects, and the surface must stay free of them.
 */
export function AgentEditMarkers({
  editor,
  provider,
}: {
  editor: Editor;
  provider: HocuspocusProvider;
}) {
  const t = useTranslations('editor.agentEdits');
  const lastTypedAt = React.useRef(0);

  // Only the reader's own edits count as typing: a remote update, including
  // the one this notice describes, arrives as a change of origin.
  React.useEffect(() => {
    const onTransaction = ({
      transaction,
    }: {
      transaction: Parameters<typeof isChangeOrigin>[0];
    }): void => {
      if (transaction.docChanged && !isChangeOrigin(transaction)) lastTypedAt.current = Date.now();
    };
    editor.on('transaction', onTransaction);
    return () => {
      editor.off('transaction', onTransaction);
    };
  }, [editor]);

  React.useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let serial = 0;

    const publish = (update: (markers: Map<string, AgentEditMarker>) => void): void => {
      if (editor.isDestroyed) return;
      const next = new Map(agentEditKey.getState(editor.state) ?? []);
      update(next);
      editor.view.dispatch(editor.state.tr.setMeta(agentEditKey, next));
    };

    const later = (delay: number, action: () => void): void => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        action();
      }, delay);
      timers.add(timer);
    };

    /**
     * Settles a marker and then takes it away, each on its own clock -- but
     * only while it is still the one that was placed: a newer change to the
     * same block owns the block from then on.
     */
    const retire = (id: string, marker: AgentEditMarker): void => {
      const owns = (markers: Map<string, AgentEditMarker>): boolean =>
        markers.get(id)?.serial === marker.serial;
      const remove = (): void =>
        publish((markers) => {
          if (owns(markers)) markers.delete(id);
        });
      const settle = (): void => {
        publish((markers) => {
          if (owns(markers)) markers.set(id, { ...marker, settling: true });
        });
        later(SETTLE_MS, remove);
      };
      later(HOLD_MS[marker.state], settle);
    };

    const onStateless = ({ payload }: { payload: string }): void => {
      const notice = readEditNotice(payload);
      if (notice === null || notice.blockIds.length === 0) return;

      const name =
        notice.actorName ?? (notice.actorKind === 'agent' ? t('someAgent') : t('somePerson'));
      const typing = Date.now() - lastTypedAt.current < TYPING_WINDOW_MS;
      const underCursor = typing ? blocksAtSelection(editor.state) : new Set<string>();

      serial += 1;
      const placed = new Map<string, AgentEditMarker>();
      for (const [id, state] of markerStates(notice, underCursor)) {
        placed.set(id, { state, label: t(state, { name }), settling: false, serial });
      }
      publish((markers) => {
        for (const [id, marker] of placed) markers.set(id, marker);
      });

      for (const [id, marker] of placed) retire(id, marker);
    };

    provider.on('stateless', onStateless);
    return () => {
      provider.off('stateless', onStateless);
      for (const timer of timers) clearTimeout(timer);
      // Markers belong to this provider; a new connection starts clean.
      publish((markers) => markers.clear());
    };
  }, [editor, provider, t]);

  return null;
}
