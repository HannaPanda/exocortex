import { Module } from '@nestjs/common';

import { DatabasesModule } from '../databases/databases.module';
import { DocumentsModule } from '../documents/documents.module';

import { EntitiesController } from './entities.controller';
import { EntitiesService } from './entities.service';
import { EntityCandidatesService } from './entity-candidates.service';
import { EntityProfileService } from './entity-profile.service';
import { EntityRegistryService } from './entity-registry.service';

/**
 * The entity layer (issue #47).
 *
 * Depends on the documents and databases modules rather than on Prisma for its
 * writes: an entity is a database row, and creating one has to pass the checks
 * a hand-added row passes.
 */
@Module({
  imports: [DocumentsModule, DatabasesModule],
  controllers: [EntitiesController],
  providers: [
    EntitiesService,
    EntityRegistryService,
    EntityProfileService,
    EntityCandidatesService,
  ],
  exports: [EntitiesService, EntityRegistryService, EntityProfileService],
})
export class EntitiesModule {}
