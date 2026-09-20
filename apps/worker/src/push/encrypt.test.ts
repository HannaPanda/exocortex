import { createECDH, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  decodeBase64Url,
  decryptPushPayload,
  encodeBase64Url,
  encryptPushPayload,
} from './encrypt';

/**
 * The worked example from RFC 8291 section 5.
 *
 * This is the reason the encryption is written out in this repository instead
 * of installed: with the salt and the ephemeral key pinned, the whole body is
 * a constant, and a single character wrong anywhere in the derivation changes
 * it. A library would have to be believed; this can be checked.
 */
const RFC_8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  receiverPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  receiverPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

describe('encryptPushPayload', () => {
  it('reproduces the worked example in RFC 8291', () => {
    const body = encryptPushPayload(
      RFC_8291.plaintext,
      { p256dh: RFC_8291.receiverPublic, auth: RFC_8291.auth },
      {
        salt: decodeBase64Url(RFC_8291.salt),
        senderPrivateKey: decodeBase64Url(RFC_8291.senderPrivate),
      },
    );

    expect(encodeBase64Url(body)).toBe(RFC_8291.body);
  });

  it('writes the RFC 8188 header in front of the ciphertext', () => {
    const receiver = createECDH('prime256v1');
    receiver.generateKeys();
    const body = encryptPushPayload('hallo', {
      p256dh: encodeBase64Url(receiver.getPublicKey()),
      auth: encodeBase64Url(randomBytes(16)),
    });

    // salt, record size, key id length, key id: 16 + 4 + 1 + 65.
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body.readUInt8(20)).toBe(65);
    expect(body.subarray(21, 22)[0]).toBe(0x04);
  });

  it('round-trips an arbitrary payload back to the device that subscribed', () => {
    const receiver = createECDH('prime256v1');
    receiver.generateKeys();
    const auth = randomBytes(16);
    const payload = JSON.stringify({
      title: 'Ümläute & "Anführungszeichen"',
      body: 'a'.repeat(500),
    });

    const body = encryptPushPayload(payload, {
      p256dh: encodeBase64Url(receiver.getPublicKey()),
      auth: encodeBase64Url(auth),
    });

    expect(decryptPushPayload(body, receiver.getPrivateKey(), auth)).toBe(payload);
  });

  it('produces a different body every time, because the salt and the key are fresh', () => {
    const receiver = createECDH('prime256v1');
    receiver.generateKeys();
    const keys = {
      p256dh: encodeBase64Url(receiver.getPublicKey()),
      auth: encodeBase64Url(randomBytes(16)),
    };

    const first = encryptPushPayload('same text', keys);
    const second = encryptPushPayload('same text', keys);

    expect(encodeBase64Url(first)).not.toBe(encodeBase64Url(second));
  });

  it('refuses a key that is not an uncompressed P-256 point', () => {
    expect(() =>
      encryptPushPayload('x', {
        p256dh: encodeBase64Url(randomBytes(32)),
        auth: 'BTBZMqHH6r4Tts7J_aSIgg',
      }),
    ).toThrow(/uncompressed P-256/);
  });

  it('refuses an auth secret of the wrong length', () => {
    const receiver = createECDH('prime256v1');
    receiver.generateKeys();
    expect(() =>
      encryptPushPayload('x', {
        p256dh: encodeBase64Url(receiver.getPublicKey()),
        auth: encodeBase64Url(randomBytes(8)),
      }),
    ).toThrow(/16 bytes/);
  });
});
