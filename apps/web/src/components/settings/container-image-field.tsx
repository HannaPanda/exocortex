'use client';

import { CheckIcon, CopyIcon, LockIcon, TriangleAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type ContainerImageSettingKey,
  isContainerImageReference,
  settingsSchema,
} from '@exocortex/contracts';
import { Alert, AlertDescription, Button, Input } from '@exocortex/ui';

/** The value a key falls back to with no row, read from the schema itself. */
export function containerImageDefault(key: ContainerImageSettingKey): string {
  return settingsSchema.shape[key].parse(undefined);
}

/**
 * The image a build runs in, shown locked (issue #175).
 *
 * A wrong value here fails every build afterwards, and the name that worked
 * is not written down anywhere a person would look. So the field starts as
 * something to read and copy; changing it is a deliberate unlock that says
 * what a change does. The default comes from `settingsSchema`, the same
 * object the API resolves with, so "back to the default" can never name a
 * different image than an empty table would. The text is the field's own
 * state while unlocked: a half-typed reference the sandbox would refuse does
 * not reach the draft, and the field says so.
 */
export function ContainerImageSettingField({
  settingKey,
  value,
  stored,
  onChange,
  described,
  id,
}: {
  settingKey: ContainerImageSettingKey;
  value: string;
  /** The value on the server, to say what a save would replace. */
  stored: string | undefined;
  onChange: (value: string) => void;
  described: { 'aria-describedby': string; 'aria-invalid': boolean };
  id: string;
}) {
  const t = useTranslations('settings.row.containerImage');
  const fallback = containerImageDefault(settingKey);
  const [unlocked, setUnlocked] = React.useState(false);
  const [text, setText] = React.useState(value);
  const [synced, setSynced] = React.useState(value);
  const [copied, setCopied] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // A value that changed from outside (a reset, a discarded draft) replaces
  // the text; one this field emitted itself is already what it shows.
  if (value !== synced) {
    setSynced(value);
    setText(value);
  }

  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  React.useEffect(() => {
    if (unlocked) inputRef.current?.focus();
  }, [unlocked]);

  const trimmed = text.trim();
  const invalid = unlocked && !isContainerImageReference(trimmed);
  const invalidId = `${id}-image-invalid`;
  const warningId = `${id}-image-warning`;
  const changed = stored !== undefined && value !== stored;

  function handleText(next: string): void {
    setText(next);
    const candidate = next.trim();
    if (!isContainerImageReference(candidate)) return;
    setSynced(candidate);
    onChange(candidate);
  }

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // No clipboard permission: the name is on screen and selectable.
    }
  }

  const describedBy = [
    described['aria-describedby'],
    unlocked ? warningId : null,
    invalid ? invalidId : null,
  ]
    .filter((part) => part !== null)
    .join(' ');

  return (
    <div className="flex flex-col gap-2" data-testid={`${id}-image`}>
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          id={id}
          name={settingKey}
          type="text"
          autoComplete="off"
          spellCheck={false}
          readOnly={!unlocked}
          className="min-w-0 flex-1 font-mono text-xs read-only:bg-sunken"
          value={text}
          aria-describedby={describedBy}
          aria-invalid={described['aria-invalid'] || invalid}
          onChange={(event) => handleText(event.target.value)}
          onFocus={(event) => {
            if (!unlocked) event.currentTarget.select();
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t('copy')}
          data-testid={`${id}-image-copy`}
          onClick={() => void handleCopy()}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
        {unlocked ? (
          <Button
            type="button"
            variant="outline"
            data-testid={`${id}-image-lock`}
            onClick={() => {
              setUnlocked(false);
              setText(value);
            }}
          >
            <LockIcon />
            {t('lock')}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            data-testid={`${id}-image-unlock`}
            onClick={() => setUnlocked(true)}
          >
            {t('unlock')}
          </Button>
        )}
      </div>
      {invalid ? (
        <p id={invalidId} className="text-xs text-destructive-text" data-testid={invalidId}>
          {t('invalid')}
        </p>
      ) : null}
      {unlocked ? (
        <Alert id={warningId}>
          <TriangleAlertIcon />
          <AlertDescription>{t('warning')}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {value === fallback ? (
          <span>{t('isDefault')}</span>
        ) : (
          <>
            <span>{t('default', { image: fallback })}</span>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              data-testid={`${id}-image-reset`}
              onClick={() => onChange(fallback)}
            >
              {t('reset')}
            </Button>
          </>
        )}
      </div>
      {changed ? (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
          data-testid={`${id}-image-changed`}
        >
          <span>{t('stored', { image: stored })}</span>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={() => onChange(stored)}
          >
            {t('revert')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
