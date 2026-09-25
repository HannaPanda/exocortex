import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { AcceptInvitationForm } from '@/components/auth/accept-invitation-form';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.invitation');
  return { title: t('metaTitle') };
}

/**
 * The page an invitation link opens.
 *
 * The token sits in the path because that is what a link is. Everything the page
 * then does with it goes through a request body, and the token expires and works
 * exactly once -- the parts of the problem that can be fixed.
 */
export default async function AcceptInvitationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <AcceptInvitationForm token={decodeURIComponent(token)} />;
}
