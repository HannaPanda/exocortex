/**
 * A stand-in for the eXocortex memory API, for the hook tests (issue #188).
 *
 * It answers the four routes the hooks call, remembers every request it saw
 * (method, path, whether the bearer matched, and the parsed body), and can be
 * told to answer a route with a fixed status, to hang, or to report a capture
 * job as completed only after a number of polls.
 */

import { createServer } from 'node:http';

export const VALID_TOKEN = 'exo_testtoken_0123456789abcdef';

/**
 * @param {{
 *   status?: Record<string, number>,
 *   hang?: string[],
 *   captureAnswer?: { accepted: boolean, jobId: string | null, reason: string | null },
 *   pollsUntilDone?: number,
 *   outcome?: { outcome: string, documentId: string | null },
 *   recallHits?: { documentId: string }[],
 * }} options
 */
export async function startFakeApi(options = {}) {
  const requests = [];
  let polls = 0;

  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(request.url ?? '/', 'http://localhost');
      const route = `${request.method} ${url.pathname.replace(/\/capture\/[^/]+$/, '/capture/:id')}`;
      requests.push({
        route,
        authorized: request.headers.authorization === `Bearer ${VALID_TOKEN}`,
        query: Object.fromEntries(url.searchParams),
        body: raw.length === 0 ? null : JSON.parse(raw),
      });

      if (options.hang?.includes(route)) return; // never answers
      const send = (status, body) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (request.headers.authorization !== `Bearer ${VALID_TOKEN}`) {
        return send(401, { error: 'unauthorized' });
      }
      const forced = options.status?.[route];
      if (forced !== undefined) return send(forced, { error: 'forced' });

      if (route === 'GET /api/memory/recall') {
        const hits = (options.recallHits ?? []).map((hit) => ({ ...hit, title: 'Notiz' }));
        return send(200, { hits, messages: [], text: hits.length === 0 ? '' : '- Notiz' });
      }
      if (route === 'POST /api/memory/capture') {
        return send(200, options.captureAnswer ?? { accepted: true, jobId: '42', reason: null });
      }
      if (route === 'GET /api/memory/capture/:id') {
        polls += 1;
        if (polls < (options.pollsUntilDone ?? 1)) {
          return send(200, {
            jobId: '42',
            state: 'running',
            outcome: null,
            documentId: null,
            reason: null,
          });
        }
        const outcome = options.outcome ?? { outcome: 'written', documentId: 'doc-12345' };
        return send(200, { jobId: '42', state: 'completed', reason: null, ...outcome });
      }
      if (route === 'POST /api/memory/messages/read') return send(200, { read: 0 });
      return send(404, { error: 'not_found' });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
