// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';

import { highlightSpans } from './code-block';
import { buildEditorExtensions } from './extensions';

/**
 * Issue #317: a block set to "Ohne Hervorhebung" was coloured by a guessed
 * language, a block set to "Shell" stayed white, and a language picked while
 * the caret was elsewhere did not recolour the block at all.
 */

/** `text` with each stretch's classes written around it: `[hljs-x:text]`. */
function render(code: string, language: string): string {
  let out = '';
  let position = 0;
  for (const span of highlightSpans(code, language)) {
    out += code.slice(position, span.from);
    out += `[${span.className}:${code.slice(span.from, span.to)}]`;
    position = span.to;
  }
  return out + code.slice(position);
}

const RSYNC_OUTPUT = [
  'receiving incremental file list',
  'test.zip',
  '',
  'sent 27 bytes  received 75 bytes  40.80 bytes/sec',
  'total size is 2,044,808  speedup is 20,047.14 (DRY RUN)',
].join('\n');

describe('highlightSpans', () => {
  it('leaves a block without a language plain, never guessing one', () => {
    expect(highlightSpans(RSYNC_OUTPUT, '')).toEqual([]);
    expect(highlightSpans(RSYNC_OUTPUT, null)).toEqual([]);
    expect(highlightSpans('const a = 1;', '')).toEqual([]);
  });

  it('leaves an unknown language plain', () => {
    expect(highlightSpans('const a = 1;', 'text')).toEqual([]);
    expect(highlightSpans('const a = 1;', 'klingonisch')).toEqual([]);
  });

  it('colours commands, options, paths, strings, variables and comments in bash', () => {
    expect(render('rsync -av --progress src/ "$HOME/x" # copy', 'bash')).toBe(
      '[hljs-title function_ invoke__:rsync] [hljs-attr:-av] [hljs-attr:--progress] ' +
        '[hljs-string path_:src/] [hljs-string:"][hljs-string hljs-variable:$HOME][hljs-string:/x"] ' +
        '[hljs-comment:# copy]',
    );
  });

  it('finds the command after a pipe, a semicolon and sudo, but not a keyword', () => {
    const out = render('if true; then sudo cat /etc/hosts | grep -v x; fi', 'bash');
    expect(out).toContain('[hljs-keyword:if]');
    expect(out).toContain('[hljs-keyword:then]');
    expect(out).toContain('[hljs-keyword:fi]');
    expect(out).toContain('[hljs-title function_ invoke__:cat]');
    expect(out).toContain('[hljs-title function_ invoke__:grep]');
    expect(out).toContain('[hljs-string path_:/etc/hosts]');
  });

  it('does not take an assignment or a continued line for a command', () => {
    expect(render('NAME=value', 'bash')).not.toContain('invoke__');
    const continued = render('rsync -a \\\n  src/ dst/', 'bash');
    expect(continued).toContain('[hljs-title function_ invoke__:rsync]');
    expect(continued).toContain('[hljs-string path_:src/]');
    expect(continued.match(/invoke__/g)).toHaveLength(1);
  });

  it('keeps the shebang of a script', () => {
    expect(render('#!/usr/bin/env bash\necho hi', 'bash')).toContain(
      '[hljs-meta:#!/usr/bin/env bash]',
    );
  });

  it('reads a terminal session: prompts as bash, output as printed', () => {
    const session = [
      'user@host:~$ rsync -av --progress src/ dst/',
      'sending incremental file list',
      'host:~/scripts # head -1 /usr/local/bin/rrsync',
      '#!/usr/bin/env python3',
      '[jo@box tmp]$ ls',
      '$ echo "fertig"',
    ].join('\n');
    const lines = render(session, 'console').split('\n');
    expect(lines[0]).toBe(
      '[hljs-meta prompt_:user@host:~$ ][hljs-title function_ invoke__:rsync] ' +
        '[hljs-attr:-av] [hljs-attr:--progress] [hljs-string path_:src/] [hljs-string path_:dst/]',
    );
    expect(lines[1]).toBe('sending incremental file list');
    expect(lines[2]).toContain('[hljs-meta prompt_:host:~/scripts # ]');
    expect(lines[2]).toContain('[hljs-title function_ invoke__:head]');
    // Output that happens to start with `#` is not a root prompt.
    expect(lines[3]).toBe('#!/usr/bin/env python3');
    expect(lines[4]).toContain('[hljs-meta prompt_:[jo@box tmp]$ ]');
    expect(lines[5]).toContain('[hljs-string:"fertig"]');
    // A space between two tokens carries no class and gets no decoration.
    expect(highlightSpans('$ ls -l', 'console').map((span) => span.className)).toEqual([
      'hljs-meta prompt_',
      'hljs-title function_ invoke__',
      'hljs-attr',
    ]);
  });

  it('understands the names people write after a fence', () => {
    expect(highlightSpans('echo hi', 'shell')).toEqual(highlightSpans('echo hi', 'bash'));
    expect(highlightSpans('echo hi', 'sh')).toEqual(highlightSpans('echo hi', 'bash'));
    expect(highlightSpans('KEY=value', 'dotenv').length).toBeGreaterThan(0);
    expect(highlightSpans('$ ls', 'shellsession')).toEqual(highlightSpans('$ ls', 'console'));
    expect(highlightSpans('Get-ChildItem -Path C:\\', 'powershell').length).toBeGreaterThan(0);
  });
});

