import { type Provider } from '@nestjs/common';

import { type ApiEnv, loadApiEnv } from '@exocortex/config';
import { createLogger, type Logger } from '@exocortex/logger';

export const LOGGER = Symbol('EXOCORTEX_LOGGER');
export const API_ENV = Symbol('EXOCORTEX_API_ENV');

/**
 * Environment configuration is validated exactly once, during module
 * instantiation. A missing variable aborts the process before the server binds
 * a port.
 */
export const apiEnvProvider: Provider = {
  provide: API_ENV,
  useFactory: (): ApiEnv => loadApiEnv(),
};

export const loggerProvider: Provider = {
  provide: LOGGER,
  inject: [API_ENV],
  useFactory: (env: ApiEnv): Logger =>
    createLogger({
      name: 'api',
      level: env.LOG_LEVEL,
      pretty: env.NODE_ENV === 'development',
    }),
};
