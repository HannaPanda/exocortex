import { Inject, Injectable } from '@nestjs/common';

import {
  AI_CONVERSATION_SEARCH_LIMIT,
  type AiConversationRole,
  type AiConversationSearchHit,
} from '@exocortex/contracts';
import {
  type AiConversationRole as AiConversationRolePrisma,
  buildTsQuery,
  Prisma,
  type PrismaClient,
} from '@exocortex/database';

import { PRISMA } from '../platform/platform.module';

/**
 * Full-text search over the messages of one's own conversations (issue #69).
 *
 * Its own file rather than another method on `ConversationsService`: this is
 * the one place in the AI module that writes SQL, and the permission rule it
 * carries is the whole security of the feature. Two conditions, both in the
 * `WHERE` and neither optional: the conversation was created by the caller,
 * and it sits in a workspace the caller is a member of. Ownership alone would
 * be enough today; membership is checked as well so that a workspace someone
 * was removed from stops answering, the same way `ConversationsService`
 * re-checks the role on every read.
 *
 * Retired messages (`supersededAt`) are searched too. They are exactly what a
 * person is looking for when a compaction has replaced them: the summary above
 * them does not contain the sentence they remember.
 */

/** One conversation's best-ranked matching message, as SQL returns it. */
interface SearchRow {
  conversationId: string;
  messageId: string;
  role: AiConversationRolePrisma;
  snippet: string;
  createdAt: Date;
  supersededAt: Date | null;
  matchCount: bigint;
  rank: number;
}

const ROLE_TO_CONTRACT: Record<AiConversationRolePrisma, AiConversationRole> = {
  SYSTEM: 'system',
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL: 'tool',
};

const HEADLINE_OPTIONS =
  'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, MaxWords=22, MinWords=6';

export interface ConversationSearchMatch {
  conversationId: string;
  hit: Omit<AiConversationSearchHit, 'conversation'>;
}

@Injectable()
export class ConversationSearchService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /**
   * Conversations whose transcript matches, best passage first.
   *
   * Returns an empty list for a query that carries no searchable token at all
   * (`"???"`), rather than asking PostgreSQL to parse an empty `tsquery`.
   */
  async search(input: {
    query: string;
    userId: string;
    workspaceIds: readonly string[];
    archived: 'open' | 'archived' | 'all';
    limit?: number;
  }): Promise<ConversationSearchMatch[]> {
    const tsQuery = buildTsQuery(input.query);
    if (tsQuery === '' || input.workspaceIds.length === 0) return [];

    const limit = Math.min(input.limit ?? AI_CONVERSATION_SEARCH_LIMIT, 100);
    const archivedFilter =
      input.archived === 'all'
        ? Prisma.empty
        : input.archived === 'archived'
          ? Prisma.sql`AND conversation."archivedAt" IS NOT NULL`
          : Prisma.sql`AND conversation."archivedAt" IS NULL`;

    const rows = await this.prisma.$queryRaw<SearchRow[]>(Prisma.sql`
      WITH matches AS (
        SELECT
          message."conversationId"                                  AS "conversationId",
          message."id"                                              AS "messageId",
          message."role"                                            AS "role",
          message."createdAt"                                       AS "createdAt",
          message."supersededAt"                                    AS "supersededAt",
          ts_headline(
            'simple',
            message."content",
            to_tsquery('simple', ${tsQuery}),
            ${HEADLINE_OPTIONS}
          )                                                         AS "snippet",
          ts_rank_cd(message."searchVector", to_tsquery('simple', ${tsQuery})) AS "rank",
          count(*) OVER (PARTITION BY message."conversationId")      AS "matchCount"
        FROM "ai_conversation_message" message
        JOIN "ai_conversation" conversation
          ON conversation."id" = message."conversationId"
        WHERE message."searchVector" @@ to_tsquery('simple', ${tsQuery})
          AND conversation."createdById" = ${input.userId}
          AND conversation."workspaceId" IN (${Prisma.join(input.workspaceIds)})
          ${archivedFilter}
      ),
      best AS (
        SELECT DISTINCT ON ("conversationId") *
        FROM matches
        ORDER BY "conversationId", "rank" DESC, "createdAt" DESC
      )
      SELECT * FROM best
      ORDER BY "rank" DESC, "createdAt" DESC
      LIMIT ${limit}
    `);

    return rows.map((row) => ({
      conversationId: row.conversationId,
      hit: {
        snippet: row.snippet,
        messageId: row.messageId,
        messageRole: ROLE_TO_CONTRACT[row.role],
        messageCreatedAt: row.createdAt.toISOString(),
        messageSuperseded: row.supersededAt !== null,
        matchCount: Number(row.matchCount),
      },
    }));
  }
}
