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
  // A mail job's payload (issue #102): the address it goes to and the values
  // the template puts in front of a reader. Nothing logs these -- the mailer
  // and the processor log the template name and the recipient's *domain*, and
  // that is on purpose -- but a job payload is one `logger.error(..., { payload })`
  // away from a log file that holds somebody's post and the address it went to.
  'recipient',
  'mail',
  '*.recipient',
  '*.mail',
  '*.password',
  '*.token',
  '*.secret',
  '*.apiKey',
  '*.yjsState',
];

export const REDACTION_PLACEHOLDER = '[redacted]';
