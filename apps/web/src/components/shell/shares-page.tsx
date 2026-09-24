'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { AppPage, Tabs, TabsContent, TabsList, TabsTrigger } from '@exocortex/ui';

import { IncomingSharesList } from './incoming-shares-list';
import { MySharesList } from './my-shares-list';

type Direction = 'von-mir' | 'mit-mir';

/**
 * Both directions of sharing on one page, `/geteilt`.
 *
 * "Von mir geteilt" comes first: it is the list somebody opens on purpose, to
 * find and withdraw a grant they forgot about. "Mit mir geteilt" is where a
 * mail about a received or withdrawn grant points, so that tab is addressable
 * as `?ansicht=mit-mir` and the address survives a reload.
 */
export function SharesPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const active: Direction = params.get('ansicht') === 'mit-mir' ? 'mit-mir' : 'von-mir';

  function select(next: Direction): void {
    router.replace(next === 'mit-mir' ? `${pathname}?ansicht=mit-mir` : pathname, {
      scroll: false,
    });
  }

  return (
    <AppPage maxWidth="max-w-3xl">
      <h1 className="exocortex-page-title">Freigaben</h1>
      <Tabs value={active} onValueChange={(value) => select(value as Direction)} className="mt-6">
        <TabsList className="max-w-sm" data-testid="shares-direction">
          <TabsTrigger value="von-mir" data-testid="shares-tab-mine">
            Von mir geteilt
          </TabsTrigger>
          <TabsTrigger value="mit-mir" data-testid="shares-tab-incoming">
            Mit mir geteilt
          </TabsTrigger>
        </TabsList>
        <TabsContent value="von-mir" className="mt-6">
          <MySharesList />
        </TabsContent>
        <TabsContent value="mit-mir" className="mt-6">
          <IncomingSharesList />
        </TabsContent>
      </Tabs>
    </AppPage>
  );
}
