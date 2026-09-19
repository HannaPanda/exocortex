import { Module } from '@nestjs/common';

import { SearchController } from './search.controller';
import {
  keywordSearchAdapterProvider,
  searchAdapterProvider,
  SearchService,
} from './search.service';

@Module({
  controllers: [SearchController],
  providers: [SearchService, searchAdapterProvider, keywordSearchAdapterProvider],
  exports: [SearchService, searchAdapterProvider, keywordSearchAdapterProvider],
})
export class SearchModule {}
