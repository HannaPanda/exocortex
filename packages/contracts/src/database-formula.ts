/**
 * The formula language of a FORMULA database property (issue #76).
 *
 * Deliberately not JavaScript. A formula is stored as source text on the
 * property and has to be evaluated by the *query engine*, because a computed
 * column that filters and sorts has to exist inside the SQL that reads the
 * rows -- evaluating it in TypeScript afterwards would mean a column you can
 * see but not sort by. So the language is small enough to compile to a SQL
 * scalar expression, and total enough that compiling it cannot fail at
 * runtime: no loops, no assignment, no property access, a fixed function
 * table, and division guarded with `NULLIF`.
 *
 * This file is the front half: tokens, parse tree and type check. It is pure
 * and dependency-free on purpose, so `apps/web` can tell a person their
 * formula is wrong while they type it, and `packages/database` can compile the
 * very same tree the API validated. The SQL back half lives in
 * `packages/database/src/database-derived.ts`.
 */

export type FormulaValueType = 'number' | 'text' | 'boolean' | 'date';

export const FORMULA_BINARY_OPERATORS = [
  '+',
  '-',
  '*',
  '/',
  '%',
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'and',
  'or',
] as const;
export type FormulaBinaryOperator = (typeof FORMULA_BINARY_OPERATORS)[number];

export type FormulaNode =
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  | { kind: 'boolean'; value: boolean }
  /** `prop("...")`: a property of this database, by name or by id. */
  | { kind: 'property'; ref: string }
  | { kind: 'negate'; operand: FormulaNode }
  | { kind: 'binary'; operator: FormulaBinaryOperator; left: FormulaNode; right: FormulaNode }
  | { kind: 'call'; name: string; args: FormulaNode[] };

/** A formula that cannot be parsed or does not type-check. Carries a German message. */
export class FormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormulaError';
  }
}

// ---------------------------------------------------------------------------
// Function table
// ---------------------------------------------------------------------------

interface FormulaFunctionSpec {
  /** Parameter types in order. `'any'` is decided by the checker. */
  params: readonly (FormulaValueType | 'any')[];
  /** Further parameters of this type, repeated any number of times. */
  rest?: FormulaValueType;
  /** How many trailing entries of `params` may be left out. */
  optional?: number;
  /** A fixed type, or `'branches'` for a function returning its own arguments. */
  returns: FormulaValueType | 'branches';
  /** `if`: the two branches must agree, and their common type is the result. */
  branchesFrom?: readonly [number, number];
  /** Shown in the formula editor's help list. */
  hint: string;
}

export const FORMULA_FUNCTIONS: Record<string, FormulaFunctionSpec> = {
  if: {
    params: ['boolean', 'any', 'any'],
    returns: 'branches',
    branchesFrom: [1, 2],
    hint: 'if(Bedingung; dann; sonst)',
  },
  not: { params: ['boolean'], returns: 'boolean', hint: 'not(Bedingung)' },
  and: { params: ['boolean', 'boolean'], returns: 'boolean', hint: 'and(a; b)' },
  or: { params: ['boolean', 'boolean'], returns: 'boolean', hint: 'or(a; b)' },
  empty: { params: ['any'], returns: 'boolean', hint: 'empty(Wert): ist die Zelle leer?' },
  format: { params: ['any'], returns: 'text', hint: 'format(Wert): als Text' },
  concat: { params: ['text'], rest: 'text', returns: 'text', hint: 'concat(a; b; …)' },
  length: { params: ['text'], returns: 'number', hint: 'length(Text)' },
  upper: { params: ['text'], returns: 'text', hint: 'upper(Text)' },
  lower: { params: ['text'], returns: 'text', hint: 'lower(Text)' },
  contains: { params: ['text', 'text'], returns: 'boolean', hint: 'contains(Text; Teil)' },
  abs: { params: ['number'], returns: 'number', hint: 'abs(Zahl)' },
  floor: { params: ['number'], returns: 'number', hint: 'floor(Zahl)' },
  ceil: { params: ['number'], returns: 'number', hint: 'ceil(Zahl)' },
  round: {
    params: ['number', 'number'],
    optional: 1,
    returns: 'number',
    hint: 'round(Zahl; Nachkommastellen)',
  },
  min: { params: ['number'], rest: 'number', returns: 'number', hint: 'min(a; b; …)' },
  max: { params: ['number'], rest: 'number', returns: 'number', hint: 'max(a; b; …)' },
  now: { params: [], returns: 'date', hint: 'now(): jetzt' },
  dateAdd: { params: ['date', 'number'], returns: 'date', hint: 'dateAdd(Datum; Tage)' },
  dateDiffDays: {
    params: ['date', 'date'],
    returns: 'number',
    hint: 'dateDiffDays(von; bis): Tage dazwischen',
  },
  year: { params: ['date'], returns: 'number', hint: 'year(Datum)' },
  month: { params: ['date'], returns: 'number', hint: 'month(Datum)' },
  day: { params: ['date'], returns: 'number', hint: 'day(Datum)' },
};

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenType = 'number' | 'string' | 'identifier' | 'operator' | 'punct';

