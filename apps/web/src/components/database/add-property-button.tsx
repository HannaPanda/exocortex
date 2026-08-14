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

import { CREATABLE_PROPERTY_TYPES, PROPERTY_TYPE_LABELS } from './property-types';

export function AddPropertyButton({ documentId }: { documentId: string }) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [type, setType] = React.useState<DatabasePropertyType>('TEXT');
  const createProperty = useCreateDatabaseProperty(documentId);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setName('');
          setType('TEXT');
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
      <PopoverContent align="start" className="w-64">
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = name.trim();
            if (trimmed.length === 0) return;
            createProperty.mutate({ name: trimmed, type });
            setOpen(false);
          }}
        >
          <Input
            autoFocus
            placeholder="Name der Eigenschaft"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Select value={type} onValueChange={(next) => setType(next as DatabasePropertyType)}>
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
          <Button type="submit" size="sm" disabled={name.trim().length === 0}>
            Hinzufügen
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
