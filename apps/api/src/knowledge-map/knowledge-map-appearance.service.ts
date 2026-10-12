import { Inject, Injectable } from '@nestjs/common';

import {
  DEFAULT_KNOWLEDGE_MAP_APPEARANCE,
  type KnowledgeMapAppearancePatch,
  type KnowledgeMapAppearanceResponse,
  mergeKnowledgeMapAppearance,
  readKnowledgeMapAppearance,
} from '@exocortex/contracts';
import { Prisma, type PrismaClient } from '@exocortex/database';

import { AppError } from '../common/app-error';
import { PRISMA } from '../platform/platform-tokens';

/**
 * How the knowledge map looks to one person (issue #189). Kept on the account
 * like the interface language, because taste follows the person rather than
 * a workspace. The whole look is stored once anything is changed, so a later
 * change of the defaults moves only the people who never tuned it.
 */
@Injectable()
export class KnowledgeMapAppearanceService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async get(userId: string): Promise<KnowledgeMapAppearanceResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { knowledgeMapAppearance: true },
    });
    if (user === null)
      throw AppError.unauthenticated('Session references a user that no longer exists');
    const stored = user.knowledgeMapAppearance;
    return stored === null
      ? { appearance: DEFAULT_KNOWLEDGE_MAP_APPEARANCE, isDefault: true }
      : { appearance: readKnowledgeMapAppearance(stored), isDefault: false };
  }

  async update(
    userId: string,
    patch: KnowledgeMapAppearancePatch,
  ): Promise<KnowledgeMapAppearanceResponse> {
    const current = await this.get(userId);
    const appearance = mergeKnowledgeMapAppearance(current.appearance, patch);
    await this.prisma.user.update({
      where: { id: userId },
      data: { knowledgeMapAppearance: appearance },
    });
    return { appearance, isDefault: false };
  }

  async reset(userId: string): Promise<KnowledgeMapAppearanceResponse> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { knowledgeMapAppearance: Prisma.DbNull },
    });
    return { appearance: DEFAULT_KNOWLEDGE_MAP_APPEARANCE, isDefault: true };
  }
}
