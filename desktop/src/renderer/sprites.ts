import { ANIMATIONS, CELL, STATES, type FrogState } from '../shared/animations';

/** A loaded strip plus, per frame, which of its 64x64 art pixels are opaque (for click-through). */
export interface Sprite {
  image: HTMLImageElement;
  frames: number;
  /** opaque[frame][y * 64 + x] */
  opaque: Uint8Array[];
}

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${src}`));
    img.src = src;
  });
}

export async function loadSprites(): Promise<Record<FrogState, Sprite>> {
  const entries = await Promise.all(STATES.map(async (state) => {
    const image = await load(`./sprites/${state}.png`);
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, image.width, image.height).data;
    const frames = ANIMATIONS[state].frames.length;
    const opaque = Array.from({ length: frames }, (_, f) => {
      const mask = new Uint8Array(CELL * CELL);
      for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
          mask[y * CELL + x] = data[(y * image.width + f * CELL + x) * 4 + 3] > 0 ? 1 : 0;
        }
      }
      return mask;
    });
    return [state, { image, frames, opaque }] as const;
  }));
  return Object.fromEntries(entries) as Record<FrogState, Sprite>;
}

/**
 * Draws one frame at a whole-number scale with no smoothing, so every art pixel becomes an
 * exact square of device pixels. `mirrored` flips it horizontally (walking left).
 */
export function drawFrame(ctx: CanvasRenderingContext2D, sprite: Sprite, frame: number, multiple: number, mirrored: boolean) {
  const size = CELL * multiple;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.save();
  if (mirrored) {
    ctx.translate(size, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(sprite.image, frame * CELL, 0, CELL, CELL, 0, 0, size, size);
  ctx.restore();
}
