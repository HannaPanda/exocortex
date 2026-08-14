/**
 * Seeds the AI model registry from a table verified against the live OpenRouter
 * model endpoint on 2026-08-05.
 *
 * Idempotent: rows are upserted by `slug`, so re-running never duplicates and
 * never resets a value an admin edited by hand -- only fields that are still at
 * their seeded value are refreshed. Vision companions are wired in a second
 * pass because they reference other rows in the same table.
 */
import { loadDotEnv } from '@exocortex/config';

import { type AiReasoningLevel, createPrismaClient, type PrismaClient } from '../src/client';

loadDotEnv();

interface SeedModel {
  slug: string;
  displayName: string;
  description: string;
  contextWindowTokens: number;
  maxOutputTokens: number | null;
  supportsVision: boolean;
  supportsTools: boolean;
  reasoningLevels: AiReasoningLevel[];
  inputMicroUsdPerMTok: number;
  outputMicroUsdPerMTok: number;
  sortOrder: number;
  visionCompanionSlug: string | null;
}

const NONE_ONLY: AiReasoningLevel[] = ['NONE'];
const STANDARD_LEVELS: AiReasoningLevel[] = ['NONE', 'LOW', 'MEDIUM', 'HIGH'];
const OPENAI_LEVELS: AiReasoningLevel[] = ['NONE', 'MINIMAL', 'LOW', 'MEDIUM', 'HIGH'];

const QWEN_FLASH = 'qwen/qwen3.7-flash';

/**
 * The 17 rows from plan-00 section 7, copied verbatim (prices are
 * micro-USD per million tokens; every slug was confirmed present in
 * `GET https://openrouter.ai/api/v1/models` before seeding).
 */
