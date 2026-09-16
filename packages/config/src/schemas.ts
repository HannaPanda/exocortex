import { z } from 'zod';

/** Trimmed, non-empty string. Rejects accidental empty environment values. */
const requiredString = z.string().trim().min(1);

const booleanFromString = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1');

const port = z.coerce.number().int().min(1).max(65535);

export const nodeEnvSchema = z.enum(['development', 'test', 'production']);
export type NodeEnvironment = z.infer<typeof nodeEnvSchema>;

export const baseSchema = z.object({
  NODE_ENV: nodeEnvSchema.default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  /** Browser-visible origin of the web application. */
  APP_URL: z.url(),
});

export const databaseSchema = z.object({
  DATABASE_URL: requiredString.refine((value) => value.startsWith('postgres'), {
    message: 'DATABASE_URL must be a PostgreSQL connection string',
  }),
});

export const redisSchema = z.object({
  REDIS_URL: requiredString.refine((value) => value.startsWith('redis'), {
    message: 'REDIS_URL must be a redis:// or rediss:// connection string',
  }),
});

export const authSchema = z.object({
  BETTER_AUTH_SECRET: requiredString.min(32, {
    message: 'BETTER_AUTH_SECRET must be at least 32 characters (openssl rand -hex 32)',
  }),
  BETTER_AUTH_URL: z.url(),
});

export const collaborationTicketSchema = z.object({
  COLLABORATION_TICKET_SECRET: requiredString.min(32, {
    message: 'COLLABORATION_TICKET_SECRET must be at least 32 characters (openssl rand -hex 32)',
  }),
  COLLABORATION_TICKET_TTL_SECONDS: z.coerce.number().int().min(10).max(600).default(60),
});

export const storageSchema = z.object({
  S3_ENDPOINT: z.url(),
  S3_REGION: requiredString.default('us-east-1'),
  S3_BUCKET: requiredString,
  S3_ACCESS_KEY_ID: requiredString,
  S3_SECRET_ACCESS_KEY: requiredString,
  S3_FORCE_PATH_STYLE: booleanFromString.default(true),
});

export const mailSchema = z.object({
  SMTP_HOST: requiredString,
  SMTP_PORT: port,
  SMTP_FROM: requiredString,
  /**
   * Credentials for the relay. Optional as a pair: Mailpit accepts anything and
   * needs none, a public relay needs both. Supplying them also switches the
   * transport to STARTTLS, because a password must never cross the wire in the
   * clear -- see `createMailer`.
   */
  SMTP_USER: z.string().trim().min(1).optional(),
  SMTP_PASSWORD: z.string().trim().min(1).optional(),
});

export const aiSchema = z.object({
  AI_PROVIDER: z.enum(['mock', 'openrouter']).default('mock'),
  OPENROUTER_API_KEY: z.string().trim().optional(),
  OPENROUTER_BASE_URL: z.url().default('https://openrouter.ai/api/v1'),
  /** Main driver model. Falls back to the provider's own default when unset. */
  OPENROUTER_DEFAULT_MODEL: z.string().trim().optional(),
  /**
   * Cheap vision-capable model used only to describe document images as text
   * before the main model (which may not support vision, e.g. GLM) sees them.
   * Vision preprocessing is skipped entirely when unset.
   */
  OPENROUTER_VISION_MODEL: z.string().trim().optional(),
  /**
   * Base URL of a docling-serve instance, e.g. `http://127.0.0.1:5010`. Unset
   * means the Docling extractor is never built, so `ai.pdfExtractor: 'docling'`
   * degrades to "not configured" instead of failing at request time.
   */
  DOCLING_BASE_URL: z.url().optional(),
});

/**
 * CalDAV credentials for the calendar sync. Optional throughout: an unset
 * account means "no calendar configured", which degrades the sync job to a
 * no-op instead of stopping the worker from booting.
 *
 * These live in the environment rather than the `setting` table because the
 * table is not encrypted (ADR-013 makes it the authority for *configuration*,
 * not for credentials). Source of truth is Infisical, project `Exocortex`,
 * env `prod`; `deploy/infisical-sync-env.py` merges them into the root `.env`.
 *
 * Known limit: one account per provider. A second mailbox.org account has to
 * move to a per-account row that references its own Infisical key.
 */
export const calendarSchema = z.object({
  /** CalDAV entry point, e.g. `https://dav.mailbox.org/`. Discovery starts here. */
  MAILBOX_CALDAV_URL: z.url().optional(),
  MAILBOX_CALDAV_USERNAME: z.string().trim().min(1).optional(),
  MAILBOX_CALDAV_PASSWORD: z.string().min(1).optional(),
  /**
   * How an appointment reminder leaves the deployment: an executable that takes
   * the message on stdin, plus the target to hand it. On this host that is
   * Hermes' one-shot sender, `/home/johanna/.local/bin/hermes`, which reaches
   * Telegram with the gateway's own credentials and without an LLM.
   *
   * Here rather than in the `setting` table because it is deployment topology:
   * an absolute path on this machine, meaningless on another. Unset means
   * reminders stay off however the settings are configured, the same seam that
   * disables the AI tool loop without a service-token secret.
   */
  CALENDAR_REMINDER_COMMAND: z.string().trim().min(1).optional(),
  /** Passed as the delivery target, e.g. `telegram` or `telegram:<chatId>`. */
  CALENDAR_REMINDER_TARGET: z.string().trim().min(1).optional(),
});

