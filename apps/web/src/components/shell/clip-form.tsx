'use client';

import { ArrowRightIcon, BookmarkIcon, InboxIcon } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { type CaptureRequest, type CaptureResponse, type Workspace } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Button,
  Checkbox,
  ErrorState,
  Input,
  Label,
  LoadingState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@exocortex/ui';

import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import { useCapture, useClip } from '@/lib/api/inbox-queries';
import { useWorkspaces } from '@/lib/api/workspace-queries';
import { bookmarkletFor, type SharedContent } from '@/lib/share-target';

/**
 * The receiving end of a share and of the bookmarklet (issue #72).
 *
 * It is a form and not a dialog because it is where the operating system drops
 * someone: the window may hold nothing else, and there is no page behind it to
 * go back to. Everything in it is already filled in, so the fast path is one
 * button, and the slow path is editing what was shared before saving it.
 *
 * Reading the whole article is a checkbox and not the default. It is the only
 * thing here that opens a browser on the server, and a share from a phone
 * should not quietly start one.
 */
export function ClipForm({ shared }: { shared: SharedContent }) {
  const workspaces = useWorkspaces();
  const [workspaceId, setWorkspaceId] = React.useState<string | null>(null);
  const [title, setTitle] = React.useState(shared.title ?? '');
  const [text, setText] = React.useState(shared.text ?? '');
  const [fetchPage, setFetchPage] = React.useState(false);
  const [saved, setSaved] = React.useState<CaptureResponse | null>(null);

  // The first workspace, until someone picks another one. The same rule the
  // workspace landing follows, and for the same reason: with one workspace
  // there is nothing to decide, and a share target that asks anyway is a share
  // target nobody uses.
  const chosen = workspaceId ?? workspaces.data?.[0]?.id;

  const clip = useClip(chosen);
  const capture = useCapture(chosen);
  const pending = clip.isPending || capture.isPending;
  const error = clip.error ?? capture.error;
  const isClip = shared.url !== null;

  const save = (): void => {
    if (chosen === undefined || pending) return;
    const note = text.trim();
    const named = title.trim();

    const request =
      shared.url === null
        ? capture.mutateAsync(captureFrom(named, note))
        : clip.mutateAsync({
            url: shared.url,
            fetchPage,
            ...(named.length > 0 ? { title: named } : {}),
            ...(note.length > 0 ? { selection: note } : {}),
          });

    void request.then(setSaved).catch(() => {
      // Shown from `error` below. Nothing typed is lost: the fields keep what
      // they hold, which is the whole content of this window.
    });
  };

  if (workspaces.isPending) return <LoadingState label="Arbeitsbereiche werden geladen …" />;
  if (workspaces.isError) return <ErrorState onRetry={() => void workspaces.refetch()} />;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 p-6" data-testid="clip-form">
      <div className="flex flex-col gap-1">
        <h1 className="exocortex-page-title">{isClip ? 'Webseite aufheben' : 'Erfassen'}</h1>
        <p className="text-sm text-muted-foreground">
          Landet im Eingang des Arbeitsbereichs. Einsortiert wird später.
        </p>
      </div>

      {error === null ? null : (
        <Alert variant="destructive" data-testid="clip-error">
          <AlertDescription>
            {messageForCode(error instanceof ApiError ? error.code : undefined)}
          </AlertDescription>
        </Alert>
      )}

      {shared.url === null ? null : (
        <p className="truncate text-sm text-muted-foreground" data-testid="clip-url">
          {shared.url}
        </p>
      )}

      <WorkspacePicker
        workspaces={workspaces.data}
        chosen={chosen}
        onChoose={(next) => setWorkspaceId(next)}
      />

      <ClipFields
        isClip={isClip}
        title={title}
        text={text}
        fetchPage={fetchPage}
        onTitle={setTitle}
        onText={setText}
        onFetchPage={setFetchPage}
      />

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={pending || chosen === undefined} data-testid="clip-submit">
          {isClip ? 'Aufheben' : 'Erfassen'}
        </Button>
        {fetchPage ? (
          <span className="text-xs text-muted-foreground">
            Die Seite wird dafür im Browser geladen, das dauert einen Moment.
          </span>
        ) : null}
      </div>

      <SavedNotice saved={saved} workspaceId={chosen ?? ''} />

      {isClip || shared.text !== null ? null : <BookmarkletCard />}
    </div>
  );
}

/**
 * A share with no address at all is an ordinary capture, and an empty one is
 * not worth a page, so the title stands in when nothing else was sent.
 */
