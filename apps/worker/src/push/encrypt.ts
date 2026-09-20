import { createCipheriv, createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Message encryption for Web Push (RFC 8291 over RFC 8188), written out here
 * rather than taken from a library.
 *
 * It is about eighty lines of standard primitives, all of them in `node:crypto`,
 * and the alternative pulls five transitive dependencies into a deployment whose
 * licence (CLAUDE.md rule 14) makes every one of them a question. The decisive
 * argument is not the size though: this file is checked against the worked
 * example in RFC 8291 section 5 by `encrypt.test.ts`, so it is *verified*
 * rather than trusted, which is the one thing a crypto dependency cannot offer.
 *
 * What happens here, in one sentence: a payload is encrypted to the two keys a
 * browser handed over when it subscribed, so the push service in the middle --
 * Google's, Mozilla's, Apple's -- carries a blob it cannot read.
 */

/** The device's half of the agreement, exactly as the browser reports it. */
export interface PushKeys {
  /** P-256 public key, uncompressed point (65 bytes), base64url. */
  p256dh: string;
  /** Authentication secret (16 bytes), base64url. */
  auth: string;
}

/**
 * Overrides for the two random inputs.
 *
 * Only the test passes them, and it has to: a worked example can only be
 * reproduced when the ephemeral key and the salt are the ones the example used.
 * Production never sets them, which is what keeps every message unique.
 */
export interface EncryptOverrides {
  salt?: Buffer;
  senderPrivateKey?: Buffer;
}

/** The single record `aes128gcm` body, ready to be POSTed to the endpoint. */
export function encryptPushPayload(
  payload: string,
  keys: PushKeys,
  overrides: EncryptOverrides = {},
): Buffer {
  const receiverPublicKey = decodeBase64Url(keys.p256dh);
  if (receiverPublicKey.length !== 65 || receiverPublicKey[0] !== 0x04) {
    throw new Error('Push subscription key is not an uncompressed P-256 point');
  }
  const authSecret = decodeBase64Url(keys.auth);
  if (authSecret.length !== 16) {
    throw new Error('Push subscription auth secret is not 16 bytes');
  }

  const ecdh = createECDH('prime256v1');
  if (overrides.senderPrivateKey === undefined) {
    ecdh.generateKeys();
  } else {
    ecdh.setPrivateKey(overrides.senderPrivateKey);
  }
  const senderPublicKey = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(receiverPublicKey);

  /*
   * RFC 8291 section 3.4. The auth secret is the salt of the first extraction
   * and the two public keys are the info, which is what binds the derived key
   * to *this* pair of parties: an attacker who replaces one of them derives a
   * different key and the receiver's decryption fails.
   */
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    receiverPublicKey,
    senderPublicKey,
  ]);
  const inputKeyingMaterial = Buffer.from(
    hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32),
  );

  const salt = overrides.salt ?? randomBytes(16);
  if (salt.length !== 16) throw new Error('Push salt must be 16 bytes');

  // RFC 8188 section 2.2: the content encoding's own two derivations. The
  // trailing NUL belongs to the info string; it is the empty context, not a C
  // string terminator.
  const contentKey = Buffer.from(
    hkdfSync('sha256', inputKeyingMaterial, salt, 'Content-Encoding: aes128gcm\0', 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', inputKeyingMaterial, salt, 'Content-Encoding: nonce\0', 12),
  );

  /*
   * One record, so the padding delimiter is 0x02 ("last record") and there is
   * no padding after it. Splitting a payload across records would buy nothing:
   * a notification is a few hundred bytes and every push service accepts at
   * least four kilobytes in one go.
   */
  const plaintext = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([0x02])]);
  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  // RFC 8188 section 2.1: salt, record size, key id length, key id. The key id
  // of a Web Push message is the sender's public key, which is how the receiver
  // knows what to run the agreement against.
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(senderPublicKey.length, 20);

  return Buffer.concat([header, senderPublicKey, ciphertext]);
}

/**
 * The declared record size.
 *
 * It is the size a receiver must be prepared to buffer, not the size of what
 * was sent, so a fixed 4096 is correct for any payload that fits in one record
 * -- and `MAX_PAYLOAD_BYTES` is what keeps a payload inside it.
 */
const RECORD_SIZE = 4096;

/**
 * The most plaintext one record holds: the record size less the 16-byte
 * authentication tag and the one-byte delimiter. Everything this deployment
 * sends is an order of magnitude smaller; the check exists so a long comment
 * body fails loudly at the sender rather than silently at the device.
 */
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - 17;

export function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

export function encodeBase64Url(value: Buffer): string {
  return value.toString('base64url');
}

/**
 * Decrypts a body again, for the round-trip test.
 *
 * It lives beside the encryptor on purpose. A test that reimplemented the
 * derivation would prove the two halves agree with each other and nothing
 * more; this one shares the derivation and proves the *framing* -- header
 * layout, delimiter, tag placement -- which is where a hand-written
 * implementation actually goes wrong.
 */
export function decryptPushPayload(
  body: Buffer,
  receiverPrivateKey: Buffer,
  authSecret: Buffer,
): string {
  const salt = body.subarray(0, 16);
  const keyIdLength = body.readUInt8(20);
  const senderPublicKey = body.subarray(21, 21 + keyIdLength);
  const ciphertext = body.subarray(21 + keyIdLength);

  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(receiverPrivateKey);
  const sharedSecret = ecdh.computeSecret(senderPublicKey);
  // The receiver's own public key comes first here, exactly as it does when
  // encrypting: the info string is written from the receiver's point of view
  // on both sides, which is why the two agree at all.
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    ecdh.getPublicKey(),
    senderPublicKey,
  ]);
  const inputKeyingMaterial = Buffer.from(
    hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32),
  );
  const contentKey = Buffer.from(
    hkdfSync('sha256', inputKeyingMaterial, salt, 'Content-Encoding: aes128gcm\0', 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', inputKeyingMaterial, salt, 'Content-Encoding: nonce\0', 12),
  );

  const decipher = createDecipheriv('aes-128-gcm', contentKey, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plaintext = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);

  // Everything from the 0x02 delimiter onwards is padding, and a single
  // record has none after it.
  const delimiter = plaintext.lastIndexOf(0x02);
  return plaintext.subarray(0, delimiter === -1 ? plaintext.length : delimiter).toString('utf8');
}
