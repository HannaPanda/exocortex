import { type LookupAddress } from 'node:dns';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '@exocortex/logger';

import { AppError } from '../common/app-error';

import { fetchRemoteFile } from './remote-file';

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
