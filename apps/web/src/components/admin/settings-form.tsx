'use client';

import * as React from 'react';

import { type AiModel, SETTING_KEYS, type SettingKey, type Settings } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Button,
  Input,
  Label,
  LoadingState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from '@exocortex/ui';

import { useAdminAiModels, useAdminSettings, useUpdateAdminSettings } from '@/lib/api/admin-queries';
import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';

const GROUP_LABELS: Record<string, string> = { ai: 'KI', mcp: 'MCP', calendar: 'Kalender' };

/** German label and help text for every setting key. Written in the same voice. */
const SETTING_COPY: Record<SettingKey, { label: string; help: string }> = {
  'ai.enabled': {
    label: 'KI aktiviert',
    help: 'Schaltet die eingebaute KI für diese Installation vollständig ein oder aus.',
  },
  'ai.defaultModelSlug': {
    label: 'Standardmodell',
    help: 'Wird verwendet, wenn eine Anfrage kein eigenes Modell angibt.',
  },
  'ai.systemPrompt': {
    label: 'Basis-Systemprompt',
    help: 'Wird jedem Lauf vorangestellt, noch vor etwaigen KI-Regelseiten.',
  },
  'ai.maxOutputTokens': {
    label: 'Maximale Antwortlänge (Tokens)',
    help: 'Obergrenze für die Länge einer einzelnen KI-Antwort.',
  },
  'ai.timeoutMs': {
    label: 'Zeitlimit pro Modellantwort (ms)',
    help: 'Bricht eine einzelne Antwort des Modells ab. Werkzeugaufrufe und Folgeantworten haben ihre eigene Zeit, siehe „Gesamtzeit pro Lauf".',
  },
  'ai.maxRunMs': {
    label: 'Gesamtzeit pro Lauf (ms)',
    help: 'Nach dieser Zeit endet ein Lauf insgesamt, auch wenn er noch Werkzeuge aufruft. Kann nie kürzer sein als das Zeitlimit pro Modellantwort.',
  },
  'ai.budgetMicroUsdPerRun': {
    label: 'Kostenlimit pro Anfrage (µUSD)',
    help: 'Ein Lauf stoppt, sobald dieses Kostenlimit erreicht ist.',
  },
  'ai.toolsEnabled': {
    label: 'Werkzeuge erlauben',
    help: 'Erlaubt der KI, Werkzeuge wie Suche oder Seiten lesen aufzurufen.',
  },
  'ai.mutatingToolsEnabled': {
    label: 'Schreibende Werkzeuge erlauben',
    help: 'Erlaubt der KI zusätzlich, Daten zu verändern statt sie nur zu lesen.',
  },
  'ai.maxToolIterations': {
    label: 'Maximale Werkzeugdurchläufe',
    help: 'Obergrenze für Werkzeugaufrufe innerhalb eines Laufs.',
  },
  'ai.visionEnabled': {
    label: 'Bildbeschreibung aktivieren',
    help: 'Lässt ein Sichtmodell Bilder beschreiben, bevor das Hauptmodell antwortet.',
  },
  'ai.visionMaxImagesPerRun': {
    label: 'Bilder pro Anfrage',
    help: 'Obergrenze für die Anzahl beschriebener Bilder je Lauf.',
  },
  'ai.pageContextEnabled': {
    label: 'Text der geöffneten Seite mitschicken',
    help: 'Aus: Die KI erfährt nur Titel und Pfad der offenen Seite und lädt den Text selbst, wenn eine Frage ihn braucht. An: Der Text geht bei jeder Frage mit, auch wenn sie nichts damit zu tun hat. Nötig für Modelle ohne Werkzeuge, sonst zusätzlicher Datenabfluss zum Anbieter.',
  },
  'ai.pageContextMaxChars': {
    label: 'Zeichen der geöffneten Seite',
    help: 'Obergrenze für den mitgeschickten Seitentext. Was darüber liegt, wird gekürzt, und die Kürzung steht sichtbar im Text.',
  },
  'ai.compactionThresholdPercent': {
    label: 'Zusammenfassen ab (% des Kontextfensters)',
    help: 'Ab diesem Füllstand werden ältere Nachrichten zu einer Zusammenfassung verdichtet.',
  },
  'ai.compactionKeepRecentMessages': {
    label: 'Letzte Nachrichten behalten',
    help: 'So viele der jüngsten Nachrichten bleiben von einer Zusammenfassung unberührt.',
  },
  'ai.compactionModelSlug': {
    label: 'Modell für Zusammenfassungen',
    help: 'Automatisch verwendet dasselbe Modell wie die Unterhaltung.',
  },
  'ai.pdfExtractionEnabled': {
    label: 'PDF-Text extrahieren',
    help: 'Extrahiert den Text aus hochgeladenen PDF-Dateien, damit die KI ihn lesen kann.',
  },
  'ai.pdfExtractor': {
    label: 'PDF-Verfahren',
    help: 'Docling läuft lokal, kostet nichts pro Dokument und liest auch Scans per Texterkennung. OpenRouter braucht keinen eigenen Dienst, wird aber pro Seite abgerechnet und kann keine Scans lesen. Titel, Autor und Datum werden in beiden Fällen direkt aus der Datei gelesen.',
  },
  'ai.pdfExtractorFallbackEnabled': {
    label: 'Zweites Verfahren als Rückfallebene',
    help: 'Findet oder erreicht das gewählte Verfahren nichts, versucht es das jeweils andere. Wirkungslos, wenn nur eines von beiden eingerichtet ist.',
  },
  'ai.pdfExtractionModelSlug': {
    label: 'Modell für PDF-Text',
    help: 'Automatisch verwendet das Standardmodell.',
  },
  'ai.pdfMaxBytes': {
    label: 'Maximale PDF-Größe (Bytes)',
    help: 'PDFs über dieser Größe werden nicht für die Textextraktion angenommen.',
  },
  'ai.imageGenerationEnabled': {
    label: 'Titelbilder erzeugen',
    help: 'Erlaubt es, das Titelbild einer Seite von der KI malen zu lassen. Jedes Bild ist ein kostenpflichtiger Aufruf.',
  },
  'ai.imageModelSlug': {
    label: 'Modell für Bilder',
    help: 'Ein Modell, das Bilder ausgeben kann, zum Beispiel google/gemini-2.5-flash-image. Ohne Eintrag bleibt die Bilderzeugung aus, auch wenn der Schalter darüber an ist.',
  },
  'mcp.enabled': {
    label: 'MCP-Server aktiviert',
    help: 'Erlaubt externen Programmen wie dem MCP-Server den Zugriff auf diese Installation.',
  },
  'mcp.maxSearchResults': {
    label: 'Maximale Suchtreffer',
    help: 'Obergrenze für die Anzahl Ergebnisse einer MCP-Suche.',
  },
  'mcp.writeConfirmationRequired': {
    label: 'Schreibzugriffe bestätigen lassen',
    help: 'Verlangt eine zweistufige Bestätigung, bevor ein MCP-Werkzeug Daten verändert.',
  },
  'calendar.remindersEnabled': {
    label: 'Terminerinnerungen senden',
    help: 'Schickt vor einem gespiegelten Termin eine Nachricht. Braucht zusätzlich einen eingerichteten Versandweg auf dem Server.',
  },
  'calendar.reminderLeadMinutes': {
    label: 'Vorlauf in Minuten',
    help: 'Wie lange vor einem Termin mit Uhrzeit die Erinnerung rausgeht. 0 bedeutet genau zum Beginn.',
  },
  'calendar.reminderAllDayHour': {
    label: 'Uhrzeit für ganztägige Termine',
    help: 'Zu welcher Stunde ganztägige Termine wie Geburtstage angekündigt werden. Sie haben keine Startzeit, von der aus man zurückrechnen könnte.',
  },
  'calendar.timeZone': {
    label: 'Zeitzone',
    help: 'In welcher Zone die beiden Angaben darüber gelesen werden, zum Beispiel Europe/Berlin.',
  },
};

