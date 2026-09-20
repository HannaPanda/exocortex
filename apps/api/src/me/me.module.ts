import { Module } from '@nestjs/common';

import { ApiTokensController } from './api-tokens.controller';
import { ApiTokensService } from './api-tokens.service';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';
import { PushController } from './push.controller';
import { PushService } from './push.service';

@Module({
  controllers: [ApiTokensController, ConnectionsController, PushController],
  providers: [ApiTokensService, ConnectionsService, PushService],
})
export class MeModule {}
