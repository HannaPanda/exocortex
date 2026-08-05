import type { Metadata } from 'next';

import { WorkspaceLanding } from '@/components/shell/workspace-landing';

export const metadata: Metadata = { title: 'Arbeitsbereiche' };

export default function WorkspaceIndexPage() {
  return <WorkspaceLanding />;
}
