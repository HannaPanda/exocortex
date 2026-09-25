import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { RenderTemplatesPage } from '@/components/render/render-templates-page';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('render.route');
  return { title: t('title') };
}

export default async function WorkspaceRenderTemplatesPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <RenderTemplatesPage workspaceId={workspaceId} />;
}
