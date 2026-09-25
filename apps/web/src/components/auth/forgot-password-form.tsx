'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { Alert, AlertDescription, Button, Card, CardContent, Input, Label } from '@exocortex/ui';

import { requestPasswordReset } from '@/lib/auth/client';

export function ForgotPasswordForm() {
  const t = useTranslations('auth.forgotPassword');
  const [email, setEmail] = React.useState('');
  const [sent, setSent] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPending(true);
    // The response is intentionally identical whether or not the address exists,
    // so the form cannot be used to enumerate accounts.
    await requestPasswordReset({ email, redirectTo: '/anmelden' });
    setSent(true);
    setPending(false);
  };

  return (
    <Card>
      <CardContent className="pt-6">
        <form className="flex flex-col gap-4" onSubmit={(event) => void onSubmit(event)}>
          <div className="flex flex-col gap-1.5">
            <h1 className="exocortex-page-title">{t('title')}</h1>
            <p className="text-sm text-muted-foreground">{t('intro')}</p>
          </div>

          {sent ? (
            <Alert>
              <AlertDescription>{t('sent')}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex flex-col gap-2">
            <Label htmlFor="email">{t('email')}</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <Button type="submit" disabled={pending}>
            {pending ? t('submitting') : t('submit')}
          </Button>

          <p className="text-center text-xs text-muted-foreground">
            <Link href="/anmelden" className="underline underline-offset-2">
              {t('backToSignIn')}
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
