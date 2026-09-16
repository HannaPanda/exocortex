import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { type ApiEnv } from '@exocortex/config';
import {
  type AddAiModelsFromCatalogRequest,
  type AddAiModelsFromCatalogResponse,
  type AiModel,
  type AiModelCatalogEntry,
  type AiModelCatalogResponse,
  type AiModelListResponse,
  type CreateAiModelRequest,
  type SyncAiModelsRequest,
  type SyncAiModelsResponse,
  type UpdateAiModelRequest,
} from '@exocortex/contracts';
import {
  type AiReasoningLevel as AiReasoningLevelPrisma,
  type Prisma,
  type PrismaClient,
} from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import {
  AiModelResolverService,
  mapAiModelRow,
  REASONING_LEVEL_TO_CONTRACT,
  REASONING_LEVEL_TO_PRISMA,
} from '../ai/ai-model-resolver.service';
import { AppError } from '../common/app-error';
import { API_ENV, LOGGER } from '../common/logger.provider';
import { PRISMA } from '../platform/platform-tokens';

const AI_MODEL_INCLUDE = { visionCompanion: { select: { slug: true } } } as const;

/**
 * Context window for a provider entry that does not state one. Rare, and low
 * enough to be conservative: compaction triggers early rather than late, and an
 * admin can correct the row afterwards.
 */
const FALLBACK_CONTEXT_WINDOW_TOKENS = 8192;

/** Gap between the sort positions of models added in one go, so single rows fit between them later. */
const CATALOG_SORT_ORDER_STEP = 10;

/**
 * Narrow, lenient schema for `GET {OPENROUTER_BASE_URL}/models`.
 *
 * `.loose()` on every object lets OpenRouter add a field at any time without
 * breaking the sync -- only the handful of properties this service actually
 * reads are named.
 */
const openRouterModelSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    context_length: z.number().optional(),
    architecture: z
      .object({
        input_modalities: z.array(z.string()).default([]),
      })
      .loose()
      .optional(),
    supported_parameters: z.array(z.string()).default([]),
    top_provider: z
      .object({
        max_completion_tokens: z.number().nullable().optional(),
      })
      .loose()
      .nullable()
      .optional(),
    pricing: z
      .object({
        prompt: z.string(),
        completion: z.string(),
      })
      .loose(),
  })
  .loose();

const openRouterModelListSchema = z.object({
  data: z.array(openRouterModelSchema),
});

export type OpenRouterModel = z.infer<typeof openRouterModelSchema>;

/**
 * Derives the selectable thinking levels from OpenRouter's `supported_parameters`.
 *
 * A model that only lists `reasoning` thinks on its own terms and offers no
 * level to pick, so it gets `[NONE]`. `reasoning_effort` means the effort levels
 * are honoured; `verbosity` (Anthropic) does not add a level. MINIMAL is only
 * offered where the provider documents it, which today is OpenAI.
 */
export function deriveReasoningLevels(input: {
  slug: string;
  supportedParameters: readonly string[];
}): AiReasoningLevelPrisma[] {
  if (!input.supportedParameters.includes('reasoning_effort')) {
    return ['NONE'];
  }
  const levels: AiReasoningLevelPrisma[] = ['NONE'];
  if (input.slug.startsWith('openai/')) levels.push('MINIMAL');
  levels.push('LOW', 'MEDIUM', 'HIGH');
  return levels;
}

interface MappedLiveFields {
  contextWindowTokens: number;
  maxOutputTokens: number | null;
  supportsVision: boolean;
  supportsTools: boolean;
  reasoningLevels: AiReasoningLevelPrisma[];
  inputMicroUsdPerMTok: number;
  outputMicroUsdPerMTok: number;
}

