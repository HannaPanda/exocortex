import type { Metadata } from 'next';

import { RenderTemplatesPage } from '@/components/render/render-templates-page';

export const metadata: Metadata = { title: 'Vorlagen' };

export default async function WorkspaceRenderTemplatesPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <RenderTemplatesPage workspaceId={workspaceId} />;
}
