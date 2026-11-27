import { type AiPromptMessage } from '@exocortex/ai';
import { type AiFillMaterial, fenceUntrustedContent } from '@exocortex/contracts';

type ReadyMaterial = Extract<AiFillMaterial, { status: 'ready' }>;

/**
 * The prompt for one cell of an AI fill (issue #237, ADR-099). Pure, so what
 * a model is told is a test rather than a hope.
 *
 * German like everything else the built-in AI is told. The model is asked for
 * one JSON object and nothing else, because the answer is checked against the
 * column by `coerceAiFillAnswer` and is never read as prose. Every file is
 * fenced as foreign content (ADR-030); there are no tools to call, so the
 * worst a planted instruction can do is choose the value of this one cell,
 * which is then checked like any other answer.
 */
export function buildAiFillPrompt(material: ReadyMaterial): AiPromptMessage[] {
  const { property, row } = material;
  const system = [
    'Du füllst genau ein Feld eines Datenbankeintrags aus.',
    'Antworte ausschließlich mit einem JSON-Objekt der Form {"value": …}, ohne Erklärung davor oder danach.',
    'Gibt das Material die Antwort nicht her, antworte {"value": null}. Erfinde nichts.',
    'Antworte in der Sprache des Materials, außer der Auftrag nennt eine andere.',
    '',
    `Das Feld heißt „${property.name}“. ${formatRule(material)}`,
  ].join('\n');

  const parts: string[] = [
    `Auftrag: ${material.instruction}`,
    '',
    `Titel des Eintrags: ${row.title}`,
  ];
  if (row.properties.length > 0) {
    parts.push('', 'Weitere Felder des Eintrags:');
    for (const entry of row.properties) parts.push(`- ${entry.name}: ${entry.value}`);
  }
  if (row.content !== null) {
    parts.push(
      '',
      row.contentTruncated ? 'Inhalt der Seite (gekürzt):' : 'Inhalt der Seite:',
      row.content,
    );
  }
  for (const file of material.attachments) {
    if (file.text === null) continue;
    parts.push(
      '',
      fenceUntrustedContent({
        origin: 'attachment',
        label: file.truncated ? `${file.filename} (gekürzt)` : file.filename,
        text: file.text,
      }),
    );
  }

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n') },
  ];
}

function quoted(labels: readonly string[]): string {
  return labels.map((label) => JSON.stringify(label)).join(', ');
}

/** What `value` has to look like for this column. */
function formatRule(material: ReadyMaterial): string {
  const { property } = material;
  switch (property.type) {
    case 'TEXT':
      return '"value" ist ein Text. Mehrere Punkte schreibst du als Zeilen mit "- " davor.';
    case 'NUMBER':
      return '"value" ist eine Zahl als JSON-Zahl, ohne Einheit und ohne Tausendertrennzeichen.';
    case 'CHECKBOX':
      return '"value" ist true oder false.';
    case 'URL':
      return '"value" ist eine vollständige Adresse, die mit https:// oder http:// beginnt.';
    case 'EMAIL':
      return '"value" ist eine E-Mail-Adresse.';
    case 'PHONE':
      return '"value" ist eine Telefonnummer als Text.';
    case 'DATE': {
      const one = property.includeTime
        ? 'ein Zeitpunkt im ISO-Format mit Zeitzone, etwa "2026-03-05T14:30:00+01:00"'
        : 'ein Tag im ISO-Format, etwa "2026-03-05"';
      return property.isRange
        ? `"value" ist {"start": …, "end": …}, beide ${one}; "end" darf null sein.`
        : `"value" ist ${one}.`;
    }
    case 'SELECT':
      return property.allowNewOptions
        ? `"value" ist eine der Optionen ${quoted(property.options)} oder, wenn keine passt, ein kurzer neuer Name.`
        : `"value" ist genau eine der Optionen ${quoted(property.options)}, wörtlich. Passt keine, antworte null.`;
    case 'MULTI_SELECT':
      return property.allowNewOptions
        ? `"value" ist eine Liste aus den Optionen ${quoted(property.options)}; passt keine, darfst du kurze neue Namen nennen.`
        : `"value" ist eine Liste aus den Optionen ${quoted(property.options)}, wörtlich. Andere Namen sind nicht erlaubt.`;
    case 'PERSON': {
      const people = material.members.map((member) => `${member.name} <${member.email}>`);
      return `"value" ist eine Liste von E-Mail-Adressen aus diesen Mitgliedern: ${people.join(', ')}. Ist niemand davon gemeint, antworte null.`;
    }
  }
}
