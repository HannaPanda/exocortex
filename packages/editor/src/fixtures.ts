/**
 * Markdown fixtures used by round-trip tests and by the development seed.
 *
 * They deliberately cover every supported construct so a regression in the
 * Markdown layer fails a test instead of silently losing content.
 */

export const KITCHEN_SINK_MARKDOWN = `---
title: Vollständiges Beispiel
icon: 🧠
tags:
  - beispiel
  - markdown
customProperty: bleibt erhalten
---

# Vollständiges Beispiel

Ein Absatz mit **fett**, *kursiv*, ~~durchgestrichen~~ und \`inline code\`.

Ein Absatz mit einem [externen Link](https://exocortex.app) und einem Wiki-Link
auf [[Andere Seite]] sowie einem benannten Wiki-Link [[Zielseite|Anderer Text]].

## Listen

- Erster Punkt
- Zweiter Punkt
  - Verschachtelt
- Dritter Punkt

1. Eins
2. Zwei
3. Drei

- [ ] Offene Aufgabe
- [x] Erledigte Aufgabe

## Zitat und Hinweis

> Ein normales Zitat.

> [!warning] Achtung
> Callouts sind eine Exocortex-Erweiterung.

## Code

\`\`\`ts
const answer: number = 42;
\`\`\`

## Tabelle

| Spalte A | Spalte B |
| --- | --- |
| Wert 1 | Wert 2 |
| Wert 3 | Wert 4 |

## Sonstiges

![Alternativtext](https://exocortex.app/bild.png)

---

Letzter Absatz.
`;

export const SIMPLE_MARKDOWN = `# Einfache Seite

Nur ein Absatz.
`;

export const NESTED_LIST_MARKDOWN = `- Ebene 1
  - Ebene 2
    - Ebene 3
`;

export const CALLOUT_MARKDOWN = `> [!info] Wichtig
> Erste Zeile.
>
> Zweite Zeile.
`;

export const TABLE_MARKDOWN = `| Kopf 1 | Kopf 2 |
| --- | --- |
| a | b |
`;

export const TASK_LIST_MARKDOWN = `- [x] Fertig
- [ ] Noch offen
`;

export const INLINE_STYLING_MARKDOWN = `Ein Absatz mit ==Hervorhebung==, ++Unterstreichung++,
H~2~O und E=mc^2^.

Kombiniert: **fett und ==hervorgehoben==** sowie *kursiv und ++unterstrichen++*.
`;

export const TOGGLE_MARKDOWN = `:::toggle Mehr erfahren
Der Inhalt der Klappbox.

Auch mehrere Absätze.
:::
`;

export const COLUMNS_MARKDOWN = `::::columns
:::column
Linke Spalte.
:::
:::column
Rechte Spalte.
:::
::::
`;

export const MATH_MARKDOWN = `Die Masse-Energie-Beziehung lautet $E = mc^2$.

$$
\\sum_{i=1}^{n} x_i = X
$$
`;

export const DERIVED_BLOCKS_MARKDOWN = `:::toc
:::

:::breadcrumb
:::

:::page Andere Seite
:::

:::database-embed Aufgaben
:::
`;

export const MEDIA_MARKDOWN = `:::file /api/attachments/abc/download Handbuch.pdf
:::

:::video /api/attachments/def/download Aufzeichnung.mp4
:::

:::audio /api/attachments/ghi/download Sprachnotiz.mp3
:::

:::pdf /api/attachments/jkl/download Vertrag.pdf
:::

:::embed https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ
:::

:::bookmark https://exocortex.app Exocortex
:::
`;

export const MENTION_MARKDOWN = `Besprochen mit @[Anna Beispiel] am @(2026-08-04),
Details siehe @[[Projektplan]].
`;

export const BLOCK_ID_MARKDOWN = `# Titel mit Id ^aaaaaaaaaaaa

Absatz mit Id ^bbbbbbbbbbbb

> [!note] Hinweis ^cccccccccccc
> Inhalt der Box.
`;

export const MARKDOWN_FIXTURES = {
  kitchenSink: KITCHEN_SINK_MARKDOWN,
  simple: SIMPLE_MARKDOWN,
  nestedList: NESTED_LIST_MARKDOWN,
  callout: CALLOUT_MARKDOWN,
  table: TABLE_MARKDOWN,
  taskList: TASK_LIST_MARKDOWN,
  inlineStyling: INLINE_STYLING_MARKDOWN,
  toggle: TOGGLE_MARKDOWN,
  columns: COLUMNS_MARKDOWN,
  math: MATH_MARKDOWN,
  derivedBlocks: DERIVED_BLOCKS_MARKDOWN,
  media: MEDIA_MARKDOWN,
  mention: MENTION_MARKDOWN,
  blockIds: BLOCK_ID_MARKDOWN,
} as const;

export type MarkdownFixtureName = keyof typeof MARKDOWN_FIXTURES;

/** Nested example pages used by `pnpm db:seed`. */
export const SEED_PAGES = [
  {
    title: 'Willkommen bei Exocortex',
    icon: '👋',
    markdown: `# Willkommen bei Exocortex

Exocortex ist dein gemeinsames externes Gehirn: Seiten, Datenbanken, Suche und
KI in einem Werkzeug.

> [!info] Erste Schritte
> Lege links im Seitenbaum eine neue Seite an und beginne zu schreiben.

- [x] Arbeitsbereich angelegt
- [ ] Erste eigene Seite geschrieben
- [ ] Markdown-Export ausprobiert
`,
    children: [
      {
        title: 'Tastenkürzel',
        icon: '⌨️',
        markdown: `# Tastenkürzel

| Kürzel | Wirkung |
| --- | --- |
| Strg + K | Befehlspalette öffnen |
| Strg + B | Fett |
| Strg + I | Kursiv |
`,
        children: [],
      },
      {
        title: 'Markdown-Referenz',
        icon: '📝',
        markdown: `# Markdown-Referenz

Exocortex kann Markdown importieren und exportieren.

\`\`\`ts
const beispiel = 'Code-Blöcke funktionieren';
\`\`\`

Verlinke andere Seiten mit [[Tastenkürzel]].
`,
        children: [],
      },
    ],
  },
  {
    title: 'Projekte',
    icon: '📁',
    markdown: `# Projekte

Sammelseite für laufende Projekte.
`,
    children: [
      {
        title: 'Exocortex selbst hosten',
        icon: '🚀',
        markdown: `# Exocortex selbst hosten

1. Repository klonen
2. \`pnpm install\`
3. \`pnpm infra:up\`
4. \`pnpm db:migrate\`
5. \`pnpm dev\`

> [!warning] Achtung
> Für den Produktivbetrieb müssen alle Secrets neu erzeugt werden.
`,
        children: [
          {
            title: 'Betriebsnotizen',
            icon: '🛠️',
            markdown: `# Betriebsnotizen

- Postgres, Redis, MinIO und Mailpit laufen als Container
- nginx terminiert TLS
`,
            children: [],
          },
        ],
      },
    ],
  },
] as const;
