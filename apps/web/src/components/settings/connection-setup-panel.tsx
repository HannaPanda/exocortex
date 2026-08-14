'use client';

import { KeyRoundIcon } from 'lucide-react';
import * as React from 'react';

import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@exocortex/ui';

import { connectionSnippets, TOKEN_PLACEHOLDER } from '@/lib/connection-snippets';

import { CopyBlock } from './copy-block';

/** The origin never changes while the page is open, so there is nothing to subscribe to. */
function subscribeToNothing(): () => void {
  return () => {};
}

function readOrigin(): string {
  return window.location.origin;
}

interface ConnectionSetupPanelProps {
  /**
   * A token created a moment ago in this page's lifetime. When present it is
   * already inside every command below, which is the difference between "copy
   * this line" and "copy this line, then find the secret you were shown once
   * and paste it into the right spot".
   */
  freshSecret: string | null;
  onForgetSecret: () => void;
}

export function ConnectionSetupPanel({ freshSecret, onForgetSecret }: ConnectionSetupPanelProps) {
  // The origin is read from the browser, because the deployment's own URL is
  // exactly what the snippets need and no build-time variable carries it. Read
  // through `useSyncExternalStore` rather than an effect: the server snapshot is
  // null, the client snapshot is the real origin, and React swaps them at
  // hydration without a mismatch warning and without a second render pass.
  const origin = React.useSyncExternalStore(subscribeToNothing, readOrigin, () => null);

  const snippets = React.useMemo(
    () => connectionSnippets(origin ?? 'https://exocortex.app', freshSecret),
    [origin, freshSecret],
  );

  return (
    <section className="flex flex-col gap-3" aria-labelledby="setup-heading">
      <div>
        <h2 id="setup-heading" className="text-sm font-semibold">
          Einrichten
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Such dir dein Programm und kopier die Zeile. Mehr ist es nicht.
        </p>
      </div>

      {freshSecret !== null ? (
        <Alert>
          <KeyRoundIcon />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>
              Dein neues Token steckt bereits in den Befehlen unten. Es verschwindet, sobald du
              diese Seite neu lädst.
            </span>
            <Button variant="outline" size="sm" onClick={onForgetSecret}>
              Token ausblenden
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <p className="text-xs text-muted-foreground">
          Wo <code className="font-mono">{TOKEN_PLACEHOLDER}</code> steht, gehört ein Token aus dem
          Abschnitt darüber hin. Legst du gleich hier eins an, setzt eXocortex es von selbst ein.
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {snippets.map((snippet) => (
          <Card key={snippet.id} className="gap-4">
            <CardHeader>
              <CardTitle className="text-sm">{snippet.title}</CardTitle>
              <CardDescription>{snippet.summary}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <CopyBlock value={snippet.code} label={`Angaben für ${snippet.title} kopieren`} />
              {snippet.notes.length > 0 ? (
                <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-muted-foreground">
                  {snippet.notes.map((note) => (
                    <li key={note} className="break-words">
                      {note}
                    </li>
                  ))}
                </ul>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
        <h3 className="text-sm font-semibold text-foreground">Welche Rechte für wen</h3>
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-4">
          <li>
            <span className="font-medium text-foreground">ChatGPT: nur lesen.</span> Es soll
            nachschlagen, nicht umschreiben.
          </li>
          <li>
            <span className="font-medium text-foreground">
              Coding-Agenten wie Claude Code: lesen und schreiben.
            </span>{' '}
            Sie legen Seiten an und pflegen sie.
          </li>
          <li>
            <span className="font-medium text-foreground">Voller Zugriff: an niemanden.</span> Kein
            Werkzeug im MCP-Katalog braucht ihn, und er ist das einzige Recht, mit dem sich ein
            Token weitere Token ausstellen kann.
          </li>
        </ul>
      </div>
    </section>
  );
}
