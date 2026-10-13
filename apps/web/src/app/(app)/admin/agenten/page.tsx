import { Suspense } from 'react';

import { AgentSessionTable } from '@/components/admin/agent-session-table';

export default function AdminAgentSessionsPage() {
  // The list keeps its filters in the address, which needs a Suspense boundary.
  return (
    <Suspense>
      <AgentSessionTable />
    </Suspense>
  );
}
