/**
 * A small reader for ICU MessageFormat, enough to compare two messages.
 *
 * The i18n gate and the translation tool both have to answer one question
 * about a translated string: does it still take the same arguments, the same
 * tags and the same choices as its German source? That needs the structure of
 * the message, not a full formatter, and the gates are dependency-free on
 * purpose (they run before `pnpm install` could have repaired anything), so
 * this is the structure and nothing more.
 *
 * Syntax covered, which is what `use-intl` accepts:
 *
 *   {name}                          simple argument
 *   {name, number|date|time, fmt}   formatted argument
 *   {name, plural, =0 {…} one {…} other {…}}   and selectordinal, with offset:n
 *   {name, select, a {…} other {…}}
 *   <tag>…</tag>  <tag/>            rich-text tags
 *   '' for a literal apostrophe, '{…}' to quote syntax characters
 */

const SYNTAX_AFTER_QUOTE = new Set(['{', '}', '#', '<', '>', '|']);

class IcuSyntaxError extends Error {}

/**
 * Parses `message` into a list of nodes. Throws `IcuSyntaxError` on anything
 * a formatter would refuse: an unclosed brace, a plural without `other`, a
 * closing tag that does not match.
 */
export function parseIcu(message) {
  let index = 0;

  function error(reason) {
    return new IcuSyntaxError(`${reason} at position ${index}`);
  }

  function skipSpace() {
    while (index < message.length && /\s/.test(message[index])) index += 1;
  }

  function readIdentifier() {
    skipSpace();
    const start = index;
    while (index < message.length && /[^\s{},<>/]/.test(message[index])) index += 1;
    if (start === index) throw error('expected a name');
    return message.slice(start, index);
  }

  function expect(character) {
    skipSpace();
    if (message[index] !== character) throw error(`expected "${character}"`);
    index += 1;
  }

  /** Steps over an apostrophe: `''` is one, `'{…}'` quotes syntax. */
  function skipQuote() {
    const next = message[index + 1];
    if (next === "'") {
      index += 2;
    } else if (next !== undefined && SYNTAX_AFTER_QUOTE.has(next)) {
      const end = message.indexOf("'", index + 1);
      if (end === -1) throw error('unclosed quote');
      index = end + 1;
    } else {
      index += 1;
    }
  }

  /**
   * At a `<`: a closing tag answers `'close'`, an opening or self-closing
   * tag answers its node, a lone `<` in prose answers `null`.
   */
  function parseTag(inPlural, closingTag) {
    if (message[index + 1] === '/') {
      if (closingTag === undefined) throw error('unexpected closing tag');
      index += 2;
      const name = readIdentifier();
      if (name !== closingTag) throw error(`closing tag </${name}> does not match <${closingTag}>`);
      expect('>');
      return 'close';
    }
    if (!/[A-Za-z]/.test(message[index + 1] ?? '')) return null;
    index += 1;
    const name = readIdentifier();
    skipSpace();
    if (message[index] === '/' && message[index + 1] === '>') {
      index += 2;
      return { type: 'tag', name, children: [] };
    }
    expect('>');
    return { type: 'tag', name, children: parseNodes(inPlural, name) };
  }

  /** Nodes until the end, a `}` closing an option, or a closing tag. */
  function parseNodes(inPlural, closingTag) {
    const nodes = [];
    while (index < message.length) {
      const character = message[index];
      if (character === "'") {
        skipQuote();
        continue;
      }
      if (character === '{') {
        nodes.push(parseArgument());
        continue;
      }
      if (character === '}') {
        if (closingTag !== undefined) throw error(`unclosed tag <${closingTag}>`);
        if (inPlural === undefined) throw error('unexpected "}"');
        return nodes;
      }
      if (character === '<') {
        const tag = parseTag(inPlural, closingTag);
        if (tag === 'close') return nodes;
        if (tag !== null) {
          nodes.push(tag);
          continue;
        }
      }
      if (character === '#' && inPlural === true) nodes.push({ type: 'pound' });
      index += 1;
    }
    if (inPlural !== undefined) throw error('unclosed "{"');
    if (closingTag !== undefined) throw error(`unclosed tag <${closingTag}>`);
    return nodes;
  }

  function parseArgument() {
    index += 1; // {
    const name = readIdentifier();
    skipSpace();
    if (message[index] === '}') {
      index += 1;
      return { type: 'argument', name, kind: 'simple' };
    }
    expect(',');
    const kind = readIdentifier();
    skipSpace();
    if (kind === 'number' || kind === 'date' || kind === 'time') {
      if (message[index] === ',') {
        const end = message.indexOf('}', index);
        if (end === -1) throw error('unclosed "{"');
        index = end;
      }
      expect('}');
      return { type: 'argument', name, kind };
    }
    if (kind !== 'plural' && kind !== 'selectordinal' && kind !== 'select') {
      throw error(`unknown argument type "${kind}"`);
    }
    expect(',');
    const options = new Map();
    for (;;) {
      skipSpace();
      if (message[index] === '}') {
        index += 1;
        break;
      }
      if (index >= message.length) throw error('unclosed "{"');
      const key = readIdentifier();
      if (key.startsWith('offset:')) continue;
      expect('{');
      if (options.has(key)) throw error(`option "${key}" appears twice`);
      options.set(key, parseNodes(kind !== 'select', undefined));
      index += 1; // the option's }
    }
    if (!options.has('other')) throw error(`{${name}, ${kind}} has no "other" option`);
    return { type: 'argument', name, kind, options };
  }

  const nodes = parseNodes(undefined, undefined);
  return nodes;
}

