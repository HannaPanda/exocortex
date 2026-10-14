import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * The type scale's own sizes (`--text-*` in `styles.css`). tailwind-merge only
 * knows Tailwind's built-in sizes, so it read `text-micro` as a colour and
 * dropped it next to `text-muted-foreground`: every section label passed
 * through `cn` rendered at 16 px instead of 11 (found in issue #195).
 */
export const TYPE_SCALE_SIZES = [
  'title',
  'section',
  'subsection',
  'body',
  'ui',
  'meta',
  'micro',
  'nano',
] as const;

const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: [...TYPE_SCALE_SIZES] }] } },
});

/** Merges class names and resolves conflicting Tailwind utilities. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
