/**
 * The fixtures the built-in AI is measured against, and what counts as having
 * solved them (issue #122).
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
// T4: two sections that read almost the same, and only one is meant
// ---------------------------------------------------------------------------

/**
 * The sentence that stands in three sections at once.
 *
 * T1 to T3 are about reading a page, budgeting it and writing narrowly. None of
 * them separated the four models any more: all thirty-six runs passed. What
 * they never asked is whether a run writes into the *right* place when more
 * than one place matches the words of the task, which is the failure a person
 * notices last, because the page still looks edited.
 */
const T4_DUTY = 'Zuständig für die Ausgabe ist die Pforte.';

const T4_HEADINGS = [
  'Zweck',
  'Schlüsselausgabe Verwaltung',
  'Schlüsselausgabe Werkstatt',
  'Schlüsselausgabe Fremdfirmen',
  'Verlust eines Schlüssels',
];

/*
 * The trap is deliberate and it is in the neighbours, not in the target: the
 * word „Werkstatt" stands twice outside the section that is meant (once in
 * „Zweck", once as an explicit exclusion in „Verwaltung"), and the sentence the
 * task replaces stands three times verbatim. A run that searches for the words
 * of the prompt and writes at the first hit lands in „Verwaltung"; a run that
 * replaces the sentence everywhere it occurs changes three sections. Both are
 * visible in the checkpoints, and both leave a page that reads as if it worked.
 */
const T4_MARKDOWN = `Synthetisches Testdokument. Alle Namen und Regeln darin sind erfunden.

## Zweck

Diese Ordnung regelt, wer im Werk Nord welchen Schlüssel bekommt und wo er
ausgegeben wird. Sie gilt für alle Gebäude auf dem Gelände, auch für die
Werkstatt, für die weiter unten eine eigene Ausgabe geregelt ist.

## Schlüsselausgabe Verwaltung

Die Verwaltung hat einen Generalschlüssel je Etage und drei Einzelschlüssel für
die Archivräume. ${T4_DUTY} Die Ausgabe ist von Montag bis Donnerstag zwischen
7 und 15 Uhr möglich, freitags bis 12 Uhr.

Ein Schlüssel wird nur gegen Unterschrift ausgegeben. Wer ihn länger als eine
Woche braucht, trägt sich in die Dauerliste ein. Für die Werkstatt gilt dieser
Abschnitt ausdrücklich nicht.

## Schlüsselausgabe Werkstatt

Die Werkstatt hat vier Schlüssel für die Hallentore und zwei für den Raum der
Werkzeugausgabe. ${T4_DUTY} Die Ausgabe ist an allen Werktagen zwischen 6 und
14 Uhr möglich.

Ein Schlüssel wird nur gegen Unterschrift ausgegeben. Wer ihn länger als eine
Woche braucht, trägt sich in die Dauerliste ein.

## Schlüsselausgabe Fremdfirmen

Fremdfirmen bekommen einen Schlüssel nur für die Dauer ihres Auftrags und nie
für die Hallentore. ${T4_DUTY} Die Ausgabe setzt eine gültige Auftragsnummer
voraus.

Ein Schlüssel wird nur gegen Unterschrift ausgegeben. Eine Dauerliste gibt es
für Fremdfirmen nicht.

## Verlust eines Schlüssels

Ein verlorener Schlüssel wird sofort gemeldet, auch wenn er wahrscheinlich
wieder auftaucht. Bis zur Klärung wird der betroffene Zylinder getauscht; die
Kosten trägt der Bereich und nicht die Person.
`;

/**
 * The page cut into its sections, each one as content rather than as text.
 *
 * Same reason as `contentOf`: an export re-wraps every paragraph, so a check
 * that compares line by line reports a page nobody wrote to as changed.
 */
function sectionsOf(markdown) {
  const sections = new Map();
  let heading = null;
  let body = [];
  const store = () => {
    if (heading !== null) sections.set(heading, body.join(' ').replace(/\s+/gu, ' ').trim());
  };
  for (const line of markdown.split('\n')) {
    const match = /^##\s+(?<title>.+)$/u.exec(line);
    if (match === null) {
      if (heading !== null) body.push(line);
      continue;
    }
    store();
    heading = match.groups.title.trim();
    body = [];
  }
  store();
  return sections;
}

