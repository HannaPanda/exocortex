import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { AutomationsPage } from '@/components/automations/automations-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('automations.route');
  return { title: t('title') };
}

export default async function WorkspaceAutomationsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <AutomationsPage workspaceId={workspaceId} />;
}
