'use client';

import { useTranslations } from 'next-intl';

import { type AiModel, SETTING_KEYS, type SettingKey, type Settings } from '@exocortex/contracts';

import { ReferencePicker } from '@/components/settings/reference-picker';
import { useAiModelCatalog } from '@/lib/api/admin-queries';
import {
  catalogOptions,
  embeddingOptions,
  type ModelCatalogs,
  type ModelField,
  type ReferenceOption,
  registryOptions,
} from '@/lib/setting-references';

/**
 * The two provider lists, for the administrator's form. Each is fetched only
 * while the group holding its setting is on screen, since every fetch is a
 * round trip to OpenRouter.
 */
export function useAdminModelCatalogs(requestedGroup: string | null): ModelCatalogs {
  // The form shows its first group when none or an unknown one is asked for.
  const groups = SETTING_KEYS.map((key) => key.split('.')[0] ?? key);
  const shownGroup =
    requestedGroup !== null && groups.includes(requestedGroup) ? requestedGroup : groups[0];
  const embeddings = useAiModelCatalog(shownGroup === 'search', 'embeddings');
  const image = useAiModelCatalog(shownGroup === 'ai', 'image');
  return {
    embeddings: {
      entries: embeddings.data?.entries ?? [],
      loading: embeddings.isFetching,
      unavailable: embeddings.isError,
    },
    image: {
      entries: image.data?.entries ?? [],
      loading: image.isFetching,
      // A failed list leaves the image model a text field rather than an
      // empty picker, so the setting can still be written.
      unavailable: image.isError,
    },
  };
}

/** The control of a model setting that `modelFieldHasList` says can offer a list. */
export function ModelSettingField({
  settingKey,
  field,
  value,
  onChange,
  models,
  catalogs,
  described,
  id,
}: {
  settingKey: SettingKey;
  field: ModelField;
  value: string | null;
  onChange: (value: Settings[SettingKey]) => void;
  models: readonly AiModel[];
  catalogs: ModelCatalogs | undefined;
  described: { 'aria-describedby': string; 'aria-invalid': boolean };
  id: string;
}) {
  const t = useTranslations('settings.row.modelPicker');

  let options: ReferenceOption[];
  let loading = false;
  if (field.source === 'registry') {
    options = [
      {
        value: null,
        label: t(`inherit.${field.empty}`),
        detail: t(`inheritDetail.${field.empty}`),
      },
      ...registryOptions(models, value, t('disabled')),
    ];
  } else if (field.source === 'embeddings') {
    options = embeddingOptions(catalogs?.embeddings?.entries ?? []);
    loading = catalogs?.embeddings?.loading ?? false;
  } else {
    options = [
      { value: null, label: t('inherit.off'), detail: t('inheritDetail.off') },
      ...catalogOptions(catalogs?.image?.entries ?? []),
    ];
    loading = catalogs?.image?.loading ?? false;
  }

  return (
    <ReferencePicker
      id={id}
      name={settingKey}
      value={value}
      options={options}
      loading={loading}
      onChange={onChange}
      described={described}
    />
  );
}
