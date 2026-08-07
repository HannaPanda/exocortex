'use client';

import { Link2OffIcon, LinkIcon } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import {
  type DocumentLinkKind,
  type IncomingDocumentLink,
  type OutgoingDocumentLink,
} from '@exocortex/contracts';
import { Badge, EmptyState, ErrorState, LoadingState } from '@exocortex/ui';

import { DocumentIcon } from '@/components/document/document-icon';
import { useDocumentLinks } from '@/lib/api/queries';

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
      trailing={
        link.source.archivedAt === null ? null : (
          <Badge variant="muted">Archiviert</Badge>
        )
      }
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
      trailing={
        link.target.archivedAt === null ? null : <Badge variant="muted">Archiviert</Badge>
      }
    />
  );
}

/**
 * The "Verweise" tab: which pages point at this one, and which pages this one
 * points at.
 *
 * Both directions come from the same index, and unresolved references stay
 * visible instead of being filtered away — a reference to a title that no page
 * carries is the single most useful thing this panel can tell someone, because
 * it is the one nothing else in the application reveals.
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

  if (incoming.length === 0 && outgoing.length === 0) {
    return (
      <EmptyState
        title="Keine Verweise"
        description={
          pending
            ? 'Diese Seite wurde noch nicht verarbeitet. Sobald das passiert ist, stehen ihre Verweise hier.'
            : 'Weder verweist eine andere Seite hierher, noch verweist diese Seite auf eine andere.'
        }
        icon={LinkIcon}
      />
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
    </div>
  );
}
