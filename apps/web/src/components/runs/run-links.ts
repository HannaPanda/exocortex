/** Where a run's inspector lives: inside its workspace, so the shell knows where you are. */
export function runInspectorHref(workspaceId: string, runId: string): string {
  return `/arbeitsbereich/${workspaceId}/laeufe/${runId}`;
}

/** The short address, for a link that knows the run but not its workspace. */
export function runInspectorShortHref(runId: string): string {
  return `/laeufe/${runId}`;
}
