'use client';

import { Link2OffIcon, LinkIcon } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import {
  type DocumentLinkKind,
  type IncomingDocumentLink,
  type OutgoingDocumentLink,
  type RelatedDocument,
} from '@exocortex/contracts';
import { Badge, EmptyState, ErrorState, LoadingState } from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';
import { useDocumentLinks, useRelatedDocuments } from '@/lib/api/queries';

export interface BacklinksPanelProps {
  workspaceId: string | null;
  documentId: string | null;
}

/** How a reference was written. Shown so "erwähnt" and "verlinkt" stay distinguishable. */
const KIND_LABEL: Record<DocumentLinkKind, string> = {
  pageLink: 'Seitenlink',
  mention: 'Erwähnung',
  wikiMark: 'Wiki-Link',
};

function SectionHeading({ children, count }: { children: React.ReactNode; count: number }) {
  return (
    <h3 className="flex items-center gap-2 px-1 text-xs font-medium text-muted-foreground">
      {children}
      <span className="exocortex-numeric">{count}</span>
    </h3>
  );
}

/** One row: icon, title, the sentence the reference sits in. */
function LinkRow({
  href,
  icon,
  title,
  kind,
  context,
  trailing,
}: {
  href: string | null;
  icon: React.ReactNode;
  title: string;
  kind: DocumentLinkKind;
  context: string;
  trailing?: React.ReactNode;
}) {
  const body = (
    <>
      <span className="flex items-center gap-2">
        {icon}
        <span className="truncate text-sm font-medium">{title}</span>
        {trailing}
      </span>
      {context.length > 0 ? (
        <span className="line-clamp-3 text-xs text-muted-foreground">{context}</span>
      ) : null}
      <span className="text-[0.6875rem] text-muted-foreground">{KIND_LABEL[kind]}</span>
    </>
  );

  const className =
    'flex w-full flex-col gap-1 rounded-md border border-border px-2 py-2 text-left';

  return href === null ? (
    <div className={className}>{body}</div>
  ) : (
    <Link href={href} className={`${className} hover:bg-accent`}>
      {body}
    </Link>
  );
}

function IncomingRow({ link, workspaceId }: { link: IncomingDocumentLink; workspaceId: string }) {
  return (
    <LinkRow
      href={`/arbeitsbereich/${workspaceId}/seite/${link.source.id}`}
      icon={
        <DocumentIcon
          icon={link.source.icon}
          iconColor={link.source.iconColor}
          type={link.source.type}
        />
      }
      title={link.source.title}
      kind={link.kind}
      context={link.context}
      trailing={link.source.archivedAt === null ? null : <Badge variant="muted">Archiviert</Badge>}
    />
  );
}

function OutgoingRow({ link, workspaceId }: { link: OutgoingDocumentLink; workspaceId: string }) {
  if (link.target === null) {
    return (
      <LinkRow
        href={null}
        icon={<Link2OffIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
        title={link.targetTitle}
        kind={link.kind}
        context={link.context}
        trailing={<Badge variant="outline">Kein Ziel</Badge>}
      />
    );
  }
  return (
    <LinkRow
      href={`/arbeitsbereich/${workspaceId}/seite/${link.target.id}`}
      icon={
        <DocumentIcon
          icon={link.target.icon}
          iconColor={link.target.iconColor}
          type={link.target.type}
        />
      }
      title={link.target.title}
      kind={link.kind}
      context={link.context}
      trailing={link.target.archivedAt === null ? null : <Badge variant="muted">Archiviert</Badge>}
    />
  );
}

/**
 * One found neighbour: a page about the same thing, which nobody linked.
 *
 * Carries its path, because the whole point of the section is pages the reader
 * has forgotten about, and a title alone often does not say which of several
 * similar pages this is. The similarity is printed as a plain number: it orders
 * the list honestly and does not pretend to be a percentage of anything.
 */
function RelatedRow({ entry, workspaceId }: { entry: RelatedDocument; workspaceId: string }) {
  const location = entry.path.map((step) => step.title).join(' / ');

  return (
    <Link
      href={`/arbeitsbereich/${workspaceId}/seite/${entry.document.id}`}
      className="flex w-full flex-col gap-1 rounded-md border border-border px-2 py-2 text-left hover:bg-accent"
    >
      <span className="flex items-center gap-2">
        <DocumentIcon
          icon={entry.document.icon}
          iconColor={entry.document.iconColor}
          type={entry.document.type}
        />
        <span className="truncate text-sm font-medium">{entry.document.title}</span>
        {entry.linked ? <Badge variant="muted">Verlinkt</Badge> : null}
      </span>
      {entry.snippet.length > 0 ? (
        <span className="line-clamp-2 text-xs text-muted-foreground">{entry.snippet}</span>
      ) : null}
      <span className="flex items-center gap-2 text-[0.6875rem] text-muted-foreground">
        {location.length > 0 ? <span className="truncate">{location}</span> : null}
        <span className="exocortex-numeric ml-auto shrink-0">
          Ähnlichkeit {entry.similarity.toLocaleString('de-DE', { maximumFractionDigits: 2 })}
        </span>
      </span>
    </Link>
  );
}

/**
 * "Verwandte Notizen": pages that resemble this one although nobody linked
 * them (issue #33).
 *
 * Stands below the two reference sections rather than in a tab of its own,
 * because it answers the same question they do — what else belongs to this
 * page — and the reference sections are the part that is certain. Set
 * references first, guesses second.
 *
 * Nothing here writes into the page. A found neighbour is a suggestion to
 * read, and whether it becomes a reference is the reader's decision (ADR-004:
 * the Yjs state is canonical and no one else may put a link into it).
 */
function RelatedSection({ workspaceId, documentId }: { workspaceId: string; documentId: string }) {
  const related = useRelatedDocuments(documentId);

  // Silent while it loads and silent when it breaks: this section is an extra,
  // and the references above it are the answer the tab promises. An error
  // banner for a suggestion list would push the real content down the panel.
  if (related.isPending || related.isError) return null;

  const { state, related: entries } = related.data;
  // Switched off is not the same as nothing found, but it is not this panel's
  // job to advertise a setting either: without semantic search there is
  // nothing to show and no section.
  if (state === 'disabled') return null;

  return (
    <section className="flex flex-col gap-2" data-testid="related-documents">
      <SectionHeading count={entries.length}>Verwandte Notizen</SectionHeading>
      {state === 'pending' ? (
        <p className="px-1 text-xs text-muted-foreground">
          Diese Seite wurde noch nicht für die semantische Suche erfasst. Sobald das passiert ist,
          stehen hier Seiten zum selben Thema.
        </p>
      ) : entries.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">
          Keine andere Seite dieses Arbeitsbereichs ähnelt dieser deutlich genug.
        </p>
      ) : (
        entries.map((entry) => (
          <RelatedRow key={entry.document.id} entry={entry} workspaceId={workspaceId} />
        ))
      )}
    </section>
  );
}

