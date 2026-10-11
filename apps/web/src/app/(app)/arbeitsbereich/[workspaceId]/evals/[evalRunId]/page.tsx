import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { EvalRunDetail } from '@/components/evals/eval-run-detail';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('evals.route');
  return { title: t('runTitle') };
}

export default async function WorkspaceEvalRunPage({
  params,
}: {
  params: Promise<{ workspaceId: string; evalRunId: string }>;
}) {
  const { workspaceId, evalRunId } = await params;
  return <EvalRunDetail workspaceId={workspaceId} evalRunId={evalRunId} />;
}
