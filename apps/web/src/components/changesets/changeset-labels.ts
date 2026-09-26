'use client';

import { type ChangesetChangeStatus, type ChangesetStatus } from '@exocortex/contracts';

/**
 * The badge colour of a changeset's state (issue #141): outline for what
 * waits on the reader, the default for what landed, muted for what is over
 * without landing, destructive for what went stale.
 */
export function changesetStatusVariant(
  status: ChangesetStatus,
): 'default' | 'secondary' | 'destructive' | 'outline' | 'muted' {
  switch (status) {
    case 'draft':
      return 'secondary';
    case 'ready':
      return 'outline';
    case 'partially_applied':
    case 'applied':
      return 'default';
    case 'rejected':
      return 'muted';
    case 'stale':
      return 'destructive';
  }
}

export function changeStatusVariant(
  status: ChangesetChangeStatus,
): 'default' | 'secondary' | 'destructive' | 'outline' | 'muted' {
  switch (status) {
    case 'pending':
      return 'outline';
    case 'applied':
      return 'default';
    case 'rejected':
      return 'muted';
    case 'stale':
      return 'destructive';
  }
}
