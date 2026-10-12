import { Module } from '@nestjs/common';

import { SearchModule } from '../search/search.module';

import { KnowledgeMapController } from './knowledge-map.controller';
import { KnowledgeMapService } from './knowledge-map.service';

/**
 * The knowledge map (issue #189). Its own module because it reads across
 * documents, references, entities and search vectors and belongs to none of
 * them; `SearchModule` is imported for the adapter, to know whether this
 * deployment has vectors at all.
 */
@Module({
  imports: [SearchModule],
  controllers: [KnowledgeMapController],
  providers: [KnowledgeMapService],
})
export class KnowledgeMapModule {}