export const apiProcessSchema = z.object({
  API_PORT: port.default(3211),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(512 * 1024 * 1024)
    .default(26_214_400),
});

/**
 * Shared secret the worker uses to mint short-lived service tokens the API
 * accepts as bearer credentials. Optional on purpose: when unset the built-in
 * AI simply runs without tools, so a missing line in `.env` can never stop a
 * process from booting.
 */
export const serviceTokenSchema = z.object({
  SERVICE_TOKEN_SECRET: z.string().trim().min(32).optional(),
  SERVICE_TOKEN_TTL_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
});

/**
 * Key that encrypts the stored third-party credentials in `workspace_credential`
 * (issue #52, ADR-023): 32 bytes, base64, e.g. `openssl rand -base64 32`.
 *
 * Optional like `SERVICE_TOKEN_SECRET`, and for the same reason: an unset line
 * in `.env` must never stop a process from booting. Unset means a workspace
 * cannot bring its own provider key, and every AI run is paid for with the
 * deployment's key, which is exactly how the deployment behaved before BYOK.
 */
export const credentialEncryptionSchema = z.object({
  CREDENTIAL_ENCRYPTION_KEY: z.string().trim().optional(),
});

export const internalApiSchema = z.object({
  /** Internal base URL of the REST API, used by the worker's tool loop. */
  API_URL: z.url().default('http://127.0.0.1:3211'),
});

export const collaborationProcessSchema = z.object({
  COLLABORATION_PORT: port.default(3212),
});

/**
 * Internal base URL of the collaboration server, used by the API to push a
 * non-editor write into an open editing session (ADR-016). Loopback by default
 * because the endpoint behind it is private: it must never be published through
 * the reverse proxy.
 */
export const internalCollaborationSchema = z.object({
  COLLABORATION_INTERNAL_URL: z.url().default('http://127.0.0.1:3212'),
});

/**
 * Distributed tracing (issue #57). Off unless an endpoint is configured, and
 * the switch is here rather than in the `setting` table on purpose: the tracer
 * has to exist before the first request is served, which is well before the
 * database is read (ADR-013 leaves bootstrap to the environment).
 */
export const tracingSchema = z.object({
  /** OTLP/HTTP base URL of the collector, e.g. `http://127.0.0.1:4318`. Empty means no tracing. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().trim().optional(),
  /** `key=value,key2=value2` for a collector that wants an authorization header. */
  OTEL_EXPORTER_OTLP_HEADERS: z.string().trim().optional(),
  /** Fraction of traces to keep, 0 to 1. A child always follows its parent's decision. */
  OTEL_TRACES_SAMPLER_RATIO: z.coerce.number().min(0).max(1).default(1),
  /** Switches tracing off without removing the endpoint. */
  OTEL_TRACES_ENABLED: booleanFromString.default(true),
});

export const webProcessSchema = z.object({
  WEB_PORT: port.default(3210),
});

/**
 * Values that are safe to ship to the browser bundle. Everything referenced
 * here is public by definition; secrets must never be added.
 */
export const publicSchema = z.object({
  PUBLIC_API_URL: z.url(),
  PUBLIC_COLLABORATION_URL: requiredString.refine(
    (value) => value.startsWith('ws://') || value.startsWith('wss://'),
    { message: 'PUBLIC_COLLABORATION_URL must be a ws:// or wss:// URL' },
  ),
});

export const apiEnvSchema = baseSchema
  .extend(databaseSchema.shape)
  .extend(redisSchema.shape)
  .extend(authSchema.shape)
  .extend(collaborationTicketSchema.shape)
  .extend(storageSchema.shape)
  .extend(mailSchema.shape)
  .extend(aiSchema.shape)
  .extend(apiProcessSchema.shape)
  .extend(publicSchema.shape)
  .extend(serviceTokenSchema.shape)
  .extend(credentialEncryptionSchema.shape)
  .extend(internalCollaborationSchema.shape)
  .extend(tracingSchema.shape);

export const workerEnvSchema = baseSchema
  .extend(databaseSchema.shape)
  .extend(redisSchema.shape)
  .extend(storageSchema.shape)
  .extend(aiSchema.shape)
  .extend(calendarSchema.shape)
  .extend(serviceTokenSchema.shape)
  .extend(credentialEncryptionSchema.shape)
  .extend(internalApiSchema.shape)
  .extend(tracingSchema.shape);

export const collaborationEnvSchema = baseSchema
  .extend(databaseSchema.shape)
  .extend(redisSchema.shape)
  .extend(collaborationTicketSchema.shape)
  .extend(collaborationProcessSchema.shape)
  .extend(tracingSchema.shape);

export const webEnvSchema = baseSchema.extend(webProcessSchema.shape).extend(publicSchema.shape);

export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;
export type CollaborationEnv = z.infer<typeof collaborationEnvSchema>;
export type WebEnv = z.infer<typeof webEnvSchema>;
export type PublicEnv = z.infer<typeof publicSchema>;
