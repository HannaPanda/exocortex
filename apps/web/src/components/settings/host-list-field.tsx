'use client';

import { XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import type { SettingKey } from '@exocortex/contracts';
import { Button, Input } from '@exocortex/ui';

import {
  entriesOfPastedHosts,
  entriesOfStoredHosts,
  hostNeverMatches,
  type HostProblem,
  hostProblems,
  hostsNoLongerAllowed,
  normalizedHost,
  serializeHosts,
} from '@/lib/webhook-hosts';

/** What the last attempt to add hosts left out, and why. */
interface AddOutcome {
  refused: string[];
  present: string[];
}

const NO_OUTCOME: AddOutcome = { refused: [], present: [] };

/**
 * A list of hosts, one per entry, stored as the comma-separated string the
 * API already reads (issue #173).
 *
 * The entries are the field's own state, because a half-edited entry is not
 * yet a host and an empty one is not a value at all; the stored string is
 * derived from them on every edit. A value that is never touched is never
 * re-emitted, so opening and saving the form leaves the stored spelling as it
 * was. What an entry means is read with the server's own functions
 * (`lib/webhook-hosts.ts`), so the marks under an entry say what the server
 * will do with it and the field never filters what the server would accept:
 * an entry that never matches is marked, not removed.
 */
export function HostListSettingField({
  settingKey,
  value,
  stored,
  onChange,
  described,
  id,
}: {
  settingKey: SettingKey;
  value: string;
  /** The value on the server, to say which hosts a save would stop allowing. */
  stored: string | undefined;
  onChange: (value: string) => void;
  described: { 'aria-describedby': string; 'aria-invalid': boolean };
  id: string;
}) {
  const t = useTranslations('settings.row.hostList');
  const [entries, setEntries] = React.useState(() => entriesOfStoredHosts(value));
  const [synced, setSynced] = React.useState(value);
  const [pending, setPending] = React.useState('');
  const [outcome, setOutcome] = React.useState<AddOutcome>(NO_OUTCOME);
  // A value that changed from outside (a discarded draft, a reload) replaces
  // the entries; one this field emitted itself is already what it shows.
  if (value !== synced) {
    setEntries(entriesOfStoredHosts(value));
    setSynced(value);
    setOutcome(NO_OUTCOME);
  }

  const problems = hostProblems(entries);
  const removed = stored === undefined ? [] : hostsNoLongerAllowed(stored, value);
  const outcomeId = `${id}-hosts-outcome`;

  function commit(next: string[]): void {
    setEntries(next);
    const serialized = serializeHosts(next);
    setSynced(serialized);
    if (serialized !== value) onChange(serialized);
  }

  /**
   * Adds every host in a piece of text, in the server's spelling. An entry
   * that could never match stays in the input to be corrected, rather than
   * entering a list where it would allow nothing; one already allowed by an
   * equal entry is left out and named.
   */
  function add(text: string): void {
    const next = [...entries];
    const refused: string[] = [];
    const present: string[] = [];
    for (const candidate of entriesOfPastedHosts(text)) {
      const host = normalizedHost(candidate) ?? candidate;
      const problem = hostProblems([...next, host]).at(-1) ?? null;
      if (hostNeverMatches(problem)) refused.push(candidate);
      else if (problem?.kind === 'duplicate') present.push(host);
      else next.push(host);
    }
    if (next.length !== entries.length) commit(next);
    setOutcome({ refused, present });
    setPending(refused.join(', '));
  }

  function problemText(problem: HostProblem): string {
    switch (problem.kind) {
      case 'idn':
        return t('problems.idn', { ascii: problem.ascii });
      case 'rewritten':
        return t('problems.rewritten', { host: problem.host });
      case 'covered':
        return t('problems.covered', { host: problem.by });
      default:
        return t(`problems.${problem.kind}`);
    }
  }

  const describedAdd =
    outcome.refused.length + outcome.present.length > 0
      ? `${described['aria-describedby']} ${outcomeId}`
      : described['aria-describedby'];

  return (
    <div className="flex flex-col gap-2" data-testid={`${id}-hosts`}>
      {entries.length > 0 ? (
        <ul className="flex flex-col gap-1.5" aria-label={t('listLabel')}>
          {entries.map((entry, index) => {
            const problem = problems[index] ?? null;
            const problemId = `${id}-host-${index}-problem`;
            const severe = hostNeverMatches(problem);
            return (
              // The position is the identity: two entries may read the same,
              // and that is exactly the case a duplicate mark is about.
              <li key={index} className="flex flex-col gap-1">
                <div className="flex gap-2">
                  <Input
                    name={`${settingKey}[${index}]`}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    className="min-w-0 flex-1 font-mono text-xs"
                    aria-label={t('entryLabel', { position: index + 1 })}
                    aria-invalid={severe}
                    aria-describedby={problem === null ? undefined : problemId}
                    value={entry}
                    data-testid={`${id}-host-${index}`}
                    onChange={(event) =>
                      commit(entries.map((old, at) => (at === index ? event.target.value : old)))
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('remove', { host: entry })}
                    data-testid={`${id}-host-${index}-remove`}
                    onClick={() => commit(entries.filter((_, at) => at !== index))}
                  >
                    <XIcon aria-hidden />
                  </Button>
                </div>
                {problem === null ? null : (
                  <p
                    id={problemId}
                    className={
                      severe ? 'text-xs text-destructive-text' : 'text-xs text-muted-foreground'
                    }
                    data-testid={problemId}
                  >
                    {problemText(problem)}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="flex gap-2">
        <Input
          id={id}
          type="text"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 font-mono text-xs"
          placeholder={t('addPlaceholder')}
          value={pending}
          {...described}
          aria-describedby={describedAdd}
          data-testid={`${id}-add-input`}
          onChange={(event) => setPending(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            // Enter adds the host here; it must not submit anything around it.
            event.preventDefault();
            add(pending);
          }}
          onPaste={(event) => {
            const text = event.clipboardData.getData('text');
            // A single host is pasted like typing; a list is split at once.
            if (!/[\s,;]/.test(text.trim())) return;
            event.preventDefault();
            add(`${pending} ${text}`);
          }}
        />
        <Button
          variant="outline"
          disabled={pending.trim().length === 0}
          data-testid={`${id}-add`}
          onClick={() => add(pending)}
        >
          {t('add')}
        </Button>
      </div>

      {outcome.refused.length + outcome.present.length > 0 ? (
        <div id={outcomeId} className="flex flex-col gap-0.5 text-xs" data-testid={outcomeId}>
          {outcome.refused.length > 0 ? (
            <p className="text-destructive-text">
              {t('refused', {
                count: outcome.refused.length,
                hosts: outcome.refused.join(', '),
              })}
            </p>
          ) : null}
          {outcome.present.length > 0 ? (
            <p className="text-muted-foreground">
              {t('present', {
                count: outcome.present.length,
                hosts: outcome.present.join(', '),
              })}
            </p>
          ) : null}
        </div>
      ) : null}

      {serializeHosts(entries).length === 0 ? (
        <p className="text-xs text-destructive-text" data-testid={`${id}-hosts-empty`}>
          {t('empty')}
        </p>
      ) : null}
      {removed.length > 0 ? (
        <p className="text-xs text-destructive-text" data-testid={`${id}-hosts-removed`}>
          {t('removed', { count: removed.length, hosts: removed.join(', ') })}
        </p>
      ) : null}
    </div>
  );
}
