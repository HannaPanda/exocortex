'use client';

import { type Editor } from '@tiptap/react';
import { ExternalLinkIcon, UnlinkIcon } from 'lucide-react';
import * as React from 'react';

import { type DocumentSummary, type DocumentTreeNode } from '@exocortex/contracts';
import {
  parseLinkHref,
  WIKI_LINK_IDENTITY_ATTRIBUTE,
  WIKI_LINK_SCHEME,
  wikiLinkDocumentId,
} from '@exocortex/editor';
import { Button, Input, Popover, PopoverContent, PopoverTrigger } from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';
import { useDocumentTree } from '@/lib/api/document-queries';

import { FollowLinkContext } from './follow-link-context';

interface LinkMenuProps {
  editor: Editor;
  workspaceId: string;
  trigger: React.ReactElement<Record<string, unknown>>;
}

/** How many pages the suggestion list offers at once. */
const MAX_PAGE_SUGGESTIONS = 6;

/** Depth-first flattening of the page tree, like the `@` menu's source. */
function flattenTree(nodes: readonly DocumentTreeNode[]): DocumentSummary[] {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children)]);
}

/**
 * Link editor.
 *
 * Accepts three inputs and normalizes all of them:
 *   * `https://…` and `mailto:…` stay as they are,
 *   * `[[Seite]]` and a bare page title become the internal `wiki:` scheme,
 *   * everything else that looks like a host gets `https://` prepended, because a
 *     protocol-less href would resolve against the app itself.
 *
 * Text that does not look like an address is also treated as a *search*: the
 * pages of this workspace whose title contains it are offered for selection,
 * so linking to a page no longer means typing its title exactly right, and the
 * bracket notation becomes optional rather than required (issue #14). Nothing
 * is looked up over the network for that — the page tree is already in the
 * cache, the same source the `@` menu reads.
 */
export function LinkMenu({ editor, workspaceId, trigger }: LinkMenuProps) {
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState('');
  const followLinkRef = React.useContext(FollowLinkContext);
  const tree = useDocumentTree(open ? workspaceId : undefined);

  const currentHref = editor.getAttributes('link').href;

  const suggestions = React.useMemo((): DocumentSummary[] => {
    const needle = searchTermOf(value);
    if (needle === null || tree.data === undefined) return [];
    const lowered = needle.toLowerCase();
    return flattenTree(tree.data.nodes)
      .filter((page) => page.title.toLowerCase().includes(lowered))
      .slice(0, MAX_PAGE_SUGGESTIONS);
  }, [tree.data, value]);

  // Opening the popover seeds the field from the link under the cursor.
  const onOpenChange = (next: boolean): void => {
    if (next) setValue(typeof currentHref === 'string' ? displayValue(currentHref) : '');
    setOpen(next);
  };

  /**
   * Sets the link, with the identity of its target when one is known.
   *
   * Picking a page from the list below is the one moment where the application
   * knows *which* page is meant rather than only what it is called, so that is
   * where the identity has to be written (issue #24). A title typed by hand
   * carries none — and explicitly none: the address changed, so an identity
   * left over from the link that was there before would point somewhere else
   * entirely.
   */
  const applyHref = (href: string | null, documentId: string | null = null): void => {
    if (href === null) {
      editor.chain().focus().unsetLink().run();
    } else {
      const attributes = { href, [WIKI_LINK_IDENTITY_ATTRIBUTE]: documentId };
      editor.chain().focus().setLink(attributes).run();
    }
    setOpen(false);
  };

  const apply = (): void => applyHref(normalizeHref(value));

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={trigger} />
      <PopoverContent align="start" className="w-80">
        <div className="flex items-center gap-1.5">
          <Input
            autoFocus
            value={value}
            aria-label="Adresse oder Seitentitel"
            data-testid="link-input"
            placeholder="https://… oder Seite suchen"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                apply();
              }
            }}
          />
          <Button size="sm" data-testid="link-apply" onClick={apply}>
            Setzen
          </Button>
        </div>

        {suggestions.length > 0 ? (
          <ul
            className="mt-2 max-h-56 overflow-y-auto rounded-md border border-border"
            data-testid="link-page-suggestions"
            aria-label="Passende Seiten"
          >
            {suggestions.map((page) => (
              <li key={page.id}>
                <button
                  type="button"
                  data-testid={`link-page-option-${page.id}`}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                  // The editor loses its selection when a button takes focus,
                  // and the link would then be set on nothing.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyHref(`${WIKI_LINK_SCHEME}${page.title}`, page.id)}
                >
                  <DocumentIcon icon={page.icon} iconColor={page.iconColor} type={page.type} />
                  <span className="min-w-0 flex-1 truncate">{page.title}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {typeof currentHref === 'string' && currentHref.length > 0 ? (
          <div className="mt-2 flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              data-testid="link-remove"
              onClick={() => {
                editor.chain().focus().unsetLink().run();
                setOpen(false);
              }}
            >
              <UnlinkIcon /> Entfernen
            </Button>
            {currentHref.startsWith(WIKI_LINK_SCHEME) ? (
              <Button
                variant="ghost"
                size="sm"
                data-testid="link-open"
                onClick={() => {
                  const parsed = parseLinkHref(currentHref);
                  const target =
                    parsed.kind === 'wiki'
                      ? { ...parsed, documentId: wikiLinkDocumentId(editor.getAttributes('link')) }
                      : parsed;
                  if (target.kind !== 'unknown') {
                    // Only shown for a `wiki:` target, which stays in this tab.
                    followLinkRef?.current?.(target, { download: false, newTab: false });
                  }
                  setOpen(false);
                }}
              >
                <ExternalLinkIcon /> Öffnen
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                render={
                  <a href={currentHref} target="_blank" rel="noopener noreferrer">
                    <ExternalLinkIcon /> Öffnen
                  </a>
                }
              />
            )}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** Shows an internal link the way it is written in Markdown. */
export function displayValue(href: string): string {
  return href.startsWith(WIKI_LINK_SCHEME) ? `[[${href.slice(WIKI_LINK_SCHEME.length)}]]` : href;
}

/**
 * What to search pages for, or `null` when the input is plainly an address.
 *
 * `[[Seite]]` counts: the brackets stay valid, they just stop being the only
 * way in, and while they are being typed the list should already narrow down.
 */
export function searchTermOf(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const brackets = /^\[\[(.*?)\]?\]?$/.exec(trimmed);
  if (brackets !== null) {
    const inner = (brackets[1] ?? '').trim();
    return inner.length === 0 ? null : inner;
  }

  if (/^(https?:|mailto:|wiki:)/i.test(trimmed)) return null;
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return null;
  // A bare token with a dot is a host, not a page title.
  if (/^[^\s/]+\.[^\s/]{2,}(\/.*)?$/.test(trimmed)) return null;

  return trimmed;
}

/** `null` means "remove the link". */
function normalizeHref(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const wiki = /^\[\[(.+)\]\]$/.exec(trimmed);
  if (wiki !== null) return `${WIKI_LINK_SCHEME}${(wiki[1] ?? '').trim()}`;

  if (/^(https?:|mailto:|wiki:)/i.test(trimmed)) return trimmed;
  // A bare token with a dot is a host; anything else is a page title.
  if (/^[^\s/]+\.[^\s/]{2,}(\/.*)?$/.test(trimmed)) return `https://${trimmed}`;
  return `${WIKI_LINK_SCHEME}${trimmed}`;
}
