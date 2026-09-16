import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createWebhookSender } from './webhook-request';

/**
 * These tests use a real server on a real socket (issue #63).
 *
 * The thing being proven is that no second request happens, and a fake network
 * cannot prove that: a stub that records one call would pass whether or not the
 * real client follows a `307`. So the server counts what actually arrives.
 */

let server: Server | null = null;

/** A server that answers however the test says, and remembers every request. */
async function listening(
  answer: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const instance = createServer((request, response) => {
    requests.push(request.url ?? '');
    answer(request, response);
  });
  server = instance;
  await new Promise<void>((resolve) => {
    instance.listen(0, '127.0.0.1', resolve);
  });
  const address = instance.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(address.port)}`, requests };
}

afterEach(async () => {
  const instance = server;
  server = null;
  if (instance === null) return;
  await new Promise<void>((resolve) => {
    instance.close(() => {
      resolve();
    });
  });
});

/** Everything but the address policy, which the last block tests on its own. */
const sender = createWebhookSender({ addressRefusal: () => null });

function post(url: string) {
  return sender({
    url,
    headers: { 'content-type': 'application/json' },
    body: '{}',
    timeoutMs: 5_000,
  });
}

describe('a webhook request', () => {
  it('delivers the body and reports the status', async () => {
    const target = await listening((_request, response) => {
      response.writeHead(202);
      response.end('ok');
    });

    await expect(post(`${target.url}/hook`)).resolves.toEqual({ status: 202 });
    expect(target.requests).toEqual(['/hook']);
  });

  it('refuses a 307 into the machine itself instead of following it', async () => {
    const target = await listening((request, response) => {
      if (request.url === '/hook') {
        response.writeHead(307, { location: 'http://127.0.0.1:1/internal' });
        response.end();
        return;
      }
      response.writeHead(200);
      response.end();
    });

    await expect(post(`${target.url}/hook`)).rejects.toThrow(/redirect/);
    expect(target.requests).toEqual(['/hook']);
  });

  it('refuses a 302 to another host instead of following it', async () => {
    const target = await listening((_request, response) => {
      response.writeHead(302, { location: 'https://not-allowed.example.net/take-this' });
      response.end();
    });

    await expect(post(`${target.url}/hook`)).rejects.toThrow(/redirect/);
    expect(target.requests).toEqual(['/hook']);
  });

  it('refuses a 301 on the way back as well', async () => {
    const target = await listening((_request, response) => {
      response.writeHead(301, { location: '/moved' });
      response.end();
    });

    await expect(post(`${target.url}/hook`)).rejects.toThrow(/redirect/);
    expect(target.requests).toHaveLength(1);
  });
});

describe('the address policy', () => {
  it('refuses to connect at all when the target is on this machine', async () => {
    const target = await listening((_request, response) => {
      response.writeHead(200);
      response.end();
    });

    const guarded = createWebhookSender();
    await expect(
      guarded({ url: `${target.url}/hook`, headers: {}, body: '{}', timeoutMs: 5_000 }),
    ).rejects.toThrow(/loopback/);
    expect(target.requests).toEqual([]);
  });

  it('only speaks http and https', async () => {
    const guarded = createWebhookSender();
    await expect(
      guarded({ url: 'file:///etc/passwd', headers: {}, body: '{}', timeoutMs: 5_000 }),
    ).rejects.toThrow(/http/);
  });
});
