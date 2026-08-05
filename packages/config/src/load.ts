import { type z } from 'zod';

import { loadDotEnv } from './dotenv';
import {
  apiEnvSchema,
  collaborationEnvSchema,
  publicSchema,
  webEnvSchema,
  workerEnvSchema,
} from './schemas';

/**
 * Thrown when environment validation fails. The message is developer-facing and
 * always English; it lists every offending variable so a misconfigured
 * deployment fails fast and explains itself.
 */
export class EnvironmentValidationError extends Error {
  public readonly issues: readonly string[];

  constructor(processName: string, issues: readonly string[]) {
    super(
      `Invalid environment for "${processName}". Fix the following ` +
        `variables (see .env.example):\n` +
        issues.map((issue) => `  - ${issue}`).join('\n'),
    );
    this.name = 'EnvironmentValidationError';
    this.issues = issues;
  }
}

export type EnvironmentSource = Record<string, string | undefined>;

function parseWith<TSchema extends z.ZodType>(
  processName: string,
  schema: TSchema,
  source: EnvironmentSource,
): z.infer<TSchema> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    });
    throw new EnvironmentValidationError(processName, issues);
  }
  return result.data;
}

function defaultSource(): EnvironmentSource {
  loadDotEnv();
  return process.env;
}

export function loadApiEnv(source: EnvironmentSource = defaultSource()) {
  return parseWith('api', apiEnvSchema, source);
}

export function loadWorkerEnv(source: EnvironmentSource = defaultSource()) {
  return parseWith('worker', workerEnvSchema, source);
}

export function loadCollaborationEnv(source: EnvironmentSource = defaultSource()) {
  return parseWith('collaboration', collaborationEnvSchema, source);
}

export function loadWebEnv(source: EnvironmentSource = defaultSource()) {
  return parseWith('web', webEnvSchema, source);
}

/**
 * Validates the browser-safe subset. Called from the Next.js configuration so a
 * missing public URL breaks the build instead of the running application.
 */
export function loadPublicEnv(source: EnvironmentSource = defaultSource()) {
  return parseWith('web:public', publicSchema, source);
}

export function isProduction(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return nodeEnv === 'production';
}
