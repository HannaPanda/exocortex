/**
 * Shared output for the deploy gates.
 *
 * Every gate reports the same way -- what is red, which places, and one
 * sentence on how to fix it -- so a red build reads the same no matter which
 * gate produced it. Deliberately tiny and dependency-free: a gate has to stay
 * runnable on its own with `node scripts/check-<name>.mjs`, before `pnpm
 * install` has ever run and without a build step.
 */

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const wrap = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);

export const c = {
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  cyan: wrap('36'),
  bold: wrap('1'),
  dim: wrap('2'),
};

/** Names the gate that is about to run. One per script, printed first. */
export function step(message) {
  console.log(`${c.cyan('▸')} ${c.bold(message)}`);
}

/** The gate passed. */
export function ok(message) {
  console.log(`${c.green('✓')} ${message}`);
}

export function warn(message) {
  console.warn(`${c.yellow('⚠')} ${message}`);
}

/** A detail line under a step: counts, scope, what was skipped and why. */
export function info(message) {
  console.log(`  ${c.dim(message)}`);
}

/**
 * Reports the gate as red and exits with 1.
 *
 * `details` are the individual findings, one line each, and `hint` is the
 * single sentence that says what to do about them. A gate has no bypass flag,
 * so the hint is the only way out and is not optional in spirit.
 *
 * Findings are capped: a gate that has just been introduced can find hundreds,
 * and a wall of them buries the hint that explains all of them at once.
 */
export function fail(title, details = [], hint) {
  const shown = details.slice(0, 25);
  console.error(`${c.red('✗')} ${c.bold(title)}`);
  for (const detail of shown) console.error(`    ${c.red('•')} ${detail}`);
  if (details.length > shown.length) {
    console.error(`    ${c.dim(`… and ${details.length - shown.length} more`)}`);
  }
  if (hint !== undefined) console.error(`  ${c.yellow('→')} ${hint}`);
  process.exit(1);
}