export interface FormulaToken {
  type: TokenType;
  value: string;
  /** Character offset of the first character, so the editor can point at the mistake. */
  at: number;
  /** Character offset just past the last character. */
  end: number;
}

type Token = FormulaToken;

const TWO_CHAR_OPERATORS = new Set(['==', '!=', '<=', '>=']);
const ONE_CHAR_OPERATORS = new Set(['+', '-', '*', '/', '%', '<', '>']);
const PUNCTUATION = new Set(['(', ')', ',', ';']);

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_]/.test(char);
}

function readString(source: string, start: number): Token {
  const quote = source[start];
  let index = start + 1;
  let value = '';
  while (index < source.length && source[index] !== quote) {
    if (source[index] === '\\' && index + 1 < source.length) {
      value += source[index + 1];
      index += 2;
      continue;
    }
    value += source[index];
    index += 1;
  }
  if (index >= source.length) {
    throw new FormulaError(`Zeichenkette ab Position ${start} wird nicht geschlossen`);
  }
  return { type: 'string', value, at: start, end: index + 1 };
}

function readNumber(source: string, start: number): Token {
  let index = start;
  while (index < source.length && (isDigit(source[index] ?? '') || source[index] === '.')) {
    index += 1;
  }
  const raw = source.slice(start, index);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new FormulaError(`Keine gültige Zahl: ${raw}`);
  return { type: 'number', value: raw, at: start, end: index };
}

function readIdentifier(source: string, start: number): Token {
  let index = start;
  while (index < source.length && /[A-Za-z0-9_]/.test(source[index] ?? '')) index += 1;
  return { type: 'identifier', value: source.slice(start, index), at: start, end: index };
}

