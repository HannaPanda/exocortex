/**
 * The three fixtures the built-in AI is measured against, and what counts as
 * having solved them (issue #122).
 *
 * Every word here is invented. No production page and no memory note is ever a
 * fixture: a test that fails against real content costs real content, and this
 * one writes.
 *
 * The prompts are deliberately as imprecise as a person's would be ("den Teil
 * mit Halle 4"), because that imprecision is the thing under test. They must
 * not be improved between measurements, or the new numbers stop being
 * comparable to the old ones.
 *
 * Each fixture answers two questions: what the page says at the start, and
 * which checkpoints a finished run passed. The checkpoints are predicates over
 * what is on the pages afterwards and over the run's tool sequence, never a
 * judgement -- ADR-059's ledger says what a run did, and this says whether it
 * worked.
 */

// ---------------------------------------------------------------------------
// T1: a section that has to move onto a page of its own
// ---------------------------------------------------------------------------

const T1_MARKDOWN = `## Ausgangslage

Projekt Nordlicht soll die Kommissionierung der Ersatzteilsparte von zwei
Standorten auf einen zusammenziehen. Der Beschluss dazu ist im Februar gefallen,
die Umsetzung läuft seitdem in drei Wellen. Die erste Welle ist abgeschlossen,
die zweite hängt an der Bauabnahme.

Der Zeitplan hat zwei Wochen Puffer, die inzwischen aufgebraucht sind. Das ist
nicht dramatisch, solange die dritte Welle nicht vor Oktober startet.

## Beteiligte

- Vera Lindqvist, Projektleitung, entscheidet über den Zeitplan
- Tomas Ehrenberg, Logistik, kennt die Wege in beiden Hallen
- Ruth Abakar, Einkauf, verhandelt die Regaltechnik
- Milan Petrov, IT, hängt die Scanner an das neue Netz

## Standort Halle 4

Halle 4 ist der größere der beiden Standorte und soll am Ende alles aufnehmen.
Die Halle hat 4.200 Quadratmeter, zwei Tore auf der Nordseite und eine
Deckenhöhe von 9,60 Metern, was für die geplante dritte Regalebene reicht.

Der Boden trägt 5 Tonnen pro Quadratmeter. Das Gutachten dazu ist zwei Jahre
alt und muss vor der Bauabnahme erneuert werden, weil die Regaltechnik anders
ausfällt als damals angenommen.

Die Stromversorgung ist der eigentliche Engpass. Für die Förderanlage braucht
es einen zweiten Anschluss, und der Termin dafür steht noch nicht. Ohne ihn
läuft die Anlage im Notbetrieb, also mit halber Geschwindigkeit.

Offen an diesem Standort:

- Gutachten zur Bodenlast erneuern
- Termin für den zweiten Stromanschluss festmachen
- Tore auf der Nordseite auf Schnelllauftore umrüsten

## Offene Punkte

- Die Bauabnahme hat noch keinen Termin
- Die Regaltechnik ist ausgeschrieben, aber nicht vergeben
- Für die Scanner fehlt die Freigabe der IT-Sicherheit

## Nächste Schritte

Vera setzt einen Termin mit dem Bauamt an, Ruth holt das dritte Angebot für die
Regaltechnik ein. Alles Weitere entscheidet sich nach der Bauabnahme.
`;

/** Sentences that must end up on the new page, and must leave the old one. */
const T1_MOVED = [
  '4.200 Quadratmeter',
  'Der Boden trägt 5 Tonnen',
  'Die Stromversorgung ist der eigentliche Engpass',
  'Schnelllauftore',
];

/** Sentences the move must not touch. */
const T1_UNTOUCHED = [
  'Vera Lindqvist',
  'Die Bauabnahme hat noch keinen Termin',
  'Ruth holt das dritte Angebot',
];

function checkT1({ source, children, answer, toolNames }) {
  const moved = children.find((child) =>
    T1_MOVED.every((phrase) => child.markdown.includes(phrase)),
  );
  const leftBehind = T1_MOVED.filter((phrase) => source.markdown.includes(phrase));
  return [
    { id: 'unterseite', passed: moved !== undefined, note: `${children.length} Unterseite(n)` },
    {
      id: 'abschnitt-weg',
      passed: leftBehind.length === 0,
      note: leftBehind.length === 0 ? '' : `noch auf der Quellseite: ${leftBehind.join(', ')}`,
    },
    {
      id: 'verweis',
      passed:
        moved !== undefined &&
        (source.markdown.includes(moved.id) || source.markdown.includes(moved.title)),
    },
    {
      id: 'rest-unberuehrt',
      passed: T1_UNTOUCHED.every((phrase) => source.markdown.includes(phrase)),
    },
    { id: 'regel-geladen', passed: toolNames.includes('exo_rules_load') },
    {
      id: 'ergebnis-benannt',
      passed: moved !== undefined && answer.includes(moved.id),
    },
  ];
}

