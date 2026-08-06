/**
 * Rough token estimate for context budgeting.
 *
 * Providers report usage only after a call, but compaction has to decide
 * *before* one, so an approximation is unavoidable. 3.6 characters per token is
 * a deliberately conservative figure for the German- and Markdown-heavy text
 * this workspace holds; overestimating triggers compaction slightly early,
 * which is the safe direction. Never present the result as exact.
 */
export const CHARS_PER_TOKEN_ESTIMATE = 3.6;

/** Per-message overhead tokens (role framing, separators). */
const MESSAGE_OVERHEAD_TOKENS = 4;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

export function estimateMessageTokens(message: { role: string; content: string }): number {
  return estimateTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
}

export function estimateConversationTokens(
  messages: readonly { role: string; content: string }[],
): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}
