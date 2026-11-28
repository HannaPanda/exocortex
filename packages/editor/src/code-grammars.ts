import type { HLJSApi, Language, LanguageFn, Mode } from 'highlight.js';
import bash from 'highlight.js/lib/languages/bash';

/**
 * The two shell grammars of the code block (issue #317).
 *
 * highlight.js' own `bash` grammar colours keywords, strings, variables and
 * comments, and nothing else: in a typical command line such as
 * `rsync -av --progress src/ dst/` it found no token at all, so a block set to
 * "Shell" stayed white. Its `shell` grammar is meant for a terminal session,
 * but its prompt pattern stops at the first `:`, so neither `user@host:~$` nor
 * `host:~/scripts #` counted as a prompt, and a prompt ending in `#` was read
 * as a comment by `bash`. Both grammars below wrap the upstream ones rather than
 * copying them, so a highlight.js update still reaches them.
 */

/** Words that open or close a construct in bash; never the name of a command. */
const BASH_KEYWORDS = [
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'in',
  'do',
  'done',
  'case',
  'esac',
  'function',
  'select',
];

/**
 * The command a statement runs: the first word at the start of a line (but not
 * of a line continued with a backslash), after `|`, `;`, `&`, `(` or `{`, and
 * after a word that runs another command (`sudo`, `then`, `do` ...). It has to
 * be followed by a space, the end of the line or `;`, which keeps an assignment
 * (`NAME=value`) and a `case` label (`start)`) out.
 */
const COMMAND: Mode = {
  scope: 'title.function.invoke',
  match: new RegExp(
    String.raw`(?:(?<=^[ \t]*)(?<!\\\r?\n[ \t]*)|(?<=[|;&({][ \t]*)|(?<=\b(?:sudo|then|do|else|time|exec|xargs|env|nohup|watch)[ \t]+))` +
      String.raw`(?!(?:${BASH_KEYWORDS.join('|')})(?![\w.+/~-]))` +
      String.raw`[A-Za-z_.~/][\w.+/~-]*(?=[ \t]|$|;)`,
  ),
  relevance: 0,
};

/** An option: `-a`, `-av`, `--progress`, the name part of `--exclude=x`. */
const OPTION: Mode = {
  scope: 'attr',
  match: /(?<=^|[ \t])--?[A-Za-z0-9][\w-]*/,
  relevance: 0,
};

/**
 * A path: absolute (`/usr/bin`), home or dot relative (`~/x`, `./run.sh`), or
 * a relative one with a slash in it (`src/`). It reads as a literal argument,
 * which is why it wears the string colour, with `path_` beside it for a theme
 * that wants to tell the two apart.
 */
const PATH: Mode = {
  scope: 'string.path',
  match: /(?<=^|[ \t=])(?:(?:~|\.{1,2})?\/|[\w.-]+\/)[^\s;|&<>()'"`$]*/,
  relevance: 0,
};

/**
 * bash with commands, options and paths. Registered under the name `bash`, so
 * every stored block and every Markdown fence keeps its language; `shell` is an
 * alias, because that is what most people write after a fence when they mean a
 * script (GitHub reads it the same way).
 */
export const shellScript: LanguageFn = (hljs: HLJSApi): Language => {
  const base = bash(hljs);
  const contains = [...(base.contains ?? [])];
  // After upstream's two shebang modes and its function definition (`name()
  // {`), before the rest: at an equal position highlight.js takes the first
  // mode in this list, and upstream has a path mode without a colour that
  // would otherwise swallow `/usr/bin` before ours sees it. The unit tests pin
  // what each of them finds, so a reordered upstream list shows up there.
  contains.splice(Math.min(3, contains.length), 0, COMMAND, OPTION, PATH);
  return { ...base, aliases: [...(base.aliases ?? []), 'shell'], contains };
};

/**
 * The prompt of a terminal session: an optional `(venv)`, then either a
 * bracketed `[user@host dir]` or a run of host and path characters
 * (`user@host:~`, `host:~/scripts`, `C:\Users`), an optional space, one of
 * `$ # % >`, and a space or the end of the line. A `#!` shebang is no prompt,
 * because the `#` has to be followed by a space.
 */
const PROMPT =
  /^[ \t]{0,3}(?:\([\w.-]+\)[ \t])?(?:PS[ \t])?(?:\[[^\]\n]*\]|[\w.~@:/\\+-]*)[ \t]?[$#%>](?=[ \t]|$)[ \t]?/;

/**
 * A terminal session: lines starting with a prompt are commands and are read
 * as bash; every other line is output and stays as it was printed. Output is
 * not code, and guessing a language for it is what made "Ohne Hervorhebung"
 * look more colourful than "Shell" (issue #317).
 *
 * Registered as `console`, the name GitHub and most Markdown tools use for a
 * session, with `shellsession` and `terminal` as aliases.
 */
export const terminalSession: LanguageFn = (): Language => ({
  name: 'Terminal session',
  aliases: ['shellsession', 'terminal'],
  contains: [
    {
      scope: 'meta.prompt',
      begin: PROMPT,
      starts: { end: /[^\\](?=\s*$)/, subLanguage: 'bash' },
    },
  ],
});

/**
 * A prompt no script line can start with: `user@host:~$`, `host:~/dir #`,
 * `[user@host dir]$`, or a bare `$ ` (in a script `$` starts a variable and is
 * never followed by a space). Deliberately narrower than `PROMPT` above, which
 * may assume it is looking at a session.
 */
const SESSION_MARKER =
  /^[ \t]{0,3}(?:\([\w.-]+\)[ \t])?(?:\[[^\]\n]*@[^\]\n]*\]|[\w.-]+@[\w.-]+(?::\S*?)?|[\w.-]+:[~/]\S*?)?[ \t]?[$#](?:[ \t]|$)/m;

/**
 * Whether a block marked as a shell script is in fact a terminal session.
 *
 * Most "Shell" blocks in practice are pasted from a terminal: prompt, command,
 * output (issue #317). Read as a script, the prompt's `#` opens a comment and
 * every line of output looks like a command. One line starting with an
 * unmistakable prompt settles it, so such a block is highlighted as `console`
 * while its stored language stays `bash`. A root prompt without a host (`# `)
 * is not enough on its own: in a script that is a comment.
 */
export function looksLikeSession(code: string): boolean {
  for (const match of code.matchAll(new RegExp(SESSION_MARKER.source, 'gm'))) {
    if (!/^[ \t]*#/.test(match[0])) return true;
  }
  return false;
}