// ---------------------------------------------------------------------------
// T2: a page too large to read in one go
// ---------------------------------------------------------------------------

const T2_SECTIONS = [
  [
    'Zweck und Geltungsbereich',
    'Dieses Handbuch beschreibt, wie in der Niederlassung Süd bestellt wird, und gilt für alle Bereiche außer dem Werkstattlager.',
  ],
  [
    'Begriffe',
    'Eine Bedarfsmeldung ist der Wunsch eines Bereichs, eine Bestellung der daraus entstandene Vertrag mit einem Lieferanten.',
  ],
  [
    'Bedarfsmeldung',
    'Eine Bedarfsmeldung nennt Menge, Termin und Verwendungszweck und wird von der Bereichsleitung gezeichnet.',
  ],
  [
    'Lieferantenauswahl',
    'Lieferanten werden aus der gepflegten Liste gewählt; ein neuer Lieferant braucht eine Selbstauskunft und eine Bonitätsprüfung.',
  ],
  [
    'Angebotsvergleich',
    'Ab drei vergleichbaren Positionen wird ein Spiegel angelegt, der Preis, Termin und Nebenkosten nebeneinander stellt.',
  ],
  [
    'Bestellanlage',
    'Eine Bestellung entsteht immer im System und nie per Zuruf, weil sonst der Wareneingang nichts zum Abgleichen hat.',
  ],
  [
    'Sofortbestellungen',
    'Die Freigabegrenze für eine Sofortbestellung liegt bei 480 Euro; darüber entscheidet ausschließlich die Bereichsleitung Technik.',
  ],
  [
    'Rahmenverträge',
    'Ein Rahmenvertrag legt Preise für zwölf Monate fest und wird drei Monate vor Ablauf neu verhandelt.',
  ],
  [
    'Wareneingang',
    'Der Wareneingang prüft Menge und sichtbare Schäden, nie die technische Eignung; dafür ist der anfordernde Bereich zuständig.',
  ],
  [
    'Rechnungsprüfung',
    'Geprüft wird gegen Bestellung und Wareneingang; weicht eine der drei Angaben ab, geht die Rechnung zurück.',
  ],
  [
    'Reklamationen',
    'Eine Reklamation wird innerhalb von fünf Werktagen gemeldet, sonst gilt die Lieferung als angenommen.',
  ],
  [
    'Rückgaben und Gutschriften',
    'Eine Rückgabe braucht die Zustimmung des Lieferanten; eine Gutschrift ohne Rückgabe ist die Ausnahme und wird begründet.',
  ],
  [
    'Archivierung',
    'Bestellung, Lieferschein und Rechnung werden zehn Jahre aufbewahrt, digital und ohne Papierdoppel.',
  ],
  [
    'Zuständigkeiten',
    'Der Einkauf verantwortet den Preis, der anfordernde Bereich die Eignung und die Buchhaltung die Zahlung.',
  ],
];

/** Filler that reads like a handbook and names its own section, so it is not interchangeable. */
function t2Body(topic, lead) {
  return [
    `${lead} Die Regelung gilt seit der letzten Überarbeitung unverändert und ist mit der Revision abgestimmt.`,
    '',
    `Für ${topic} gilt darüber hinaus: Abweichungen werden schriftlich festgehalten, und zwar in der Akte des Vorgangs und nicht in einer Mail. Wer eine Abweichung zulässt, nennt den Grund und die Dauer. Eine Abweichung ohne Enddatum gibt es nicht, weil sie sonst zur stillen Regel wird und niemand mehr weiß, warum etwas so läuft, wie es läuft.`,
    '',
    `Im Zweifel entscheidet die Bereichsleitung. Sie kann die Entscheidung an den Einkauf abgeben, behält aber die Verantwortung dafür. Kommt es bei ${topic} wiederholt zu Abweichungen, wird die Regelung überprüft statt die Abweichung zu wiederholen; die Überprüfung läuft über die halbjährliche Runde und nicht über Einzelfälle.`,
    '',
    `Fragen zu ${topic} beantwortet der Einkauf. Eine Antwort, die für mehr als einen Fall gilt, gehört in dieses Handbuch und nicht in eine Mail an die fragende Person.`,
  ].join('\n');
}

