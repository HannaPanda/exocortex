'use client';

import { useSearchParams } from 'next/navigation';
import * as React from 'react';

import { Alert, AlertDescription, Button, Card, CardContent } from '@exocortex/ui';

import { apiRequest } from '@/lib/api/client';

interface OAuthClient {
  clientId: string;
  name: string;
  redirectUrls: string[];
  disabled: boolean;
  registeredAt: string;
}

interface ConsentResponse {
  url: string;
}

/**
 * German labels for the OAuth scopes this server issues. An unknown scope is
 * shown verbatim rather than hidden: a person cannot weigh what they are not
 * told about.
 */
const SCOPE_LABELS: Record<string, string> = {
  openid: 'Deine Identität bestätigen',
  profile: 'Deinen Namen lesen',
  email: 'Deine E-Mail-Adresse lesen',
  offline_access: 'Verbunden bleiben, ohne dich erneut zu fragen',
};

export function OAuthConsentForm() {
  const searchParams = useSearchParams();
  // The whole query, verbatim: the authorization server signs the parameters
  // it redirected here with, and the signature covers every one of them.
  // Sending back a subset, or an extra field, invalidates it.
  const oauthQuery = searchParams.toString();
  const clientId = searchParams.get('client_id');
  const scope = searchParams.get('scope') ?? '';

  // An authorization request without a client id is broken before it starts.
  // That is known at render time, so it is derived rather than pushed into
  // state by an effect.
  const incomplete = clientId === null;

  const [client, setClient] = React.useState<OAuthClient | null>(null);
  const [loading, setLoading] = React.useState(!incomplete);
  const [lookupFailed, setLookupFailed] = React.useState(false);
  const [pending, setPending] = React.useState<'accept' | 'deny' | null>(null);
  const [decisionError, setDecisionError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (clientId === null) return;
    let active = true;
    void apiRequest<OAuthClient>(`/api/mcp/clients/${encodeURIComponent(clientId)}`)
      .then((result) => {
        if (active) setClient(result);
      })
      .catch(() => {
        if (active) setLookupFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [clientId]);

  const error =
    decisionError ??
    (incomplete
      ? 'Diese Anfrage ist unvollständig. Starte die Verbindung in der App noch einmal.'
      : lookupFailed
        ? 'Diese Anwendung ist unbekannt. Erlaube den Zugriff nicht.'
        : null);

  const decide = async (accept: boolean): Promise<void> => {
    setPending(accept ? 'accept' : 'deny');
    setDecisionError(null);
    try {
      const result = await apiRequest<ConsentResponse>('/api/auth/oauth2/consent', {
        method: 'POST',
        body: { accept, oauth_query: oauthQuery },
      });
      // The target belongs to the connector, not to this app, so it is a full
      // navigation out of the site.
      window.location.assign(result.url);
    } catch {
      setDecisionError('Die Anfrage ist abgelaufen. Starte die Verbindung in der App noch einmal.');
      setPending(null);
    }
  };

  const scopes = scope.split(' ').filter((entry) => entry !== '');

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 pt-6">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-lg font-semibold">Zugriff erlauben?</h1>
          <p className="text-sm text-muted-foreground">
            {loading
              ? 'Anwendung wird geprüft …'
              : client === null
                ? 'Eine unbekannte Anwendung möchte auf dein eXocortex zugreifen.'
                : `„${client.name}" möchte auf dein eXocortex zugreifen.`}
          </p>
        </div>

        {error !== null ? (
          <Alert variant="destructive" data-testid="consent-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {client !== null ? (
          <>
            <Alert>
              <AlertDescription>
                Die Anwendung darf danach deine Seiten lesen und schreiben, in allen
                Arbeitsbereichen, in denen du Mitglied bist. Erlaube das nur, wenn du die Verbindung
                gerade selbst eingerichtet hast.
              </AlertDescription>
            </Alert>

            {scopes.length > 0 ? (
              <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
                {scopes.map((entry) => (
                  <li key={entry}>• {SCOPE_LABELS[entry] ?? entry}</li>
                ))}
              </ul>
            ) : null}

            <dl className="flex flex-col gap-1 text-xs text-muted-foreground">
              <div className="flex gap-2">
                <dt className="shrink-0">Weiterleitung an:</dt>
                <dd className="break-all">{client.redirectUrls.join(', ')}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="shrink-0">Registriert am:</dt>
                <dd>{new Date(client.registeredAt).toLocaleString('de-DE')}</dd>
              </div>
            </dl>
          </>
        ) : null}

        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            disabled={pending !== null}
            onClick={() => void decide(false)}
            data-testid="consent-deny"
          >
            {pending === 'deny' ? 'Wird abgelehnt …' : 'Ablehnen'}
          </Button>
          <Button
            type="button"
            className="flex-1"
            disabled={pending !== null || loading || client === null}
            onClick={() => void decide(true)}
            data-testid="consent-accept"
          >
            {pending === 'accept' ? 'Wird erlaubt …' : 'Erlauben'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