describe('code block decorations', () => {
  let editor: Editor | null = null;

  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  function create(content: string): Editor {
    editor = new Editor({ extensions: buildEditorExtensions(), content });
    return editor;
  }

  function codeBlockPos(instance: Editor): number {
    let found = -1;
    instance.state.doc.descendants((node, pos) => {
      if (found < 0 && node.type.name === 'codeBlock') found = pos;
      return found < 0;
    });
    expect(found).toBeGreaterThanOrEqual(0);
    return found;
  }

  const highlighted = (instance: Editor): string[] =>
    [...instance.view.dom.querySelectorAll('pre [class*="hljs-"]')].map((node) => node.className);

  it('draws nothing for a block without a language', () => {
    const instance = create(`<pre><code>${RSYNC_OUTPUT}</code></pre>`);
    expect(highlighted(instance)).toEqual([]);
  });

  it('recolours at once when the language changes with the caret outside the block', () => {
    const instance = create(
      '<p>Davor</p><pre><code class="language-bash">const a = 1;</code></pre>',
    );
    instance.commands.setTextSelection(2);
    const before = highlighted(instance);

    const pos = codeBlockPos(instance);
    instance.view.dispatch(instance.state.tr.setNodeAttribute(pos, 'language', 'typescript'));
    expect(highlighted(instance)).toContain('hljs-keyword');
    expect(highlighted(instance)).not.toEqual(before);

    instance.view.dispatch(instance.state.tr.setNodeAttribute(pos, 'language', ''));
    expect(highlighted(instance)).toEqual([]);

    instance.view.dispatch(instance.state.tr.setNodeAttribute(pos, 'language', 'typescript'));
    expect(highlighted(instance)).toContain('hljs-keyword');
  });

  it('keeps the colours of a block when only text around it changes', () => {
    const instance = create(
      '<p>Davor</p><pre><code class="language-typescript">const a = 1;</code></pre>',
    );
    instance.commands.setTextSelection(2);
    instance.commands.insertContent('neu ');
    expect(highlighted(instance)).toContain('hljs-keyword');
    const keyword = instance.view.dom.querySelector('pre .hljs-keyword');
    expect(keyword?.textContent).toBe('const');
  });

  it('follows typing inside the block', () => {
    const instance = create('<pre><code class="language-typescript">x</code></pre>');
    instance.commands.setTextSelection(codeBlockPos(instance) + 2);
    instance.commands.insertContent(' = "eins";');
    expect(instance.view.dom.querySelector('pre .hljs-string')?.textContent).toBe('"eins"');
  });
});