const T2_MARKDOWN =
  'Synthetisches Testdokument. Jede Zahl darin ist erfunden.\n\n' +
  T2_SECTIONS.map(([topic, lead]) => `## ${topic}\n\n${t2Body(topic, lead)}`).join('\n\n') +
  '\n';

/**
 * A page as its content, not as its formatting.
 *
 * An export is not the string that was written: it carries frontmatter the
 * writer never sent, and it re-wraps every paragraph, because Markdown is an
 * interchange format derived from the canonical Yjs state (ADR-007). Comparing
 * the two strings therefore reported every page as changed, including the six
 * that nobody wrote to. What the checkpoint is about is whether the text
 * changed, so that is what it compares.
 */
function contentOf(markdown) {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function checkT2({ source, fixtureMarkdown, answer, toolResultChars, maxToolResultChars }) {
  return [
    { id: 'betrag', passed: answer.includes('480') },
    { id: 'zustaendig', passed: /Bereichsleitung\s+Technik/u.test(answer) },
    { id: 'abschnitt-benannt', passed: answer.includes('Sofortbestellungen') },
    {
      /*
       * The point of the map (ADR-056): no single answer carried the whole
       * page. The *largest* result, not the sum of them: a run that reads two
       * sections and a search hit legitimately adds up past the page's size
       * without ever having been handed the page, and scoring the sum marked
       * exactly those runs as failures. What the checkpoint is about is
       * whether one read returned everything.
       */
      id: 'nicht-volltext',
      passed: maxToolResultChars < source.markdown.length,
      note: `größte Werkzeugantwort ${maxToolResultChars} Zeichen gegen ${source.markdown.length} Zeichen Seite, ${toolResultChars} Zeichen zusammen`,
    },
    {
      id: 'seite-unveraendert',
      passed: contentOf(source.markdown) === contentOf(fixtureMarkdown),
    },
  ];
}

// ---------------------------------------------------------------------------
// T3: three corrections in a table of sixty rows
// ---------------------------------------------------------------------------

const T3_ITEMS = [
  'Regalwinkel verzinkt',
  'Schraubensortiment M6',
  'Hydrauliköl HLP 46',
  'Kabelbinder 200 mm',
  'Schutzhandschuhe Gr. 9',
  'Dichtring 12 x 2',
  'Rollenlager 6204',
  'Gewindestange M10',
  'Isolierband schwarz',
  'Federstecker 4 mm',
];

/** The rows as they start out, and as the checks expect them back. */
function t3Rows() {
  const rows = [];
  for (let number = 1; number <= 60; number += 1) {
    const name = T3_ITEMS[(number - 1) % T3_ITEMS.length];
    const size = 40 + ((number * 17) % 260);
    rows.push({ number, article: `${name} ${100 + number}`, stock: String(size) });
  }
  return rows;
}

const T3_MARKDOWN = `Synthetische Inventarliste. Die Einheit stimmt bei drei Artikeln nicht.

| Nr. | Artikel | Bestand | Einheit |
| --- | --- | --- | --- |
${t3Rows()
  .map((row) => `| ${row.number} | ${row.article} | ${row.stock} | Stück |`)
  .join('\n')}
`;

/** The three rows the prompt names. Everything else has to stay `Stück`. */
const T3_TO_CHANGE = [17, 34, 58];

/**
 * What counts as the corrected unit.
 *
 * The prompt says "das sind Kartons", and the column is singular throughout
 * ("Stück"), so both spellings are the same answer. Demanding the plural
 * failed five runs that had changed exactly the right three rows, which made
 * the checkpoint a test of wording rather than of the edit.
 */
const T3_CORRECTED_UNIT = ['Karton', 'Kartons'];

/** Parses the table back out of the page, so the checks are about data and not about text. */
function parseT3(markdown) {
  return markdown
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) =>
      line
        .trim()
        .replace(/^\||\|$/gu, '')
        .split('|')
        .map((cell) => cell.trim()),
    )
    .filter((cells) => cells.length === 4 && /^\d+$/u.test(cells[0]));
}

