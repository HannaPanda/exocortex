'use client';

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  MoreVerticalIcon,
  PlusIcon,
  SettingsIcon,
  TrashIcon,
  XIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type DatabaseDatePropertyConfig,
  type DatabaseProperty,
  type DatabaseView,
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
  useReorderDatabaseProperty,
  useUpdateDatabaseProperty,
  useUpdateDatabasePropertyOption,
  useUpdateDatabaseView,
} from '@/lib/api/database-queries';

import {
  isPropertyConfigComplete,
  type PropertyConfig,
  PropertyConfigEditor,
  PropertyConfigErrorMessage,
} from './property-config-editor';
import {
  CONFIGURED_PROPERTY_TYPE_SET,
  OPTION_COLOR_BG_CLASS,
  OPTION_COLOR_TEXT_CLASS,
  OPTION_COLORS,
  OPTION_PROPERTY_TYPES,
  useOptionColorLabel,
  usePropertyTypeLabel,
} from './property-types';
import {
  columnMoveAfter,
  hasOwnColumnOrder,
  moveColumnInView,
  type MoveDirection,
} from './table-columns';

interface PropertyMenuProps {
  documentId: string;
  workspaceId: string;
  property: DatabaseProperty;
  /** The view this header belongs to, and the columns it shows, in order. */
  view: DatabaseView;
  columns: DatabaseProperty[];
  readOnly: boolean;
}

