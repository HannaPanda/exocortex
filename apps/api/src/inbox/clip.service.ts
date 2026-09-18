import { Inject, Injectable } from '@nestjs/common';

import { type ClipRequest, type ClipResponse, type WebFetchResponse } from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { ResearchService } from '../research/research.service';

import { buildClipNote, MAX_ARTICLE_CHARS } from './clip-note';
import { InboxService } from './inbox.service';

/**
 * Clipping a web page (issue #72).
 *
 * Everything this service does is already built somewhere else, and that is the
 * design rather than a coincidence: the address check and the browser come from
 * web research (ADR-033), the page, the inbox and the filing come from capture
 * (ADR-036). What is left here is the decision of what a clip is made of, which
 * lives in `clip-note.ts` and is the only part worth testing on its own.
 */
@Injectable()
export class ClipService {
  constructor(
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly inbox: InboxService,
    private readonly research: ResearchService,
  ) {}

  async clip(input: {
    workspaceId: string;
    userId: string;
    request: ClipRequest;
    correlationId: string;
  }): Promise<ClipResponse> {
    assertWebAddress(input.request.url);

    // Only a fetch goes near the address check, because only a fetch goes near
    // the address. A clip that just writes the link down makes no request at
    // all, and refusing to write down an intranet link would be a rule about
    // text rather than about this host's network.
    const page = input.request.fetchPage ? await this.fetchPage(input) : null;

    const note = buildClipNote({ request: input.request, page, at: new Date() });

    const captured = await this.inbox.capture({
      workspaceId: input.workspaceId,
      userId: input.userId,
      correlationId: input.correlationId,
      request: {
        text: note.markdown,
        // The title is handed over rather than derived, so the provenance line
        // stays the first line of the body instead of becoming the headline.
        title: note.title,
        ...(input.request.parentId === undefined ? {} : { parentId: input.request.parentId }),
      },
    });

    this.logger.info('Clipped a web page', {
      documentId: captured.document.id,
      workspaceId: input.workspaceId,
      url: input.request.url,
      fetched: page !== null,
      correlationId: input.correlationId,
    });

    return {
      ...captured,
      fetched: page !== null,
      truncated: page?.truncated ?? false,
      characters: note.markdown.length,
    };
  }

  private async fetchPage(input: {
    workspaceId: string;
    userId: string;
    request: ClipRequest;
  }): Promise<WebFetchResponse> {
    return this.research.fetch({
      workspaceId: input.workspaceId,
      userId: input.userId,
      request: {
        url: input.request.url,
        maxChars: MAX_ARTICLE_CHARS,
        includeLinks: false,
      },
    });
  }
}

/**
 * A `javascript:` or `data:` address in a link is not a source, it is a trap
 * waiting for whoever clicks it later. The zod schema proves the string is a
 * URL; this proves it is a web address.
 */
function assertWebAddress(candidate: string): void {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new AppError('web_address_refused', 'Address refused (invalid): not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('web_address_refused', `Address refused (scheme): ${url.protocol}`);
  }
}
