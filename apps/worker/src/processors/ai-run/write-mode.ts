import {
  type AiMessage,
  type AiWriteMode,
  type Settings,
  strictestWriteMode,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

/**
 * The write mode a run is held to (issue #141, ADR-070): the stricter of the
 * workspace's `ai.writeMode` and the work item's own, when the run is an
 * attempt at one. Read from the database when the run starts, never from the
 * job payload, so nothing a request carried can loosen it.
 */
export async function resolveRunWriteMode(input: {
  prisma: PrismaClient;
  run: { workItemId: string | null };
  settings: Pick<Settings, 'ai.writeMode'>;
}): Promise<AiWriteMode> {
  const work =
    input.run.workItemId === null
      ? null
      : await input.prisma.workItem.findUnique({
          where: { id: input.run.workItemId },
          select: { writeMode: true },
        });
  const own = work?.writeMode == null ? null : (work.writeMode.toLowerCase() as AiWriteMode);
  return strictestWriteMode(input.settings['ai.writeMode'], own);
}

/** The column's spelling of a mode. */
export function writeModeColumn(mode: AiWriteMode): 'READ_ONLY' | 'PROPOSE' | 'DIRECT' {
  return mode.toUpperCase() as 'READ_ONLY' | 'PROPOSE' | 'DIRECT';
}

/**
 * What the model is told about its mode, before the conversation. The tool
 * loop and the API refuse regardless; this saves the turn a refused write
 * would cost, and says what to do instead.
 */
export function writeModeMessage(mode: AiWriteMode): AiMessage | null {
  if (mode === 'direct') return null;
  return {
    role: 'system',
    content:
      mode === 'propose'
        ? 'Dieser Lauf arbeitet im Vorschlagsmodus: Du schreibst keine Seite selbst. Jede ' +
          'Änderung an einer Seite schlägst du mit exo_changeset_propose vor (eine Änderung pro ' +
          'Aufruf, beim ersten ohne changesetId, danach mit der zurückgegebenen), und reichst ' +
          'den Vorschlag am Ende mit exo_changeset_submit ein. Ein Mensch prüft ihn und ' +
          'übernimmt, was passt. Über deinen Auftrag berichten darfst du wie sonst auch.'
        : 'Dieser Lauf darf nur lesen und über seinen Auftrag berichten, nichts verändern und ' +
          'nichts vorschlagen. Sage in deiner Antwort, was du ändern würdest.',
  };
}
