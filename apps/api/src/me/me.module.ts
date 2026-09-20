import { Module } from '@nestjs/common';

import { ApiTokensController } from './api-tokens.controller';
import { ApiTokensService } from './api-tokens.service';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';
import { NotificationPreferencesController } from './notification-preferences.controller';
import { NotificationPreferencesService } from './notification-preferences.service';
import { PushController } from './push.controller';
import { PushService } from './push.service';

@Module({
  controllers: [
    ApiTokensController,
    ConnectionsController,
    NotificationPreferencesController,
    PushController,
  ],
  providers: [ApiTokensService, ConnectionsService, NotificationPreferencesService, PushService],
})
export class MeModule {}
