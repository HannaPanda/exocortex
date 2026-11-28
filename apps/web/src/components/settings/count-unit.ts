import { useTranslations } from 'next-intl';
import * as React from 'react';

import { countUnitOfSettingKey } from '@/lib/setting-units';

/**
 * The word beside a counted setting's field (`%`, `Zeichen`, `Tage`) for the
 * value it holds, or `null` for a setting that counts in no unit (issue #203).
 */
export function useCountUnitWord(): (key: string, value: number) => string | null {
  const t = useTranslations('settings.row.countUnits');
  return React.useCallback(
    (key: string, value: number) => {
      const unit = countUnitOfSettingKey(key);
      if (unit === null) return null;
      return unit === 'percent' ? t('percent') : t(unit, { count: value });
    },
    [t],
  );
}
