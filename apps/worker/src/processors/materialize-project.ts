import { type Prisma, type PrismaClient } from '@exocortex/database';
import { readProjectTree, yjsStateToDocument } from '@exocortex/editor';

/**
 * Rebuilds a project's `ProjectFile` rows from its canonical Yjs state
 * (issue #43, ADR-027).
 *
 * The project half of materialization. A `PROJECT` document's Yjs state holds a
 * map of paths rather than a ProseMirror document, so nothing the page half
 * does applies: there is no Markdown to serialize, no reference index to
 * rebuild and no prose to hand to the entity extraction. What there is instead
 * is a projection, so that reading a project does not mean decoding a CRDT and
 * so that a path can be joined against.
 *
 * The rows are derived and are treated as such: the whole set is reconciled
 * against the tree every time. A row for a path that no longer exists is
 * deleted rather than kept as history -- history is the project document's
 * snapshots, which hold the state these rows were derived from.
 */
export async function materializeProject(
  prisma: PrismaClient,
  input: { documentId: string; yjsState: Uint8Array; materializedAt: Date },
): Promise<{ paths: string[]; textFiles: number; assets: number }> {
  const doc = yjsStateToDocument(input.yjsState);
  let entries;
  try {
    entries = readProjectTree(doc);
  } finally {
    doc.destroy();
  }

  const paths = entries.map((entry) => entry.path);

  // An asset entry names an attachment, and the attachment may be gone: the
  // tree is a CRDT that nothing stops a client from writing, and hard-deleting
  // a file is allowed. A foreign key on a vanished id would fail the whole
  // materialization, so the reference is dropped and the path stays -- a
  // visible hole in the tree, which is the truth.
  const referenced = entries
    .map((entry) => entry.attachmentId)
    .filter((id): id is string => id !== null);
  const known =
    referenced.length === 0
      ? new Set<string>()
      : new Set(
          (
            await prisma.attachment.findMany({
              where: { id: { in: referenced } },
              select: { id: true },
            })
          ).map((row) => row.id),
        );

  await prisma.$transaction(async (tx) => {
    // Everything that is no longer in the tree goes, in one statement rather
    // than one per path: a recursive delete of a chapter directory would
    // otherwise be forty round trips.
    await tx.projectFile.deleteMany({
      where:
        paths.length === 0
          ? { projectId: input.documentId }
          : { projectId: input.documentId, path: { notIn: paths } },
    });

    for (const entry of entries) {
      const attachmentId =
        entry.kind === 'ASSET' && entry.attachmentId !== null && known.has(entry.attachmentId)
          ? entry.attachmentId
          : null;
      const data = {
        kind: entry.kind,
        content: entry.kind === 'TEXT' ? (entry.content ?? '') : null,
        attachmentId,
        byteSize: entry.byteSize,
      } satisfies Prisma.ProjectFileUncheckedUpdateInput;

      await tx.projectFile.upsert({
        where: { projectId_path: { projectId: input.documentId, path: entry.path } },
        create: { projectId: input.documentId, path: entry.path, ...data },
        update: data,
      });
    }

    await tx.project.update({
      where: { documentId: input.documentId },
      data: { materializedAt: input.materializedAt },
    });
  });

  return {
    paths,
    textFiles: entries.filter((entry) => entry.kind === 'TEXT').length,
    assets: entries.filter((entry) => entry.kind === 'ASSET').length,
  };
}
