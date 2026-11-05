import { CELL } from '../shared/animations';
import type { CompanionInfo, Pose } from '../shared/companions';

/**
 * A companion's poses, ready to draw: each pose's sheet image, plus per frame which of its 64x64
 * art pixels are opaque (for click-through: clicks on transparent pixels pass to the desktop).
 */
export interface Sprite {
  image: HTMLImageElement;
  pose: Pose;
  /** opaque[frame][y * 64 + x] */
  opaque: Uint8Array[];
}

export type SpriteSet = Record<string, Sprite>;

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${src}`));
    img.src = src;
  });
}

/** Loads every pose of a companion. Sheets are read once each, however many poses share them. */
export async function loadSprites(c: Pick<CompanionInfo, 'id' | 'poses'>): Promise<SpriteSet> {
  const sheets = new Map<string, Promise<{ image: HTMLImageElement; data: Uint8ClampedArray }>>();
  const sheet = (file: string) => {
    if (!sheets.has(file)) {
      sheets.set(file, load(`./companions/${c.id}/${file}`).then((image) => {
        const canvas = new OffscreenCanvas(image.width, image.height);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(image, 0, 0);
        return { image, data: ctx.getImageData(0, 0, image.width, image.height).data };
      }));
    }
    return sheets.get(file)!;
  };
  const entries = await Promise.all(Object.entries(c.poses).map(async ([name, pose]) => {
    const { image, data } = await sheet(pose.sheet);
    // Rows are left-aligned: only the manifest's frame count is read; empty cells after it are ignored.
    const opaque = pose.frames.map((_, f) => {
      const mask = new Uint8Array(CELL * CELL);
      for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
          mask[y * CELL + x] = data[((pose.row * CELL + y) * image.width + f * CELL + x) * 4 + 3] > 0 ? 1 : 0;
        }
      }
      return mask;
    });
    return [name, { image, pose, opaque }] as const;
  }));
  return Object.fromEntries(entries);
}

/**
 * Draws one frame at a whole-number scale with no smoothing, so every art pixel becomes an exact
 * square of device pixels. The whole 64x64 cell is drawn at the canvas origin, so a companion's
 * position never depends on where its visible pixels are (WISP hovers, NOX hangs from the top).
 * `mirrored` flips the frame horizontally (walking left); only the frame, never any text.
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
  ctx.drawImage(sprite.image, frame * CELL, sprite.pose.row * CELL, CELL, CELL, 0, 0, size, size);
  ctx.restore();
}
