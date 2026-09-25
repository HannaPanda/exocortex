'use client';

import { KeyRoundIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
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
  const t = useTranslations('account.setup');

  const snippets = React.useMemo(
    () => connectionSnippets(origin ?? 'https://exocortex.app', freshSecret),
    [origin, freshSecret],
  );

  return (
    <section className="flex flex-col gap-3" aria-labelledby="setup-heading">
      <div>
        <h2 id="setup-heading" className="text-sm font-semibold">
          {t('title')}
        </h2>
        <p className="mt-1 max-w-measure text-sm text-muted-foreground">{t('intro')}</p>
      </div>

      {freshSecret !== null ? (
        <Alert>
          <KeyRoundIcon />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{t('freshToken')}</span>
            <Button variant="outline" size="sm" onClick={onForgetSecret}>
              {t('hideToken')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t.rich('placeholderHint', {
            placeholder: TOKEN_PLACEHOLDER,
            code: (chunks) => <code className="font-mono">{chunks}</code>,
          })}
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {snippets.map((snippet) => {
          const title = t(`snippets.${snippet.id}.title`);
          return (
            <Card key={snippet.id} className="gap-4">
              <CardHeader>
                <CardTitle className="text-sm">{title}</CardTitle>
                <CardDescription>{t(`snippets.${snippet.id}.summary`)}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <CopyBlock value={snippet.code} label={t('copyLabel', { title })} />
                {snippet.notes.length > 0 ? (
                  <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-muted-foreground">
                    {snippet.notes.map((note) =>
                      note.kind === 'code' ? (
                        <li key={note.code} className="break-words">
                          {note.code}
                        </li>
                      ) : (
                        <li key={note.key} className="break-words">
                          {t(`notes.${note.key}`, note.values)}
                        </li>
                      ),
                    )}
                  </ul>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
        <h3 className="text-sm font-semibold text-foreground">{t('rightsTitle')}</h3>
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-4">
          {(['rightsChatgpt', 'rightsAgents', 'rightsAdmin'] as const).map((key) => (
            <li key={key}>
              {t.rich(key, {
                strong: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
              })}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
