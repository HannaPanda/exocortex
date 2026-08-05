import { Module } from '@nestjs/common';

import { SearchController } from './search.controller';
import { searchAdapterProvider, SearchService } from './search.service';

@Module({
  controllers: [SearchController],
  providers: [SearchService, searchAdapterProvider],
  exports: [SearchService, searchAdapterProvider],
})
export class SearchModule {}
