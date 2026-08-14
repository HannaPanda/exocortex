'use client';

import { MoreVerticalIcon, PlusIcon, SettingsIcon, TrashIcon, XIcon } from 'lucide-react';
import * as React from 'react';

import {
  type DatabaseDatePropertyConfig,
  type DatabaseProperty,
  parseDatePropertyConfig,
} from '@exocortex/contracts';
import {
  Badge,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Switch,
} from '@exocortex/ui';

import {
  useCreateDatabasePropertyOption,
  useDeleteDatabaseProperty,
  useDeleteDatabasePropertyOption,
  useUpdateDatabaseProperty,
  useUpdateDatabasePropertyOption,
} from '@/lib/api/database-queries';

import {
  ARRAY_PROPERTY_TYPES,
  OPTION_COLOR_BG_CLASS,
  OPTION_COLOR_LABELS,
  OPTION_COLOR_TEXT_CLASS,
  OPTION_COLORS,
  PROPERTY_TYPE_LABELS,
} from './property-types';

interface PropertyMenuProps {
  documentId: string;
  property: DatabaseProperty;
  readOnly: boolean;
}

/** Column header: name, icon-labelled type, and the manage/delete menu. */
export function PropertyMenu({ documentId, property, readOnly }: PropertyMenuProps) {
  const [renaming, setRenaming] = React.useState(false);
  const [managingOptions, setManagingOptions] = React.useState(false);
  const [editingDateFormat, setEditingDateFormat] = React.useState(false);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [name, setName] = React.useState(property.name);

  const updateProperty = useUpdateDatabaseProperty(documentId);
  const deleteProperty = useDeleteDatabaseProperty(documentId);

  const hasOptions = ARRAY_PROPERTY_TYPES.has(property.type) || property.type === 'SELECT';

  if (readOnly) {
    return (
      <span
        className="truncate text-xs font-medium text-muted-foreground"
        title={PROPERTY_TYPE_LABELS[property.type]}
      >
        {property.name}
      </span>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center justify-between gap-1 rounded-sm px-1 py-0.5 hover:bg-accent-solid"
              data-testid={`property-menu-${property.id}`}
            >
              <span className="truncate">{property.name}</span>
              <MoreVerticalIcon className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          }
        />
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => setRenaming(true)}>Umbenennen</DropdownMenuItem>
          {hasOptions ? (
            <DropdownMenuItem onClick={() => setManagingOptions(true)}>
              <SettingsIcon /> Optionen verwalten
            </DropdownMenuItem>
          ) : null}
          {property.type === 'DATE' ? (
            <DropdownMenuItem onClick={() => setEditingDateFormat(true)}>
              <SettingsIcon /> Datumsformat
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setConfirmingDelete(true)}>
            <TrashIcon /> Eigenschaft löschen
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Popover open={renaming} onOpenChange={setRenaming}>
        {/* Opened programmatically from the dropdown menu above, never clicked
            directly: a plain span anchor, so `nativeButton={false}` tells Base UI
            not to expect real button semantics from it. */}
        <PopoverTrigger render={<span />} nativeButton={false} />
        <PopoverContent className="w-56">
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = name.trim();
              if (trimmed.length > 0 && trimmed !== property.name) {
                updateProperty.mutate({ propertyId: property.id, request: { name: trimmed } });
              }
              setRenaming(false);
            }}
          >
            <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} />
            <Button type="submit" size="sm">
              Fertig
            </Button>
          </form>
        </PopoverContent>
      </Popover>

      <Popover open={managingOptions} onOpenChange={setManagingOptions}>
        {/* Opened programmatically from the dropdown menu above, never clicked
            directly: a plain span anchor, so `nativeButton={false}` tells Base UI
            not to expect real button semantics from it. */}
        <PopoverTrigger render={<span />} nativeButton={false} />
        <PopoverContent align="start" className="w-72">
          <OptionsManager documentId={documentId} property={property} />
        </PopoverContent>
      </Popover>

      <Popover open={editingDateFormat} onOpenChange={setEditingDateFormat}>
        {/* Same programmatic-anchor pattern as the two popovers above. */}
        <PopoverTrigger render={<span />} nativeButton={false} />
        <PopoverContent align="start" className="w-72">
          <DateFormatEditor documentId={documentId} property={property} />
        </PopoverContent>
      </Popover>

      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Eigenschaft „{property.name}“ löschen?</DialogTitle>
            <DialogDescription>
              Jede Zeile verliert damit unwiderruflich ihren Wert für diese Eigenschaft.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
              Abbrechen
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                deleteProperty.mutate(property.id);
                setConfirmingDelete(false);
              }}
            >
              Löschen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The two switches that turn a plain date into a calendar event: a time of day,
 * and an end. Both live on the property because they decide the shape of every
 * value it holds, so the whole column changes together or not at all.
 *
 * Turning the span off again is refused by the API while rows still carry an
 * end (`database_property_date_range_in_use`), which surfaces here as the
 * mutation's error message rather than as silent data loss.
 */
