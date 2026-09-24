import { Module } from '@nestjs/common';

import { SearchController } from './search.controller';
import {
  keywordSearchAdapterProvider,
  passageSearchProvider,
  searchAdapterProvider,
  SearchService,
} from './search.service';

@Module({
  controllers: [SearchController],
  providers: [
    SearchService,
    searchAdapterProvider,
    keywordSearchAdapterProvider,
    passageSearchProvider,
  ],
  exports: [
    SearchService,
    searchAdapterProvider,
    keywordSearchAdapterProvider,
    passageSearchProvider,
  ],
})
export class SearchModule {}
