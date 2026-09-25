import { SettingsForm } from '@/components/admin/settings-form';
import { SETTING_GROUP_PARAM } from '@/components/palette/settings-addresses';

/**
 * `?gruppe=ai` opens that group, which is where a palette command lands
 * (issue #148) and what a pasted address means.
 */
export default async function AdminSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const requested = (await searchParams)[SETTING_GROUP_PARAM];
  return <SettingsForm requestedGroup={typeof requested === 'string' ? requested : null} />;
}
