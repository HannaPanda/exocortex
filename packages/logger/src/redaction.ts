/**
 * Paths that must never appear in logs. Pino replaces them with `[redacted]`.
 *
 * Document content is deliberately excluded from logs as well; see
 * `docs/security.md`. Only identifiers, sizes and counts may be logged.
 */
export const REDACTED_PATHS: readonly string[] = [
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'sessionToken',
  'ticket',
  'secret',
  'apiKey',
  'authorization',
  'cookie',
  'setCookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  // Derived and canonical document payloads.
  'yjsState',
  'proseMirrorJson',
  'markdown',
  'plainText',
  'content',
  // Assembled prompts. Since `ai.pageContextEnabled` these can carry a page's
  // full text, and a selection handed over in the editor lands in a message
  // either way, so a prompt logged for debugging would be a document leak into
  // the log files. Nothing logs these today; the entries exist so that adding
  // such a log later cannot quietly become one.
  'prompt',
  'systemPrompt',
  'messages',
  '*.password',
  '*.token',
  '*.secret',
  '*.apiKey',
  '*.yjsState',
];

export const REDACTION_PLACEHOLDER = '[redacted]';
