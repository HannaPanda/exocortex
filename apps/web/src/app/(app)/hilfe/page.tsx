import type { Metadata } from 'next';

import { HelpPage } from '@/components/help/help-page';

export const metadata: Metadata = { title: 'Funktionen' };

export default function HelpRoute() {
  return <HelpPage />;
}
