import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { DocumentView } from '@/components/shell/document-view';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('document.metadata');
  return { title: t('page') };
}

export default async function DocumentPage({
  params,
}: {
  params: Promise<{ workspaceId: string; documentId: string }>;
}) {
  const { workspaceId, documentId } = await params;
  return <DocumentView workspaceId={workspaceId} documentId={documentId} />;
}
