import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * WCAG 2.2 AA contrast for every text/background pair the UI uses (NFR-05.03). The colours are
 * read from the shared tokens file, so a token change that breaks contrast fails here.
 */
const css = readFileSync(join(import.meta.dirname, '..', 'src', 'renderer', 'theme', 'tokens.css'), 'utf8');

function token(name: string): string {
  const m = css.match(new RegExp(`--smoi-${name}:\\s*(#[0-9A-Fa-f]{6})`));
  if (!m) throw new Error(`No colour token --smoi-${name}`);
  return m[1];
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Every place text appears: [where, text token, background token]. All text is charcoal. */
const TEXT_PAIRS: [string, string, string][] = [
  ['panel header (SMOI, mood)', 'charcoal', 'green'],
  ['pink bubble, error banners', 'charcoal', 'pink'],
  ['dashboard page background', 'charcoal', 'cream'],
  ['blue bubble, info notes', 'charcoal', 'blue'],
  ['lavender bubble, hovered row, selected tab', 'charcoal', 'lavender'],
  ['panel body, cards, inputs, dismiss button', 'charcoal', 'panel'],
];

/** Non-text: focus outline and borders need 3:1 against what they sit on (WCAG 1.4.11). */
const NON_TEXT_PAIRS: [string, string, string][] = [
  ['focus outline on the page', 'charcoal', 'cream'],
  ['focus outline in the panel', 'charcoal', 'panel'],
  ['focus outline on a hovered row', 'charcoal', 'lavender'],
  ['borders on bubbles', 'charcoal', 'blue'],
];

describe('WCAG AA contrast of the design tokens', () => {
  it.each(TEXT_PAIRS)('%s: text passes 4.5:1', (_where, fg, bg) => {
    expect(contrast(token(fg), token(bg))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(NON_TEXT_PAIRS)('%s: passes 3:1', (_where, fg, bg) => {
    expect(contrast(token(fg), token(bg))).toBeGreaterThanOrEqual(3);
  });

  it('matches the published WCAG example (black on white is 21:1)', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
  });
});
