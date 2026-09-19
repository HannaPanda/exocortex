import type { Metadata } from 'next';

import { SharedDocumentPage } from '@/components/shell/shared-document-page';

export const metadata: Metadata = { title: 'Geteilte Seite' };

export default async function SharedDocumentRoute({
  params,
}: {
  params: Promise<{ documentId: string }>;
}) {
  const { documentId } = await params;
  return <SharedDocumentPage documentId={documentId} />;
}