function captureFrom(title: string, note: string): CaptureRequest {
  return {
    text: note.length > 0 ? note : title,
    ...(title.length > 0 ? { title } : {}),
  };
}

/** Nothing to choose with one workspace, which is the common case. */
function WorkspacePicker({
  workspaces,
  chosen,
  onChoose,
}: {
  workspaces: Workspace[];
  chosen: string | undefined;
  onChoose: (workspaceId: string) => void;
}) {
  if (workspaces.length < 2) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="clip-workspace">Arbeitsbereich</Label>
      <Select value={chosen ?? ''} onValueChange={(next) => onChoose(next as string)}>
        <SelectTrigger id="clip-workspace" data-testid="clip-workspace">
          {/* Base UI shows the raw id without this. */}
          <SelectValue>
            {() => workspaces.find((it) => it.id === chosen)?.name ?? 'Arbeitsbereich'}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {workspaces.map((workspace) => (
            <SelectItem key={workspace.id} value={workspace.id}>
              {workspace.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ClipFields({
  isClip,
  title,
  text,
  fetchPage,
  onTitle,
  onText,
  onFetchPage,
}: {
  isClip: boolean;
  title: string;
  text: string;
  fetchPage: boolean;
  onTitle: (value: string) => void;
  onText: (value: string) => void;
  onFetchPage: (value: boolean) => void;
}) {
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="clip-title">Titel</Label>
        <Input
          id="clip-title"
          value={title}
          placeholder="Titel der Seite"
          data-testid="clip-title"
          onChange={(event) => onTitle(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="clip-text">{isClip ? 'Markierter Text' : 'Notiz'}</Label>
        <Textarea
          id="clip-text"
          rows={8}
          value={text}
          placeholder={isClip ? 'Nichts markiert' : 'Was willst du dir merken?'}
          data-testid="clip-text"
          onChange={(event) => onText(event.target.value)}
        />
      </div>

      {isClip ? (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={fetchPage}
            data-testid="clip-fetch"
            onCheckedChange={(checked) => onFetchPage(checked === true)}
          />
          Ganze Seite lesen und mitschreiben
        </label>
      ) : null}
    </>
  );
}

function SavedNotice({
  saved,
  workspaceId,
}: {
  saved: CaptureResponse | null;
  workspaceId: string;
}) {
  if (saved === null) return null;
  return (
    <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <InboxIcon className="size-4 shrink-0" />
      <span className="truncate" data-testid="clip-saved">
        Gespeichert: {saved.document.title}
      </span>
      <Link
        href={`/arbeitsbereich/${workspaceId}/seite/${saved.document.id}`}
        className="ml-auto flex shrink-0 items-center gap-1 text-foreground hover:underline"
        data-testid="clip-open"
      >
        Öffnen <ArrowRightIcon className="size-3.5" />
      </Link>
    </p>
  );
}

/**
 * Only shown when this page was opened with nothing to save, which is what
 * happens when somebody came here to set the clipper up rather than to use it.
 * The address is read at the moment of the click: a bookmarklet built into the
 * server-rendered markup would point at whatever host built it, and this one
 * has to point at the deployment the person is actually looking at.
 */
function BookmarkletCard() {
  const anchor = React.useRef<HTMLAnchorElement>(null);

  React.useEffect(() => {
    // Set through the DOM rather than as a prop: React refuses to render a
    // `javascript:` href, and a bookmark is a link or it is nothing.
    anchor.current?.setAttribute('href', bookmarkletFor(window.location.origin));
  }, []);

  return (
    <div className="mt-4 flex flex-col gap-3 rounded-lg border border-border p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <BookmarkIcon className="size-4" /> Web Clipper einrichten
      </h2>
      <p className="text-sm text-muted-foreground">
        Zieh den Knopf in die Lesezeichenleiste. Ein Klick darauf schickt die offene Seite samt
        markiertem Text hierher. Auf dem Handy geht es ohne: eXocortex installieren, dann steht es
        im Teilen-Menü.
      </p>
      <a
        ref={anchor}
        data-testid="clip-bookmarklet"
        className="w-fit rounded-md border border-border bg-muted px-3 py-1.5 text-sm font-medium"
        onClick={(event) => event.preventDefault()}
      >
        In eXocortex aufheben
      </a>
      <Button
        variant="ghost"
        size="sm"
        className="w-fit"
        onClick={() => {
          void navigator.clipboard.writeText(bookmarkletFor(window.location.origin));
        }}
      >
        Code kopieren
      </Button>
    </div>
  );
}
