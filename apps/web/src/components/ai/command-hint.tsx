'use client';

import { useTranslations } from 'next-intl';

import { type CHAT_COMMANDS } from '@exocortex/contracts';
import { cn } from '@exocortex/ui';

export interface CommandHintProps {
  commands: readonly (typeof CHAT_COMMANDS)[number][];
  activeIndex: number;
  onSelect: (name: string) => void;
}

/**
 * Discovery surface for the slash-command set. Rendered above the composer
 * while the user is still typing a command word (no whitespace yet).
 */
export function CommandHint({ commands, activeIndex, onSelect }: CommandHintProps) {
  const t = useTranslations('ai');
  if (commands.length === 0) return null;

  return (
    <div
      role="listbox"
      aria-label={t('composer.commandsLabel')}
      className="absolute bottom-full left-0 z-10 mb-1 max-h-64 w-full overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md"
    >
      {commands.map((command, index) => (
        <div
          key={command.name}
          role="option"
          aria-selected={index === activeIndex}
          className={cn(
            'flex cursor-default items-center gap-2 px-2 py-1.5 text-sm',
            index === activeIndex && 'bg-accent text-accent-foreground',
          )}
          // mousedown (not click) fires before the textarea would lose focus.
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(command.name);
          }}
        >
          <span className="shrink-0 font-mono text-xs">
            /{command.name}
            {/* `/new`'s argument is a placeholder the reader fills in; the others are
                syntax the server parses and stay as the contract spells them. */}
            {command.argument === null
              ? ''
              : ` ${command.name === 'new' ? t('commands.titleArgument') : command.argument}`}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {t(`commands.${command.name}`)}
          </span>
        </div>
      ))}
    </div>
  );
}
