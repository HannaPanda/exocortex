'use client';

import { PlusIcon } from 'lucide-react';
import * as React from 'react';

import type { SettingKey, Settings } from '@exocortex/contracts';
import {
  Badge,
  Button,
  SectionRule,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exocortex/ui';

import {
  SETTING_LIST_CLASS,
  SettingRow,
  useSettingMessages,
} from '@/components/settings/setting-row';
import { SettingsActionBar } from '@/components/settings/unsaved-changes-guard';

import { NARROW_PROBE_TITLES, type NarrowProbe } from './probes';

/**
 * The dense surfaces as a phone shows them (P12, decided 2026-09-24), each
 * drawn alone so `/design-system/rahmen/<probe>` can put it in a window 390 px
 * wide. Built from the product's own `Table` and `SettingRow`, not from a
 * drawing of them: what changes here changes in the product.
 */

interface TokenRow {
  name: string;
  scope: string;
  created: string;
  used: string;
}

const TOKENS: readonly TokenRow[] = [
  { name: 'Hermes', scope: 'Lesen, Schreiben', created: '12.08.2026', used: 'vor 3 Minuten' },
  { name: 'Claude Code', scope: 'Lesen, Schreiben', created: '16.09.2026', used: 'gestern' },
  {
    name: 'Nächtlicher Import aus dem Laborrechner',
    scope: 'Lesen',
    created: '02.09.2026',
    used: 'nie',
  },
];

function TableAsList() {
  return (
    <section className="flex flex-col gap-3 p-4">
      <SectionRule
        as="h2"
        trailing={TOKENS.length}
        action={
          <Button size="sm" variant="outline">
            <PlusIcon /> Token anlegen
          </Button>
        }
      >
        Aktive Tokens
      </SectionRule>
      <Table narrow="list">
        <TableCaption className="exocortex-sr-only">Aktive Zugangstokens</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Rechte</TableHead>
            <TableHead>Angelegt</TableHead>
            <TableHead>Zuletzt benutzt</TableHead>
            <TableHead className="text-right">Aktionen</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {TOKENS.map((token) => (
            <TableRow key={token.name}>
              <TableCell cell="title">{token.name}</TableCell>
              <TableCell label="Rechte">
                <Badge variant="secondary">{token.scope}</Badge>
              </TableCell>
              <TableCell label="Angelegt" className="exocortex-numeric">
                {token.created}
              </TableCell>
              <TableCell label="Zuletzt benutzt">{token.used}</TableCell>
              <TableCell cell="actions" className="text-right">
                <Button variant="outline" size="sm" aria-label={`${token.name} zurückziehen`}>
                  Zurückziehen
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

/** A switch, a select with long entries, a number holding a refused value, a long text. */
const SETTINGS_KEYS = [
  'ai.enabled',
  'ai.untrustedContentPolicy',
  'ai.timeoutMs',
  'ai.systemPrompt',
] as const satisfies readonly SettingKey[];

const INITIAL: Partial<Settings> = {
  'ai.enabled': true,
  'ai.untrustedContentPolicy': 'guarded',
  'ai.timeoutMs': 9_000_000,
  'ai.systemPrompt':
    'Antworte auf Deutsch, knapp und ohne Gedankenstriche. Nenne bei jeder Aussage über eine Seite deren Titel, und frag nach, bevor du mehr als eine Seite änderst.',
};

const REFUSED: SettingKey = 'ai.timeoutMs';

function SettingsNarrow() {
  const { invalidMessage } = useSettingMessages();
  const [values, setValues] = React.useState<Partial<Settings>>(INITIAL);
  return (
    <div className="flex min-h-full flex-col px-6 pt-4">
      <h2 className="text-subsection">KI</h2>
      <div className={SETTING_LIST_CLASS}>
        {SETTINGS_KEYS.map((key) => (
          <div key={key} className="max-sm:py-4">
            <SettingRow
              settingKey={key}
              value={values[key] ?? null}
              onChange={(value) => setValues((current) => ({ ...current, [key]: value }))}
              models={[]}
              error={key === REFUSED ? invalidMessage(key) : undefined}
            />
          </div>
        ))}
      </div>
      {/* Dirty, so the bar sticks as it does in the product with a change pending. */}
      <SettingsActionBar dirty>
        <div className="flex gap-2">
          <Button>Speichern</Button>
          <Button variant="outline">Verwerfen</Button>
        </div>
      </SettingsActionBar>
    </div>
  );
}

const RENDERERS: Record<NarrowProbe, () => React.JSX.Element> = {
  'tabelle-liste': TableAsList,
  einstellungen: SettingsNarrow,
};

export function NarrowProbeView({ probe }: { probe: NarrowProbe }) {
  const Probe = RENDERERS[probe];
  return (
    <main className="min-h-dvh bg-background">
      <h1 className="exocortex-sr-only">{NARROW_PROBE_TITLES[probe]}</h1>
      <Probe />
    </main>
  );
}
