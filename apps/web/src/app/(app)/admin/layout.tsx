import { getTranslations } from 'next-intl/server';

import { AppPage } from '@exocortex/ui';

import { AdminGuard } from '@/components/admin/admin-guard';
import { AdminNav } from '@/components/admin/admin-nav';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations('shell.adminLayout');
  return (
    <AdminGuard>
      <AppPage maxWidth="max-w-5xl">
        <h1 className="exocortex-page-title">{t('title')}</h1>
        <p className="mt-1 max-w-measure text-sm text-muted-foreground">{t('intro')}</p>
        <AdminNav />
        <div className="mt-6">{children}</div>
      </AppPage>
    </AdminGuard>
  );
}
