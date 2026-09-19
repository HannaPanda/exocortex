import type { Metadata } from 'next';

import { IncomingSharesPage } from '@/components/shell/incoming-shares-page';

export const metadata: Metadata = { title: 'Mit mir geteilt' };

export default function SharedWithMeRoute() {
  return <IncomingSharesPage />;
}
