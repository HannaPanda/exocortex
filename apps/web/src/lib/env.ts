import { z } from 'zod';

/**
 * Browser-safe configuration.
 *
 * Only `PUBLIC_*` values are exposed to the bundle (see next.config.ts). Server
 * secrets, database URLs and AI keys never reach the client.
 */
const publicEnvSchema = z.object({
  PUBLIC_API_URL: z.string().min(1),
  PUBLIC_COLLABORATION_URL: z
    .string()
    .refine((value) => value.startsWith('ws://') || value.startsWith('wss://'), {
      message: 'PUBLIC_COLLABORATION_URL must be a ws:// or wss:// URL',
    }),
});

const parsed = publicEnvSchema.safeParse({
  PUBLIC_API_URL: process.env.PUBLIC_API_URL,
  PUBLIC_COLLABORATION_URL: process.env.PUBLIC_COLLABORATION_URL,
});

if (!parsed.success) {
  throw new Error(
    'Invalid public environment for the web app. Fix these variables:\n' +
      parsed.error.issues
        .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
        .join('\n'),
  );
}

export const publicEnv = parsed.data;

/**
 * Origin used for the realtime socket. In production this is the same origin as
 * the page, so cookies are sent automatically.
 */
export function realtimeOrigin(): string {
  if (typeof window === 'undefined') return publicEnv.PUBLIC_API_URL;
  const configured = new URL(publicEnv.PUBLIC_API_URL, window.location.origin);
  return configured.origin;
}
