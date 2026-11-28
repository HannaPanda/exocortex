'use client';

import * as React from 'react';

import { highlightCode, type HighlightNode } from '@exocortex/editor';

import { DsExample, DsSection } from '../showcase';

/**
 * A code block's syntax colours (issue #317), drawn with the editor's own
 * grammar registry (`highlightCode`) and the product's classes, without an
 * editor. Each example is one grammar; together they show every role of the
 * `--syntax-*` tokens at least once, so a changed token is a changed picture.
 */

function renderNodes(nodes: readonly HighlightNode[], prefix: string): React.ReactNode {
  return nodes.map((node, index) => {
    const key = `${prefix}-${String(index)}`;
    if (node.type === 'text') return <React.Fragment key={key}>{node.value ?? ''}</React.Fragment>;
    return (
      <span key={key} className={node.className?.join(' ')}>
        {renderNodes(node.children ?? [], key)}
      </span>
    );
  });
}

function Code({ language, code }: { language: string; code: string }) {
  const nodes = React.useMemo(() => highlightCode(code, language), [code, language]);
  return (
    <div className="exocortex-editor max-w-measure">
      <pre translate="no" className="my-0">
        <code className={language.length > 0 ? `language-${language}` : undefined}>
          {renderNodes(nodes, language)}
        </code>
      </pre>
    </div>
  );
}

const SESSION = `user@host:~$ rsync -av --progress src/ dst/
sending incremental file list
notizen.md

sent 27 bytes  received 75 bytes  40.80 bytes/sec
host:~/scripts # head -1 /usr/local/bin/rrsync
#!/usr/bin/env python3`;

const SCRIPT = `#!/usr/bin/env bash
# Sichert das Archiv, wenn es existiert
ZIEL="$HOME/sicherung"
if [ -f archiv.tar ]; then
  cp -v archiv.tar "$ZIEL/" && echo "fertig: 3 Dateien"
fi`;

const TYPESCRIPT = `interface Sicherung {
  ziel: string;
  versuche: number;
}

export function sichern(ziel: string): Sicherung {
  // Drei Versuche, dann aufgeben
  return { ziel, versuche: 3 };
}`;

const DIFF = `@@ -1,3 +1,3 @@
 ziel: /srv/sicherung
-versuche: 2
+versuche: 3`;

export function CodeBlockPattern() {
  return (
    <DsSection
      id="codeblock"
      title="Codeblock"
      lead="Die Grammatik färbt acht Rollen mit den Syntaxfarben. Sie unterscheiden sich in Helligkeit, Blau gegen Orange und im Schnitt (kursive Kommentare, halbfette Schlüsselwörter), damit sie auch bei Rot-Grün-Schwäche auseinanderzuhalten sind. Ein Block ohne Sprache bleibt ungefärbt, statt eine zu raten."
    >
      <DsExample
        id="codeblock-terminal"
        title="Terminal-Sitzung"
        source="packages/editor/src/code-grammars.ts"
        note="Eine Zeile mit Prompt ist ein Befehl und wird als Bash gelesen, jede andere ist Ausgabe und bleibt, wie sie gedruckt wurde."
      >
        <Code language="console" code={SESSION} />
      </DsExample>

      <DsExample
        id="codeblock-shell"
        title="Shell"
        note="Befehle blau, Optionen und Variablen hell, Pfade und Zeichenketten orange, Kommentare gedämpft und kursiv, Schlüsselwörter halbfett. Steht in einem Shell-Block eine Zeile mit einem eindeutigen Prompt (user@host:~$), wird er wie eine Terminal-Sitzung gelesen; die gespeicherte Sprache bleibt."
      >
        <Code language="bash" code={SCRIPT} />
      </DsExample>

      <DsExample id="codeblock-typescript" title="TypeScript">
        <Code language="typescript" code={TYPESCRIPT} />
      </DsExample>

      <DsExample
        id="codeblock-diff"
        title="Diff"
        note="Hinzugefügt blau, entfernt orange. Das Plus und das Minus vor jeder Zeile sagen es auch ohne Farbe."
      >
        <Code language="diff" code={DIFF} />
      </DsExample>

      <DsExample
        id="codeblock-ohne"
        title="Ohne Hervorhebung"
        note="Keine Sprache heißt keine Farbe. Programmausgabe ist kein Code, und eine geratene Sprache färbt Wörter wie „list“ oder „is“."
      >
        <Code
          language=""
          code={'receiving incremental file list\ntotal size is 2,044,808  speedup is 20,047.14'}
        />
      </DsExample>
    </DsSection>
  );
}