/** Column header: name, icon-labelled type, and the manage/delete menu. */
export function PropertyMenu({
  documentId,
  workspaceId,
  property,
  view,
  columns,
  readOnly,
}: PropertyMenuProps) {
  const t = useTranslations('database.propertyMenu');
  const typeLabel = usePropertyTypeLabel();
  const [renaming, setRenaming] = React.useState(false);
  const [managingOptions, setManagingOptions] = React.useState(false);
  const [editingDateFormat, setEditingDateFormat] = React.useState(false);
  const [editingConfig, setEditingConfig] = React.useState(false);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [name, setName] = React.useState(property.name);

  const updateProperty = useUpdateDatabaseProperty(documentId);
  const deleteProperty = useDeleteDatabaseProperty(documentId);
  const move = useColumnMove(documentId, view, columns);

  const hasOptions = OPTION_PROPERTY_TYPES.has(property.type);
  const hasConfig = CONFIGURED_PROPERTY_TYPE_SET.has(property.type);

  if (readOnly) {
    return (
      <span
        className="truncate text-xs font-medium text-muted-foreground"
        title={typeLabel(property.type)}
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
              className="flex min-w-0 flex-1 items-center justify-between gap-1 rounded-sm px-1 py-0.5 hover:bg-accent"
              data-testid={`property-menu-${property.id}`}
            >
              <span className="truncate">{property.name}</span>
              <MoreVerticalIcon className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          }
        />
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => setRenaming(true)}>{t('rename')}</DropdownMenuItem>
          <DropdownMenuItem
            disabled={!move.can(property.id, 'left')}
            onClick={() => move.run(property.id, 'left')}
            data-testid={`property-move-left-${property.id}`}
          >
            <ArrowLeftIcon /> {t('moveLeft')}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!move.can(property.id, 'right')}
            onClick={() => move.run(property.id, 'right')}
            data-testid={`property-move-right-${property.id}`}
          >
            <ArrowRightIcon /> {t('moveRight')}
          </DropdownMenuItem>
          {hasOptions ? (
            <DropdownMenuItem onClick={() => setManagingOptions(true)}>
              <SettingsIcon /> {t('manageOptions')}
            </DropdownMenuItem>
          ) : null}
          {property.type === 'DATE' ? (
            <DropdownMenuItem onClick={() => setEditingDateFormat(true)}>
              <SettingsIcon /> {t('dateFormat')}
            </DropdownMenuItem>
          ) : null}
          {hasConfig ? (
            <DropdownMenuItem
              onClick={() => setEditingConfig(true)}
              data-testid={`property-configure-${property.id}`}
            >
              <SettingsIcon /> {t('configure', { type: typeLabel(property.type) })}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setConfirmingDelete(true)}>
            <TrashIcon /> {t('delete')}
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
              {t('save')}
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

      <Popover open={editingConfig} onOpenChange={setEditingConfig}>
        {/* Same programmatic-anchor pattern as the popovers above. */}
        <PopoverTrigger render={<span />} nativeButton={false} />
        <PopoverContent align="start" className="w-80">
          <DerivedConfigEditor
            documentId={documentId}
            workspaceId={workspaceId}
            property={property}
            onDone={() => setEditingConfig(false)}
          />
        </PopoverContent>
      </Popover>

      <Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('deleteTitle', { name: property.name })}</DialogTitle>
            <DialogDescription>{t('deleteDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                deleteProperty.mutate(property.id);
                setConfirmingDelete(false);
              }}
            >
              {t('confirmDelete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Moving a column one step, through whichever order actually decides this view.
 *
 * Two routes, one gesture: a view that has its own column order (hiding a
 * column writes one) is rewritten in place, and a view that has none follows
 * the database's property order, so the property itself moves. Picking the
 * wrong one of the two is not a failure anybody would see -- the click would
 * simply do nothing -- which is why the choice is made here and not by the
 * reader.
 */
function useColumnMove(documentId: string, view: DatabaseView, columns: DatabaseProperty[]) {
  const reorderProperty = useReorderDatabaseProperty(documentId);
  const updateView = useUpdateDatabaseView(documentId);
  const ownOrder = hasOwnColumnOrder(view);

  const can = (propertyId: string, direction: MoveDirection): boolean =>
    ownOrder
      ? moveColumnInView(view, columns, propertyId, direction) !== null
      : columnMoveAfter(columns, propertyId, direction) !== null;

  const run = (propertyId: string, direction: MoveDirection): void => {
    if (ownOrder) {
      const visibleProperties = moveColumnInView(view, columns, propertyId, direction);
      if (visibleProperties === null) return;
      updateView.mutate({ viewId: view.id, request: { config: { visibleProperties } } });
      return;
    }
    const target = columnMoveAfter(columns, propertyId, direction);
    if (target === null) return;
    reorderProperty.mutate({ propertyId, request: target });
  };

  return { can, run };
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
  const t = useTranslations('database.propertyMenu');
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
          {t('includeTime')}
        </Label>
        <Switch
          id={`date-time-${property.id}`}
          checked={config.includeTime}
          onCheckedChange={(checked) => submit({ includeTime: checked })}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={`date-range-${property.id}`} className="text-sm font-normal">
          {t('isRange')}
        </Label>
        <Switch
          id={`date-range-${property.id}`}
          checked={config.isRange}
          onCheckedChange={(checked) => submit({ isRange: checked })}
        />
      </div>
      <p className="text-xs text-muted-foreground">{t('rangeHint')}</p>
      {updateProperty.isError ? (
        <p role="alert" className="text-xs text-destructive-text">
          {updateProperty.error.message}
        </p>
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
  const t = useTranslations('database.propertyMenu');
  const colorLabel = useOptionColorLabel();
  const [label, setLabel] = React.useState('');
  const createOption = useCreateDatabasePropertyOption(documentId);
  const updateOption = useUpdateDatabasePropertyOption(documentId);
  const deleteOption = useDeleteDatabasePropertyOption(documentId);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-muted-foreground">{t('options')}</p>
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
                  <Button variant="ghost" size="icon-sm" aria-label={t('changeColor')}>
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
                    {colorLabel(color)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('deleteOption')}
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
          placeholder={t('newOption')}
          className="h-8"
          onChange={(event) => setLabel(event.target.value)}
        />
        <Button type="submit" size="icon-sm" aria-label={t('addOption')}>
          <PlusIcon />
        </Button>
      </form>
    </div>
  );
}

/**
 * Changes the settings of a RELATION, ROLLUP or FORMULA column after the fact.
 *
 * Saving is a plain `PATCH` of `config`, so the API runs exactly the same
 * checks it ran when the column was created -- including whether every other
 * derived column of this database still compiles afterwards.
 */
function DerivedConfigEditor({
  documentId,
  workspaceId,
  property,
  onDone,
}: {
  documentId: string;
  workspaceId: string;
  property: DatabaseProperty;
  onDone: () => void;
}) {
  const t = useTranslations('database.propertyMenu');
  const [config, setConfig] = React.useState<PropertyConfig>(property.config);
  const updateProperty = useUpdateDatabaseProperty(documentId);
  const ready = isPropertyConfigComplete(property.type, config);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        // Closed on success only: a refused formula has to stay on screen
        // next to the reason, or the person cannot correct it.
        updateProperty.mutate(
          { propertyId: property.id, request: { config } },
          { onSuccess: () => onDone() },
        );
      }}
    >
      <PropertyConfigEditor
        documentId={documentId}
        workspaceId={workspaceId}
        type={property.type}
        config={config}
        onChange={setConfig}
      />
      <PropertyConfigErrorMessage error={updateProperty.error} />
      <Button type="submit" size="sm" disabled={!ready}>
        {t('save')}
      </Button>
    </form>
  );
}
