import { createHash } from 'node:crypto';

const DEFAULT_TTL_MS = 300_000;

/**
 * Sorts object keys recursively so the same payload always serializes to the
 * same string, regardless of property insertion order.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deriveKey(input: { toolName: string; target: string; payload: unknown }): string {
  const material = `${input.toolName}\n${input.target}\n${stableStringify(input.payload)}`;
  return createHash('sha256').update(material).digest('hex');
}

interface PendingEntry {
  expiresAt: number;
}

/**
 * Two-step confirmation for mutating tools.
 *
 * The pending key is derived server-side from the tool name, its declared
 * write target and a hash of the payload. A client cannot fabricate a
 * confirmation for an operation it did not first request, and it cannot swap
 * the payload between the announcement and the confirmation. This exists
 * because flauschibrain shipped a confirmation gate keyed on a client-supplied
 * token *twice* — that lets a model confirm an operation it never announced.
 */
export class WriteConfirmationGate {
  private readonly ttlMs: number;
  private readonly pending = new Map<string, PendingEntry>();

  constructor(options?: { ttlMs?: number }) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Returns 'confirmed' when a matching pending entry exists (and consumes
   * it), otherwise records the entry and returns 'pending' with the German
   * prompt.
   */
  check(input: {
    toolName: string;
    target: string;
    payload: unknown;
  }): { state: 'confirmed' } | { state: 'pending'; message: string } {
    this.prune();
    const key = deriveKey(input);
    const entry = this.pending.get(key);
    if (entry !== undefined && entry.expiresAt > Date.now()) {
      this.pending.delete(key);
      return { state: 'confirmed' };
    }
    this.pending.set(key, { expiresAt: Date.now() + this.ttlMs });
    return {
      state: 'pending',
      message:
        `Dieser Vorgang verändert Daten (${input.toolName} auf ${input.target}). ` +
        'Rufe das Werkzeug mit denselben Parametern erneut auf, um zu bestätigen.',
    };
  }

  /** Drops expired entries. Called on every `check`. */
  prune(now: number = Date.now()): void {
    for (const [key, entry] of this.pending.entries()) {
      if (entry.expiresAt <= now) {
        this.pending.delete(key);
      }
    }
  }
}
