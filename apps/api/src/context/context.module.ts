import { Module } from '@nestjs/common';

import { SearchModule } from '../search/search.module';

import { ContextController } from './context.controller';
import { ContextService } from './context.service';

/** The context compiler (issue #110, ADR-061). Reads through the search module, owns nothing. */
@Module({
  imports: [SearchModule],
  controllers: [ContextController],
  providers: [ContextService],
  exports: [ContextService],
})
export class ContextModule {}