/** Maps one live OpenRouter entry onto the registry's column shape. Prices are integers: never store a float. */
function mapLiveEntry(
  entry: OpenRouterModel,
  fallbackContextWindowTokens: number,
): MappedLiveFields {
  return {
    contextWindowTokens: entry.context_length ?? fallbackContextWindowTokens,
    maxOutputTokens: entry.top_provider?.max_completion_tokens ?? null,
    supportsVision: (entry.architecture?.input_modalities ?? []).includes('image'),
    supportsTools: entry.supported_parameters.includes('tools'),
    reasoningLevels: deriveReasoningLevels({
      slug: entry.id,
      supportedParameters: entry.supported_parameters,
    }),
    inputMicroUsdPerMTok: Math.round(Number(entry.pricing.prompt) * 1e12),
    outputMicroUsdPerMTok: Math.round(Number(entry.pricing.completion) * 1e12),
  };
}

/** One live entry as the catalogue dialog shows it: the registry's shape, not the provider's. */
export function toCatalogEntry(entry: OpenRouterModel, registered: boolean): AiModelCatalogEntry {
  const mapped = mapLiveEntry(entry, FALLBACK_CONTEXT_WINDOW_TOKENS);
  return {
    slug: entry.id,
    displayName: entry.name ?? entry.id,
    description: entry.description ?? null,
    contextWindowTokens: mapped.contextWindowTokens,
    maxOutputTokens: mapped.maxOutputTokens,
    supportsVision: mapped.supportsVision,
    supportsTools: mapped.supportsTools,
    reasoningLevels: mapped.reasoningLevels.map((level) => REASONING_LEVEL_TO_CONTRACT[level]),
    inputMicroUsdPerMTok: mapped.inputMicroUsdPerMTok,
    outputMicroUsdPerMTok: mapped.outputMicroUsdPerMTok,
    registered,
  };
}

function reasoningLevelsEqual(
  a: readonly AiReasoningLevelPrisma[],
  b: readonly AiReasoningLevelPrisma[],
): boolean {
  return a.length === b.length && a.every((level, index) => level === b[index]);
}

/** One `ai_model` row as the registry reads it back. */
type AiModelRegistryRow = Awaited<ReturnType<PrismaClient['aiModel']['findMany']>>[number];

/** True when a registry row already says exactly what the live entry says. */
function matchesLiveEntry(row: AiModelRegistryRow, mapped: MappedLiveFields): boolean {
  return (
    row.contextWindowTokens === mapped.contextWindowTokens &&
    row.maxOutputTokens === mapped.maxOutputTokens &&
    row.supportsVision === mapped.supportsVision &&
    row.supportsTools === mapped.supportsTools &&
    reasoningLevelsEqual(row.reasoningLevels, mapped.reasoningLevels) &&
    row.inputMicroUsdPerMTok === mapped.inputMicroUsdPerMTok &&
    row.outputMicroUsdPerMTok === mapped.outputMicroUsdPerMTok
  );
}

/**
 * Admin CRUD and OpenRouter sync for the AI model registry.
 *
 * `AuditLog.workspaceId` is non-nullable and this is deployment-global
 * administration, so every mutation is recorded through the structured logger
 * with the actor id instead of inventing a workspace row (same constraint
 * `SettingsService` documents).
 */
