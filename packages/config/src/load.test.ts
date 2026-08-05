import { describe, expect, it } from 'vitest';

import { EnvironmentValidationError, loadApiEnv } from './load';

const validApiEnv = {
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:3210',
  DATABASE_URL: 'postgresql://user:pass@127.0.0.1:5433/exocortex',
  REDIS_URL: 'redis://127.0.0.1:6380',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3210',
  COLLABORATION_TICKET_SECRET: 'b'.repeat(32),
  S3_ENDPOINT: 'http://127.0.0.1:9110',
  S3_BUCKET: 'exocortex',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1026',
  SMTP_FROM: 'Exocortex <no-reply@exocortex.app>',
  PUBLIC_API_URL: 'http://localhost:3211',
  PUBLIC_COLLABORATION_URL: 'ws://localhost:3212',
};

describe('loadApiEnv', () => {
  it('accepts a complete environment and applies defaults', () => {
    const env = loadApiEnv(validApiEnv);
    expect(env.API_PORT).toBe(3211);
    expect(env.AI_PROVIDER).toBe('mock');
    expect(env.COLLABORATION_TICKET_TTL_SECONDS).toBe(60);
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
  });

  it('fails with an explicit message when a secret is too short', () => {
    expect(() => loadApiEnv({ ...validApiEnv, BETTER_AUTH_SECRET: 'short' })).toThrowError(
      EnvironmentValidationError,
    );
  });

  it('lists every missing variable at once', () => {
    try {
      loadApiEnv({ NODE_ENV: 'test' });
      expect.unreachable('validation should have failed');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      const issues = (error as EnvironmentValidationError).issues;
      expect(issues.some((issue) => issue.startsWith('DATABASE_URL'))).toBe(true);
      expect(issues.some((issue) => issue.startsWith('REDIS_URL'))).toBe(true);
    }
  });

  it('rejects a non-websocket collaboration URL', () => {
    expect(() =>
      loadApiEnv({ ...validApiEnv, PUBLIC_COLLABORATION_URL: 'http://localhost:3212' }),
    ).toThrowError(/PUBLIC_COLLABORATION_URL/);
  });
});
