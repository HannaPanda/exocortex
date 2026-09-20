/**
 * How a working directory becomes the thing a memory is filed under.
 *
 * Its own module rather than a corner of `memory.service.ts` because everything
 * in this folder needs it -- notes, facts, checkpoints and the mailbox -- and
 * the one that needs it *and* is used by the service (`agent-messages.service`)
 * would otherwise close an import cycle around it.
 */

/**
 * One spelling per project.
 *
 * A working directory arrives as `/var/www/exocortex`, `/var/www/exocortex/`
 * or with a trailing newline from a shell, and all three mean the same project.
 * Without this, one project would collect three pages.
 */
export function normaliseProject(raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, ' ');
  const withoutTrailingSlash = collapsed.replace(/\/+$/, '');
  return withoutTrailingSlash.length === 0 ? collapsed : withoutTrailingSlash;
}

/**
 * The page title for a project.
 *
 * The full path, not its last segment: `web` under two different repositories
 * is two projects, and a title that cannot tell them apart would merge their
 * memories. Long paths are cut from the front, because the end is the part that
 * identifies the project.
 */
export function projectLabel(project: string): string {
  const max = 200;
  return project.length <= max ? project : `…${project.slice(project.length - max + 1)}`;
}
