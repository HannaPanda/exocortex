import { createHmac } from 'node:crypto';

import { decryptCredential } from '@exocortex/auth';
import { AUTOMATION_SIGNATURE_HEADER, AUTOMATION_TIMESTAMP_HEADER } from '@exocortex/contracts';

import { type AutomationRuleRecord } from './run-recorder';

/**
 * Signing a webhook POST (issue #50, ADR-024).
 *
 * `sha256=<hex>` over `<timestamp>.<body>`, in the two headers named by the
 * contract. The timestamp is inside the signed material rather than beside it,
 * which is the whole point: without it a captured body can be replayed for ever
 * against a receiver that only checks the signature.
 *
 * The receiving end is somebody else's code, so these two strings and this one
 * construction are a public interface. They are documented in `docs/automations.md`
 * and must not change shape without a new header.
 */

/** Purpose bound into the AES-GCM tag when the API stored the secret. */
const WEBHOOK_SECRET_PURPOSE = 'automation-webhook';

export interface SignWebhookInput {
  /** The deployment's `CREDENTIAL_ENCRYPTION_KEY`, or null when it has none. */
  key: Buffer | null;
  rule: AutomationRuleRecord;
  body: string;
  now?: number;
}

/**
 * The signature headers for one POST.
 *
 * Throws rather than sending unsigned. A receiver that trusts a signature is
 * entitled to assume every request carries one, and a deployment that quietly
 * dropped the signature the day its encryption key went missing would be
 * teaching that receiver to accept anything.
 */
export function signWebhookBody(input: SignWebhookInput): Record<string, string> {
  const { rule } = input;
  if (
    rule.secretCiphertext === null ||
    rule.secretIv === null ||
    rule.secretAuthTag === null ||
    rule.secretKeyVersion === null
  ) {
    throw new Error('The rule has no signing secret');
  }
  if (input.key === null) {
    throw new Error('This deployment has no CREDENTIAL_ENCRYPTION_KEY, so nothing can be signed');
  }

  const secret = decryptCredential({
    key: input.key,
    purpose: WEBHOOK_SECRET_PURPOSE,
    record: {
      ciphertext: rule.secretCiphertext,
      iv: rule.secretIv,
      authTag: rule.secretAuthTag,
      keyVersion: rule.secretKeyVersion,
    },
  });

  const timestamp = String(Math.floor((input.now ?? Date.now()) / 1_000));
  const signature = createHmac('sha256', secret).update(`${timestamp}.${input.body}`).digest('hex');

  return {
    [AUTOMATION_TIMESTAMP_HEADER]: timestamp,
    [AUTOMATION_SIGNATURE_HEADER]: `sha256=${signature}`,
  };
}
