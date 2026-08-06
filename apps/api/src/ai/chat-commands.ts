import { CHAT_COMMANDS, type ChatCommandName,chatCommandNameSchema } from '@exocortex/contracts';

/**
 * Slash commands are parsed on the server so every client behaves identically:
 * the side panel, the MCP surface and anything added later all get the same
 * command set without reimplementing it.
 */
export interface ParsedChatCommand {
  name: ChatCommandName;
  argument: string | null;
}

const KNOWN_COMMAND_NAMES = new Set<string>(CHAT_COMMANDS.map((command) => command.name));

/**
 * Matches a leading `/`, a lowercase command word, and an optional argument
 * separated by whitespace. Anchored at both ends: anything after the command
 * word that is not preceded by whitespace (e.g. `/tmp/foo`) fails to match, so
 * it falls through to the "not a command" branch below.
 */
const COMMAND_PATTERN = /^\/([a-z]+)(?:\s+([\s\S]*))?$/;

/**
 * Parses a chat message as a slash command.
 *
 * Returns `null` for anything that is not a **known** command, so a message
 * like `/tmp/foo ist kaputt` (or a message that does not start with `/` at
 * all, or names an unrecognised command) is treated as ordinary prose rather
 * than rejected.
 */
export function parseChatCommand(content: string): ParsedChatCommand | null {
  const match = COMMAND_PATTERN.exec(content);
  if (match === null) return null;

  const word = match[1];
  if (word === undefined || !KNOWN_COMMAND_NAMES.has(word)) return null;
  const parsedName = chatCommandNameSchema.safeParse(word);
  if (!parsedName.success) return null;

  const rest = match[2];
  const trimmedRest = rest?.trim() ?? '';
  return {
    name: parsedName.data,
    argument: trimmedRest.length > 0 ? trimmedRest : null,
  };
}