/** Sentinel for "no model chosen"; distinct from every real slug. */
const AUTO_VALUE = '__automatic__';

/**
 * Choices for settings whose schema is a `z.enum`. Only listed keys render as a
 * dropdown; everything else still derives its control from the runtime value
 * type, so an ordinary string setting added later needs no entry here.
 */
const SETTING_CHOICES: Partial<Record<SettingKey, readonly { value: string; label: string }[]>> = {
  'ai.pdfExtractor': [
    { value: 'docling', label: 'Docling (lokal, kostenlos, mit Texterkennung)' },
    { value: 'openrouter', label: 'OpenRouter (gehostet, kostenpflichtig, ohne Texterkennung)' },
  ],
};

function groupOf(key: SettingKey): string {
  return key.split('.')[0] ?? key;
}

function inputId(key: SettingKey): string {
  return `setting-${key.replace(/\./g, '-')}`;
}

interface SettingRowProps {
  settingKey: SettingKey;
  value: Settings[SettingKey];
  onChange: (value: Settings[SettingKey]) => void;
  models: AiModel[];
}

/**
 * One form row. The control is derived from the *runtime* value type (plus the
 * `*ModelSlug` naming convention), not from a hardcoded per-key list, so a
 * setting added later to `settingsSchema` renders here automatically.
 */