function DateFormatEditor({
  documentId,
  property,
}: {
  documentId: string;
  property: DatabaseProperty;
}) {
  const updateProperty = useUpdateDatabaseProperty(documentId);
  const config = parseDatePropertyConfig(property.config);

  const submit = (next: Partial<DatabaseDatePropertyConfig>) => {
    updateProperty.mutate({
      propertyId: property.id,
      // The API replaces the whole config bag, so every field is sent, not only
      // the one that changed.
      request: { config: { ...config, ...next } },
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={`date-time-${property.id}`} className="text-sm font-normal">
          Uhrzeit
        </Label>
        <Switch
          id={`date-time-${property.id}`}
          checked={config.includeTime}
          onCheckedChange={(checked) => submit({ includeTime: checked })}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={`date-range-${property.id}`} className="text-sm font-normal">
          Enddatum
        </Label>
        <Switch
          id={`date-range-${property.id}`}
          checked={config.isRange}
          onCheckedChange={(checked) => submit({ isRange: checked })}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Mit Enddatum wird aus der Eigenschaft ein Zeitraum. Erst dann kann eine Kalenderansicht
        Termine über mehrere Tage zeigen.
      </p>
      {updateProperty.isError ? (
        <p className="text-xs text-destructive-text">{updateProperty.error.message}</p>
      ) : null}
    </div>
  );
}

function OptionsManager({
  documentId,
  property,
}: {
  documentId: string;
  property: DatabaseProperty;
}) {
  const [label, setLabel] = React.useState('');
  const createOption = useCreateDatabasePropertyOption(documentId);
  const updateOption = useUpdateDatabasePropertyOption(documentId);
  const deleteOption = useDeleteDatabasePropertyOption(documentId);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-muted-foreground">Optionen</p>
      <ul className="flex flex-col gap-1">
        {property.options.map((option) => (
          <li key={option.id} className="flex items-center gap-1">
            <Badge
              variant="outline"
              className={cn(
                'flex-1 justify-start border-transparent',
                OPTION_COLOR_BG_CLASS[option.color],
                OPTION_COLOR_TEXT_CLASS[option.color],
              )}
            >
              {option.label}
            </Badge>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="ghost" size="icon-sm" aria-label="Farbe ändern">
                    <SettingsIcon className="size-3.5" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                {OPTION_COLORS.map((color) => (
                  <DropdownMenuItem
                    key={color}
                    onClick={() =>
                      updateOption.mutate({
                        propertyId: property.id,
                        optionId: option.id,
                        request: { color },
                      })
                    }
                  >
                    <span className={cn('size-3 rounded-full', OPTION_COLOR_BG_CLASS[color])} />
                    {OPTION_COLOR_LABELS[color]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Option löschen"
              onClick={() => deleteOption.mutate({ propertyId: property.id, optionId: option.id })}
            >
              <XIcon className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = label.trim();
          if (trimmed.length === 0) return;
          const usedColors = new Set(property.options.map((option) => option.color));
          const nextColor =
            OPTION_COLORS.find((color) => !usedColors.has(color)) ?? OPTION_COLORS[0];
          createOption.mutate({
            propertyId: property.id,
            request: { label: trimmed, color: nextColor! },
          });
          setLabel('');
        }}
      >
        <Input
          value={label}
          placeholder="Neue Option"
          className="h-8"
          onChange={(event) => setLabel(event.target.value)}
        />
        <Button type="submit" size="icon-sm" aria-label="Option hinzufügen">
          <PlusIcon />
        </Button>
      </form>
    </div>
  );
}
