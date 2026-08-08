'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Alert, AlertDescription, Button, Card, CardContent, Input, Label } from '@exocortex/ui';

import { signIn } from '@/lib/auth/client';

export function SignInForm() {
  const router = useRouter();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = await signIn.email({ email, password });
    if (result.error !== null && result.error !== undefined) {
      setError('E-Mail-Adresse oder Passwort ist falsch.');
      setPending(false);
      return;
    }
    router.replace('/arbeitsbereich');
  };

  return (
    <Card>
      <CardContent className="pt-6">
        <form className="flex flex-col gap-4" onSubmit={(event) => void onSubmit(event)}>
          <div className="flex flex-col gap-1.5">
            <h1 className="text-lg font-semibold">Anmelden</h1>
            <p className="text-sm text-muted-foreground">Willkommen zurück.</p>
          </div>

          {error !== null ? (
            <Alert variant="destructive" data-testid="signin-error">
              <AlertDescription>{error}</AlertDescription>
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

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Passwort</Label>
              <Link
                href="/passwort-vergessen"
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                Vergessen?
              </Link>
            </div>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          <Button type="submit" disabled={pending} data-testid="signin-submit">
            {pending ? 'Wird angemeldet …' : 'Anmelden'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
