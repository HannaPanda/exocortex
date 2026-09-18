import type { Metadata } from 'next';

import { ClipForm } from '@/components/shell/clip-form';
import { readShare } from '@/lib/share-target';

export const metadata: Metadata = { title: 'Aufheben' };

/**
 * Where a share lands (issue #72).
 *
 * The share target is declared as a GET in the manifest, so what was shared
 * arrives as query parameters and this page can read them on the server. A POST
 * target would need the service worker to catch the request, and that worker
 * deliberately caches nothing and answers nothing.
 */
export default async function SharePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return (
    <ClipForm
      shared={readShare({
        url: first(params.url),
        title: first(params.title),
        text: first(params.text),
      })}
    />
  );
}

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
