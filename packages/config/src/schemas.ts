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

export const collaborationProcessSchema = z.object({
  COLLABORATION_PORT: port.default(3212),
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
  .extend(publicSchema.shape);

export const workerEnvSchema = baseSchema
  .extend(databaseSchema.shape)
  .extend(redisSchema.shape)
  .extend(storageSchema.shape)
  .extend(aiSchema.shape);

export const collaborationEnvSchema = baseSchema
  .extend(databaseSchema.shape)
  .extend(redisSchema.shape)
  .extend(collaborationTicketSchema.shape)
  .extend(collaborationProcessSchema.shape);

export const webEnvSchema = baseSchema.extend(webProcessSchema.shape).extend(publicSchema.shape);

export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;
export type CollaborationEnv = z.infer<typeof collaborationEnvSchema>;
export type WebEnv = z.infer<typeof webEnvSchema>;
export type PublicEnv = z.infer<typeof publicSchema>;