function checkT3({ source, toolNames }) {
  const rows = parseT3(source.markdown);
  const expected = t3Rows();
  const numbering = rows.map((cells) => Number(cells[0]));
  const wrongUnit = rows.filter((cells) =>
    T3_TO_CHANGE.includes(Number(cells[0]))
      ? !T3_CORRECTED_UNIT.includes(cells[3])
      : cells[3] !== 'Stück',
  );
  const changedArticles = rows.filter((cells, index) => {
    const row = expected[index];
    return row === undefined || cells[1] !== row.article || cells[2] !== row.stock;
  });
  const narrow = ['exo_page_block_update', 'exo_page_patch', 'exo_page_section_write'];
  return [
    { id: 'sechzig-zeilen', passed: rows.length === 60, note: `${rows.length} Zeilen` },
    {
      id: 'nummerierung',
      passed: numbering.every((value, index) => value === index + 1),
      note: numbering.length === 0 ? 'keine Tabelle gefunden' : '',
    },
    {
      id: 'genau-drei',
      passed: wrongUnit.length === 0,
      note: wrongUnit.map((cells) => `${cells[0]}=${cells[3]}`).join(', '),
    },
    {
      id: 'rest-unberuehrt',
      passed: changedArticles.length === 0,
      note: changedArticles.map((cells) => cells[0]).join(', '),
    },
    {
      id: 'gezielt-geschrieben',
      passed:
        toolNames.some((name) => narrow.includes(name)) && !toolNames.includes('exo_page_write'),
      note: toolNames.filter((name) => name.startsWith('exo_page_')).join(' → '),
    },
  ];
}

// ---------------------------------------------------------------------------

/**
 * The header each fixture page carries above its content.
 *
 * It repeats the prompt and names the checkpoints, and it is kept exactly as
 * the first measurement had it -- including the fact that a model reading the
 * page can read the checkpoints. That is a leak, and removing it would make
 * the new numbers incomparable with the baseline they exist to be compared
 * with (issue #122). Change it, and the baseline is gone.
 */
function fixturePage(header, body) {
  return (model) => `${header(model)}\n\n---\n\n${body}`;
}

const T1_HEADER = (model) => `> **Test T1 (${model}).** Prompt, wortwörtlich:
>
> Verschiebe den Teil mit Halle 4 auf eine eigene Seite unter dieser Seite.

Prüfpunkte: die neue Seite trägt alle vier Absätze und die Liste; auf dieser
Seite steht statt des Abschnitts ein Verweis; nichts anderes hat sich geändert;
der Lauf hat den Abschnitt vor dem Verschieben wirklich gelesen; die Regelseite
„Regel: Abschnitt verschieben" wurde geladen und ihre drei Punkte eingehalten.`;

const T2_HEADER = (model) => `> **Test T2 (${model}).** Prompt, wortwörtlich:
>
> Wie hoch ist die Freigabegrenze für Sofortbestellungen, und wer entscheidet darüber?

Prüfpunkte: die Antwort nennt 480 Euro und die Bereichsleitung Technik; sie
nennt den Abschnitt, in dem das steht; der Lauf hat dafür die Karte der Seite
benutzt und nicht die ganze Seite in den Kontext gezogen.`;

const T3_HEADER = (model) => `> **Test T3 (${model}).** Prompt, wortwörtlich:
>
> Bei den Artikeln 17, 34 und 58 ist die Einheit falsch, das sind Kartons und keine Stück. Korrigier das, sonst nichts.

Prüfpunkte: genau drei Zeilen geändert; die Tabelle hat danach immer noch 60
Zeilen; keine Zeile doppelt; die Seite ist nicht neu geschrieben worden,
sondern gezielt geändert.`;

export const BENCHMARK_FIXTURES = [
  {
    key: 'T1',
    title: 'T1 Abschnitt verschieben',
    markdown: fixturePage(T1_HEADER, T1_MARKDOWN),
    prompt: 'Verschiebe den Teil mit Halle 4 auf eine eigene Seite unter dieser Seite.',
    check: checkT1,
  },
  {
    key: 'T2',
    title: 'T2 Große Seite lesen',
    markdown: fixturePage(T2_HEADER, T2_MARKDOWN),
    prompt: 'Wie hoch ist die Freigabegrenze für Sofortbestellungen, und wer entscheidet darüber?',
    check: checkT2,
  },
  {
    key: 'T3',
    title: 'T3 Gezielte Korrektur',
    markdown: fixturePage(T3_HEADER, T3_MARKDOWN),
    prompt:
      'Bei den Artikeln 17, 34 und 58 ist die Einheit falsch, das sind Kartons und keine Stück. Korrigier das, sonst nichts.',
    check: checkT3,
  },
];
