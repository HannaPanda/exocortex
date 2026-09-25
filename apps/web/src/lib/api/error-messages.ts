import { API_ERROR_CODES, type ApiErrorCode } from '@exocortex/contracts';

/**
 * User-facing messages for machine-readable API error codes.
 *
 * The API always returns English developer messages; the sentences a person
 * reads live in the `errors.codes` namespace of the message catalogue (issue
 * #98), and this module is the only place that turns a code into one.
 *
 * The translator is installed by `ErrorMessages` in the client providers
 * rather than passed to every caller, because the sentence is read from
 * places that are not components: `ApiError.message`, a mutation's
 * `onError`. That is sound only because an `ApiError` is only ever made by a
 * fetch in the browser, where one locale is active at a time; a server render
 * never builds one. Until the translator is installed the code itself is the
 * answer, which is a visible defect rather than a wrong language.
 */
type ErrorTranslator = (code: ApiErrorCode) => string;

let translator: ErrorTranslator | null = null;

export function installErrorTranslator(next: ErrorTranslator | null): void {
  translator = next;
}

const KNOWN: ReadonlySet<string> = new Set(API_ERROR_CODES);

/**
 * The sentence for an error code, or the generic one.
 *
 * A set lookup rather than `in` on an object: the code comes out of a
 * response body, and `in` walks the prototype chain, so a body saying
 * `"code": "toString"` would resolve to something that is not a code.
 */
export function messageForCode(code: string | undefined): string {
  const known: ApiErrorCode =
    code !== undefined && KNOWN.has(code) ? (code as ApiErrorCode) : 'internal_error';
  return translator === null ? known : translator(known);
}
