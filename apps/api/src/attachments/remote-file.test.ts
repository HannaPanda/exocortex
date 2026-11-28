import { type LookupAddress } from 'node:dns';
import { createServer, type IncomingMessage, request as httpRequest, type Server } from 'node:http';
import { type AddressInfo, type LookupFunction } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '@exocortex/logger';

import { AppError } from '../common/app-error';

import { fetchRemoteFile, REMOTE_FILE_USER_AGENT, requestOnce } from './remote-file';

/**
 * DNS rebinding against the URL attachment fetch (issue #178).
 *
 * The internal service is a real HTTP server on loopback, standing in for
 * Grafana or the cloud metadata address. The resolver answers with a public
 * address the first time and with loopback afterwards, which is exactly what
 * an attacker's name server with a one-second TTL does. Before the fix the
 * check saw the public answer and `fetch` dialled loopback; now the socket
 * only ever gets addresses that were judged at the moment it connects.
 */

const silent = createLogger({ name: 'api-test', level: 'silent' });

let server: Server;
let port = 0;
let hits = 0;

beforeAll(async () => {
  server = createServer((_request, response) => {
    hits += 1;
    response.end('internal secret');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function rebinding(): (host: string) => Promise<readonly LookupAddress[]> {
  let calls = 0;
  return () => {
    calls += 1;
    return Promise.resolve(
      calls === 1
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }],
    );
  };
}

async function refusal(promise: Promise<unknown>): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe('fetching a file by address', () => {
  it('says who is asking, because Wikimedia refuses a request that does not', async () => {
    let seen: string | undefined;
    const probe = createServer((request, response) => {
      seen = request.headers['user-agent'];
      response.end();
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const probePort = (probe.address() as AddressInfo).port;
    // The real hop, with a lookup that lets it reach this local server; the
    // production lookup would rightly refuse loopback.
    const toProbe: LookupFunction = (_host, _options, callback) => {
      (callback as (error: null, address: LookupAddress[]) => void)(null, [
        { address: '127.0.0.1', family: 4 },
      ]);
    };
    try {
      const response = await requestOnce(`http://probe.example:${probePort}/`, toProbe, 2000);
      response.destroy();
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
    expect(seen).toBe(REMOTE_FILE_USER_AGENT);
  });

  it('never reaches loopback when the name rebinds after the check', async () => {
    hits = 0;
    const error = await refusal(
      fetchRemoteFile(`http://rebind.example:${port}/secret`, {
        maxBytes: 1024,
        logger: silent,
        correlationId: 'test',
        resolve: rebinding(),
      }),
    );
    expect(error.code).toBe('web_address_refused');
    expect(error.details).toMatchObject({ reason: 'private_address' });
    expect(hits).toBe(0);
  });

  it('refuses a name with one public and one private record at connect time', async () => {
    hits = 0;
    let calls = 0;
    const error = await refusal(
      fetchRemoteFile(`http://mixed.example:${port}/secret`, {
        maxBytes: 1024,
        logger: silent,
        correlationId: 'test',
        resolve: () => {
          calls += 1;
          return Promise.resolve(
            calls === 1
              ? [{ address: '93.184.216.34', family: 4 }]
              : [
                  { address: '93.184.216.34', family: 4 },
                  { address: '::ffff:7f00:1', family: 6 },
                ],
          );
        },
      }),
    );
    expect(error.code).toBe('web_address_refused');
    expect(hits).toBe(0);
  });

  it.each([
    'http://127.0.0.1:PORT/',
    'http://[::1]:PORT/',
    'http://[::ffff:127.0.0.1]:PORT/',
    'http://[::ffff:7f00:1]:PORT/',
    'http://2130706433:PORT/',
  ])('refuses the literal %s before any request', async (template) => {
    hits = 0;
    const error = await refusal(
      fetchRemoteFile(template.replace('PORT', String(port)), {
        maxBytes: 1024,
        logger: silent,
        correlationId: 'test',
      }),
    );
    expect(error.code).toBe('web_address_refused');
    expect(hits).toBe(0);
  });
});

/**
 * The rest of what a fetch on somebody's behalf has to refuse (issue #212):
 * every redirect hop judged again, a status that is not a success, a body
 * over the cap, a server that stalls, a scheme that is not the web's.
 *
 * The network is replaced by a local server here, through the `request`
 * seam: the address check still runs on every hop, with a resolver that
 * answers every name publicly, and only the connection itself is routed to
 * loopback. A redirect to a literal private address therefore meets the real
 * check, and the counter below proves it was never followed.
 */
describe('fetching a file by address, hop by hop', () => {
  let web: Server;
  let webPort = 0;
  let secretHits = 0;
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

  beforeAll(async () => {
    web = createServer((request, response) => {
      switch (request.url) {
        case '/foto.png':
          response.writeHead(200, { 'content-type': 'image/png' });
          response.end(PNG);
          return;
        case '/weiter':
          response.writeHead(302, { location: 'https://cdn.example/foto.png' });
          response.end();
          return;
        case '/nach-innen':
          response.writeHead(302, { location: `http://127.0.0.1:${webPort}/geheim` });
          response.end();
          return;
        case '/metadaten':
          response.writeHead(307, { location: 'http://169.254.169.254/latest/meta-data/' });
          response.end();
          return;
        case '/geheim':
          secretHits += 1;
          response.end('internal secret');
          return;
        case '/kreis':
          response.writeHead(301, { location: '/kreis' });
          response.end();
          return;
        case '/riesig': {
          // No content-length: only counting while reading stops it.
          response.writeHead(200, { 'content-type': 'image/jpeg' });
          const chunk = Buffer.alloc(1024, 1);
          for (let index = 0; index < 16; index += 1) response.write(chunk);
          response.end();
          return;
        }
        case '/stockt':
          response.writeHead(200, { 'content-type': 'image/jpeg' });
          response.write(Buffer.alloc(16, 1));
          // ...and never ends.
          return;
        case '/schweigt':
          // Never answers at all.
          return;
        default:
          response.writeHead(404);
          response.end('not found');
      }
    });
    await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve));
    webPort = (web.address() as AddressInfo).port;
  });

  afterAll(async () => {
    web.closeAllConnections();
    await new Promise<void>((resolve) => web.close(() => resolve()));
  });

  const publicEverywhere = (): Promise<readonly LookupAddress[]> =>
    Promise.resolve([{ address: '93.184.216.34', family: 4 }]);

  /** The hop as the real code would make it, delivered to the local server. */
  function toLocal(url: string, _lookup: unknown, timeoutMs: number): Promise<IncomingMessage> {
    const target = new URL(url);
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: webPort,
          path: `${target.pathname}${target.search}`,
          headers: { host: target.host },
          agent: false,
          signal: AbortSignal.timeout(timeoutMs),
        },
        resolve,
      );
      request.on('error', reject);
      request.end();
    });
  }

  function fetchVia(url: string, maxBytes = 4096) {
    return fetchRemoteFile(url, {
      maxBytes,
      logger: silent,
      correlationId: 'test',
      resolve: publicEverywhere,
      request: toLocal,
      timeoutMs: 300,
    });
  }

  it('fetches a picture and names it after the address', async () => {
    const file = await fetchVia('https://bilder.example/foto.png');
    expect(file.body.equals(PNG)).toBe(true);
    expect(file.contentType).toBe('image/png');
    expect(file.filename).toBe('foto.png');
  });

  it('follows a redirect to another public address and reports where it ended', async () => {
    const file = await fetchVia('https://bilder.example/weiter');
    expect(file.url).toBe('https://cdn.example/foto.png');
    expect(file.body.equals(PNG)).toBe(true);
  });

  it('judges the redirect target again and never follows it into loopback', async () => {
    secretHits = 0;
    const error = await refusal(fetchVia('https://bilder.example/nach-innen'));
    expect(error.code).toBe('web_address_refused');
    expect(error.details).toMatchObject({ reason: 'private_address' });
    expect(secretHits).toBe(0);
  });

  it('refuses a redirect to the cloud metadata address', async () => {
    const error = await refusal(fetchVia('https://bilder.example/metadaten'));
    expect(error.code).toBe('web_address_refused');
  });

  it('gives up on a redirect loop', async () => {
    const error = await refusal(fetchVia('https://bilder.example/kreis'));
    expect(error.code).toBe('web_fetch_failed');
  });

  it('reports a missing file as a failed fetch with its status', async () => {
    const error = await refusal(fetchVia('https://bilder.example/gibt-es-nicht.jpg'));
    expect(error.code).toBe('web_fetch_failed');
    expect(error.details).toMatchObject({ statusCode: 404 });
  });

  it('cuts a body off at the cap while reading, without a content-length', async () => {
    const error = await refusal(fetchVia('https://bilder.example/riesig', 4096));
    expect(error.code).toBe('payload_too_large');
  });

  it('gives up on a server that stalls halfway through the body', async () => {
    const error = await refusal(fetchVia('https://bilder.example/stockt'));
    expect(error.code).toBe('web_fetch_failed');
  });

  it('gives up on a server that never answers', async () => {
    const error = await refusal(fetchVia('https://bilder.example/schweigt'));
    expect(error.code).toBe('web_fetch_failed');
  });

  it.each(['ftp://bilder.example/foto.png', 'file:///etc/passwd', 'data:image/png;base64,AAAA'])(
    'refuses %s before any request',
    async (url) => {
      const error = await refusal(fetchVia(url));
      expect(error.code).toBe('web_address_refused');
    },
  );
});
