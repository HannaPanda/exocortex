import { type ToolImage, type ToolResult } from '@exocortex/mcp-tools';

/**
 * Pictures in a tool result, for a loop whose messages are text (issue #204).
 *
 * An MCP client gets `exo_attachment_read_image`'s picture as an image element
 * and shows it to its model. The built-in loop cannot (ADR-009), so here the
 * picture goes to a vision model and its description takes the picture's
 * place. The result is then fenced like any other attachment content by the
 * tool runner, because a screenshot can carry a sentence addressed to a model
 * just as a PDF can (ADR-030).
 */

/** Describes one picture. `label` is the file's name, a hint only. */
export type ToolImageDescriber = (image: ToolImage, label: string) => Promise<string>;

const NO_DESCRIBER =
  'Das Bild kann in diesem Lauf nicht angesehen werden: das gewählte Modell sieht keine Bilder, ' +
  'und es ist kein Bildmodell eingerichtet, das es beschreiben könnte (Bildverarbeitung in den ' +
  'KI-Einstellungen). Sag das, statt den Inhalt des Bilds zu erraten.';

const DESCRIBE_FAILED =
  'Das Bildmodell konnte das Bild nicht beschreiben. Sag das, statt den Inhalt des Bilds zu erraten.';

/**
 * The result with its pictures replaced by text. A result without pictures,
 * or a failed one, is returned as it is. A picture nobody can look at turns
 * the call into an error, so the model reads that it saw nothing rather than
 * a line of facts it might mistake for the picture.
 */
export async function describeToolImages(input: {
  result: ToolResult;
  describe: ToolImageDescriber | null;
  label: string;
  onFailure: (reason: string) => void;
}): Promise<ToolResult> {
  const { result } = input;
  const images = result.images ?? [];
  if (images.length === 0 || result.isError === true) return { ...result, images: undefined };

  if (input.describe === null) {
    return {
      ...result,
      images: undefined,
      text: `${result.text}\n\n${NO_DESCRIBER}`,
      isError: true,
    };
  }

  const descriptions: string[] = [];
  for (const image of images) {
    try {
      const description = (await input.describe(image, input.label)).trim();
      if (description.length === 0) throw new Error('empty description');
      descriptions.push(description);
    } catch (error) {
      input.onFailure(error instanceof Error ? error.message : String(error));
      return {
        ...result,
        images: undefined,
        text: `${result.text}\n\n${DESCRIBE_FAILED}`,
        isError: true,
      };
    }
  }

  return {
    ...result,
    images: undefined,
    text:
      `${result.text}\n\n` +
      'Beschreibung durch ein Bildmodell (du siehst das Bild nicht selbst, nur diese Beschreibung):\n' +
      descriptions.join('\n\n'),
  };
}
