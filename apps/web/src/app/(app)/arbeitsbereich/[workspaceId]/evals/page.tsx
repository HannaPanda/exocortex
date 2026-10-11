import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { EvalsPage } from '@/components/evals/evals-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('evals.route');
  return { title: t('listTitle') };
}

export default async function WorkspaceEvalsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <EvalsPage workspaceId={workspaceId} />;
}
