import { CHARS_PER_TOKEN_ESTIMATE, estimateTokens } from '@exocortex/ai';
import {
  type AiMessage,
  type AiRunContextSection,
  type AiRunContextSectionKey,
  type AiRunEventData,
} from '@exocortex/contracts';

import { type PromptSection } from '../../system-prompt';
import { type ToolContext } from '../../tool-runner';

const CONVERSATION_SECTION: Record<AiMessage['role'], AiRunContextSectionKey> = {
  system: 'conversation_summary',
  user: 'conversation_user',
  assistant: 'conversation_assistant',
  tool: 'conversation_tool',
};

function measured(
  key: AiRunContextSectionKey,
  text: string,
  rest: Partial<Omit<AiRunContextSection, 'key' | 'chars' | 'estimatedTokens'>> = {},
): AiRunContextSection {
  return {
    key,
    chars: text.length,
    estimatedTokens: estimateTokens(text),
    items: null,
    truncated: false,
    sources: [],
    ...rest,
  };
}

/**
 * What the first turn's prompt was built from, as the run inspector records
 * it (issue #145): every part measured, every source named by id, no text.
 *
 * Measured from the very messages that go to the provider, so the sizes are
 * the ones the run paid for rather than a second estimate of them.
 */
export function contextEvent(input: {
  promptSections: readonly PromptSection[];
  notes: readonly { key: 'agent_role' | 'write_mode'; message: AiMessage }[];
  imageContext: AiMessage | null;
  documentId: string | null;
  conversation: readonly AiMessage[];
  tools: ToolContext | null;
}): AiRunEventData {
  const sections: AiRunContextSection[] = input.promptSections.map((section) =>
    measured(section.key, section.text, {
      items: section.items,
      truncated: section.truncated,
      sources: section.sources,
    }),
  );
  for (const note of input.notes) sections.push(measured(note.key, note.message.content));
  if (input.imageContext !== null) {
    const text = input.imageContext.content;
    sections.push(
      measured('images', text, {
        sources: [
          {
            kind: 'attachment_images',
            documentId: input.documentId,
            databaseViewId: null,
            savedQueryId: null,
            mode: 'embedded',
            chars: text.length,
            fullChars: null,
            truncated: false,
            origin: 'attachment',
          },
        ],
      }),
    );
  }

  const byRole = new Map<AiRunContextSectionKey, { text: string; items: number }>();
  for (const message of input.conversation) {
    const key = CONVERSATION_SECTION[message.role];
    const entry = byRole.get(key) ?? { text: '', items: 0 };
    entry.text += message.content;
    entry.items += 1;
    byRole.set(key, entry);
  }
  for (const [key, entry] of byRole) {
    sections.push(measured(key, entry.text, { items: entry.items }));
  }

  if (input.tools !== null && input.tools.schemaChars > 0) {
    sections.push({
      key: 'tool_schemas',
      chars: input.tools.schemaChars,
      estimatedTokens: Math.ceil(input.tools.schemaChars / CHARS_PER_TOKEN_ESTIMATE),
      items: input.tools.offered,
      truncated: false,
      sources: [],
    });
  }

  return { kind: 'context', data: { sections: sections.filter((section) => section.chars > 0) } };
}
