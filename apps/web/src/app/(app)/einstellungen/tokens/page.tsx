import { redirect } from 'next/navigation';

/**
 * The token page grew into the connections page. Kept as a redirect because the
 * old path is in bookmarks, in `docs/admin.md` and in at least one shell
 * history: a 404 there would look like the feature was removed.
 */
export default function ApiTokensRoute() {
  redirect('/einstellungen/verbindungen');
}
