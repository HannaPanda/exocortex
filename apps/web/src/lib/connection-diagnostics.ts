'use client';

import {
  clearConnectionLog,
  connectionLogEntries,
  type ConnectionLogEntry,
  dumpConnectionLog,
  logConnection,
  setConnectionLogConsole,
} from './connection-log';
import { formatProbeReport, probeConnections } from './connection-probe';

/**
 * The console handle for everything in this folder.
 *
 * The two live channels fail without throwing, which leaves the person in front
 * of the tab with an empty console and no way to ask the page what it thinks is
 * happening. This puts five verbs on `window` so they can, from any tab, with
 * no build and no extension:
 *
 *   exocortex.dump()    what the connection did, including before the reload
 *   exocortex.probe()   open both sockets by hand and report what happens
 *   exocortex.clear()   start a clean recording before reproducing the fault
 *   exocortex.quiet()   stop the console output, keep the recording
 *   exocortex.loud()    turn it back on
 *
 * Attached under the plain lowercase identifier, like the package names and the
 * cookie prefix: this is a technical handle, not text a reader sees.
 */
export interface ExocortexDiagnostics {
  /** Prints the recorded history and returns it as text. */
  dump: () => string;
  /** The entries behind {@link dump}, for filtering rather than reading. */
  entries: () => readonly ConnectionLogEntry[];
  /** Opens both sockets directly and prints the result. */
  probe: () => Promise<string>;
  /** Empties the history. */
  clear: () => void;
  /** Silences the console output; the recording continues. */
  quiet: () => void;
  /** Restores the console output. */
  loud: () => void;
}

declare global {
  // `var` is the only declaration form that adds a property to `globalThis`,
  // which is exactly what a console handle has to be.
  var exocortex: ExocortexDiagnostics | undefined;
}

let installed = false;

/**
 * Installs the console handle once per page.
 *
 * Called from the realtime provider, which mounts with the application shell
 * and therefore exists on every signed-in page. Guarded because React mounts an
 * effect twice in development.
 */
export function installConnectionDiagnostics(): void {
  if (typeof window === 'undefined' || installed) return;
  installed = true;

  const diagnostics: ExocortexDiagnostics = {
    dump: () => {
      const text = dumpConnectionLog();
      // oxlint-disable-next-line no-console -- printing is the point of the call.
      console.log(text);
      return text;
    },
    entries: () => connectionLogEntries(),
    probe: async () => {
      const text = formatProbeReport(await probeConnections());
      // oxlint-disable-next-line no-console -- printing is the point of the call.
      console.log(text);
      return text;
    },
    clear: () => clearConnectionLog(),
    quiet: () => setConnectionLogConsole(false),
    loud: () => setConnectionLogConsole(true),
  };

  window.exocortex = diagnostics;
  logConnection('app', 'page.load', {
    url: window.location.pathname,
    online: navigator.onLine,
    visibility: document.visibilityState,
  });
  // oxlint-disable-next-line no-console -- the one line that makes the rest discoverable.
  console.info(
    '%c[exo]%c Verbindungsdiagnose bereit: exocortex.dump(), exocortex.probe()',
    'color:#F9AA33;font-weight:600',
    '',
  );
}
