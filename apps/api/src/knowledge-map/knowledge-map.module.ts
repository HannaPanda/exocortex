import { Module } from '@nestjs/common';

import { SearchModule } from '../search/search.module';

import { KnowledgeMapController } from './knowledge-map.controller';
import { KnowledgeMapService } from './knowledge-map.service';
import { KnowledgeMapAppearanceController } from './knowledge-map-appearance.controller';
import { KnowledgeMapAppearanceService } from './knowledge-map-appearance.service';

/**
 * The knowledge map (issue #189). Its own module because it reads across
 * documents, references, entities and search vectors and belongs to none of
 * them; `SearchModule` is imported for the adapter, to know whether this
 * deployment has vectors at all. The person's look of the map lives here too,
 * under `/api/me`, because nothing else reads it.
 */
@Module({
  imports: [SearchModule],
  controllers: [KnowledgeMapController, KnowledgeMapAppearanceController],
  providers: [KnowledgeMapService, KnowledgeMapAppearanceService],
})
export class KnowledgeMapModule {}
