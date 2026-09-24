import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Metadata } from 'next';

import { DesignSystemPage } from '@/components/design-system/design-system-page';
import { parseCustomProperties, typeLadder } from '@/lib/design-tokens';

/**
 * The living styleguide (issue #125).
 *
 * Outside `(app)` and without a session, like the public share route: it shows
 * fixtures and calls nothing, so there is nothing to sign in for.
 *
 * The tokens are read from the stylesheets that define them, here, at build
 * time: nothing on the page depends on the request, so Next renders it once and
 * the files are never touched while serving. `next build` runs in `apps/web`,
 * which is what the relative path is written against.
 */
export const metadata: Metadata = { title: 'Designsystem' };

const UI_SOURCE = join(process.cwd(), '..', '..', 'packages', 'ui', 'src');

export default function DesignSystemRoute() {
  const tokens = parseCustomProperties(
    readFileSync(join(UI_SOURCE, 'tokens.css'), 'utf8'),
    ':root',
  );
  const theme = parseCustomProperties(
    readFileSync(join(UI_SOURCE, 'styles.css'), 'utf8'),
    '@theme inline',
  );
  const measure = theme.properties.find((property) => property.name === '--container-measure');

  return (
    <DesignSystemPage
      tokens={tokens.properties}
      ladder={typeLadder(theme)}
      measure={measure?.value ?? ''}
    />
  );
}
