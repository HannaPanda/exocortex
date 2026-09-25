import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';

import { LoadingState } from '@exocortex/ui';

import { ChatsPage } from '@/components/ai/chats-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('search.chatsRoute');
  return { title: t('title') };
}

/**
 * The area reads `?fortsetzen=<id>` with `useSearchParams`, which suspends
 * during a production build unless there is a boundary above it.
 */
export default async function ChatsRoute() {
  const t = await getTranslations('search.chatsRoute');
  return (
    <Suspense fallback={<LoadingState label={t('loading')} />}>
      <ChatsPage />
    </Suspense>
  );
}