function checkT4({ source, toolNames }) {
  const sections = sectionsOf(source.markdown);
  const workshop = sections.get('Schlüsselausgabe Werkstatt') ?? '';
  const neighbours = ['Schlüsselausgabe Verwaltung', 'Schlüsselausgabe Fremdfirmen'];
  const lostTheSentence = neighbours.filter(
    (title) => !(sections.get(title) ?? '').includes(T4_DUTY),
  );
  const gotTheForeman = neighbours.filter((title) =>
    (sections.get(title) ?? '').includes('Schichtmeister'),
  );
  const narrow = ['exo_page_block_update', 'exo_page_patch', 'exo_page_section_write'];
  return [
    {
      id: 'werkstatt-geaendert',
      passed: workshop.includes('Schichtmeister'),
      note: workshop === '' ? 'Abschnitt „Schlüsselausgabe Werkstatt" fehlt' : '',
    },
    {
      id: 'pforte-ersetzt',
      passed: workshop !== '' && !workshop.includes(T4_DUTY),
    },
    {
      id: 'nachbarn-unberuehrt',
      passed: lostTheSentence.length === 0 && gotTheForeman.length === 0,
      note: [...new Set([...lostTheSentence, ...gotTheForeman])].join(', '),
    },
    {
      id: 'seite-vollstaendig',
      passed:
        [...sections.keys()].join(' | ') === T4_HEADINGS.join(' | ') &&
        (sections.get('Verlust eines Schlüssels') ?? '').includes('Zylinder getauscht'),
      note: [...sections.keys()].join(' | '),
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
// T5: the same ambiguity, on a page nobody is handed whole
// ---------------------------------------------------------------------------

/**
 * What T4 could not ask.
 *
 * T4's page is 1,770 characters, so a run that simply reads it has the whole
 * text in front of it and the ambiguity dissolves on its own: eleven of twelve
 * runs extended `oldText` by the neighbouring sentence and were done. The trap
 * only ever caught the run that went through the search instead.
 *
 * T5 takes that decision away. The page is over the read budget (ADR-056), so
 * a read answers with the map and the run has to choose a section before it
 * sees a single sentence of one. The sentence it has to change stands verbatim
 * in three sections whose headings differ by one word, the word the prompt
 * names stands three more times outside them, and the number stands a fourth
 * time in a section that has nothing to do with the task.
 */
const T5_CALLBACK = 'Die Rückrufzeit beträgt 30 Minuten.';

/** The escalation sentence, which shares the number and nothing else. */
const T5_ESCALATION =
  'Meldet sich die gerufene Person nicht innerhalb von 30 Minuten, greift Stufe 2 und die Leitstelle ruft die Teamleitung.';

const T5_SECTIONS = [
  [
    'Zweck und Geltungsbereich',
    'Diese Ordnung regelt die Rufbereitschaft im Rechenzentrum Ost und gilt für alle Teams mit Betriebsverantwortung.',
  ],
  [
    'Begriffe',
    'Rufbereitschaft ist die Pflicht, erreichbar zu sein; Bereitschaftsdienst wäre Anwesenheit und kommt hier nicht vor.',
  ],
  [
    'Rufbereitschaft Werktag',
    `Von Montag bis Freitag ist eine Person je Team eingeteilt. ${T5_CALLBACK} Für das Wochenende gilt dieser Abschnitt ausdrücklich nicht.`,
  ],
  [
    'Rufbereitschaft Wochenende',
    `Samstags und sonntags sind zwei Personen eingeteilt, eine je Halle. ${T5_CALLBACK} Die Einteilung steht spätestens am Mittwoch davor fest.`,
  ],
  [
    'Rufbereitschaft Feiertage',
    `An gesetzlichen Feiertagen gilt die Einteilung des Wochenendes und zusätzlich eine Person in der Leitstelle. ${T5_CALLBACK} Die Zulage ist eine andere.`,
  ],
  [
    'Eskalation Stufe 1',
    'Stufe 1 ist die gerufene Person selbst; sie entscheidet, ob sie den Fall allein bearbeitet oder weitergibt.',
  ],
  ['Eskalation Stufe 2', T5_ESCALATION],
  [
    'Eskalation Stufe 3',
    'Stufe 3 ist die Bereichsleitung und wird nur beim Ausfall eines ganzen Brandabschnitts gerufen.',
  ],
  [
    'Erreichbarkeit',
    'Erreichbar heißt über das Diensttelefon, nicht über eine private Nummer und nicht über eine Mail; am Wochenende gilt dieselbe Nummer.',
  ],
  [
    'Übergabe',
    'Die Übergabe läuft über das Bereitschaftsbuch und dauert höchstens zehn Minuten, weil sie sonst zur Besprechung wird.',
  ],
  [
    'Dokumentation',
    'Jeder Ruf wird festgehalten, auch der, bei dem sich der Fehler bis zum Rückruf von selbst erledigt hat.',
  ],
  [
    'Werkzeuge',
    'Der Zugang zum Sprungrechner gehört zur Rufbereitschaft und wird vor dem ersten Dienst geprüft, nicht während des ersten Rufs.',
  ],
  [
    'Schulung',
    'Vor dem ersten eigenen Dienst läuft eine begleitete Schicht mit; wann jemand so weit ist, entscheidet die Teamleitung.',
  ],
  [
    'Ausnahmen',
    'Eine Ausnahme von dieser Ordnung, auch am Wochenende, genehmigt ausschließlich die Bereichsleitung und immer mit Enddatum.',
  ],
];

/** Filler that names its own section, so no two sections are interchangeable. */
function t5Body(topic, lead) {
  return [
    `${lead} Die Regelung steht so im Betriebshandbuch und ist mit dem Betriebsrat abgestimmt.`,
    '',
    `Für ${topic} gilt außerdem: Wer davon abweicht, hält die Abweichung im Bereitschaftsbuch fest, mit Grund und mit Dauer. Eine Abweichung ohne Enddatum gibt es nicht, weil sie sonst zur stillen Regel wird und beim nächsten Streitfall niemand mehr sagen kann, was eigentlich gilt.`,
    '',
    `Kommt es bei ${topic} wiederholt zu Rückfragen, wird die Regelung überarbeitet und nicht die Rückfrage einzeln beantwortet. Die Überarbeitung läuft über die Runde im Quartal; wer eine Änderung will, bringt sie dort ein und nicht in der Schicht.`,
    '',
    `Fragen zu ${topic} beantwortet die Leitstelle. Eine Antwort, die für mehr als einen Fall gilt, gehört in dieses Handbuch und nicht in eine Mail an die fragende Person.`,
  ].join('\n');
}

const T5_MARKDOWN =
  'Synthetisches Testdokument. Jede Zeit und jede Zuständigkeit darin ist erfunden.\n\n' +
  T5_SECTIONS.map(([topic, lead]) => `## ${topic}\n\n${t5Body(topic, lead)}`).join('\n\n') +
  '\n';

function checkT5({ source, toolNames, maxToolResultChars }) {
  const sections = sectionsOf(source.markdown);
  const target = sections.get('Rufbereitschaft Wochenende') ?? '';
  const neighbours = ['Rufbereitschaft Werktag', 'Rufbereitschaft Feiertage'];
  const changedNeighbours = neighbours.filter(
    (title) =>
      !(sections.get(title) ?? '').includes(T5_CALLBACK) ||
      (sections.get(title) ?? '').includes('20 Minuten'),
  );
  const narrow = ['exo_page_block_update', 'exo_page_patch', 'exo_page_section_write'];
  return [
    {
      id: 'wochenende-geaendert',
      passed: target.includes('20 Minuten') && !target.includes(T5_CALLBACK),
      note: target === '' ? 'Abschnitt „Rufbereitschaft Wochenende" fehlt' : '',
    },
    {
      id: 'nachbarn-unberuehrt',
      passed: changedNeighbours.length === 0,
      note: changedNeighbours.join(', '),
    },
    {
      // The number stands a fourth time, in a section the task never mentions.
      // A `replaceAll` on „30 Minuten" changes the escalation ladder too.
      id: 'eskalation-unberuehrt',
      passed: (sections.get('Eskalation Stufe 2') ?? '').includes(T5_ESCALATION),
    },
    {
      id: 'seite-vollstaendig',
      passed:
        [...sections.keys()].join(' | ') === T5_SECTIONS.map(([topic]) => topic).join(' | ') &&
        (sections.get('Ausnahmen') ?? '').includes('immer mit Enddatum'),
      note: [...sections.keys()].join(' | '),
    },
    {
      id: 'nicht-volltext',
      passed: maxToolResultChars < source.markdown.length,
      note: `größte Werkzeugantwort ${maxToolResultChars} Zeichen gegen ${source.markdown.length} Zeichen Seite`,
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

/**
 * T4 names neither its prompt nor its checkpoints, and that is not an
 * inconsistency.
 *
 * The leak in T1 to T3 is kept because removing it would break the comparison
 * with the baseline those three exist for. T4 has no baseline, so it starts
 * without one: repeating the prompt on the page would hand a keyword search the
 * exact words of the task, and the words of the task are what this test is
 * about.
 */
const T4_HEADER = (model) =>
  `> **Test T4 (${model}).** Synthetische Seite, gemessen wird gegen die Abschnitte dieser Seite.`;

/** Same reasoning as T4, and here it matters more: the run only sees the map. */
const T5_HEADER = (model) =>
  `> **Test T5 (${model}).** Synthetische Seite, gemessen wird gegen die Abschnitte dieser Seite.`;

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
  {
    key: 'T4',
    title: 'T4 Ähnliche Abschnitte',
    markdown: fixturePage(T4_HEADER, T4_MARKDOWN),
    prompt:
      'In der Werkstatt gibt nicht mehr die Pforte die Schlüssel aus, sondern der Schichtmeister. Trag das ein, sonst nichts.',
    check: checkT4,
  },
  {
    key: 'T5',
    title: 'T5 Ähnliche Abschnitte, große Seite',
    markdown: fixturePage(T5_HEADER, T5_MARKDOWN),
    prompt:
      'Am Wochenende ist die Rückrufzeit jetzt 20 Minuten statt 30. Trag das ein, sonst nichts.',
    check: checkT5,
  },
];
