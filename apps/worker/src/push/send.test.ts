import { createECDH, randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { type PushNotificationPayload } from '@exocortex/contracts';

import { encodeBase64Url } from './encrypt';
import { createPushSender, type PushTarget } from './send';
import { generateVapidKeys } from './vapid';

const keys = generateVapidKeys('mailto:johanna@example.org');

function target(): PushTarget {
  const receiver = createECDH('prime256v1');
  receiver.generateKeys();
  return {
    endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/abc',
    p256dh: encodeBase64Url(receiver.getPublicKey()),
    auth: encodeBase64Url(randomBytes(16)),
  };
}

const notification: PushNotificationPayload = {
  kind: 'AGENT',
  title: 'Fertig',
  body: 'Der Lauf ist durch.',
  url: 'https://exocortex.test/arbeitsbereich/w/seite/p',
  tag: null,
};

function sender(response: Response | Error) {
  const fetchImpl = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  return {
    send: createPushSender({ keys, fetchImpl: fetchImpl as unknown as typeof fetch }),
    fetchImpl,
  };
}

describe('createPushSender', () => {
  it('posts an encrypted body with the headers a push service expects', async () => {
    const { send, fetchImpl } = sender(new Response(null, { status: 201 }));

    const outcome = await send.send(target(), notification);

    expect(outcome).toEqual({ status: 'delivered' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://updates.push.services.mozilla.com/wpush/v2/abc');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Encoding']).toBe('aes128gcm');
    expect(headers.Authorization).toMatch(/^vapid t=[\w.-]+, k=[\w-]+$/);
    expect(headers.TTL).toBe(String(4 * 60 * 60));
    // The plain text must not be recognisable anywhere in the body.
    const body = Buffer.from(init.body as Uint8Array);
    expect(body.includes(Buffer.from('Der Lauf ist durch.', 'utf8'))).toBe(false);
  });

  it('reports a 410 as gone, so the subscription is deleted rather than retried', async () => {
    const { send } = sender(new Response(null, { status: 410 }));
    expect(await send.send(target(), notification)).toEqual({
      status: 'gone',
      reason: 'Push service answered 410',
    });
  });

  it('reports a 404 as gone as well', async () => {
    const { send } = sender(new Response(null, { status: 404 }));
    expect((await send.send(target(), notification)).status).toBe('gone');
  });

  it('reports anything else as failed and keeps the retry-after it was given', async () => {
    const { send } = sender(
      new Response('slow down', { status: 429, headers: { 'retry-after': '90' } }),
    );
    const outcome = await send.send(target(), notification);

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.retryAfterSeconds).toBe(90);
    expect(outcome.reason).toContain('429');
  });

  it('reports a network error as failed, never as gone', async () => {
    const { send } = sender(new Error('ECONNRESET'));
    expect((await send.send(target(), notification)).status).toBe('failed');
  });

  it('treats unusable subscription keys as gone, because nothing can ever be encrypted to them', async () => {
    const { send, fetchImpl } = sender(new Response(null, { status: 201 }));
    const outcome = await send.send(
      { ...target(), p256dh: encodeBase64Url(randomBytes(10)) },
      notification,
    );

    expect(outcome.status).toBe('gone');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a payload that would not fit one record', async () => {
    const { send, fetchImpl } = sender(new Response(null, { status: 201 }));
    const outcome = await send.send(target(), { ...notification, body: 'a'.repeat(5000) });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.retryAfterSeconds).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
