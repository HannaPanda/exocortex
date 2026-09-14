import type { Metadata } from 'next';

import { EntitiesPage } from '@/components/entities/entities-page';

export const metadata: Metadata = { title: 'Entitäten' };

export default function EntitiesRoute() {
  return <EntitiesPage />;
}
