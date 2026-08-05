import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { type FastifyReply } from 'fastify';

import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { Public } from '../auth/session.guard';
import { LOGGER } from '../common/logger.provider';
import { OBJECT_STORAGE, PRISMA, QUEUES } from '../platform/platform.module';

interface ReadinessReport {
  status: 'ok' | 'degraded';
  checks: Record<'database' | 'redis' | 'objectStorage', 'ok' | 'failed'>;
}

/**
 * Liveness answers "is the process up", readiness answers "can it serve
 * traffic". Readiness verifies every hard dependency: PostgreSQL, Redis and
 * object storage.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  @Public()
  @Get('live')
  @ApiOkResponse({ description: 'Process is running' })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  @ApiOkResponse({ description: 'All dependencies are reachable' })
  @ApiServiceUnavailableResponse({ description: 'At least one dependency is unavailable' })
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<ReadinessReport> {
    const [database, redis, objectStorage] = await Promise.all([
      this.check('database', async () => {
        await this.prisma.$queryRaw`SELECT 1`;
      }),
      this.check('redis', async () => {
        const alive = await this.queues.ping();
        if (!alive) throw new Error('Redis did not answer PING');
      }),
      this.check('objectStorage', async () => {
        const healthy = await this.storage.healthCheck();
        if (!healthy) throw new Error('Object storage bucket is not reachable');
      }),
    ]);

    const checks = { database, redis, objectStorage } as const;
    const status = Object.values(checks).every((value) => value === 'ok') ? 'ok' : 'degraded';
    // A degraded readiness probe must fail, otherwise orchestrators keep routing
    // traffic to an instance that cannot serve it.
    void reply.status(status === 'ok' ? 200 : 503);
    return { status, checks };
  }

  private async check(name: string, probe: () => Promise<void>): Promise<'ok' | 'failed'> {
    try {
      await probe();
      return 'ok';
    } catch (error) {
      this.logger.warn('Readiness check failed', {
        check: name,
        reason: error instanceof Error ? error.message : String(error),
      });
      return 'failed';
    }
  }
}
