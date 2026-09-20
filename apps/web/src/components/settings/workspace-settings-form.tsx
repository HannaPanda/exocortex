'use client';

import * as React from 'react';

import {
  type Settings,
  updateWorkspaceSettingsRequestSchema,
  type WorkspaceSettingKey,
  type WorkspaceSettingsResponse,
} from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  LoadingState,
  Tabs,
  TabsContent,
} from '@exocortex/ui';

import { SettingGroupNav } from '@/components/settings/setting-group-nav';
import { groupOf, SettingRow } from '@/components/settings/setting-row';
import { useAiModels } from '@/lib/api/ai-queries';
import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import {
  useUpdateWorkspaceSettings,
  useWorkspaceSettings,
} from '@/lib/api/workspace-settings-queries';

/** The workspace form reports refusals as one message, not per field. */
const NO_INVALID_GROUPS: ReadonlySet<string> = new Set<string>();

/**
 * The overrides one workspace has set, and the ones it inherits (issue #52).
 *
 * Deliberately not a second copy of the admin form. It renders the same rows
 * through the same component, but it answers a different question: not "what
 * is this installation configured to do" but "what does this workspace do
 * differently". That is why every row says which of the two it is, and why a
 * row that says nothing is the normal case rather than an empty field.
 */
export function WorkspaceSettingsForm({
  workspaceId,
  canEdit,
}: {
  workspaceId: string;
  canEdit: boolean;
}) {
  const query = useWorkspaceSettings(workspaceId);
  const models = useAiModels();
  const update = useUpdateWorkspaceSettings(workspaceId);

  const [draft, setDraft] = React.useState<Settings | null>(null);
  const [reset, setReset] = React.useState<WorkspaceSettingKey[]>([]);
  const [saved, setSaved] = React.useState(false);
  // Which group of rows is on screen. Over forty rows in one column is a
  // scroll no one reads to the end of; the draft lives above this, so
  // switching groups never loses an edit and one save covers all of them.
  const [group, setGroup] = React.useState<string | null>(null);

  // Same pattern as the admin form: seed the draft during render, once, rather
  // than from an effect.
  if (draft === null && query.data !== undefined) setDraft(query.data.settings);

  if (query.isPending || query.data === undefined || draft === null) {
    return <LoadingState label="Einstellungen werden geladen …" variant="skeleton" rows={4} />;
  }

  const data: WorkspaceSettingsResponse = query.data;
  const current: Settings = draft;
  const overridden = new Set<string>(data.overriddenKeys);
  const editable = data.editableKeys;

  const changed = editable.filter((key) => current[key] !== data.settings[key]);
  const dirty = changed.length > 0 || reset.length > 0;

  const groups = new Map<string, WorkspaceSettingKey[]>();
  for (const key of editable) {
    const list = groups.get(groupOf(key)) ?? [];
    list.push(key);
    groups.set(groupOf(key), list);
  }

  const groupNames = [...groups.keys()];
  const activeGroup = group !== null && groups.has(group) ? group : (groupNames[0] ?? '');
  // A pending edit in a group that is not on screen is invisible otherwise, and
  // the save button below covers every group at once.
  const pending = new Set([...changed, ...reset].map((key) => groupOf(key)));

  function updateField(key: WorkspaceSettingKey, value: Settings[WorkspaceSettingKey]): void {
    setDraft((previous) =>
      previous === null ? previous : ({ ...previous, [key]: value } as Settings),
    );
    // Editing a field that was queued for reset means the person changed their
    // mind about resetting it; the two cannot travel in one request anyway.
    setReset((previous) => previous.filter((entry) => entry !== key));
    setSaved(false);
  }

  function queueReset(key: WorkspaceSettingKey): void {
    setDraft((previous) =>
      previous === null
        ? previous
        : ({ ...previous, [key]: data.deploymentSettings[key] } as Settings),
    );
    setReset((previous) => (previous.includes(key) ? previous : [...previous, key]));
    setSaved(false);
  }

  function handleDiscard(): void {
    setDraft(data.settings);
    setReset([]);
    setSaved(false);
    update.reset();
  }

  function handleSave(): void {
    const patch: Record<string, unknown> = {};
    for (const key of changed) patch[key] = current[key];
    if (reset.length > 0) patch.reset = reset;

    const parsed = updateWorkspaceSettingsRequestSchema.safeParse(patch);
    if (!parsed.success) return;

    update.mutate(parsed.data, {
      onSuccess: (response) => {
        setDraft(response.settings);
        setReset([]);
        setSaved(true);
      },
    });
  }

  const errorCode = update.error instanceof ApiError ? update.error.code : undefined;

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Ohne eigenen Wert gilt hier, was für die ganze Installation eingestellt ist. Was du hier
        setzt, gilt nur in diesem Arbeitsbereich.
      </p>

      <Tabs
        value={activeGroup}
        onValueChange={(next) => setGroup(typeof next === 'string' ? next : null)}
        orientation="vertical"
        className="flex flex-col gap-6 md:flex-row md:gap-8"
      >
        <SettingGroupNav
          groups={groupNames}
          pending={pending}
          invalid={NO_INVALID_GROUPS}
          testIdPrefix="workspace-setting-group"
        />

        <fieldset disabled={!canEdit || update.isPending} className="min-w-0 flex-1 border-0 p-0">
          {[...groups.entries()].map(([name, keys]) => (
            <TabsContent key={name} value={name} className="flex flex-col gap-4">
              {keys.map((key) => (
                <div key={key} className="flex flex-col gap-1">
                  <SettingRow
                    settingKey={key}
                    value={current[key]}
                    onChange={(value) => updateField(key, value)}
                    models={models.data?.models ?? []}
                  />
                  <div className="flex items-center gap-2 sm:pl-[calc(240px+1rem)]">
                    {overridden.has(key) && !reset.includes(key) ? (
                      <>
                        <Badge variant="secondary">Eigener Wert</Badge>
                        {canEdit ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => queueReset(key)}
                            data-testid={`workspace-setting-reset-${key}`}
                          >
                            Auf Installationswert zurücksetzen
                          </Button>
                        ) : null}
                      </>
                    ) : reset.includes(key) ? (
                      <Badge variant="outline">Wird zurückgesetzt</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Geerbt aus der Installation
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </TabsContent>
          ))}
        </fieldset>
      </Tabs>

      {saved ? (
        <Alert data-testid="workspace-settings-saved">
          <AlertDescription>Einstellungen gespeichert.</AlertDescription>
        </Alert>
      ) : null}
      {update.isError ? (
        <Alert variant="destructive" data-testid="workspace-settings-error">
          <AlertDescription>{messageForCode(errorCode)}</AlertDescription>
        </Alert>
      ) : null}

      {canEdit ? (
        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={!dirty || update.isPending}>
            Speichern
          </Button>
          <Button variant="outline" onClick={handleDiscard} disabled={!dirty || update.isPending}>
            Verwerfen
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Ändern dürfen das Besitzer und Administratoren dieses Arbeitsbereichs.
        </p>
      )}
    </div>
  );
}
