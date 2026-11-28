'use client';

import { PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type DatabasePropertyType } from '@exocortex/contracts';
import {
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { useCreateDatabaseProperty } from '@/lib/api/database-queries';

import {
  isPropertyConfigComplete,
  type PropertyConfig,
  PropertyConfigEditor,
  PropertyConfigErrorMessage,
} from './property-config-editor';
import {
  CONFIGURED_PROPERTY_TYPE_SET,
  CREATABLE_PROPERTY_TYPES,
  useDefaultPropertyName,
  usePropertyTypeLabel,
} from './property-types';

export function AddPropertyButton({
  documentId,
  workspaceId,
  existingNames,
}: {
  documentId: string;
  workspaceId: string;
  /** Every column of this database, hidden ones too: a default name avoids them all. */
  existingNames: readonly string[];
}) {
  const t = useTranslations('database.addProperty');
  const typeLabel = usePropertyTypeLabel();
  const defaultName = useDefaultPropertyName();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  // The name this form filled in itself (issue #259). While the field still
  // holds it, or nothing, choosing another type swaps it for that type's
  // default; anything a person typed is theirs and is never replaced.
  const [autoName, setAutoName] = React.useState<string | null>(null);
  const [type, setType] = React.useState<DatabasePropertyType>('TEXT');
  const [config, setConfig] = React.useState<PropertyConfig>(null);
  const createProperty = useCreateDatabaseProperty(documentId);

  // A relation, a rollup and a formula mean nothing without their settings,
  // so the button stays off until they are there rather than sending a request
  // the API is bound to refuse.
  const needsConfig = CONFIGURED_PROPERTY_TYPE_SET.has(type);
  const ready = name.trim().length > 0 && (!needsConfig || isPropertyConfigComplete(type, config));

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          const initial = defaultName('TEXT', existingNames);
          setName(initial);
          setAutoName(initial);
          setType('TEXT');
          setConfig(null);
          createProperty.reset();
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('trigger')}
            data-testid="add-property"
          >
            <PlusIcon />
          </Button>
        }
      />
      <PopoverContent align="start" className="w-72">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = name.trim();
            if (trimmed.length === 0) return;
            if (!ready) return;
            // A column that needs a configuration closes on success only, so
            // a refused formula stays on screen beside its reason.
            createProperty.mutate(
              { name: trimmed, type, config: needsConfig ? config : undefined },
              { onSuccess: () => setOpen(false) },
            );
            if (!needsConfig) setOpen(false);
          }}
        >
          <Input
            autoFocus
            placeholder={t('namePlaceholder')}
            value={name}
            // An offered name is selected, so the first keystroke replaces it
            // rather than writing behind it.
            onFocus={(event) => {
              if (name === autoName) event.currentTarget.select();
            }}
            onChange={(event) => setName(event.target.value)}
          />
          <Select
            value={type}
            onValueChange={(next) => {
              const nextType = next as DatabasePropertyType;
              setType(nextType);
              setConfig(null);
              if (name.trim().length === 0 || name === autoName) {
                const offered = defaultName(nextType, existingNames);
                setName(offered);
                setAutoName(offered);
              }
            }}
          >
            <SelectTrigger className="w-full" data-testid="property-type-select">
              {/* Without a render function Base UI shows the raw value, which
                  here would be the English type name. */}
              <SelectValue>{() => typeLabel(type)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {CREATABLE_PROPERTY_TYPES.map((entry) => (
                <SelectItem key={entry} value={entry}>
                  {typeLabel(entry)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {needsConfig ? (
            <>
              <PropertyConfigEditor
                documentId={documentId}
                workspaceId={workspaceId}
                type={type}
                config={config}
                onChange={setConfig}
              />
              <PropertyConfigErrorMessage error={createProperty.error} />
            </>
          ) : null}
          <Button type="submit" size="sm" disabled={!ready}>
            {t('submit')}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
