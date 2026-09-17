import type { Metadata } from 'next';
import { Suspense } from 'react';

import { LoadingState } from '@exocortex/ui';

import { ChatsPage } from '@/components/ai/chats-page';

export const metadata: Metadata = { title: 'Chats' };

/**
 * The area reads `?fortsetzen=<id>` with `useSearchParams`, which suspends
 * during a production build unless there is a boundary above it.
 */
export default function ChatsRoute() {
  return (
    <Suspense fallback={<LoadingState label="Chats werden geladen …" />}>
      <ChatsPage />
    </Suspense>
  );
}
