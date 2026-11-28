import { redirect } from 'next/navigation';

import { accountSettingsRedirect } from '@/components/settings-dialog/sections';

/**
 * This page became a group of the settings dialog (issue #279). The address
 * stays, because it is in bookmarks, in older documentation and in links
 * somebody sent: it opens the dialog at the same group instead of a 404.
 */
export default function SettingsRedirect(): never {
  redirect(accountSettingsRedirect('chat'));
}
