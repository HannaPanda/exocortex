import Link from 'next/link';

import { Button } from '@exocortex/ui';

export default function NotFound() {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-lg font-semibold">Seite nicht gefunden</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Diese Adresse existiert nicht oder du hast keinen Zugriff darauf.
      </p>
      <Button render={<Link href="/arbeitsbereich" />} variant="outline">
        Zur Übersicht
      </Button>
    </div>
  );
}
