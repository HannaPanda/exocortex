'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Alert, AlertDescription, Button, Card, CardContent, Input, Label } from '@exocortex/ui';

import { signUp } from '@/lib/auth/client';

const MIN_PASSWORD_LENGTH = 12;

export function SignUpForm() {
  const router = useRouter();
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen haben.`);
      return;
    }
    setPending(true);
    setError(null);
    const result = await signUp.email({ name, email, password });
    if (result.error !== null && result.error !== undefined) {
      setError('Registrierung fehlgeschlagen. Möglicherweise existiert das Konto schon.');
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
            <h1 className="text-lg font-semibold">Konto anlegen</h1>
            <p className="text-sm text-muted-foreground">
              Danach kannst du sofort einen Arbeitsbereich erstellen.
            </p>
          </div>

          {error !== null ? (
            <Alert variant="destructive" data-testid="signup-error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex flex-col gap-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              name="name"
              autoComplete="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

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
            <Label htmlFor="password">Passwort</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Mindestens {MIN_PASSWORD_LENGTH} Zeichen.
            </p>
          </div>

          <Button type="submit" disabled={pending} data-testid="signup-submit">
            {pending ? 'Konto wird angelegt …' : 'Konto anlegen'}
          </Button>

          <p className="text-center text-xs text-muted-foreground">
            Schon registriert?{' '}
            <Link href="/anmelden" className="underline underline-offset-2">
              Anmelden
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
