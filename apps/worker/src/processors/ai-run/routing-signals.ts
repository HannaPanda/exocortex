import { type ToolRoutingSignal } from '@exocortex/contracts';
import { type AiRun, type PrismaClient } from '@exocortex/database';

/**
 * What the open page carries, for the tool routing (issue #206).
 *
 * "Was zeigt diese Skizze?" names no file and no picture, in any language,
 * and phase 0 measured that no router recovers the attachment tools from such
 * words alone as reliably as the page can say it: a page with a picture or a
 * PDF on it needs `attachments`. A cover is not content of the page and does
 * not count.
 */
export async function pageRoutingSignals(
  prisma: PrismaClient,
  run: AiRun,
): Promise<ToolRoutingSignal[]> {
  if (run.documentId === null) return [];
  const attachments = await prisma.attachment.findMany({
    where: { documentId: run.documentId, deletedAt: null, isCover: false },
    select: { mimeType: true },
    take: 200,
  });
  const signals: ToolRoutingSignal[] = [];
  if (attachments.some((attachment) => attachment.mimeType.startsWith('image/'))) {
    signals.push('page_images');
  }
  if (attachments.some((attachment) => attachment.mimeType === 'application/pdf')) {
    signals.push('page_pdfs');
  }
  return signals;
}
