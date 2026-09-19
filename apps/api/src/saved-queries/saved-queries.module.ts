import { Module } from '@nestjs/common';

import { RealtimeModule } from '../realtime/realtime.module';
import { SearchModule } from '../search/search.module';

import { SavedQueriesController } from './saved-queries.controller';
import { SavedQueriesService } from './saved-queries.service';

/**
 * Saved searches, smart views and query blocks (issue #74).
 *
 * Both search adapters come from `SearchModule` rather than being built here:
 * a saved query is the search box with the filters written down, and it would
 * be a bug if the two answered the same words differently.
 */
@Module({
  imports: [SearchModule, RealtimeModule],
  controllers: [SavedQueriesController],
  providers: [SavedQueriesService],
  exports: [SavedQueriesService],
})
export class SavedQueriesModule {}
