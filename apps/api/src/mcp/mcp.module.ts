import { Module } from '@nestjs/common';

import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { McpStreamsService } from './mcp-streams.service';

@Module({
  controllers: [McpController],
  providers: [McpService, McpStreamsService],
})
export class McpModule {}
