import { ExocortexWordmark } from '@exocortex/ui';

/** Centered layout for all authentication screens. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10">
      <ExocortexWordmark className="text-base" />
      <div className="w-full max-w-sm">{children}</div>
      <p className="max-w-sm text-center text-xs text-muted-foreground">
        Exocortex ist selbst gehostet. Deine Inhalte bleiben auf diesem Server.
      </p>
    </div>
  );
}
