'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type SettingKey,
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
import { groupOf, SETTING_LIST_CLASS, SettingRow } from '@/components/settings/setting-row';
import {
  SettingsActionBar,
  UnsavedChangesNotice,
  useUnsavedChangesGuard,
} from '@/components/settings/unsaved-changes-guard';
import { useAiModels } from '@/lib/api/ai-queries';
import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import {
  useUpdateWorkspaceSettings,
  useWorkspaceSettings,
} from '@/lib/api/workspace-settings-queries';

/** The workspace form reports refusals as one message, not per field. */
const NO_INVALID_GROUPS: ReadonlySet<string> = new Set<string>();

/** The overridable settings whose draft value differs from the stored one. */
function changedOverrides(
  draft: Settings | null,
  stored: WorkspaceSettingsResponse | undefined,
): WorkspaceSettingKey[] {
  if (draft === null || stored === undefined) return [];
  return stored.editableKeys.filter((key) => draft[key] !== stored.settings[key]);
}

/** What the refusal beside the save button says, given which side refused. */
function refusalMessage(
  invalid: boolean,
  errorCode: string | undefined,
  invalidText: string,
): string {
  return invalid ? invalidText : messageForCode(errorCode);
}

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
  const t = useTranslations('settings.workspaceForm');
  const tForm = useTranslations('settings.form');

  const [draft, setDraft] = React.useState<Settings | null>(null);
  const [reset, setReset] = React.useState<WorkspaceSettingKey[]>([]);
  const [saved, setSaved] = React.useState(false);
  // Set when the save was refused before it left the browser. The API's own
  // rejection is reported through `update.error` instead.
  const [invalid, setInvalid] = React.useState(false);
  // Which group of rows is on screen. Over forty rows in one column is a
  // scroll no one reads to the end of; the draft lives above this, so
  // switching groups never loses an edit and one save covers all of them.
  const [group, setGroup] = React.useState<string | null>(null);

  // Same pattern as the admin form: seed the draft during render, once, rather
  // than from an effect.
  if (draft === null && query.data !== undefined) setDraft(query.data.settings);

  // Counted before the loading branch, because the guard is a hook and a hook
  // cannot sit after a return. A queued reset counts as a change: it is an
  // edit that has not been sent either.
  const changedKeys = changedOverrides(draft, query.data);
  const guardDialog = useUnsavedChangesGuard(changedKeys.length + reset.length);

  if (query.isPending || query.data === undefined || draft === null) {
    return <LoadingState label={tForm('loading')} variant="skeleton" rows={4} />;
  }

  const data: WorkspaceSettingsResponse = query.data;
  const current: Settings = draft;
  const overridden = new Set<string>(data.overriddenKeys);
  const editable = data.editableKeys;

  const changed = changedKeys;
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

  function updateField(key: WorkspaceSettingKey, value: Settings[SettingKey]): void {
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
    setInvalid(false);
    update.reset();
  }

  function handleSave(): void {
    const patch: Record<string, unknown> = {};
    // A key queued for reset never travels as a value as well. Queueing one
    // also puts the deployment's value into the draft, so that the row shows
    // what it will become -- which made the key differ from the workspace's
    // own stored value and land in `changed` too. The request schema refuses
    // "set and reset in one go", `safeParse` failed, and `handleSave` returned
    // without a word: the reset button did nothing at all, in exactly the case
    // where resetting means something.
    for (const key of changed) {
      if (!reset.includes(key)) patch[key] = current[key];
    }
    if (reset.length > 0) patch.reset = reset;

    const parsed = updateWorkspaceSettingsRequestSchema.safeParse(patch);
    // Not a silent return: a save button that does nothing and says nothing is
    // indistinguishable from one that worked.
    setInvalid(!parsed.success);
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
      <p className="text-sm text-muted-foreground">{t('intro')}</p>

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
            <TabsContent key={name} value={name} className={SETTING_LIST_CLASS}>
              {keys.map((key) => (
                <div key={key} className="flex flex-col gap-1 max-sm:py-4">
                  <SettingRow
                    settingKey={key}
                    value={current[key]}
                    onChange={(value) => updateField(key, value)}
                    models={models.data?.models ?? []}
                  />
                  <div className="flex items-center gap-2 sm:pl-[calc(240px+1rem)]">
                    {overridden.has(key) && !reset.includes(key) ? (
                      <>
                        <Badge variant="secondary">{t('ownValue')}</Badge>
                        {canEdit ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => queueReset(key)}
                            data-testid={`workspace-setting-reset-${key}`}
                          >
                            {t('reset')}
                          </Button>
                        ) : null}
                      </>
                    ) : reset.includes(key) ? (
                      <Badge variant="outline">{t('resetting')}</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t('inherited')}</span>
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
          <AlertDescription>{tForm('saved')}</AlertDescription>
        </Alert>
      ) : null}
      {update.isError || invalid ? (
        <Alert variant="destructive" data-testid="workspace-settings-error">
          <AlertDescription>{refusalMessage(invalid, errorCode, t('invalid'))}</AlertDescription>
        </Alert>
      ) : null}

      {canEdit ? (
        <SettingsActionBar dirty={dirty}>
          <div className="flex gap-2">
            <Button onClick={handleSave} disabled={!dirty || update.isPending}>
              {tForm('save')}
            </Button>
            <Button variant="outline" onClick={handleDiscard} disabled={!dirty || update.isPending}>
              {tForm('discard')}
            </Button>
          </div>
          <UnsavedChangesNotice
            changedCount={changed.length + reset.length}
            testId="workspace-settings-dirty"
          />
        </SettingsActionBar>
      ) : (
        <p className="text-sm text-muted-foreground">{t('readOnly')}</p>
      )}

      {guardDialog}
    </div>
  );
}