/**
 * Everything about a message a translation must keep: each argument with its
 * type, each tag, and for `select` the option keys. Plural keys are left out
 * here because they legitimately differ between languages; `pluralProblems`
 * checks them against the target language instead.
 */
export function icuSignature(nodes) {
  const entries = new Set();
  const visit = (list) => {
    for (const node of list) {
      if (node.type === 'argument') {
        entries.add(`argument ${node.name}: ${node.kind}`);
        if (node.kind === 'select') {
          entries.add(`select ${node.name}: ${[...node.options.keys()].sort().join('|')}`);
        }
        if (node.options !== undefined) for (const option of node.options.values()) visit(option);
      } else if (node.type === 'tag') {
        entries.add(`tag <${node.name}>`);
        visit(node.children);
      }
    }
  };
  visit(nodes);
  return [...entries].sort();
}

/**
 * The plural categories a message is missing for `locale`. Polish needs `few`
 * and `many` where German has only `one` and `other`; a translation that
 * copied the German shape would say "5 plik" instead of "5 plików".
 * Explicit `=n` keys are extras and never count as a category.
 */
export function pluralProblems(nodes, locale) {
  const problems = [];
  const visit = (list) => {
    for (const node of list) {
      if (node.type === 'tag') visit(node.children);
      if (node.type !== 'argument' || node.options === undefined) continue;
      problems.push(...missingCategories(node, locale));
      for (const option of node.options.values()) visit(option);
    }
  };
  visit(nodes);
  return problems;
}

function missingCategories(node, locale) {
  if (node.kind !== 'plural' && node.kind !== 'selectordinal') return [];
  const type = node.kind === 'plural' ? 'cardinal' : 'ordinal';
  return new Intl.PluralRules(locale, { type })
    .resolvedOptions()
    .pluralCategories.filter((category) => !node.options.has(category))
    .map((category) => `{${node.name}, ${node.kind}} lacks "${category}" for ${locale}`);
}

/**
 * Compares a translation with its source. Answers a list of problems, empty
 * when the translation is structurally faithful.
 */
export function compareIcu(source, translation, locale) {
  let sourceNodes;
  try {
    sourceNodes = parseIcu(source);
  } catch (error) {
    return [`the German source does not parse: ${error.message}`];
  }
  let translatedNodes;
  try {
    translatedNodes = parseIcu(translation);
  } catch (error) {
    return [`does not parse: ${error.message}`];
  }
  const expected = icuSignature(sourceNodes);
  const actual = icuSignature(translatedNodes);
  const problems = [];
  for (const entry of expected) {
    if (!actual.includes(entry)) problems.push(`missing ${entry}`);
  }
  for (const entry of actual) {
    if (!expected.includes(entry)) problems.push(`unexpected ${entry}`);
  }
  problems.push(...pluralProblems(translatedNodes, locale));
  return problems;
}

export { IcuSyntaxError };
