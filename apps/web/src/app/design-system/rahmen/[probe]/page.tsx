import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { DenseProbeView } from '@/components/design-system/experiments/dense-probes';
import { DENSE_PROBE_TITLES, isDenseProbe } from '@/components/design-system/experiments/probes';

/**
 * One experiment variant alone, for the iframe the styleguide shows it in
 * (issue #126). The iframe is 390 px wide, so this page's window is too, and
 * the product's breakpoints answer to a phone. Fixtures only, like
 * `/design-system` itself; every probe is known at build time.
 */
export const metadata: Metadata = { title: 'Designsystem: Rahmen', robots: { index: false } };

export const dynamicParams = false;

export function generateStaticParams(): { probe: string }[] {
  return Object.keys(DENSE_PROBE_TITLES).map((probe) => ({ probe }));
}

export default async function DesignSystemProbeRoute({
  params,
}: {
  params: Promise<{ probe: string }>;
}) {
  const { probe } = await params;
  if (!isDenseProbe(probe)) notFound();
  return <DenseProbeView probe={probe} />;
}
