import type { Metadata } from 'next';
import { Suspense } from 'react';

import { OAuthConsentForm } from '@/components/auth/oauth-consent-form';

export const metadata: Metadata = { title: 'Zugriff erlauben' };

/**
 * Where the OAuth authorization endpoint sends a signed-in person before it
 * hands an access token to a remote MCP client (ChatGPT, an agent on someone
 * else's machine). See `docs/mcp.md`.
 */
export default function OAuthConsentPage() {
  return (
    <Suspense fallback={null}>
      <OAuthConsentForm />
    </Suspense>
  );
}
