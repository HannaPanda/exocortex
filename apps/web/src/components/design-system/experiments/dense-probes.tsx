'use client';

import { PlusIcon } from 'lucide-react';
import * as React from 'react';

import type { SettingKey, Settings } from '@exocortex/contracts';
import {
  Badge,
  Button,
  cn,
  Label,
  SectionRule,
  Switch,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exocortex/ui';

import { SETTING_COPY } from '@/components/settings/setting-copy';
import { inputId, invalidMessage, SettingRow } from '@/components/settings/setting-row';

import { DENSE_PROBE_TITLES, type DenseProbe } from './probes';

/**
 * P12's variants, each drawn alone so `/design-system/rahmen/<probe>` can show
 * it in a window 390 px wide (issue #126). The product's components switch at
 * the window's breakpoints, which is why these live in a frame of their own
 * rather than in a narrow box on the styleguide.
 *
 * All table variants read `TOKENS` and offer the same two actions; all
 * settings variants read `SETTINGS` and show the same four states. A variant
 * that looks better by showing less would answer a different question.
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

function TokenSection({ children }: { children: React.ReactNode }) {
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
      {children}
    </section>
  );
}

function RevokeButton({ token }: { token: TokenRow }) {
  return (
    <Button variant="outline" size="sm" aria-label={`${token.name} zurückziehen`}>
      Zurückziehen
    </Button>
  );
}

/** A: the product today, `Table` scrolling sideways inside its own container. */
function TableScroll() {
  return (
    <TokenSection>
      <Table>
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
              <TableCell className="font-medium">{token.name}</TableCell>
              <TableCell>
                <Badge variant="secondary">{token.scope}</Badge>
              </TableCell>
              <TableCell className="exocortex-numeric">{token.created}</TableCell>
              <TableCell>{token.used}</TableCell>
              <TableCell className="text-right">
                <RevokeButton token={token} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TokenSection>
  );
}

/** B: one row per token as a list entry, the fields as a description list. */
function TableList() {
  return (
    <TokenSection>
      <ul className="flex flex-col divide-y divide-border border-y border-border">
        {TOKENS.map((token) => (
          <li key={token.name} className="flex flex-col gap-2 py-3">
            <div className="flex items-start justify-between gap-3">
              <h3 className="min-w-0 text-sm font-medium break-words">{token.name}</h3>
              <RevokeButton token={token} />
            </div>
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Rechte</dt>
              <dd>
                <Badge variant="secondary">{token.scope}</Badge>
              </dd>
              <dt className="text-muted-foreground">Angelegt</dt>
              <dd className="exocortex-numeric">{token.created}</dd>
              <dt className="text-muted-foreground">Zuletzt benutzt</dt>
              <dd>{token.used}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </TokenSection>
  );
}

const PINNED = 'sticky z-10 bg-background';

/** C: the table stays a table; the name is pinned left and the action right, the rest scrolls between. */
function TablePinned() {
  return (
    <TokenSection>
      <Table>
        <TableCaption className="exocortex-sr-only">Aktive Zugangstokens</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead className={cn(PINNED, 'left-0 border-r border-border')}>Name</TableHead>
            <TableHead>Rechte</TableHead>
            <TableHead>Angelegt</TableHead>
            <TableHead>Zuletzt benutzt</TableHead>
            <TableHead className={cn(PINNED, 'right-0 border-l border-border text-right')}>
              Aktionen
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {TOKENS.map((token) => (
            <TableRow key={token.name}>
              <TableCell
                className={cn(
                  PINNED,
                  'left-0 max-w-32 min-w-28 border-r border-border font-medium whitespace-normal',
                )}
              >
                {token.name}
              </TableCell>
              <TableCell>
                <Badge variant="secondary">{token.scope}</Badge>
              </TableCell>
              <TableCell className="exocortex-numeric">{token.created}</TableCell>
              <TableCell>{token.used}</TableCell>
              <TableCell className={cn(PINNED, 'right-0 border-l border-border text-right')}>
                <RevokeButton token={token} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TokenSection>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Four rows, one per hard case: a switch with a workspace override (the
 * destructive action is resetting it), a choice with long labels, a number
 * holding a refused value, and a long free text.
 */
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

const OVERRIDDEN: ReadonlySet<SettingKey> = new Set(['ai.enabled', 'ai.untrustedContentPolicy']);
const REFUSED: SettingKey = 'ai.timeoutMs';

function useSettingsFixture() {
  const [values, setValues] = React.useState<Partial<Settings>>(INITIAL);
  const [reset, setReset] = React.useState<SettingKey[]>([]);
  return {
    values,
    change: (key: SettingKey, value: Settings[SettingKey]) =>
      setValues((current) => ({ ...current, [key]: value })),
    reset,
    queueReset: (key: SettingKey) => setReset((current) => [...current, key]),
  };
}

type Fixture = ReturnType<typeof useSettingsFixture>;

function OverrideLine({
  settingKey,
  fixture,
  className,
}: {
  settingKey: SettingKey;
  fixture: Fixture;
  className?: string;
}) {
  if (fixture.reset.includes(settingKey)) {
    return (
      <div className={className}>
        <Badge variant="outline">Wird zurückgesetzt</Badge>
      </div>
    );
  }
  if (!OVERRIDDEN.has(settingKey)) {
    return (
      <div className={className}>
        <span className="text-xs text-muted-foreground">Geerbt aus der Installation</span>
      </div>
    );
  }
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <Badge variant="secondary">Eigener Wert</Badge>
      <Button variant="ghost" size="sm" onClick={() => fixture.queueReset(settingKey)}>
        Auf Installationswert zurücksetzen
      </Button>
    </div>
  );
}

function ActionBar({ className }: { className?: string }) {
  return (
    <div className={cn('flex gap-2', className)}>
      <Button>Speichern</Button>
      <Button variant="outline">Verwerfen</Button>
    </div>
  );
}

/** A: the workspace settings form as it is, rows and override line unchanged. */
function SettingsAsIs() {
  const fixture = useSettingsFixture();
  return (
    <div className="flex flex-col gap-4 p-4">
      <h2 className="text-subsection">KI</h2>
      {SETTINGS_KEYS.map((key) => (
        <div key={key} className="flex flex-col gap-1">
          <SettingRow
            settingKey={key}
            value={fixture.values[key] ?? null}
            onChange={(value) => fixture.change(key, value)}
            models={[]}
            error={key === REFUSED ? invalidMessage(key) : undefined}
          />
          <OverrideLine settingKey={key} fixture={fixture} className="sm:pl-[calc(240px+1rem)]" />
        </div>
      ))}
      <ActionBar className="border-t border-border pt-3" />
    </div>
  );
}

/**
 * B: set for a narrow window on purpose. A switch sits on its label's line,
 * the override state stands beside the label instead of under the help text,
 * rows are separated by rules, and the save bar sticks to the bottom at full
 * width. The controls are the same `SettingRow` wherever a row is not a switch.
 */
function SettingsNarrow() {
  const fixture = useSettingsFixture();
  return (
    <div className="flex min-h-full flex-col">
      <h2 className="text-subsection px-4 pt-4">KI</h2>
      <div className="flex flex-1 flex-col divide-y divide-border px-4">
        {SETTINGS_KEYS.map((key) =>
          key === 'ai.enabled' ? (
            <div key={key} className="flex flex-col gap-1.5 py-4">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor={`${inputId(key)}-narrow`}>{SETTING_COPY[key].label}</Label>
                <Switch
                  id={`${inputId(key)}-narrow`}
                  checked={fixture.values[key] === true}
                  onCheckedChange={(checked) => fixture.change(key, checked)}
                />
              </div>
              <p className="text-xs text-muted-foreground">{SETTING_COPY[key].help}</p>
              <OverrideLine settingKey={key} fixture={fixture} />
            </div>
          ) : (
            <div key={key} className="flex flex-col gap-1.5 py-4">
              <SettingRow
                settingKey={key}
                value={fixture.values[key] ?? null}
                onChange={(value) => fixture.change(key, value)}
                models={[]}
                error={key === REFUSED ? invalidMessage(key) : undefined}
              />
              <OverrideLine settingKey={key} fixture={fixture} />
            </div>
          ),
        )}
      </div>
      <ActionBar className="sticky bottom-0 border-t border-border bg-background p-3 [&>*]:flex-1" />
    </div>
  );
}

const RENDERERS: Record<DenseProbe, () => React.JSX.Element> = {
  'p12-tabelle-a': TableScroll,
  'p12-tabelle-b': TableList,
  'p12-tabelle-c': TablePinned,
  'p12-einstellungen-a': SettingsAsIs,
  'p12-einstellungen-b': SettingsNarrow,
};

export function DenseProbeView({ probe }: { probe: DenseProbe }) {
  const Probe = RENDERERS[probe];
  return (
    <main className="min-h-dvh bg-background">
      <h1 className="exocortex-sr-only">{DENSE_PROBE_TITLES[probe]}</h1>
      <Probe />
    </main>
  );
}
