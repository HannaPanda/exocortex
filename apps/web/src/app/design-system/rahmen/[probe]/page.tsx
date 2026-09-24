import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { NarrowProbeView } from '@/components/design-system/narrow/narrow-probes';
import { isNarrowProbe, NARROW_PROBE_TITLES } from '@/components/design-system/narrow/probes';

/**
 * One styleguide example alone, for the iframe the styleguide shows it in
 * (issue #126). The iframe is 390 px wide, so this page's window is
 * too, and the product's breakpoints answer to a phone. Fixtures only, like
 * `/design-system` itself; every probe is known at build time.
 */
export const metadata: Metadata = { title: 'Designsystem: Rahmen', robots: { index: false } };

export const dynamicParams = false;

export function generateStaticParams(): { probe: string }[] {
  return Object.keys(NARROW_PROBE_TITLES).map((probe) => ({ probe }));
}

export default async function DesignSystemProbeRoute({
  params,
}: {
  params: Promise<{ probe: string }>;
}) {
  const { probe } = await params;
  if (!isNarrowProbe(probe)) notFound();
  return <NarrowProbeView probe={probe} />;
}
