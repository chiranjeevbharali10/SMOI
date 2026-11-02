import { CELL } from './animations';

/**
 * Pixel-perfect sizing. The frog must cover a whole multiple of 64 *device* pixels, or Windows'
 * fractional scaling (125%, 150%) would stretch some art pixels more than others.
 *
 * At 100% the default is 128 device pixels (2x). At 125% that would be 160 device pixels, which
 * isn't a multiple of 64, so the nearest whole multiple is used instead (192 = 3x).
 */
export interface FrogSize {
  /** Art pixels per device pixel: the frog is CELL * multiple device pixels wide. */
  multiple: number;
  /** Canvas backing size in device pixels. */
  devicePixels: number;
  /** CSS size (device pixels / devicePixelRatio); may be fractional, which is fine for CSS. */
  cssPixels: number;
}

export function frogSize(devicePixelRatio: number, baseMultiple = 2): FrogSize {
  const multiple = Math.max(1, Math.round(baseMultiple * devicePixelRatio));
  const devicePixels = CELL * multiple;
  return { multiple, devicePixels, cssPixels: devicePixels / devicePixelRatio };
}

/** Window size in DIPs: the CSS size rounded up, so the canvas always fits. */
export function windowSize(devicePixelRatio: number, baseMultiple = 2): number {
  return Math.ceil(frogSize(devicePixelRatio, baseMultiple).cssPixels);
}
