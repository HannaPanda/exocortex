import { Inject, Injectable } from '@nestjs/common';

import {
  aliasTargetOf,
  fetchOpenRouterModels,
  mapModelFields,
  type OpenRouterModel,
  type OpenRouterModelFields,
  resolveModelRoutes,
} from '@exocortex/ai';
import { type ApiEnv } from '@exocortex/config';
import {
  type AddAiModelsFromCatalogRequest,
  type AddAiModelsFromCatalogResponse,
  type AiModel,
  type AiModelCatalogEntry,
  type AiModelCatalogResponse,
  type AiModelEndpointListResponse,
  type AiModelListResponse,
  type CreateAiModelRequest,
  type SyncAiModelsRequest,
  type SyncAiModelsResponse,
  type UpdateAiModelRequest,
} from '@exocortex/contracts';
import {
  type AiReasoningLevel as AiReasoningLevelPrisma,
  applyModelRouteSnapshot,
  type Prisma,
  type PrismaClient,
} from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import {
  AiModelResolverService,
  mapAiModelRow,
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
 * One live entry as the catalogue dialog shows it: the registry's shape, not the
 * provider's.
 *
 * `source` is where the numbers come from and defaults to the entry itself. For
 * an alias (`~z-ai/glm-latest`) it is the entry the alias resolves to: the alias
 * row carries the figures of the *cheapest* endpoint, which describes a
 * different model size than the one a request usually lands on.
 */
export function toCatalogEntry(
  entry: OpenRouterModel,
  registered: boolean,
  source: OpenRouterModel = entry,
): AiModelCatalogEntry {
  const fields = mapModelFields(source, FALLBACK_CONTEXT_WINDOW_TOKENS);
  return {
    slug: entry.id,
    displayName: entry.name ?? entry.id,
    description: entry.description ?? null,
    aliasTargetSlug: aliasTargetOf(entry),
    contextWindowTokens: fields.contextWindowTokens,
    maxOutputTokens: fields.maxOutputTokens,
    supportsVision: fields.supportsVision,
    supportsTools: fields.supportsTools,
    reasoningLevels: fields.reasoningLevels,
    inputMicroUsdPerMTok: fields.inputMicroUsdPerMTok,
    outputMicroUsdPerMTok: fields.outputMicroUsdPerMTok,
    registered,
  };
}

/** The registry's enum for a set of levels the catalogue reported in its own vocabulary. */
function toPrismaLevels(levels: readonly OpenRouterModelFields['reasoningLevels'][number][]) {
  return levels.map((level) => REASONING_LEVEL_TO_PRISMA[level]);
}

function reasoningLevelsEqual(
  a: readonly AiReasoningLevelPrisma[],
  b: readonly AiReasoningLevelPrisma[],
): boolean {
  return a.length === b.length && a.every((level, index) => level === b[index]);
}

/** One `ai_model` row as the registry reads it back. */
type AiModelRegistryRow = Awaited<ReturnType<PrismaClient['aiModel']['findMany']>>[number];

/** True when a registry row already says exactly what the provider says. */
function matchesLiveEntry(
  row: AiModelRegistryRow,
  fields: OpenRouterModelFields,
  aliasTargetSlug: string | null,
): boolean {
  return (
    row.contextWindowTokens === fields.contextWindowTokens &&
    row.maxOutputTokens === fields.maxOutputTokens &&
    row.supportsVision === fields.supportsVision &&
    row.supportsTools === fields.supportsTools &&
    reasoningLevelsEqual(row.reasoningLevels, toPrismaLevels(fields.reasoningLevels)) &&
    row.inputMicroUsdPerMTok === fields.inputMicroUsdPerMTok &&
    row.outputMicroUsdPerMTok === fields.outputMicroUsdPerMTok &&
    row.aliasTargetSlug === aliasTargetSlug
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
   * One model's endpoint snapshot, for the admin view (ADR-032).
   *
   * Sorted by what a request cares about first: the biggest window, then the
   * cheapest of those. It is a snapshot, not a live read -- the point is to show
   * what routing decisions are actually being made from.
   */
  async endpoints(modelId: string): Promise<AiModelEndpointListResponse> {
    const model = await this.prisma.aiModel.findUnique({
      where: { id: modelId },
      select: { id: true, slug: true, aliasTargetSlug: true, endpointsSyncedAt: true },
    });
    if (model === null) throw AppError.notFound('AI model');

    const rows = await this.prisma.aiModelEndpoint.findMany({
      where: { modelId },
      orderBy: [{ contextWindowTokens: 'desc' }, { inputMicroUsdPerMTok: 'asc' }],
    });

    return {
      endpoints: rows.map((row) => ({
        providerKey: row.providerKey,
        providerName: row.providerName,
        contextWindowTokens: row.contextWindowTokens,
        maxPromptTokens: row.maxPromptTokens,
        maxOutputTokens: row.maxOutputTokens,
        inputMicroUsdPerMTok: row.inputMicroUsdPerMTok,
        outputMicroUsdPerMTok: row.outputMicroUsdPerMTok,
        supportsTools: row.supportsTools,
        supportsReasoningEffort: row.supportsReasoningEffort,
        quantization: row.quantization,
        updatedAt: row.updatedAt.toISOString(),
      })),
      targetSlug: rows[0]?.targetSlug ?? model.aliasTargetSlug ?? model.slug,
      syncedAt: model.endpointsSyncedAt?.toISOString() ?? null,
    };
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
      .map((live) => toCatalogEntry(live, registered.has(live.id), this.sourceOf(live, liveById)))
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

      sortOrder += CATALOG_SORT_ORDER_STEP;
      added.push(
        await this.createFromLiveEntry({
          live,
          liveById,
          enabled: request.enabled,
          sortOrder,
        }),
      );
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

  /**
   * The entry whose numbers describe a model: itself, or what an alias resolves
   * to.
   *
   * An alias row (`~z-ai/glm-latest`) carries the figures of the cheapest
   * endpoint rather than of the model, so its own row is the one thing not to
   * read. A target the list does not contain leaves the alias describing itself,
   * which is wrong but is still better than nothing.
   */
  private sourceOf(live: OpenRouterModel, liveById: Map<string, OpenRouterModel>): OpenRouterModel {
    const targetSlug = aliasTargetOf(live);
    if (targetSlug === null) return live;
    return liveById.get(targetSlug) ?? live;
  }

  /**
   * The alias, the figures and the endpoints for one slug (ADR-032).
   *
   * Delegates to `@exocortex/ai`, which is the one implementation the scheduled
   * refresh in the worker uses as well. A failure to read the endpoints is
   * logged here and nowhere else: the caller keeps whatever snapshot the model
   * already had.
   */
  private async resolveRoutes(slug: string, liveById: Map<string, OpenRouterModel>) {
    const resolution = await resolveModelRoutes({
      baseUrl: this.env.OPENROUTER_BASE_URL,
      slug,
      models: liveById,
      fallbackContextWindowTokens: FALLBACK_CONTEXT_WINDOW_TOKENS,
    });
    if (resolution.endpointFailure !== null) {
      this.logger.warn('Endpoint list could not be read; the previous snapshot stands', {
        slug,
        targetSlug: resolution.targetSlug,
        reason: resolution.endpointFailure,
      });
    }
    return resolution;
  }

  /** The provider's current model list, keyed by slug. */
  private async fetchLiveModels(): Promise<Map<string, OpenRouterModel>> {
    try {
      return await fetchOpenRouterModels(this.env.OPENROUTER_BASE_URL);
    } catch (error) {
      throw new AppError(
        'ai_provider_unavailable',
        error instanceof Error ? error.message : 'The model list could not be read',
      );
    }
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

      const routes = await this.resolveRoutes(row.slug, liveById);
      // The endpoints go in even when nothing else changed: a provider that
      // dropped the model, or one that appeared, changes what a request may be
      // routed to without changing a single column on the row.
      await applyModelRouteSnapshot(this.prisma, {
        modelId: row.id,
        targetSlug: routes.targetSlug,
        aliasTargetSlug: routes.aliasTargetSlug,
        endpoints: routes.endpoints,
      });

      const fields = routes.fields;
      if (fields === null || matchesLiveEntry(row, fields, routes.aliasTargetSlug)) {
        unchanged += 1;
        continue;
      }

      await this.prisma.aiModel.update({
        where: { id: row.id },
        data: {
          contextWindowTokens: fields.contextWindowTokens,
          maxOutputTokens: fields.maxOutputTokens,
          supportsVision: fields.supportsVision,
          supportsTools: fields.supportsTools,
          reasoningLevels: toPrismaLevels(fields.reasoningLevels),
          inputMicroUsdPerMTok: fields.inputMicroUsdPerMTok,
          outputMicroUsdPerMTok: fields.outputMicroUsdPerMTok,
          aliasTargetSlug: routes.aliasTargetSlug,
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

      // Disabled and sorted last: a slug that arrived through a sync request
      // was never reviewed by anyone, unlike one picked out of the catalogue.
      await this.createFromLiveEntry({ live, liveById, enabled: false, sortOrder: 900 });
      added.push(slug);
    }

    return added;
  }

  /**
   * Creates one registry row from a live catalogue entry, endpoints and all.
   *
   * The one place a model enters the registry from the provider, used by the
   * catalogue dialog and by `sync`'s `addMissing`. The row is written first and
   * the snapshot second: a provider that will not answer about its endpoints
   * costs the model its routing, not its registration (ADR-032).
   */
  private async createFromLiveEntry(input: {
    live: OpenRouterModel;
    liveById: Map<string, OpenRouterModel>;
    enabled: boolean;
    sortOrder: number;
  }): Promise<AiModel> {
    const { live } = input;
    const routes = await this.resolveRoutes(live.id, input.liveById);
    const fields = routes.fields ?? mapModelFields(live, FALLBACK_CONTEXT_WINDOW_TOKENS);

    const created = await this.prisma.aiModel.create({
      data: {
        slug: live.id,
        displayName: live.name ?? live.id,
        description: live.description ?? null,
        contextWindowTokens: fields.contextWindowTokens,
        maxOutputTokens: fields.maxOutputTokens,
        supportsVision: fields.supportsVision,
        supportsTools: fields.supportsTools,
        reasoningLevels: toPrismaLevels(fields.reasoningLevels),
        inputMicroUsdPerMTok: fields.inputMicroUsdPerMTok,
        outputMicroUsdPerMTok: fields.outputMicroUsdPerMTok,
        enabled: input.enabled,
        sortOrder: input.sortOrder,
        aliasTargetSlug: routes.aliasTargetSlug,
        metadata: live as unknown as Prisma.InputJsonObject,
        syncedAt: new Date(),
      },
      include: AI_MODEL_INCLUDE,
    });

    await applyModelRouteSnapshot(this.prisma, {
      modelId: created.id,
      targetSlug: routes.targetSlug,
      aliasTargetSlug: routes.aliasTargetSlug,
      endpoints: routes.endpoints,
    });
    return mapAiModelRow(created);
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
