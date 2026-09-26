import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { type ApiEnv } from '@exocortex/config';

import { AdminModule } from './admin/admin.module';
import { AgentSessionsModule } from './agent-sessions/agent-sessions.module';
import { AiModule } from './ai/ai.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { AttentionModule } from './attention/attention.module';
import { AdminGuard } from './auth/admin.guard';
import { AuthModule } from './auth/auth.module';
import { SessionGuard } from './auth/session.guard';
import { TokenScopeGuard } from './auth/token-scope.guard';
import { AutomationsModule } from './automations/automations.module';
import { ChangesetsModule } from './changesets/changesets.module';
import { CommentsModule } from './comments/comments.module';
import { ApiExceptionFilter } from './common/exception.filter';
import { isHttpContext } from './common/http-context';
import { API_ENV } from './common/logger.provider';
import { ContextModule } from './context/context.module';
import { DatabasesModule } from './databases/databases.module';
import { DocumentsModule } from './documents/documents.module';
import { EntitiesModule } from './entities/entities.module';
import { FeaturesModule } from './features/features.module';
import { HealthModule } from './health/health.module';
import { InboxModule } from './inbox/inbox.module';
import { InvitationsModule } from './invitations/invitations.module';
import { McpModule } from './mcp/mcp.module';
import { MeModule } from './me/me.module';
import { MemoryModule } from './memory/memory.module';
import { PlatformModule } from './platform/platform.module';
import { ProjectsModule } from './projects/projects.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RenderModule } from './render/render.module';
import { ResearchModule } from './research/research.module';
import { SavedQueriesModule } from './saved-queries/saved-queries.module';
import { SearchModule } from './search/search.module';
import { SharesModule } from './shares/shares.module';
import { TemplatesModule } from './templates/templates.module';
import { WorkItemsModule } from './work-items/work-items.module';
import { WorkspacesModule } from './workspaces/workspaces.module';

@Module({
  imports: [
    PlatformModule,
    ThrottlerModule.forRootAsync({
      // `PlatformModule` is where `API_ENV` comes from. Naming it is also what
      // keeps this call compiling: `@nestjs/throttler` still types its options
      // against a deep import of `@nestjs/common/interfaces`, a path NestJS 12
      // no longer exposes, so `Pick<ModuleMetadata, 'imports'>` collapses into
      // an `imports` the type demands. Drop it once the throttler's
      // declarations import from the package root.
      imports: [PlatformModule],
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => ({
        // A WebSocket message is not a request and has no response to write
        // rate-limit headers to; see `isHttpContext`.
        skipIf: (context) => !isHttpContext(context),
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
    TemplatesModule,
    WorkspacesModule,
    DocumentsModule,
    CommentsModule,
    DatabasesModule,
    SearchModule,
    ContextModule,
    SavedQueriesModule,
    WorkItemsModule,
    AttentionModule,
    ChangesetsModule,
    AttachmentsModule,
    AiModule,
    AdminModule,
    InboxModule,
    InvitationsModule,
    HealthModule,
    MeModule,
    MemoryModule,
    EntitiesModule,
    FeaturesModule,
    McpModule,
    AgentSessionsModule,
    AutomationsModule,
    ProjectsModule,
    RenderModule,
    ResearchModule,
    SharesModule,
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
