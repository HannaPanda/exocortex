import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { type ApiEnv } from '@exocortex/config';

import { AdminModule } from './admin/admin.module';
import { AiModule } from './ai/ai.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { AdminGuard } from './auth/admin.guard';
import { AuthModule } from './auth/auth.module';
import { SessionGuard } from './auth/session.guard';
import { TokenScopeGuard } from './auth/token-scope.guard';
import { CommentsModule } from './comments/comments.module';
import { ApiExceptionFilter } from './common/exception.filter';
import { API_ENV } from './common/logger.provider';
import { DatabasesModule } from './databases/databases.module';
import { DocumentsModule } from './documents/documents.module';
import { HealthModule } from './health/health.module';
import { InvitationsModule } from './invitations/invitations.module';
import { McpModule } from './mcp/mcp.module';
import { MeModule } from './me/me.module';
import { MemoryModule } from './memory/memory.module';
import { PlatformModule } from './platform/platform.module';
import { RealtimeModule } from './realtime/realtime.module';
import { SearchModule } from './search/search.module';
import { WorkspacesModule } from './workspaces/workspaces.module';

@Module({
  imports: [
    PlatformModule,
    ThrottlerModule.forRootAsync({
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => ({
        throttlers: [
          {
            // Generous enough for normal use, tight enough to blunt brute force.
            ttl: 60_000,
            limit: env.NODE_ENV === 'test' ? 10_000 : 300,
          },
        ],
      }),
    }),
    AuthModule,
    RealtimeModule,
    WorkspacesModule,
    DocumentsModule,
    CommentsModule,
    DatabasesModule,
    SearchModule,
    AttachmentsModule,
    AiModule,
    AdminModule,
    InvitationsModule,
    HealthModule,
    MeModule,
    MemoryModule,
    McpModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Authentication runs after rate limiting so unauthenticated floods are
    // rejected before any database access.
    { provide: APP_GUARD, useClass: SessionGuard },
    // Runs after SessionGuard, so the credential kind and its scopes are known.
    // Only narrows `exo_` API tokens; sessions and service tokens pass through.
    { provide: APP_GUARD, useClass: TokenScopeGuard },
    // Runs after SessionGuard, so `request.exocortexSession` already exists;
    // only routes marked `@AdminOnly()` are affected.
    { provide: APP_GUARD, useClass: AdminGuard },
  ],
})
export class AppModule {}
