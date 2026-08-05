import { AlertTriangleIcon, InboxIcon, Loader2Icon, type LucideIcon } from 'lucide-react';
import * as React from 'react';

import { cn } from '../lib/utils';

import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';

/**
 * Reusable loading, empty and error states.
 *
 * Every list and panel in the application uses these, so the three states look
 * and behave the same everywhere. All copy is German; developer-facing details
 * stay out of the UI.
 */

export interface LoadingStateProps extends React.ComponentPropsWithoutRef<'div'> {
  label?: string;
  /** Renders skeleton rows instead of a spinner. */
  variant?: 'spinner' | 'skeleton';
  rows?: number;
}

export function LoadingState({
  label = 'Wird geladen …',
  variant = 'spinner',
  rows = 3,
  className,
  ...props
}: LoadingStateProps) {
  if (variant === 'skeleton') {
    return (
      <div
        className={cn('flex flex-col gap-2 p-3', className)}
        role="status"
        aria-label={label}
        {...props}
      >
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} className="h-6 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground',
        className,
      )}
      role="status"
      aria-live="polite"
      {...props}
    >
      <Loader2Icon className="size-4 animate-spin" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export interface EmptyStateProps extends React.ComponentPropsWithoutRef<'div'> {
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: { label: string; onClick: () => void };
}

export function EmptyState({
  title,
  description,
  icon: Icon = InboxIcon,
  action,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-10 text-center',
        className,
      )}
      {...props}
    >
      <Icon className="size-6 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      {description !== undefined ? (
        <p className="max-w-sm text-xs text-muted-foreground">{description}</p>
      ) : null}
      {action !== undefined ? (
        <Button variant="outline" size="sm" className="mt-2" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

export interface ErrorStateProps extends React.ComponentPropsWithoutRef<'div'> {
  title?: string;
  description?: string;
  onRetry?: () => void;
}

export function ErrorState({
  title = 'Etwas ist schiefgelaufen',
  description = 'Bitte versuche es erneut. Falls das Problem bleibt, prüfe die Verbindung.',
  onRetry,
  className,
  ...props
}: ErrorStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-10 text-center',
        className,
      )}
      role="alert"
      {...props}
    >
      <AlertTriangleIcon className="size-6 text-destructive-text" aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{description}</p>
      {onRetry !== undefined ? (
        <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
          Erneut versuchen
        </Button>
      ) : null}
    </div>
  );
}
