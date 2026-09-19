import { Module } from '@nestjs/common';

import { RealtimeModule } from '../realtime/realtime.module';

import { PublicSharesController } from './public-shares.controller';
import { PublicSharesService } from './public-shares.service';
import { SharesController } from './shares.controller';
import { SharesService } from './shares.service';

/**
 * Page shares, public links and the anonymous read behind a link (issue #83,
 * ADR-044).
 *
 * `RealtimeModule` because a withdrawn grant has to reach connections that are
 * already open (ADR-029): an HTTP caller is refused on its next request, a
 * collaboration socket makes no next request.
 */
@Module({
  imports: [RealtimeModule],
  controllers: [SharesController, PublicSharesController],
  providers: [SharesService, PublicSharesService],
  exports: [SharesService],
})
export class SharesModule {}
