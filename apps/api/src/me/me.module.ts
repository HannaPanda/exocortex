import { Module } from '@nestjs/common';

import { ApiTokensController } from './api-tokens.controller';
import { ApiTokensService } from './api-tokens.service';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';

@Module({
  controllers: [ApiTokensController, ConnectionsController],
  providers: [ApiTokensService, ConnectionsService],
})
export class MeModule {}
