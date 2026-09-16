import { Inject, Injectable } from '@nestjs/common';

import {
  type AiModel,
  type AiModelListResponse,
  type AiReasoningLevel,
  clampReasoningLevel,
} from '@exocortex/contracts';
import {
  type AiReasoningLevel as AiReasoningLevelPrisma,
  type PrismaClient,
} from '@exocortex/database';

import { AppError } from '../common/app-error';
import { AI_DEFAULT_MODEL, PRISMA } from '../platform/platform-tokens';
import { SettingsService } from '../platform/settings.service';

/** Wire format (contract) is lowercase; the Prisma enum is uppercase. Both directions are needed across admin CRUD, sync and resolution. */
export const REASONING_LEVEL_TO_CONTRACT: Record<AiReasoningLevelPrisma, AiReasoningLevel> = {
  NONE: 'none',
  MINIMAL: 'minimal',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  XHIGH: 'xhigh',
  MAX: 'max',
};

export const REASONING_LEVEL_TO_PRISMA: Record<AiReasoningLevel, AiReasoningLevelPrisma> = {
  none: 'NONE',
  minimal: 'MINIMAL',
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
  xhigh: 'XHIGH',
  max: 'MAX',
};

/** Shape returned by every query in this file: the registry row plus its resolved vision-companion slug. */
interface AiModelRow {
  id: string;
  slug: string;
  provider: string;
  displayName: string;
  description: string | null;
  contextWindowTokens: number;
  maxOutputTokens: number | null;
  supportsVision: boolean;
  supportsTools: boolean;
  reasoningLevels: AiReasoningLevelPrisma[];
  inputMicroUsdPerMTok: number;
  outputMicroUsdPerMTok: number;
  enabled: boolean;
  sortOrder: number;
  syncedAt: Date | null;
  aliasTargetSlug: string | null;
  visionCompanion: { slug: string } | null;
}

const AI_MODEL_INCLUDE = { visionCompanion: { select: { slug: true } } } as const;

/** Maps a registry row (with its companion relation resolved) onto the wire contract. */
export function mapAiModelRow(row: AiModelRow): AiModel {
  return {
    id: row.id,
    slug: row.slug,
    provider: row.provider,
    displayName: row.displayName,
    description: row.description,
    contextWindowTokens: row.contextWindowTokens,
    maxOutputTokens: row.maxOutputTokens,
    supportsVision: row.supportsVision,
    supportsTools: row.supportsTools,
    reasoningLevels: row.reasoningLevels.map((level) => REASONING_LEVEL_TO_CONTRACT[level]),
    inputMicroUsdPerMTok: row.inputMicroUsdPerMTok,
    outputMicroUsdPerMTok: row.outputMicroUsdPerMTok,
    visionCompanionSlug: row.visionCompanion?.slug ?? null,
    aliasTargetSlug: row.aliasTargetSlug,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
    syncedAt: row.syncedAt === null ? null : row.syncedAt.toISOString(),
  };
}

export interface ResolvedAiModel {
  id: string;
  slug: string;
  provider: string;
  contextWindowTokens: number;
  maxOutputTokens: number | null;
  supportsVision: boolean;
  supportsTools: boolean;
  reasoningLevels: readonly AiReasoningLevel[];
  /** Slug of the vision companion, or null when the model sees images itself. */
  visionCompanionSlug: string | null;
}

function toResolved(row: AiModelRow): ResolvedAiModel {
  return {
    id: row.id,
    slug: row.slug,
    provider: row.provider,
    contextWindowTokens: row.contextWindowTokens,
    maxOutputTokens: row.maxOutputTokens,
    supportsVision: row.supportsVision,
    supportsTools: row.supportsTools,
    reasoningLevels: row.reasoningLevels.map((level) => REASONING_LEVEL_TO_CONTRACT[level]),
    visionCompanionSlug: row.visionCompanion?.slug ?? null,
  };
}

/**
 * Resolves AI models by slug and derives the deployment's effective default.
 *
 * Shared between the built-in AI run path (`ai.service.ts`) and the
 * conversation service (brief 04), so both trust the exact same registry
 * lookup instead of each reimplementing "unknown vs. disabled vs. default".
 */
@Injectable()
export class AiModelResolverService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(AI_DEFAULT_MODEL) private readonly envDefaultModel: string,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Resolves the model for a request.
   *
   * `slug` unknown to the registry throws `ai_model_unknown`. Known but
   * disabled throws `ai_model_disabled`, unless `allowDisabled` is set (an old
   * conversation may legitimately still point at a retired model). No `slug`
   * resolves the default, which depends on where the request came from:
   * `ai.defaultModelSlug` is workspace-scoped (ADR-023).
   */
  async resolve(input: {
    slug?: string | null;
    allowDisabled?: boolean;
    workspaceId?: string;
  }): Promise<ResolvedAiModel> {
    if (input.slug === undefined || input.slug === null) {
      return this.resolveDefault(input.workspaceId);
    }

    const row = await this.prisma.aiModel.findUnique({
      where: { slug: input.slug },
      include: AI_MODEL_INCLUDE,
    });
    if (row === null) {
      throw new AppError('ai_model_unknown', `Unknown AI model slug "${input.slug}"`);
    }
    if (!row.enabled && input.allowDisabled !== true) {
      throw new AppError('ai_model_disabled', `AI model "${input.slug}" is disabled`);
    }
    return toResolved(row);
  }

  /**
   * The effective default: settings, then env, then the first enabled row.
   *
   * Without a workspace this is the deployment's answer, which is right for
   * the admin area and wrong for a run: a workspace that picked its own model
   * has to get it, and only the caller knows which workspace that is.
   */
  async resolveDefault(workspaceId?: string): Promise<ResolvedAiModel> {
    const settings =
      workspaceId === undefined
        ? await this.settings.get()
        : await this.settings.getForWorkspace(workspaceId);
    const settingSlug = settings['ai.defaultModelSlug'];
    const candidateSlug = settingSlug ?? this.envDefaultModel;

    if (candidateSlug.length > 0) {
      const row = await this.prisma.aiModel.findUnique({
        where: { slug: candidateSlug },
        include: AI_MODEL_INCLUDE,
      });
      if (row !== null && row.enabled) return toResolved(row);
    }

    const firstEnabled = await this.prisma.aiModel.findFirst({
      where: { enabled: true },
      orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
      include: AI_MODEL_INCLUDE,
    });
    if (firstEnabled === null) {
      throw new AppError('ai_model_unknown', 'No enabled AI model is configured');
    }
    return toResolved(firstEnabled);
  }

  /** Clamps a requested level to what the model actually supports. */
  clampReasoningLevel(model: ResolvedAiModel, requested: AiReasoningLevel): AiReasoningLevel {
    return clampReasoningLevel(model.reasoningLevels, requested);
  }

  /**
   * Enabled rows plus the effective default slug, for the public picker
   * (`GET /api/ai/models`). Never throws, even on an empty registry: a picker
   * with no options is a valid (if unlikely) state.
   */
  async listEnabled(): Promise<AiModelListResponse> {
    const rows = await this.prisma.aiModel.findMany({
      where: { enabled: true },
      orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
      include: AI_MODEL_INCLUDE,
    });

    let defaultModelSlug: string | null = null;
    try {
      defaultModelSlug = (await this.resolveDefault()).slug;
    } catch {
      defaultModelSlug = null;
    }

    return { models: rows.map(mapAiModelRow), defaultModelSlug };
  }
}
