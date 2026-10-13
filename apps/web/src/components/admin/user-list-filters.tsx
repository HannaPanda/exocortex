'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  adminUserActivityFilterSchema,
  type AdminUserListQuery,
  adminUserSortSchema,
  adminUserStatusFilterSchema,
  userRoleSchema,
} from '@exocortex/contracts';
import { Button } from '@exocortex/ui';

import { ListFilter, ListSearch, pageFrom } from '@/components/admin/list-controls';

export const USER_PAGE_SIZE = 50;

export const USER_LIST_DEFAULTS = {
  q: '',
  role: 'all',
  status: 'all',
  activity: 'all',
  sort: 'createdAt',
  order: 'asc',
  page: '1',
};

export type UserListParams = typeof USER_LIST_DEFAULTS;

const ROLE_FILTERS = ['all', 'user', 'admin'] as const;
const STATUS_FILTERS = ['all', 'active', 'disabled'] as const;
const ACTIVITY_FILTERS = ['all', 'recent', 'stale', 'none'] as const;

/**
 * The address as an API query. Every value is read through its schema, so a
 * hand-edited or outdated link falls back to the default instead of turning
 * the list into an error.
 */
export function userListQuery(params: UserListParams): Partial<AdminUserListQuery> {
  const page = pageFrom(params.page);
  return {
    q: params.q === '' ? undefined : params.q,
    role: userRoleSchema.safeParse(params.role).data,
    status: adminUserStatusFilterSchema.safeParse(params.status).data,
    activity: adminUserActivityFilterSchema.safeParse(params.activity).data,
    sort: adminUserSortSchema.safeParse(params.sort).data,
    order: params.order === 'desc' ? 'desc' : 'asc',
    limit: USER_PAGE_SIZE,
    offset: (page - 1) * USER_PAGE_SIZE,
  };
}

export function isUserListFiltered(params: UserListParams): boolean {
  return (
    params.q !== '' || params.role !== 'all' || params.status !== 'all' || params.activity !== 'all'
  );
}

/** Search, the three filters, and the way back to the whole list. */
export function UserListFilters({
  params,
  setParams,
}: {
  params: UserListParams;
  setParams: (patch: Partial<UserListParams>) => void;
}) {
  const t = useTranslations('admin.users');
  const onSearch = React.useCallback((q: string) => setParams({ q }), [setParams]);

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      <ListSearch
        value={params.q}
        onCommit={onSearch}
        label={t('filters.searchLabel')}
        placeholder={t('filters.searchPlaceholder')}
        testId="user-search"
      />
      <ListFilter
        label={t('filters.role')}
        value={params.role}
        options={ROLE_FILTERS.map((value) => ({
          value,
          label: value === 'all' ? t('filters.allRoles') : t(`roles.${value}`),
        }))}
        onChange={(role) => setParams({ role })}
        testId="user-filter-role"
      />
      <ListFilter
        label={t('filters.status')}
        value={params.status}
        options={STATUS_FILTERS.map((value) => ({
          value,
          label: t(`filters.statusOptions.${value}`),
        }))}
        onChange={(status) => setParams({ status })}
        testId="user-filter-status"
      />
      <ListFilter
        label={t('filters.activity')}
        value={params.activity}
        options={ACTIVITY_FILTERS.map((value) => ({
          value,
          label: t(`filters.activityOptions.${value}`),
        }))}
        onChange={(activity) => setParams({ activity })}
        testId="user-filter-activity"
      />
      {isUserListFiltered(params) ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setParams({ q: '', role: 'all', status: 'all', activity: 'all' })}
          data-testid="user-filter-reset"
        >
          {t('filters.reset')}
        </Button>
      ) : null}
    </div>
  );
}
