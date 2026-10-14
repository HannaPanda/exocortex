import { Module } from '@nestjs/common';

import { OutboxService } from '../common/outbox.service';

import { ExternalMcpController } from './external-mcp.controller';
import { ExternalMcpService } from './external-mcp.service';

/** External MCP servers for the built-in AI (issue #196, ADR-086). */
@Module({
  controllers: [ExternalMcpController],
  providers: [ExternalMcpService, OutboxService],
})
export class ExternalMcpModule {}