/**
 * The "Verweise" tab: which pages point at this one, which pages this one
 * points at, and which pages resemble it although nobody connected them.
 *
 * Both reference directions come from the same index, and unresolved
 * references stay visible instead of being filtered away — a reference to a
 * title that no page carries is the single most useful thing this panel can
 * tell someone, because it is the one nothing else in the application reveals.
 */
export function BacklinksPanel({ workspaceId, documentId }: BacklinksPanelProps) {
  const links = useDocumentLinks(documentId ?? undefined);

  if (documentId === null || workspaceId === null) {
    return (
      <EmptyState
        title="Keine Seite geöffnet"
        description="Öffne eine Seite, um ihre Verweise zu sehen."
        icon={LinkIcon}
      />
    );
  }

  if (links.isPending) {
    return <LoadingState variant="skeleton" rows={4} label="Verweise werden geladen …" />;
  }

  if (links.isError) {
    return (
      <ErrorState
        title="Verweise nicht verfügbar"
        description="Der Verweisindex konnte nicht geladen werden."
        onRetry={() => void links.refetch()}
      />
    );
  }

  const { incoming, outgoing, pending } = links.data;
  const unresolved = outgoing.filter((link) => link.target === null).length;

  // A page nobody linked is exactly the page the related section is for, so the
  // empty state keeps it rather than replacing the whole panel with a sentence.
  if (incoming.length === 0 && outgoing.length === 0) {
    return (
      <div className="flex flex-col gap-4" data-testid="backlinks-panel">
        <EmptyState
          title="Keine Verweise"
          description={
            pending
              ? 'Diese Seite wurde noch nicht verarbeitet. Sobald das passiert ist, stehen ihre Verweise hier.'
              : 'Weder verweist eine andere Seite hierher, noch verweist diese Seite auf eine andere.'
          }
          icon={LinkIcon}
        />
        <RelatedSection workspaceId={workspaceId} documentId={documentId} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="backlinks-panel">
      <section className="flex flex-col gap-2">
        <SectionHeading count={incoming.length}>Verweise auf diese Seite</SectionHeading>
        {incoming.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">
            Bisher verweist keine andere Seite hierher.
          </p>
        ) : (
          incoming.map((link) => (
            <IncomingRow key={link.id} link={link} workspaceId={workspaceId} />
          ))
        )}
      </section>

      <section className="flex flex-col gap-2">
        <SectionHeading count={outgoing.length}>Diese Seite verweist auf</SectionHeading>
        {unresolved > 0 ? (
          <p className="px-1 text-xs text-muted-foreground">
            {unresolved === 1
              ? 'Ein Verweis zeigt auf einen Titel, zu dem es keine Seite gibt.'
              : `${unresolved} Verweise zeigen auf Titel, zu denen es keine Seite gibt.`}
          </p>
        ) : null}
        {outgoing.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">
            {pending
              ? 'Diese Seite wurde noch nicht verarbeitet.'
              : 'Diese Seite verweist auf keine andere Seite.'}
          </p>
        ) : (
          outgoing.map((link) => (
            <OutgoingRow key={link.id} link={link} workspaceId={workspaceId} />
          ))
        )}
      </section>

      <RelatedSection workspaceId={workspaceId} documentId={documentId} />
    </div>
  );
}
