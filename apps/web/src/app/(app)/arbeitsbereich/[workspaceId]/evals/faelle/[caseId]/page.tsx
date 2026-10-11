import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { EvalCaseDetail } from '@/components/evals/eval-case-detail';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('evals.route');
  return { title: t('caseTitle') };
}

export default async function WorkspaceEvalCasePage({
  params,
}: {
  params: Promise<{ workspaceId: string; caseId: string }>;
}) {
  const { workspaceId, caseId } = await params;
  return <EvalCaseDetail workspaceId={workspaceId} caseId={caseId} />;
}