@Injectable()
export class AiModelsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly resolver: AiModelResolverService,
  ) {}

  async list(): Promise<AiModelListResponse> {
    const rows = await this.prisma.aiModel.findMany({
      orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
      include: AI_MODEL_INCLUDE,
    });

    let defaultModelSlug: string | null = null;
    try {
      defaultModelSlug = (await this.resolver.resolveDefault()).slug;
    } catch {
      defaultModelSlug = null;
    }

    return { models: rows.map(mapAiModelRow), defaultModelSlug };
  }

  async create(request: CreateAiModelRequest, actorId: string): Promise<AiModel> {
    const visionCompanionId = await this.resolveCompanionId(
      request.visionCompanionSlug,
      request.slug,
    );

    const created = await this.prisma.aiModel.create({
      data: {
        slug: request.slug,
        provider: request.provider ?? 'openrouter',
        displayName: request.displayName,
        description: request.description ?? null,
        contextWindowTokens: request.contextWindowTokens,
        maxOutputTokens: request.maxOutputTokens ?? null,
        supportsVision: request.supportsVision,
        supportsTools: request.supportsTools,
        reasoningLevels: (request.reasoningLevels ?? ['none']).map(
          (level) => REASONING_LEVEL_TO_PRISMA[level],
        ),
        inputMicroUsdPerMTok: request.inputMicroUsdPerMTok,
        outputMicroUsdPerMTok: request.outputMicroUsdPerMTok,
        enabled: request.enabled ?? true,
        sortOrder: request.sortOrder ?? 100,
        visionCompanionId,
      },
      include: AI_MODEL_INCLUDE,
    });

    this.logger.info('AI model created', { actorId, aiModelId: created.id, slug: created.slug });
    return mapAiModelRow(created);
  }

  async update(modelId: string, request: UpdateAiModelRequest, actorId: string): Promise<AiModel> {
    const existing = await this.prisma.aiModel.findUnique({ where: { id: modelId } });
    if (existing === null) throw AppError.notFound('AI model');

    const data: Prisma.AiModelUpdateInput = {};
    if (request.slug !== undefined) data.slug = request.slug;
    if (request.provider !== undefined) data.provider = request.provider;
    if (request.displayName !== undefined) data.displayName = request.displayName;
    if (request.description !== undefined) data.description = request.description;
    if (request.contextWindowTokens !== undefined)
      data.contextWindowTokens = request.contextWindowTokens;
    if (request.maxOutputTokens !== undefined) data.maxOutputTokens = request.maxOutputTokens;
    if (request.supportsVision !== undefined) data.supportsVision = request.supportsVision;
    if (request.supportsTools !== undefined) data.supportsTools = request.supportsTools;
    if (request.reasoningLevels !== undefined) {
      data.reasoningLevels = request.reasoningLevels.map(
        (level) => REASONING_LEVEL_TO_PRISMA[level],
      );
    }
    if (request.inputMicroUsdPerMTok !== undefined)
      data.inputMicroUsdPerMTok = request.inputMicroUsdPerMTok;
    if (request.outputMicroUsdPerMTok !== undefined)
      data.outputMicroUsdPerMTok = request.outputMicroUsdPerMTok;
    if (request.enabled !== undefined) data.enabled = request.enabled;
    if (request.sortOrder !== undefined) data.sortOrder = request.sortOrder;

    if (request.visionCompanionSlug !== undefined) {
      if (request.visionCompanionSlug === null) {
        data.visionCompanion = { disconnect: true };
      } else {
        const targetSlug = request.slug ?? existing.slug;
        const companionId = await this.resolveCompanionId(request.visionCompanionSlug, targetSlug);
        if (companionId === null) {
          // Unreachable: resolveCompanionId only returns null for a null/undefined
          // input, and this branch is guarded to a non-null slug.
          throw AppError.internal('Unexpected null vision companion id');
        }
        data.visionCompanion = { connect: { id: companionId } };
      }
    }

    const updated = await this.prisma.aiModel.update({
      where: { id: modelId },
      data,
      include: AI_MODEL_INCLUDE,
    });

    this.logger.info('AI model updated', {
      actorId,
      aiModelId: modelId,
      keys: Object.keys(request).join(','),
    });
    return mapAiModelRow(updated);
  }

  /**
   * Never a hard delete when the model is referenced by a conversation: old
   * conversations must still resolve their model, so the row is disabled
   * instead (it simply leaves the picker, see `AiModel.enabled`).
   */
  async remove(modelId: string, actorId: string): Promise<{ deleted: boolean; disabled: boolean }> {
    const existing = await this.prisma.aiModel.findUnique({ where: { id: modelId } });
    if (existing === null) throw AppError.notFound('AI model');

    const referencedByConversations = await this.prisma.aiConversation.count({
      where: { modelId },
    });
    if (referencedByConversations > 0) {
      await this.prisma.aiModel.update({ where: { id: modelId }, data: { enabled: false } });
      this.logger.info('AI model disabled instead of deleted (still referenced by conversations)', {
        actorId,
        aiModelId: modelId,
      });
      return { deleted: false, disabled: true };
    }

    await this.prisma.aiModel.delete({ where: { id: modelId } });
    this.logger.info('AI model deleted', { actorId, aiModelId: modelId });
    return { deleted: true, disabled: false };
  }

  /**
   * Everything the provider currently offers, mapped onto the registry's shape
   * and marked with what the registry already has.
   *
   * Not cached on the server: the browser holds the answer for as long as the
   * dialog is open, and a stale price here would be copied into a row.
   */
  async catalog(): Promise<AiModelCatalogResponse> {
    const liveById = await this.fetchLiveModels();
    const registered = new Set(
      (await this.prisma.aiModel.findMany({ select: { slug: true } })).map((row) => row.slug),
    );

    const entries = [...liveById.values()]
      .map((live) => toCatalogEntry(live, registered.has(live.id)))
      .sort((a, b) => a.slug.localeCompare(b.slug));

    return { entries, fetchedAt: new Date().toISOString() };
  }

  /**
   * Registers picked slugs with everything the provider knows about them.
   *
   * Enabled by default, unlike `sync`'s `addMissing`: picking a model out of a
   * list is the deliberate act that switch was asking for. A slug the registry
   * already has, or that the provider does not offer, is skipped rather than
   * refused, so picking one row that has since been added does not lose the
   * other nine.
   */
  async addFromCatalog(
    request: AddAiModelsFromCatalogRequest,
    actorId: string,
  ): Promise<AddAiModelsFromCatalogResponse> {
    const liveById = await this.fetchLiveModels();
    const existing = new Set(
      (
        await this.prisma.aiModel.findMany({
          where: { slug: { in: request.slugs } },
          select: { slug: true },
        })
      ).map((row) => row.slug),
    );
    const highest = await this.prisma.aiModel.aggregate({ _max: { sortOrder: true } });

    const added: AiModel[] = [];
    const skipped: string[] = [];
    let sortOrder = highest._max.sortOrder ?? 100;

    for (const slug of request.slugs) {
      const live = liveById.get(slug);
      if (existing.has(slug) || live === undefined) {
        skipped.push(slug);
        continue;
      }

      const mapped = mapLiveEntry(live, FALLBACK_CONTEXT_WINDOW_TOKENS);
      sortOrder += CATALOG_SORT_ORDER_STEP;
      const created = await this.prisma.aiModel.create({
        data: {
          slug,
          displayName: live.name ?? slug,
          description: live.description ?? null,
          contextWindowTokens: mapped.contextWindowTokens,
          maxOutputTokens: mapped.maxOutputTokens,
          supportsVision: mapped.supportsVision,
          supportsTools: mapped.supportsTools,
          reasoningLevels: mapped.reasoningLevels,
          inputMicroUsdPerMTok: mapped.inputMicroUsdPerMTok,
          outputMicroUsdPerMTok: mapped.outputMicroUsdPerMTok,
          enabled: request.enabled,
          sortOrder,
          metadata: live as unknown as Prisma.InputJsonObject,
          syncedAt: new Date(),
        },
        include: AI_MODEL_INCLUDE,
      });
      added.push(mapAiModelRow(created));
    }

    this.logger.info('AI models added from the provider catalogue', {
      actorId,
      added: added.length,
      skipped: skipped.length,
    });

    return { added, skipped };
  }

  async sync(request: SyncAiModelsRequest, actorId: string): Promise<SyncAiModelsResponse> {
    const liveById = await this.fetchLiveModels();

    const scopeSlugs = request.slugs.length > 0 ? request.slugs : null;
    const registryRows = await this.prisma.aiModel.findMany({
      where: scopeSlugs === null ? {} : { slug: { in: scopeSlugs } },
    });

    const { updated, disabled, unchanged } = await this.refreshRegistryRows(registryRows, liveById);
    const added =
      request.addMissing && scopeSlugs !== null
        ? await this.addMissingRows(scopeSlugs, registryRows, liveById)
        : [];

    this.logger.info('AI model registry synced', {
      actorId,
      updated: updated.length,
      added: added.length,
      disabled: disabled.length,
      unchanged,
    });

    return { updated, added, disabled, unchanged };
  }

  /** The provider's current model list, keyed by slug. */
  private async fetchLiveModels(): Promise<Map<string, OpenRouterModel>> {
    const response = await fetch(`${this.env.OPENROUTER_BASE_URL}/models`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new AppError(
        'ai_provider_unavailable',
        `OpenRouter model list request failed with status ${response.status}`,
      );
    }

    const body: unknown = await response.json();
    const parsed = openRouterModelListSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(
        'ai_provider_unavailable',
        'OpenRouter model list response did not match the expected shape',
      );
    }
    return new Map(parsed.data.data.map((entry) => [entry.id, entry]));
  }

  /**
   * Brings the rows the registry already has in line with the live list.
   *
   * A slug missing from the live list is disabled, never deleted: an old
   * conversation must still be able to resolve the model it ran on.
   */
  private async refreshRegistryRows(
    registryRows: readonly AiModelRegistryRow[],
    liveById: Map<string, OpenRouterModel>,
  ): Promise<{ updated: string[]; disabled: string[]; unchanged: number }> {
    const updated: string[] = [];
    const disabled: string[] = [];
    let unchanged = 0;

    for (const row of registryRows) {
      const live = liveById.get(row.slug);
      if (live === undefined) {
        if (row.enabled) {
          await this.prisma.aiModel.update({ where: { id: row.id }, data: { enabled: false } });
          disabled.push(row.slug);
        }
        continue;
      }

      const mapped = mapLiveEntry(live, row.contextWindowTokens);
      if (matchesLiveEntry(row, mapped)) {
        unchanged += 1;
        continue;
      }

      await this.prisma.aiModel.update({
        where: { id: row.id },
        data: {
          contextWindowTokens: mapped.contextWindowTokens,
          maxOutputTokens: mapped.maxOutputTokens,
          supportsVision: mapped.supportsVision,
          supportsTools: mapped.supportsTools,
          reasoningLevels: mapped.reasoningLevels,
          inputMicroUsdPerMTok: mapped.inputMicroUsdPerMTok,
          outputMicroUsdPerMTok: mapped.outputMicroUsdPerMTok,
          metadata: live as unknown as Prisma.InputJsonObject,
          syncedAt: new Date(),
        },
      });
      updated.push(row.slug);
    }

    return { updated, disabled, unchanged };
  }

  /** Adds the requested slugs the registry does not know yet, disabled. */
  private async addMissingRows(
    scopeSlugs: readonly string[],
    registryRows: readonly AiModelRegistryRow[],
    liveById: Map<string, OpenRouterModel>,
  ): Promise<string[]> {
    const knownSlugs = new Set(registryRows.map((row) => row.slug));
    const added: string[] = [];

    for (const slug of scopeSlugs) {
      if (knownSlugs.has(slug)) continue;
      const live = liveById.get(slug);
      if (live === undefined) continue;

      const mapped = mapLiveEntry(live, 0);
      await this.prisma.aiModel.create({
        data: {
          slug,
          displayName: live.name ?? slug,
          description: live.description ?? null,
          contextWindowTokens: mapped.contextWindowTokens,
          maxOutputTokens: mapped.maxOutputTokens,
          supportsVision: mapped.supportsVision,
          supportsTools: mapped.supportsTools,
          reasoningLevels: mapped.reasoningLevels,
          inputMicroUsdPerMTok: mapped.inputMicroUsdPerMTok,
          outputMicroUsdPerMTok: mapped.outputMicroUsdPerMTok,
          // Disabled and sorted last: an admin must review a freshly added
          // model before it appears in the picker.
          enabled: false,
          sortOrder: 900,
          metadata: live as unknown as Prisma.InputJsonObject,
          syncedAt: new Date(),
        },
      });
      added.push(slug);
    }

    return added;
  }

  /** Resolves a vision-companion slug to an id, refusing a model to be its own companion. */
  private async resolveCompanionId(
    companionSlug: string | null | undefined,
    ownSlug: string,
  ): Promise<string | null> {
    if (companionSlug === null || companionSlug === undefined) return null;
    if (companionSlug === ownSlug) {
      throw AppError.validation('A model cannot be its own vision companion');
    }
    const companion = await this.prisma.aiModel.findUnique({
      where: { slug: companionSlug },
      select: { id: true },
    });
    if (companion === null) {
      throw new AppError('ai_model_unknown', `Unknown vision companion slug "${companionSlug}"`);
    }
    return companion.id;
  }
}
