'use client';

import Link from 'next/link';
import * as React from 'react';

import { Alert, AlertDescription, Button, Card, CardContent, Input, Label } from '@exocortex/ui';

import { requestPasswordReset } from '@/lib/auth/client';

export function ForgotPasswordForm() {
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
            <h1 className="text-lg font-semibold">Passwort zurücksetzen</h1>
            <p className="text-sm text-muted-foreground">
              Wir senden dir einen Link, mit dem du ein neues Passwort setzen kannst.
            </p>
          </div>

          {sent ? (
            <Alert>
              <AlertDescription>
                Falls ein Konto mit dieser Adresse existiert, ist die E-Mail unterwegs.
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="flex flex-col gap-2">
            <Label htmlFor="email">E-Mail-Adresse</Label>
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
            {pending ? 'Wird gesendet …' : 'Link senden'}
          </Button>

          <p className="text-center text-xs text-muted-foreground">
            <Link href="/anmelden" className="underline underline-offset-2">
              Zurück zur Anmeldung
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
