'use client';

import * as React from 'react';

import {
  type AiModel,
  SETTING_KEYS,
  SETTING_NUMBER_RANGES,
  type SettingKey,
  type Settings,
  updateSettingsRequestSchema,
} from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  AlertTitle,
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

const GROUP_LABELS: Record<string, string> = {
  ai: 'KI',
  memory: 'Gedächtnis',
  search: 'Suche',
  mcp: 'MCP',
  calendar: 'Kalender',
  activity: 'Aktivität',
};

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
  'memory.enabled': {
    label: 'Gedächtnis aktiviert',
    help: 'Erlaubt Agenten, Sitzungen mitzuschreiben und Erinnerungen abzulegen. Aus: es wird nichts mehr geschrieben, gelesen werden kann weiter.',
  },
  'memory.workspaceId': {
    label: 'Arbeitsbereich fürs Gedächtnis',
    help: 'Die Id des Arbeitsbereichs, in den Agenten ihre Notizen schreiben. Sie steht in der Adresszeile eines seiner Seiten hinter /arbeitsbereich/. Ohne Eintrag wird nichts mitgeschrieben. Bewusst nicht der gepflegte Wissensbereich: automatischer Mitschrieb gehört nicht dorthin, wo Menschen etwas nachschlagen.',
  },
  'memory.captureModelSlug': {
    label: 'Modell fürs Verdichten',
    help: 'Fasst eine beendete Sitzung zu wenigen Stichpunkten zusammen. Ohne Eintrag wird das Modell für die Verdichtung von Verläufen genommen, sonst das Standardmodell.',
  },
  'memory.captureMinChars': {
    label: 'Kürzeste Sitzung (Zeichen)',
    help: 'Kürzere Sitzungen werden gar nicht erst angenommen. Kleinkram im Gedächtnis verschlechtert das Wiederfinden.',
  },
  'memory.recallMaxChars': {
    label: 'Obergrenze pro Abruf (Zeichen)',
    help: 'So viel Text darf ein Abruf höchstens zurückgeben. Ein Gedächtnis, das den Kontext auffrisst, den es verbessern soll, hilft nicht.',
  },
  'memory.recallMaxResults': {
    label: 'Obergrenze pro Abruf (Treffer)',
    help: 'Wie viele Erinnerungen ein Abruf höchstens zurückgibt, egal wonach gefragt wurde.',
  },
  'memory.retentionDays': {
    label: 'Notizen aufbewahren (Tage)',
    help: 'Ältere Sitzungsnotizen werden im Gedächtnis-Arbeitsbereich gelöscht. 0 bedeutet: nie aufräumen. Projektseiten bleiben immer stehen, andere Arbeitsbereiche werden nie angefasst.',
  },
  'search.semanticEnabled': {
    label: 'Semantische Suche',
    help: 'Sucht zusätzlich nach Bedeutung statt nur nach Wörtern, damit eine Seite auch dann auftaucht, wenn niemand mehr weiß, wie sie formuliert war. Jede indexierte Seite wird dafür einmal von einem Modell in einen Vektor übersetzt, das kostet ein paar Cent pro Arbeitsbereich.',
  },
  'search.embeddingModelSlug': {
    label: 'Modell für Vektoren',
    help: 'Muss 1536 Dimensionen liefern, so breit ist die Spalte. openai/text-embedding-3-small tut das von sich aus, openai/text-embedding-3-large kürzt auf Wunsch darauf. Ein Modell mit anderer Länge wird abgelehnt statt falsch gespeichert.',
  },
  'search.semanticWeightPercent': {
    label: 'Gewicht der Bedeutung (%)',
    help: 'Wie stark die semantische Trefferliste gegenüber der Volltextliste zählt. 0 ist reiner Volltext, 100 ist reine Bedeutung, 50 wiegt beides gleich.',
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
    label: 'Jeden Schreibzugriff bestätigen lassen',
    help: 'Aus: Nur was nichts rückgängig macht (Seite endgültig löschen, Datenbankspalte, Kommentar, Konto) verlangt eine zweistufige Bestätigung; alles andere schützt der Snapshot vor jedem Schreibvorgang. An: Jedes MCP-Werkzeug, das Daten verändert, muss zweimal identisch aufgerufen werden. Das bremst Agenten spürbar aus.',
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
  'activity.editSessionSnapshotsEnabled': {
    label: 'Bearbeitungssitzungen aufzeichnen',
    help: 'Sichert eine aktiv bearbeitete Seite in regelmäßigen Abständen, damit der Aktivitäts-Reiter echte Zeitspannen zeigen kann ("14:20 bis 14:45 bearbeitet") statt nur des letzten Standes. Aus: es entstehen keine zusätzlichen Sicherungen.',
  },
  'activity.editSessionSnapshotIntervalMinutes': {
    label: 'Abstand zwischen Sitzungs-Sicherungen (Minuten)',
    help: 'So oft darf eine aktiv bearbeitete Seite höchstens neu gesichert werden. Wirkt nur, wenn die Zeile darüber an ist.',
  },
  'activity.snapshotRetentionFullDays': {
    label: 'Volle Aufbewahrung (Tage)',
    help: 'So lange bleiben alle Sicherungen einer Seite erhalten, unabhängig vom Grund.',
  },
  'activity.snapshotRetentionDailyDays': {
    label: 'Tägliche Ausdünnung bis (Tage)',
    help: 'Zwischen der vollen Aufbewahrung und diesem Alter bleibt höchstens eine Sicherung pro Kalendertag übrig, danach höchstens eine pro Woche. Manuell benannte Sicherungen sind davon ausgenommen.',
  },
  'activity.snapshotRetentionDryRun': {
    label: 'Ausdünnung nur simulieren (Trockenlauf)',
    help: 'An: die tägliche Aufräumung berechnet und protokolliert, was sie löschen würde, löscht aber nichts. Vor dem ersten scharfen Lauf empfohlen; danach bewusst ausschalten.',
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

const numberFormat = new Intl.NumberFormat('de-DE');

/**
 * The permitted range in words, for the help text under a numeric field.
 *
 * Derived from `SETTING_NUMBER_RANGES`, never typed out, so it cannot say
 * something different from what the API validates (issue #28).
 */
function rangeHint(key: SettingKey): string | null {
  const range = SETTING_NUMBER_RANGES[key];
  if (range === undefined) return null;
  return `Zulässig: ${numberFormat.format(range.min)} bis ${numberFormat.format(range.max)}.`;
}

/** What to say about a value the schema refused. */
function invalidMessage(key: SettingKey): string {
  const hint = rangeHint(key);
  return hint === null ? 'Dieser Wert ist nicht gültig.' : `Nicht gespeichert. ${hint}`;
}

/**
 * Per-setting messages for a rejected save.
 *
 * The API reports which key failed in `details[].path` (see `ZodValidationPipe`),
 * but the shape crosses an `unknown` boundary, so it is narrowed here instead of
 * trusted. Anything unrecognisable yields no field message and leaves the
 * summary alert as the only feedback.
 */
function fieldErrorsFromDetails(details: unknown): Partial<Record<SettingKey, string>> {
  if (!Array.isArray(details)) return {};
  const errors: Partial<Record<SettingKey, string>> = {};
  for (const entry of details) {
    if (typeof entry !== 'object' || entry === null || !('path' in entry)) continue;
    const path = (entry as { path: unknown }).path;
    // Every setting is a scalar, so the issue path is the setting key itself.
    if (typeof path !== 'string' || !(SETTING_KEYS as readonly string[]).includes(path)) continue;
    errors[path as SettingKey] = invalidMessage(path as SettingKey);
  }
  return errors;
}

interface SettingRowProps {
  settingKey: SettingKey;
  value: Settings[SettingKey];
  onChange: (value: Settings[SettingKey]) => void;
  models: AiModel[];
  /** Set when the last save attempt refused this value. */
  error?: string;
}

/**
 * One form row. The control is derived from the *runtime* value type (plus the
 * `*ModelSlug` naming convention), not from a hardcoded per-key list, so a
 * setting added later to `settingsSchema` renders here automatically.
 */
function SettingRow({ settingKey, value, onChange, models, error }: SettingRowProps) {
  const copy = SETTING_COPY[settingKey];
  const id = inputId(settingKey);
  const errorId = `${id}-error`;

  const choices = SETTING_CHOICES[settingKey];
  const range = SETTING_NUMBER_RANGES[settingKey];
  const hint = rangeHint(settingKey);

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
        // Bounds come from the schema (`SETTING_NUMBER_RANGES`), so the spinner
        // stops where the API does instead of offering values it will refuse.
        {...(range === undefined ? {} : { min: range.min, max: range.max, step: 1 })}
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : errorId}
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
        <p className="text-xs text-muted-foreground">
          {hint === null ? copy.help : `${copy.help} ${hint}`}
        </p>
        {error === undefined ? null : (
          <p id={errorId} className="text-xs text-destructive-text" data-testid={`${id}-error`}>
            {error}
          </p>
        )}
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
  const [fieldErrors, setFieldErrors] = React.useState<Partial<Record<SettingKey, string>>>({});
  // Set when the save was refused before it left the browser; the API's own
  // rejection is reported through `updateSettings.error` instead.
  const [localError, setLocalError] = React.useState(false);

  // Initialise the draft once the query resolves. Setting state directly
  // during render (guarded so it only fires once) is the pattern React
  // recommends for this instead of an effect (react.dev: "Adjusting state
  // when a prop changes") and avoids the cascading-render lint warning an
  // effect-based version would trigger.
  if (draft === null && settingsQuery.data !== undefined) {
    setDraft(settingsQuery.data.settings);
  }

  if (settingsQuery.isPending || settingsQuery.data === undefined || draft === null) {
    return <LoadingState label="Einstellungen werden geladen …" variant="skeleton" rows={6} />;
  }

  // Reassigning into fresh `const`s (rather than referencing `draft` /
  // `settingsQuery.data` directly) keeps the non-null narrowing above valid
  // inside the nested handlers below, which TypeScript otherwise widens back
  // to the declared (nullable) type at a function boundary.
  const original: Settings = settingsQuery.data.settings;
  const currentDraft: Settings = draft;
  // Rows the deployment refused to load. Not an error of this form: the value
  // shown is the default that stepped in, and saving the field replaces the bad
  // row. Named per setting, because "irgendeine Zeile ist kaputt" is what the
  // log already said.
  const ignoredKeys = settingsQuery.data.invalidKeys;
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
    // Editing the offending field retracts its complaint; leaving it standing
    // would make a corrected value still look rejected.
    setFieldErrors((current) => {
      if (current[key] === undefined) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function handleDiscard(): void {
    setDraft(original);
    setSaved(false);
    setFieldErrors({});
    setLocalError(false);
    updateSettings.reset();
  }

  /** Puts the first refused setting on screen; a message out of sight is none. */
  function revealFirstError(errors: Partial<Record<SettingKey, string>>): void {
    const first = SETTING_KEYS.find((key) => errors[key] !== undefined);
    if (first === undefined) return;
    const element = document.getElementById(inputId(first));
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    element?.focus({ preventScroll: true });
  }

  function handleSave(): void {
    const changed: Partial<Settings> = {};
    for (const key of SETTING_KEYS) {
      if (currentDraft[key] !== original[key]) {
        (changed as Record<SettingKey, unknown>)[key] = currentDraft[key];
      }
    }
    if (Object.keys(changed).length === 0) return;

    // The same schema the API validates against, run here first: an
    // out-of-range value is named at its own field straight away instead of
    // coming back as a bare "Die Eingaben sind nicht gültig." (issue #27).
    const parsed = updateSettingsRequestSchema.safeParse(changed);
    if (!parsed.success) {
      const errors: Partial<Record<SettingKey, string>> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (typeof key !== 'string' || !(SETTING_KEYS as readonly string[]).includes(key)) continue;
        errors[key as SettingKey] = invalidMessage(key as SettingKey);
      }
      setFieldErrors(errors);
      setLocalError(true);
      setSaved(false);
      updateSettings.reset();
      revealFirstError(errors);
      return;
    }

    setFieldErrors({});
    setLocalError(false);
    updateSettings.mutate(changed, {
      onSuccess: () => setSaved(true),
      onError: (caught) => {
        // A rejection the local check did not anticipate still has to land at
        // the field it belongs to rather than only in the summary.
        const errors =
          caught instanceof ApiError ? fieldErrorsFromDetails(caught.details) : {};
        setFieldErrors(errors);
        revealFirstError(errors);
      },
    });
  }

  const errorCode = updateSettings.error instanceof ApiError ? updateSettings.error.code : undefined;
  const refusedCount = Object.keys(fieldErrors).length;
  const summaryMessage =
    refusedCount > 0
      ? refusedCount === 1
        ? 'Eine Einstellung liegt außerhalb ihres zulässigen Bereichs und wurde nicht gespeichert. Sie ist im Formular rot markiert.'
        : `${refusedCount} Einstellungen liegen außerhalb ihres zulässigen Bereichs und wurden nicht gespeichert. Sie sind im Formular rot markiert.`
      : messageForCode(errorCode);
  const showError = localError || updateSettings.isError;

  return (
    <div className="flex flex-col gap-8">
      {/* Unlike the two messages further down, this one belongs at the top: it is
          not the answer to a click but a condition that was already true when the
          page opened. */}
      {ignoredKeys.length > 0 ? (
        <Alert variant="destructive" data-testid="settings-invalid-rows">
          <AlertTitle>Gespeicherte Werte werden ignoriert</AlertTitle>
          <AlertDescription>
            {`In der Datenbank steht für ${ignoredKeys.length === 1 ? 'diese Einstellung' : 'diese Einstellungen'} ein unzulässiger Wert: ${ignoredKeys
              .map((key) => SETTING_COPY[key].label)
              .join(', ')}. Die Installation läuft stattdessen mit der Vorgabe. Einmal speichern ersetzt die fehlerhafte Zeile.`}
          </AlertDescription>
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
                  error={fieldErrors[key]}
                />
              ))}
            </div>
          </section>
        ))}
      </fieldset>

      {/* Both messages sit next to the button that triggers them. Above the
          form they would appear several screen heights away from the click,
          which is where the rejection in issue #27 went unnoticed. */}
      {saved ? (
        <Alert data-testid="settings-saved">
          <AlertDescription>Einstellungen gespeichert.</AlertDescription>
        </Alert>
      ) : null}
      {showError ? (
        <Alert variant="destructive" data-testid="settings-error">
          <AlertDescription>{summaryMessage}</AlertDescription>
        </Alert>
      ) : null}

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