function SettingRow({ settingKey, value, onChange, models }: SettingRowProps) {
  const copy = SETTING_COPY[settingKey];
  const id = inputId(settingKey);

  const choices = SETTING_CHOICES[settingKey];

  let control: React.ReactNode;
  if (choices !== undefined) {
    control = (
      <Select value={typeof value === 'string' ? value : ''} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          {/* Base UI shows the raw value without a render function. */}
          <SelectValue>{() => choices.find((choice) => choice.value === value)?.label ?? ''}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {choices.map((choice) => (
            <SelectItem key={choice.value} value={choice.value}>
              {choice.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  } else if (typeof value === 'boolean') {
    control = <Switch id={id} checked={value} onCheckedChange={onChange} />;
  } else if (typeof value === 'number') {
    control = (
      <Input
        id={id}
        type="number"
        value={value}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (!Number.isNaN(next)) onChange(next);
        }}
      />
    );
  } else if (settingKey.endsWith('ModelSlug')) {
    control = (
      <Select
        value={value ?? AUTO_VALUE}
        onValueChange={(next) => onChange(next === AUTO_VALUE ? null : next)}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue>
            {() => models.find((model) => model.slug === value)?.displayName ?? 'Automatisch'}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTO_VALUE}>Automatisch</SelectItem>
          {models.map((model) => (
            <SelectItem key={model.slug} value={model.slug}>
              {model.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  } else if (settingKey === 'ai.systemPrompt') {
    control = (
      <Textarea
        id={id}
        rows={4}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  } else {
    control = (
      <Input
        id={id}
        type="text"
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  return (
    <div className="grid gap-1.5 sm:grid-cols-[minmax(0,240px)_1fr] sm:items-start sm:gap-4">
      <Label htmlFor={id} className="pt-2">
        {copy.label}
      </Label>
      <div className="flex max-w-md flex-col gap-1">
        {control}
        <p className="text-xs text-muted-foreground">{copy.help}</p>
      </div>
    </div>
  );
}

export function SettingsForm() {
  const settingsQuery = useAdminSettings();
  const modelsQuery = useAdminAiModels();
  const updateSettings = useUpdateAdminSettings();

  const [draft, setDraft] = React.useState<Settings | null>(null);
  const [saved, setSaved] = React.useState(false);

  // Initialise the draft once the query resolves. Setting state directly
  // during render (guarded so it only fires once) is the pattern React
  // recommends for this instead of an effect (react.dev: "Adjusting state
  // when a prop changes") and avoids the cascading-render lint warning an
  // effect-based version would trigger.
  if (draft === null && settingsQuery.data !== undefined) {
    setDraft(settingsQuery.data);
  }

  if (settingsQuery.isPending || settingsQuery.data === undefined || draft === null) {
    return <LoadingState label="Einstellungen werden geladen …" variant="skeleton" rows={6} />;
  }

  // Reassigning into fresh `const`s (rather than referencing `draft` /
  // `settingsQuery.data` directly) keeps the non-null narrowing above valid
  // inside the nested handlers below, which TypeScript otherwise widens back
  // to the declared (nullable) type at a function boundary.
  const original: Settings = settingsQuery.data;
  const currentDraft: Settings = draft;
  const dirty = SETTING_KEYS.some((key) => currentDraft[key] !== original[key]);

  const groups = new Map<string, SettingKey[]>();
  for (const key of SETTING_KEYS) {
    const list = groups.get(groupOf(key)) ?? [];
    list.push(key);
    groups.set(groupOf(key), list);
  }

  function updateField(key: SettingKey, value: Settings[SettingKey]): void {
    setDraft((current) => {
      if (current === null) return current;
      // `key` and `value` are always a matching runtime pair from the same
      // control, but TypeScript cannot correlate them across the union here.
      // This assertion is the documented exception (CLAUDE.md rule 7), not a
      // loosening to `any`.
      return { ...current, [key]: value } as Settings;
    });
    setSaved(false);
  }

  function handleDiscard(): void {
    setDraft(original);
    setSaved(false);
  }

  function handleSave(): void {
    const changed: Partial<Settings> = {};
    for (const key of SETTING_KEYS) {
      if (currentDraft[key] !== original[key]) {
        (changed as Record<SettingKey, unknown>)[key] = currentDraft[key];
      }
    }
    if (Object.keys(changed).length === 0) return;
    updateSettings.mutate(changed, { onSuccess: () => setSaved(true) });
  }

  const errorCode = updateSettings.error instanceof ApiError ? updateSettings.error.code : undefined;

  return (
    <div className="flex flex-col gap-8">
      {saved ? (
        <Alert data-testid="settings-saved">
          <AlertDescription>Einstellungen gespeichert.</AlertDescription>
        </Alert>
      ) : null}
      {updateSettings.isError ? (
        <Alert variant="destructive" data-testid="settings-error">
          <AlertDescription>{messageForCode(errorCode)}</AlertDescription>
        </Alert>
      ) : null}

      <fieldset disabled={updateSettings.isPending} className="flex flex-col gap-8 border-0 p-0">
        {[...groups.entries()].map(([group, keys]) => (
          <section key={group} className="flex flex-col gap-4">
            <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
              {GROUP_LABELS[group] ?? group}
            </h2>
            <div className="flex flex-col gap-4">
              {keys.map((key) => (
                <SettingRow
                  key={key}
                  settingKey={key}
                  value={currentDraft[key]}
                  onChange={(value) => updateField(key, value)}
                  models={modelsQuery.data?.models ?? []}
                />
              ))}
            </div>
          </section>
        ))}
      </fieldset>

      <div className="flex gap-2">
        <Button onClick={handleSave} disabled={!dirty || updateSettings.isPending}>
          Speichern
        </Button>
        <Button
          variant="outline"
          onClick={handleDiscard}
          disabled={!dirty || updateSettings.isPending}
        >
          Verwerfen
        </Button>
      </div>
    </div>
  );
}
