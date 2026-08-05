import type { Metadata } from 'next';

import { DocumentView } from '@/components/shell/document-view';

export const metadata: Metadata = { title: 'Seite' };

export default async function DocumentPage({
  params,
}: {
  params: Promise<{ workspaceId: string; documentId: string }>;
}) {
  const { workspaceId, documentId } = await params;
  return <DocumentView workspaceId={workspaceId} documentId={documentId} />;
}
