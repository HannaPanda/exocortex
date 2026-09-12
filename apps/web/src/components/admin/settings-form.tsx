'use client';

import * as React from 'react';

import {
  SETTING_KEYS,
  type SettingKey,
  type Settings,
  updateSettingsRequestSchema,
} from '@exocortex/contracts';
import { Alert, AlertDescription, AlertTitle, Button, LoadingState } from '@exocortex/ui';

import {
  fieldErrorsFromDetails,
  GROUP_LABELS,
  groupOf,
  inputId,
  invalidMessage,
  SETTING_COPY,
  SettingRow,
} from '@/components/settings/setting-row';
import {
  useAdminAiModels,
  useAdminSettings,
  useUpdateAdminSettings,
} from '@/lib/api/admin-queries';
import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';

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
        const errors = caught instanceof ApiError ? fieldErrorsFromDetails(caught.details) : {};
        setFieldErrors(errors);
        revealFirstError(errors);
      },
    });
  }

  const errorCode =
    updateSettings.error instanceof ApiError ? updateSettings.error.code : undefined;
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
              .join(
                ', ',
              )}. Die Installation läuft stattdessen mit der Vorgabe. Einmal speichern ersetzt die fehlerhafte Zeile.`}
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