const SEED_MODELS: readonly SeedModel[] = [
  {
    sortOrder: 10,
    slug: 'anthropic/claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    description: 'Starkes Allround-Modell mit 1 Mio. Token Kontext',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    supportsVision: true,
    supportsTools: true,
    reasoningLevels: STANDARD_LEVELS,
    inputMicroUsdPerMTok: 2_000_000,
    outputMicroUsdPerMTok: 10_000_000,
    visionCompanionSlug: null,
  },
  {
    sortOrder: 20,
    slug: 'anthropic/claude-opus-5',
    displayName: 'Claude Opus 5',
    description: 'Anthropics leistungsstärkstes Modell für anspruchsvolle Aufgaben',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    supportsVision: true,
    supportsTools: true,
    reasoningLevels: STANDARD_LEVELS,
    inputMicroUsdPerMTok: 5_000_000,
    outputMicroUsdPerMTok: 25_000_000,
    visionCompanionSlug: null,
  },
  {
    sortOrder: 30,
    slug: 'anthropic/claude-haiku-4.5',
    displayName: 'Claude Haiku 4.5',
    description: 'Schnell und günstig für einfache, alltägliche Aufgaben',
    contextWindowTokens: 200_000,
    maxOutputTokens: 64_000,
    supportsVision: true,
    supportsTools: true,
    reasoningLevels: NONE_ONLY,
    inputMicroUsdPerMTok: 1_000_000,
    outputMicroUsdPerMTok: 5_000_000,
    visionCompanionSlug: null,
  },
  {
    sortOrder: 40,
    slug: 'openai/gpt-5.2',
    displayName: 'GPT-5.2',
    description: 'Vielseitiges OpenAI-Modell mit einstellbarer Denktiefe',
    contextWindowTokens: 400_000,
    maxOutputTokens: 128_000,
    supportsVision: true,
    supportsTools: true,
    reasoningLevels: OPENAI_LEVELS,
    inputMicroUsdPerMTok: 1_750_000,
    outputMicroUsdPerMTok: 14_000_000,
    visionCompanionSlug: null,
  },
  {
    sortOrder: 50,
    slug: 'openai/gpt-5.4-mini',
    displayName: 'GPT-5.4 mini',
    description: 'Günstigere GPT-5.4-Variante für alltägliche Anfragen',
    contextWindowTokens: 400_000,
    maxOutputTokens: 128_000,
    supportsVision: true,
    supportsTools: true,
    reasoningLevels: OPENAI_LEVELS,
    inputMicroUsdPerMTok: 750_000,
    outputMicroUsdPerMTok: 4_500_000,
    visionCompanionSlug: null,
  },
  {
    sortOrder: 60,
    slug: 'openai/gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    description: 'Riesiger Kontext für sehr lange Dokumente',
    contextWindowTokens: 1_050_000,
    maxOutputTokens: null,
    supportsVision: true,
    supportsTools: true,
    reasoningLevels: OPENAI_LEVELS,
    inputMicroUsdPerMTok: 1_000_000,
    outputMicroUsdPerMTok: 6_000_000,
    visionCompanionSlug: null,
  },
  {
    sortOrder: 70,
    slug: 'google/gemini-3.1-pro-preview',
    displayName: 'Gemini 3.1 Pro',
    description: 'Googles leistungsstarkes Modell mit sehr großem Kontext',
    contextWindowTokens: 1_048_576,
    maxOutputTokens: null,
    supportsVision: true,
    supportsTools: true,
    reasoningLevels: STANDARD_LEVELS,
    inputMicroUsdPerMTok: 2_000_000,
    outputMicroUsdPerMTok: 12_000_000,
    visionCompanionSlug: null,
  },
  {
    sortOrder: 80,
    slug: 'google/gemini-3.5-flash',
    displayName: 'Gemini 3.5 Flash',
    description: 'Schnelles Gemini-Modell für alltägliche Anfragen',
    contextWindowTokens: 1_048_576,
    maxOutputTokens: null,
    supportsVision: true,
    supportsTools: true,
    reasoningLevels: STANDARD_LEVELS,
    inputMicroUsdPerMTok: 1_500_000,
    outputMicroUsdPerMTok: 9_000_000,
    visionCompanionSlug: null,
  },
  {
    sortOrder: 90,
    slug: 'google/gemini-3.1-flash-lite',
    displayName: 'Gemini 3.1 Flash Lite',
    description: 'Sehr günstiges Gemini-Modell für einfache Aufgaben',
    contextWindowTokens: 1_048_576,
    maxOutputTokens: null,
    supportsVision: true,
    supportsTools: true,
    reasoningLevels: STANDARD_LEVELS,
    inputMicroUsdPerMTok: 250_000,
    outputMicroUsdPerMTok: 1_500_000,
    visionCompanionSlug: null,
  },
  {
    sortOrder: 100,
    slug: 'x-ai/grok-4.5',
    displayName: 'Grok 4.5',
    description: 'xAIs Modell mit großem Kontextfenster',
    contextWindowTokens: 500_000,
    maxOutputTokens: null,
    supportsVision: true,
    supportsTools: true,
    reasoningLevels: STANDARD_LEVELS,
    inputMicroUsdPerMTok: 2_000_000,
    outputMicroUsdPerMTok: 6_000_000,
    visionCompanionSlug: null,
  },
  {
    sortOrder: 110,
    slug: 'z-ai/glm-5.2',
    displayName: 'GLM 5.2',
    description: 'Sehr günstig, riesiger Kontext, kein Bildverständnis',
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 262_144,
    supportsVision: false,
    supportsTools: true,
    reasoningLevels: STANDARD_LEVELS,
    inputMicroUsdPerMTok: 760_000,
    outputMicroUsdPerMTok: 2_420_000,
    visionCompanionSlug: QWEN_FLASH,
  },
  {
    sortOrder: 120,
    slug: 'z-ai/glm-4.7',
    displayName: 'GLM 4.7',
    description: 'Günstiges Modell ohne Bildverständnis und ohne Denkstufen',
    contextWindowTokens: 204_800,
    maxOutputTokens: 131_072,
    supportsVision: false,
    supportsTools: true,
    reasoningLevels: NONE_ONLY,
    inputMicroUsdPerMTok: 400_000,
    outputMicroUsdPerMTok: 1_750_000,
    visionCompanionSlug: QWEN_FLASH,
  },
  {
    sortOrder: 130,
    slug: 'qwen/qwen3.8-max',
    displayName: 'Qwen3.8 Max',
    description: 'Alibabas leistungsstärkstes Qwen-Modell',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 131_072,
    supportsVision: true,
    supportsTools: true,
    reasoningLevels: STANDARD_LEVELS,
    inputMicroUsdPerMTok: 2_000_000,
    outputMicroUsdPerMTok: 6_000_000,
    visionCompanionSlug: null,
  },
  {
    sortOrder: 140,
    slug: QWEN_FLASH,
    displayName: 'Qwen3.7 Flash',
    description: 'Schnelles, günstiges Modell; dient auch als Vision-Begleiter anderer Modelle',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 65_536,
    supportsVision: true,
    supportsTools: true,
    reasoningLevels: NONE_ONLY,
    inputMicroUsdPerMTok: 30_000,
    outputMicroUsdPerMTok: 130_000,
    visionCompanionSlug: null,
  },
  {
    sortOrder: 150,
    slug: 'deepseek/deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    description: 'Günstiges Modell mit starkem Denkvermögen, kein Bildverständnis',
    contextWindowTokens: 1_048_576,
    maxOutputTokens: null,
    supportsVision: false,
    supportsTools: true,
    reasoningLevels: STANDARD_LEVELS,
    inputMicroUsdPerMTok: 435_000,
    outputMicroUsdPerMTok: 870_000,
    visionCompanionSlug: QWEN_FLASH,
  },
  {
    sortOrder: 160,
    slug: 'deepseek/deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    description: 'Sehr günstig, kein Bildverständnis',
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 65_536,
    supportsVision: false,
    supportsTools: true,
    reasoningLevels: STANDARD_LEVELS,
    inputMicroUsdPerMTok: 140_000,
    outputMicroUsdPerMTok: 280_000,
    visionCompanionSlug: QWEN_FLASH,
  },
  {
    sortOrder: 170,
    slug: 'moonshotai/kimi-k3',
    displayName: 'Kimi K3',
    description: 'Moonshot-Modell mit großem Kontextfenster',
    contextWindowTokens: 1_048_576,
    maxOutputTokens: null,
    supportsVision: true,
    supportsTools: true,
    reasoningLevels: STANDARD_LEVELS,
    inputMicroUsdPerMTok: 3_000_000,
    outputMicroUsdPerMTok: 15_000_000,
    visionCompanionSlug: null,
  },
];

