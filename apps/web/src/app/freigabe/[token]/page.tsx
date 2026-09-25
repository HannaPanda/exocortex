import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { PublicSharePage } from '@/components/shell/public-share-page';

/**
 * A page behind a public link (issue #83, ADR-044).
 *
 * Outside `(app)`: there is no session here, so the shell's navigation,
 * workspace switcher and inbox would all be requests nobody can answer.
 *
 * The root layout already sets `robots: noindex, nofollow` for the whole
 * deployment, which is what an unguessable address needs -- a link that turns
 * up in a search result is a link that is no longer unguessable.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('shares.meta');
  return { title: t('sharedPageTitle') };
}

export default async function PublicShareRoute({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PublicSharePage token={token} />;
}
