import { Inject, Injectable } from '@nestjs/common';

import { AiProviderError, type WebFetcher, type WebSearcher } from '@exocortex/ai';
import { assertPolicy, canReadWorkspace, WorkspaceAccessService } from '@exocortex/auth';
import {
  type WebFetchRequest,
  type WebFetchResponse,
  type WebSearchRequest,
  type WebSearchResponse,
} from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { currentCorrelationId } from '../common/correlation';
import { LOGGER } from '../common/logger.provider';
import { SettingsService } from '../platform/settings.service';

import { checkPublicAddress } from './public-address';
import { WEB_FETCHER, WEB_SEARCHER } from './research-tokens';

/**
 * Searching and reading the open web (issue #26).
 *
 * The service is thin on purpose: two back ends that already speak their own
 * protocols (`@exocortex/ai`'s SearXNG and Steel clients), and three decisions
 * that have to happen here rather than in either of them.
 *
 * 1. **Is this switched on.** `ai.webResearchEnabled` is workspace-scoped and
 *    defaults to off, so "not configured" and "not wanted" are one answer.
 * 2. **May this address be fetched.** `checkPublicAddress` runs before Steel
 *    sees the URL, and again on the address Steel says it ended up at. The
 *    browser sits inside this host's Docker network, so this is the only fence
 *    between a model's sentence and Grafana's admin page.
 * 3. **How much text comes back.** `ai.webResearchMaxChars`, applied here and
 *    announced as `truncated`, because a silently shortened page is one a model
 *    will summarize as though it had read the end.
 *
 * What is deliberately *not* here: counting fetches per run. That is a property
 * of a run, and only the worker's tool loop knows what a run is
 * (`ai.webResearchMaxFetchesPerRun`, `apps/worker/src/tool-runner.ts`).
 */
@Injectable()
export class ResearchService {
  constructor(
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(WEB_SEARCHER) private readonly searcher: WebSearcher | null,
    @Inject(WEB_FETCHER) private readonly fetcher: WebFetcher | null,
    private readonly access: WorkspaceAccessService,
    private readonly settings: SettingsService,
  ) {}

  async search(input: {
    workspaceId: string;
    userId: string;
    request: WebSearchRequest;
  }): Promise<WebSearchResponse> {
    const settings = await this.authorize(input.workspaceId, input.userId);
    const searcher = this.searcher;
    if (searcher === null) {
      throw new AppError(
        'web_research_unavailable',
        'No search instance is configured (SEARXNG_BASE_URL)',
      );
    }

    const limit = Math.min(input.request.limit ?? settings.maxResults, settings.maxResults);
    const startedAt = Date.now();
    const answer = await asApiError(() =>
      searcher.search({
        query: input.request.query,
        limit,
        language: input.request.language,
        correlationId: currentCorrelationId(),
      }),
    );

    if (answer.unresponsiveEngines.length > 0) {
      this.logger.info('Some search engines did not answer', {
        workspaceId: input.workspaceId,
        engines: answer.unresponsiveEngines,
      });
    }

    return {
      query: answer.query,
      results: answer.results.map((result) => ({ ...result })),
      unresponsiveEngines: [...answer.unresponsiveEngines],
      tookMs: Date.now() - startedAt,
    };
  }

  async fetch(input: {
    workspaceId: string;
    userId: string;
    request: WebFetchRequest;
  }): Promise<WebFetchResponse> {
    const settings = await this.authorize(input.workspaceId, input.userId);
    const fetcher = this.fetcher;
    if (fetcher === null) {
      throw new AppError('web_research_unavailable', 'No browser is configured (STEEL_BASE_URL)');
    }

    const checked = await checkPublicAddress(input.request.url);
    if (!checked.allowed) throw refusedAddress(checked.reason, checked.detail);

    const startedAt = Date.now();
    const page = await asApiError(() =>
      fetcher.fetch({ url: checked.url, correlationId: currentCorrelationId() }),
    );

    // The address the browser ended up at is checked too. A redirect is the
    // cheapest way past a check that only looks at what was typed, and the
    // cost of being wrong here is the whole point of the check.
    if (page.url !== checked.url) {
      const afterRedirect = await checkPublicAddress(page.url);
      if (!afterRedirect.allowed) {
        this.logger.info('A redirect left the public internet', {
          workspaceId: input.workspaceId,
          from: checked.url,
          reason: afterRedirect.reason,
        });
        throw refusedAddress(afterRedirect.reason, afterRedirect.detail);
      }
    }

    const maxChars = Math.min(input.request.maxChars ?? settings.maxChars, settings.maxChars);
    const truncated = page.markdown.length > maxChars;

    return {
      requestedUrl: checked.url,
      url: page.url,
      title: page.title,
      description: page.description,
      statusCode: page.statusCode,
      markdown: truncated ? page.markdown.slice(0, maxChars) : page.markdown,
      truncated,
      links: input.request.includeLinks ? page.links.map((link) => ({ ...link })) : [],
      tookMs: Date.now() - startedAt,
    };
  }

  /**
   * Membership, then the switch.
   *
   * `canReadWorkspace` rather than something stricter: reading a public web
   * page changes nothing here, and a reader who may ask the AI a question may
   * ask it a question that needs the web.
   */
  private async authorize(
    workspaceId: string,
    userId: string,
  ): Promise<{ maxChars: number; maxResults: number }> {
    const role = await this.access.findRole(workspaceId, userId);
    assertPolicy(canReadWorkspace(role));

    const settings = await this.settings.getForWorkspace(workspaceId);
    if (!settings['ai.enabled'] || !settings['ai.webResearchEnabled']) {
      throw new AppError('web_research_unavailable', 'Web research is switched off');
    }
    return {
      maxChars: settings['ai.webResearchMaxChars'],
      maxResults: settings['ai.webSearchMaxResults'],
    };
  }
}

/** One refusal shape for every reason the address check can give. */
function refusedAddress(reason: string, detail: string): AppError {
  return new AppError('web_address_refused', `Address refused (${reason}): ${detail}`);
}

/**
 * Turns the clients' `AiProviderError` into the API's own error shape.
 *
 * Both codes the clients raise are codes on the wire here, and the split is the
 * one that matters to a caller: `web_fetch_failed` means that page did not load
 * and another address is worth trying, `ai_provider_unavailable` means the
 * browser or the search instance is down and no address will work right now.
 * Without this translation both would arrive as an unexplained 500.
 */
async function asApiError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AiProviderError) {
      const code =
        error.code === 'web_fetch_failed' ? 'web_fetch_failed' : 'ai_provider_unavailable';
      throw new AppError(code, error.message);
    }
    throw error;
  }
}
