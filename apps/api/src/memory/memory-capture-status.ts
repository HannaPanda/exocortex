import {
  memoryCaptureJobResultSchema,
  type MemoryCaptureStatusResponse,
  QUEUE_NAMES,
} from '@exocortex/contracts';
import { type QueueRegistry } from '@exocortex/queue';

/**
 * Where one queued capture stands (issue #188).
 *
 * The job is the only record: nothing about a capture is stored before the
 * note itself, and a finished job is kept for an hour. A job queued for
 * somebody else answers exactly like one that does not exist.
 */
export async function readCaptureStatus(
  queues: QueueRegistry,
  userId: string,
  jobId: string,
): Promise<MemoryCaptureStatusResponse> {
  const notFound: MemoryCaptureStatusResponse = {
    jobId,
    state: 'not_found',
    outcome: null,
    documentId: null,
    reason: null,
  };
  const job = await queues.getQueue(QUEUE_NAMES.memoryCapture).getJob(jobId);
  if (job === undefined || job.data.userId !== userId) return notFound;

  const state = await job.getState();
  if (state === 'completed') {
    const result = memoryCaptureJobResultSchema.safeParse(job.returnvalue);
    // A job finished by a worker from before the outcome existed returns
    // nothing; it completed, and that is all that can be said about it.
    return {
      ...notFound,
      state: 'completed',
      outcome: result.success ? result.data.outcome : null,
      documentId: result.success ? result.data.documentId : null,
    };
  }
  if (state === 'failed') {
    return { ...notFound, state: 'failed', reason: job.failedReason || null };
  }
  if (state === 'active') return { ...notFound, state: 'running' };
  if (state === 'unknown') return notFound;
  return { ...notFound, state: 'queued' };
}