/** Upserts every seed row. The `update` branch never touches `enabled`, so a model an admin disabled stays disabled. */
async function upsertModels(prisma: PrismaClient): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;

  for (const seed of SEED_MODELS) {
    const existing = await prisma.aiModel.findUnique({
      where: { slug: seed.slug },
      select: { id: true },
    });

    const sharedFields = {
      displayName: seed.displayName,
      description: seed.description,
      contextWindowTokens: seed.contextWindowTokens,
      maxOutputTokens: seed.maxOutputTokens,
      supportsVision: seed.supportsVision,
      supportsTools: seed.supportsTools,
      reasoningLevels: seed.reasoningLevels,
      inputMicroUsdPerMTok: seed.inputMicroUsdPerMTok,
      outputMicroUsdPerMTok: seed.outputMicroUsdPerMTok,
      sortOrder: seed.sortOrder,
    };

    await prisma.aiModel.upsert({
      where: { slug: seed.slug },
      create: { slug: seed.slug, ...sharedFields },
      update: sharedFields,
    });

    if (existing === null) created += 1;
    else updated += 1;
  }

  return { created, updated };
}

/** Second pass: wires `visionCompanionId` now that every row in the table exists. */
async function wireVisionCompanions(prisma: PrismaClient): Promise<number> {
  let companionsWired = 0;

  for (const seed of SEED_MODELS) {
    if (seed.visionCompanionSlug === null) continue;

    const companion = await prisma.aiModel.findUnique({
      where: { slug: seed.visionCompanionSlug },
      select: { id: true },
    });
    if (companion === null) {
      console.warn(
        `  companion slug not found: ${seed.visionCompanionSlug} (referenced by ${seed.slug})`,
      );
      continue;
    }

    await prisma.aiModel.update({
      where: { slug: seed.slug },
      data: { visionCompanionId: companion.id },
    });
    companionsWired += 1;
  }

  return companionsWired;
}

async function main(): Promise<void> {
  const prisma = createPrismaClient();
  try {
    const { created, updated } = await upsertModels(prisma);
    const companionsWired = await wireVisionCompanions(prisma);

    console.log('AI model registry seed completed.');
    console.log(`  created         : ${created}`);
    console.log(`  updated         : ${updated}`);
    console.log(`  companionsWired : ${companionsWired}`);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error('Seeding the AI model registry failed:', error);
  process.exit(1);
});
