import { type QUEUE_NAMES } from '@exocortex/contracts';
import { type RedisEventBus } from '@exocortex/queue';

/**
 * The queues whose jobs report live progress to the browser, and the event
 * they report with.
 *
 * Everything else is excluded by name, each for a reason of its own.
 * `attachment-text` and `document-cover` are out because
 * `jobProgressPayloadSchema.queue` (frozen in `packages/contracts`) only ever
 * accepted the four original queues; cover generation reports its own outcome
 * through `document.cover.generated` instead.
 */
export interface JobProgressEvent {
  queue: Exclude<
    (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES],
    | typeof QUEUE_NAMES.attachmentText
    | typeof QUEUE_NAMES.documentCover
    // Nor does a composition: it runs minutes after the edit that caused it,
    // and reports through `document.overview.updated` (issue #53).
    | typeof QUEUE_NAMES.documentOverview
    // The calendar sync has no workspace in its payload and no browser
    // waiting on it, so it reports nothing over the progress channel.
    | typeof QUEUE_NAMES.calendarSync
    // Nor does memory capture: by the time it runs, the session that
    // triggered it has ended and its editor is gone.
    | typeof QUEUE_NAMES.memoryCapture
    // Nor does consolidation, which runs in the middle of the night.
    | typeof QUEUE_NAMES.memoryConsolidate
    // Nor does an entity rescan: nobody is waiting on it, and the page it
    // would report about is not the page anybody has open.
    | typeof QUEUE_NAMES.entityRescan
    // Nor does an automation: its progress is its run log, because it runs
    // for a rule somebody set up weeks ago, usually with nobody watching.
    | typeof QUEUE_NAMES.automation
    // Nor does a render: a build reports through `render.job.updated`, which
    // carries the status the dialog is actually waiting for, and a percentage
    // would be a guess -- nothing inside a LaTeX run says how far along it is.
    | typeof QUEUE_NAMES.render
    // Nor does a project build, for the same reason (issue #43, ADR-027):
    // `project.build.updated` carries the status, and latexmk says nothing
    // about how far through its passes it is.
    | typeof QUEUE_NAMES.projectBuild
    // Nor does a push notification: the device it is aimed at is precisely
    // the one nobody is looking at (issue #30, ADR-048).
    | typeof QUEUE_NAMES.push
    // Nor does a mail, for the same reason one layer further out: it has no
    // workspace, and its reader is not in a browser here (issue #102).
    | typeof QUEUE_NAMES.mail
  >;
  workspaceId: string;
  correlationId: string;
  jobId: string;
  progress: number;
  label: string;
  documentId: string | null;
}

/** Publishes a `job.progress` event so the UI can show live progress. */
export function createProgressPublisher(
  bus: RedisEventBus,
): (event: JobProgressEvent) => Promise<void> {
  return async (event) => {
    const { queue, workspaceId, correlationId, jobId, progress, label, documentId } = event;
    await bus.publish({
      type: 'job.progress',
      workspaceId,
      correlationId,
      emittedAt: new Date().toISOString(),
      payload: { jobId, queue, progress, label, documentId },
    });
  };
}
