'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type AcceptInvitationResponse, type InvitationPreview } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  Input,
  Label,
  LoadingState,
} from '@exocortex/ui';

import { ApiError, apiRequest } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import { signIn } from '@/lib/auth/client';

/** Better Auth's own minimum, repeated so the form can say so before submitting. */
const MIN_PASSWORD_LENGTH = 12;

/**
 * Accepting an invitation (issue #3).
 *
 * The one page in the application an anonymous visitor can use to create
 * something. Three states: looking the invitation up, filling in a name and a
 * password, done. The email address is never an input -- it comes from the
 * invitation, and a person holding a valid token still cannot register a
 * different address.
 *
 * The token reaches the API in a request body rather than a URL, so it does not
 * end up in the access log a second time. It is already in the log once, as part
 * of the link that was clicked; that is unavoidable for any link, which is also
 * why the token expires and works exactly once.
 */
export function AcceptInvitationForm({ token }: { token: string }) {
  const t = useTranslations('auth.invitation');
  const router = useRouter();

  const [preview, setPreview] = React.useState<InvitationPreview | null>(null);
  const [lookupError, setLookupError] = React.useState<string | null>(null);
  const [name, setName] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void apiRequest<InvitationPreview>('/api/invitations/preview', {
      method: 'POST',
      body: { token },
    })
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLookupError(
          error instanceof ApiError ? error.message : messageForCode('internal_error'),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (preview === null) return;
    setPending(true);
    setSubmitError(null);

    try {
      const result = await apiRequest<AcceptInvitationResponse>('/api/invitations/accept', {
        method: 'POST',
        body: { token, name: name.trim(), password },
      });

      // Signing in right here rather than sending the person to the login form:
      // they just chose the password, and typing it again to get through a door
      // they have already unlocked is friction with no purpose.
      const signedIn = await signIn.email({ email: result.email, password });
      if (signedIn.error !== null && signedIn.error !== undefined) {
        router.replace('/anmelden');
        return;
      }
      router.replace('/arbeitsbereich');
    } catch (error) {
      setSubmitError(error instanceof ApiError ? error.message : messageForCode('internal_error'));
      setPending(false);
    }
  };

  if (lookupError !== null) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <h1 className="exocortex-page-title">{t('invalidTitle')}</h1>
          <Alert variant="destructive" data-testid="invitation-invalid">
            <AlertDescription>{lookupError}</AlertDescription>
          </Alert>
          <p className="text-sm text-muted-foreground">{t('invalidHint')}</p>
          <Button render={<Link href="/anmelden" />}>{t('toSignIn')}</Button>
        </CardContent>
      </Card>
    );
  }

  if (preview === null) {
    return <LoadingState label={t('checking')} />;
  }

  if (preview.accountExists) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <h1 className="exocortex-page-title">{t('accountExistsTitle')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('accountExistsHint', { email: preview.email })}
          </p>
          <Button render={<Link href="/anmelden" />}>{t('toSignIn')}</Button>
        </CardContent>
      </Card>
    );
  }

  const passwordTooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;

  return (
    <Card>
      <CardContent className="pt-6">
        <form className="flex flex-col gap-4" onSubmit={(event) => void onSubmit(event)}>
          <div className="flex flex-col gap-1.5">
            <h1 className="exocortex-page-title">{t('title')}</h1>
            <p className="text-sm text-muted-foreground">
              {preview.workspaceName === null
                ? t('invitedToApp', { inviter: preview.invitedByName })
                : t('invitedToWorkspace', {
                    inviter: preview.invitedByName,
                    workspace: preview.workspaceName,
                  })}
            </p>
          </div>

          {submitError !== null ? (
            <Alert variant="destructive" data-testid="accept-invitation-error">
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex flex-col gap-2">
            <Label htmlFor="invitation-email">{t('email')}</Label>
            {/*
              Shown but not editable: the invitation decides the address. A field
              a person could change here would be a field the server has to
              ignore, and a form that ignores what you typed is worse than one
              that does not offer it.
            */}
            <Input id="invitation-email" value={preview.email} readOnly disabled />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="invitation-name">{t('name')}</Label>
            <Input
              id="invitation-name"
              autoComplete="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              data-testid="invitation-name"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="invitation-password">{t('password')}</Label>
            <Input
              id="invitation-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              data-testid="invitation-password"
            />
            <p className="text-xs text-muted-foreground">
              {t('passwordMinimum', { count: MIN_PASSWORD_LENGTH })}
            </p>
          </div>

          <Button
            type="submit"
            disabled={pending || name.trim().length === 0 || password.length < MIN_PASSWORD_LENGTH}
            data-testid="accept-invitation-submit"
          >
            {pending ? t('submitting') : t('submit')}
          </Button>

          {passwordTooShort ? (
            <p className="text-xs text-muted-foreground">{t('passwordTooShort')}</p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
