'use client';

import { PlusIcon } from 'lucide-react';
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
} from './property-config-editor';
import {
  CONFIGURED_PROPERTY_TYPE_SET,
  CREATABLE_PROPERTY_TYPES,
  PROPERTY_TYPE_LABELS,
} from './property-types';

export function AddPropertyButton({
  documentId,
  workspaceId,
}: {
  documentId: string;
  workspaceId: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
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
          setName('');
          setType('TEXT');
          setConfig(null);
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Eigenschaft hinzufügen"
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
            createProperty.mutate({
              name: trimmed,
              type,
              config: needsConfig ? config : undefined,
            });
            setOpen(false);
          }}
        >
          <Input
            autoFocus
            placeholder="Name der Eigenschaft"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Select
            value={type}
            onValueChange={(next) => {
              setType(next as DatabasePropertyType);
              setConfig(null);
            }}
          >
            <SelectTrigger className="w-full" data-testid="property-type-select">
              {/* Without a render function Base UI shows the raw value, which
                  here would be the English type name. */}
              <SelectValue>{() => PROPERTY_TYPE_LABELS[type]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {CREATABLE_PROPERTY_TYPES.map((entry) => (
                <SelectItem key={entry} value={entry}>
                  {PROPERTY_TYPE_LABELS[entry]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {needsConfig ? (
            <PropertyConfigEditor
              documentId={documentId}
              workspaceId={workspaceId}
              type={type}
              config={config}
              onChange={setConfig}
            />
          ) : null}
          <Button type="submit" size="sm" disabled={!ready}>
            Hinzufügen
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
