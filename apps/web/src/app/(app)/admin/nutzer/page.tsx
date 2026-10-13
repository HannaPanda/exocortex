import { Suspense } from 'react';

import { UserTable } from '@/components/admin/user-table';

export default function AdminUsersPage() {
  // The list keeps its filters in the address, which needs a Suspense boundary.
  return (
    <Suspense>
      <UserTable />
    </Suspense>
  );
}
