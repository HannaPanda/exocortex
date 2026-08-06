import { AdminGuard } from '@/components/admin/admin-guard';
import { AdminNav } from '@/components/admin/admin-nav';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <AdminGuard>
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Verwaltung</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Einstellungen, KI-Modelle und Nutzerverwaltung dieser Installation.
        </p>
        <AdminNav />
        <div className="mt-6">{children}</div>
      </div>
    </AdminGuard>
  );
}
