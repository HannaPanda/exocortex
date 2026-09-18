import { Module } from '@nestjs/common';

import { FeaturesController } from './features.controller';
import { FeaturesService } from './features.service';

/**
 * The feature registry (issue #80, ADR-040): a static catalogue plus one date
 * per person. No other module depends on it, and it depends on nothing but the
 * database connection.
 */
@Module({
  controllers: [FeaturesController],
  providers: [FeaturesService],
  exports: [FeaturesService],
})
export class FeaturesModule {}