export function tokenizeFormula(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? '';
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    const at = index;
    if (char === '"' || char === "'") {
      const token = readString(source, index);
      tokens.push(token);
      index = token.end;
    } else if (isDigit(char)) {
      const token = readNumber(source, index);
      tokens.push(token);
      index = token.end;
    } else if (isIdentifierStart(char)) {
      const token = readIdentifier(source, index);
      tokens.push(token);
      index = token.end;
    } else if (TWO_CHAR_OPERATORS.has(source.slice(index, index + 2))) {
      tokens.push({ type: 'operator', value: source.slice(index, index + 2), at, end: at + 2 });
      index += 2;
    } else if (ONE_CHAR_OPERATORS.has(char)) {
      tokens.push({ type: 'operator', value: char, at, end: at + 1 });
      index += 1;
    } else if (PUNCTUATION.has(char)) {
      tokens.push({ type: 'punct', value: char, at, end: at + 1 });
      index += 1;
    } else {
      throw new FormulaError(`Unerwartetes Zeichen "${char}" an Position ${index}`);
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser: precedence climbing over the operator table above
// ---------------------------------------------------------------------------

/** Lowest binds loosest. Same shape as the table in docs/database-views.md. */
const PRECEDENCE: Record<string, number> = {
  or: 1,
  and: 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};

/** Guard against a pathological nesting depth rather than blowing the stack. */
const MAX_FORMULA_DEPTH = 32;

class FormulaParser {
  private position = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parse(): FormulaNode {
    const node = this.parseExpression(0, 0);
    const leftover = this.tokens[this.position];
    if (leftover !== undefined) {
      throw new FormulaError(`Unerwartetes "${leftover.value}" an Position ${leftover.at}`);
    }
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private take(): Token {
    const token = this.tokens[this.position];
    if (token === undefined) throw new FormulaError('Die Formel endet zu früh');
    this.position += 1;
    return token;
  }

  private expect(value: string): void {
    const token = this.take();
    if (token.value !== value) {
      throw new FormulaError(`"${value}" erwartet, "${token.value}" gefunden`);
    }
  }

  private binaryOperatorAhead(): FormulaBinaryOperator | null {
    const token = this.peek();
    if (token === undefined) return null;
    const isOperator = token.type === 'operator';
    const isWordOperator =
      token.type === 'identifier' && (token.value === 'and' || token.value === 'or');
    if (!isOperator && !isWordOperator) return null;
    return PRECEDENCE[token.value] === undefined ? null : (token.value as FormulaBinaryOperator);
  }

  private parseExpression(minPrecedence: number, depth: number): FormulaNode {
    if (depth > MAX_FORMULA_DEPTH) throw new FormulaError('Die Formel ist zu tief verschachtelt');
    let left = this.parseUnary(depth);
    for (;;) {
      const operator = this.binaryOperatorAhead();
      if (operator === null) break;
      const precedence = PRECEDENCE[operator] ?? 0;
      if (precedence < minPrecedence) break;
      this.position += 1;
      // Left-associative: the right side may only take strictly tighter operators.
      const right = this.parseExpression(precedence + 1, depth + 1);
      left = { kind: 'binary', operator, left, right };
    }
    return left;
  }

  private parseUnary(depth: number): FormulaNode {
    const token = this.peek();
    if (token?.type === 'operator' && token.value === '-') {
      this.position += 1;
      return { kind: 'negate', operand: this.parseUnary(depth + 1) };
    }
    return this.parsePrimary(depth);
  }

  private parsePrimary(depth: number): FormulaNode {
    if (depth > MAX_FORMULA_DEPTH) throw new FormulaError('Die Formel ist zu tief verschachtelt');
    const token = this.take();
    if (token.type === 'number') return { kind: 'number', value: Number(token.value) };
    if (token.type === 'string') return { kind: 'text', value: token.value };
    if (token.value === '(') {
      const inner = this.parseExpression(0, depth + 1);
      this.expect(')');
      return inner;
    }
    if (token.type !== 'identifier') {
      throw new FormulaError(`Unerwartetes "${token.value}" an Position ${token.at}`);
    }
    if (token.value === 'true') return { kind: 'boolean', value: true };
    if (token.value === 'false') return { kind: 'boolean', value: false };
    return this.parseCall(token, depth);
  }

  private parseCall(name: Token, depth: number): FormulaNode {
    if (this.peek()?.value !== '(') {
      throw new FormulaError(
        `"${name.value}" ist keine Funktion; eine Spalte schreibst du als prop("Name")`,
      );
    }
    this.expect('(');
    const args: FormulaNode[] = [];
    if (this.peek()?.value !== ')') {
      for (;;) {
        args.push(this.parseExpression(0, depth + 1));
        const next = this.peek();
        // Both separators are accepted: a German locale writes `;`, every
        // formula pasted from elsewhere writes `,`.
        if (next?.value === ',' || next?.value === ';') {
          this.position += 1;
          continue;
        }
        break;
      }
    }
    this.expect(')');

    if (name.value === 'prop') return toPropertyNode(args, name.at);
    if (FORMULA_FUNCTIONS[name.value] === undefined) {
      throw new FormulaError(`Unbekannte Funktion "${name.value}"`);
    }
    return { kind: 'call', name: name.value, args };
  }
}

function toPropertyNode(args: readonly FormulaNode[], at: number): FormulaNode {
  const first = args[0];
  if (args.length !== 1 || first === undefined || first.kind !== 'text') {
    throw new FormulaError(
      `prop() erwartet genau einen Spaltennamen in Anführungszeichen (Position ${at})`,
    );
  }
  return { kind: 'property', ref: first.value };
}

export function parseFormula(source: string): FormulaNode {
  const trimmed = source.trim();
  if (trimmed.length === 0) throw new FormulaError('Die Formel ist leer');
  return new FormulaParser(tokenizeFormula(trimmed)).parse();
}

// ---------------------------------------------------------------------------
// Type check
// ---------------------------------------------------------------------------

/**
 * What a `prop("...")` reference resolves to. Returning `null` means "no such
 * column here", which is a formula error rather than a null value: a typo in a
 * column name has to be told to the person, not silently computed as empty.
 */
export type FormulaPropertyResolver = (ref: string) => FormulaValueType | null;

const COMPARABLE: Record<FormulaBinaryOperator, readonly FormulaValueType[] | 'same'> = {
  '+': ['number'],
  '-': ['number'],
  '*': ['number'],
  '/': ['number'],
  '%': ['number'],
  '<': ['number', 'date', 'text'],
  '<=': ['number', 'date', 'text'],
  '>': ['number', 'date', 'text'],
  '>=': ['number', 'date', 'text'],
  '==': 'same',
  '!=': 'same',
  and: ['boolean'],
  or: ['boolean'],
};

const ARITHMETIC = new Set<FormulaBinaryOperator>(['+', '-', '*', '/', '%']);
const LOGICAL = new Set<FormulaBinaryOperator>(['and', 'or']);

function checkBinary(
  operator: FormulaBinaryOperator,
  left: FormulaValueType,
  right: FormulaValueType,
): FormulaValueType {
  if (left !== right) {
    throw new FormulaError(
      `"${operator}" vergleicht ${left} mit ${right}; die Typen müssen gleich sein`,
    );
  }
  const allowed = COMPARABLE[operator];
  if (allowed !== 'same' && !allowed.includes(left)) {
    throw new FormulaError(`"${operator}" ist auf ${left} nicht anwendbar`);
  }
  if (ARITHMETIC.has(operator)) return 'number';
  if (LOGICAL.has(operator)) return 'boolean';
  return 'boolean';
}

function checkArity(name: string, spec: FormulaFunctionSpec, count: number): void {
  const required = spec.params.length - (spec.optional ?? 0);
  const maximum = spec.rest === undefined ? spec.params.length : Number.POSITIVE_INFINITY;
  if (count < required || count > maximum) {
    throw new FormulaError(`${name}() erwartet ${spec.hint}`);
  }
}

function checkCall(name: string, args: readonly FormulaValueType[]): FormulaValueType {
  const spec = FORMULA_FUNCTIONS[name];
  if (spec === undefined) throw new FormulaError(`Unbekannte Funktion "${name}"`);
  checkArity(name, spec, args.length);

  args.forEach((actual, index) => {
    const expected = spec.params[index] ?? spec.rest;
    if (expected === undefined || expected === 'any') return;
    if (actual !== expected) {
      throw new FormulaError(
        `${name}(): Argument ${index + 1} ist ${actual}, erwartet wird ${expected}`,
      );
    }
  });

  if (spec.returns !== 'branches') return spec.returns;
  const [first, second] = spec.branchesFrom ?? [0, 0];
  const left = args[first];
  const right = args[second];
  if (left === undefined || right === undefined || left !== right) {
    throw new FormulaError(`${name}(): beide Zweige müssen denselben Typ haben`);
  }
  return left;
}

/**
 * Types a parsed formula, which is also what proves it can be compiled to SQL.
 * Throws `FormulaError` with a German message the property editor shows as is.
 */
export function analyzeFormula(
  node: FormulaNode,
  resolve: FormulaPropertyResolver,
): FormulaValueType {
  switch (node.kind) {
    case 'number':
      return 'number';
    case 'text':
      return 'text';
    case 'boolean':
      return 'boolean';
    case 'property': {
      const type = resolve(node.ref);
      if (type === null) throw new FormulaError(`Unbekannte Spalte: ${node.ref}`);
      return type;
    }
    case 'negate': {
      const inner = analyzeFormula(node.operand, resolve);
      if (inner !== 'number')
        throw new FormulaError(`Das Minuszeichen erwartet eine Zahl, nicht ${inner}`);
      return 'number';
    }
    case 'binary':
      return checkBinary(
        node.operator,
        analyzeFormula(node.left, resolve),
        analyzeFormula(node.right, resolve),
      );
    case 'call':
      return checkCall(
        node.name,
        node.args.map((argument) => analyzeFormula(argument, resolve)),
      );
  }
}

/** Parse and type in one step, the way every caller outside the tests wants it. */
export function compileFormulaSource(
  source: string,
  resolve: FormulaPropertyResolver,
): { node: FormulaNode; type: FormulaValueType } {
  const node = parseFormula(source);
  return { node, type: analyzeFormula(node, resolve) };
}

/** Every `prop("...")` a formula reads, for cycle detection and dependency checks. */
export function formulaPropertyRefs(node: FormulaNode): string[] {
  switch (node.kind) {
    case 'property':
      return [node.ref];
    case 'negate':
      return formulaPropertyRefs(node.operand);
    case 'binary':
      return [...formulaPropertyRefs(node.left), ...formulaPropertyRefs(node.right)];
    case 'call':
      return node.args.flatMap(formulaPropertyRefs);
    default:
      return [];
  }
}

/**
 * Rewrites every `prop("from")` in a formula to `prop("to")`.
 *
 * Renaming a column would otherwise break every formula that names it, and
 * "you cannot rename this column because a formula mentions it" is a rule
 * nobody would accept. Driven by the tokenizer rather than a text replace, so
 * a column called `Summe` cannot rewrite the string `"Summe pro Monat"` that
 * happens to sit in a `concat`.
 */
export function renameFormulaProperty(source: string, from: string, to: string): string {
  const tokens = tokenizeFormula(source);
  const spans: { at: number; end: number }[] = [];
  tokens.forEach((token, index) => {
    if (token.type !== 'identifier' || token.value !== 'prop') return;
    const open = tokens[index + 1];
    const argument = tokens[index + 2];
    if (open?.value !== '(' || argument?.type !== 'string' || argument.value !== from) return;
    spans.push({ at: argument.at, end: argument.end });
  });

  let result = source;
  for (const span of spans.reverse()) {
    result = result.slice(0, span.at) + JSON.stringify(to) + result.slice(span.end);
  }
  return result;
}
