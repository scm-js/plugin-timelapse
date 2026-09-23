/**
 * Drawing a scene. The terrain is kept on a canvas of its own and only the rectangle that
 * changed since the last draw is drawn again — `graphics.renderClip` over a clip cut to
 * that rectangle — because a whole 256 × 256 map is 65 536 tile blits, fine for a seek and
 * too many for every frame of an export. The objects are few and move anywhere, so they
 * are drawn whole each time, as one clip with no tiles, over a copy of the terrain.
 */
import type { Clip, PluginApi, Rect, TilesetId } from "@scm-js/plugin-api";
import { cutRect, DOODAD_STRIDE, LOCATION_STRIDE, SPRITE_STRIDE, UNIT_STRIDE, type Scene } from "./recording";

export const TILESETS: TilesetId[] = ["badlands", "platform", "install", "ashworld", "jungle", "desert", "ice", "twilight"];

export interface DrawOptions {
  units: boolean;
  /** Doodad overlays and sprites. */
  sprites: boolean;
  locations: boolean;
  /** A box around where the frame's change fell. */
  highlight: Rect | null;
}

const BACKGROUND = "#000";
const HIGHLIGHT = "rgba(244, 208, 138, 0.95)";

function canvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, width);
  c.height = Math.max(1, height);
  return c;
}

/** Packed objects back into the records a clip carries — only the fields `renderClip` reads. */
function objectClip(scene: Scene, options: DrawOptions): Clip {
  const o = scene.objects;
  const units = [];
  if (options.units) for (let i = 0; i < o.units.length; i += UNIT_STRIDE) units.push({ unitId: o.units[i], owner: o.units[i + 1], x: o.units[i + 2], y: o.units[i + 3] });
  const doodads = [];
  const sprites = [];
  if (options.sprites) {
    for (let i = 0; i < o.doodads.length; i += DOODAD_STRIDE) doodads.push({ doodadId: o.doodads[i], owner: o.doodads[i + 1], x: o.doodads[i + 2], y: o.doodads[i + 3], disabled: 0 });
    for (let i = 0; i < o.sprites.length; i += SPRITE_STRIDE) sprites.push({ spriteId: o.sprites[i], flags: o.sprites[i + 1], owner: o.sprites[i + 2], x: o.sprites[i + 3], y: o.sprites[i + 4], unused: 0 });
  }
  const locations = [];
  if (options.locations) {
    for (let i = 0; i < o.locations.length; i += LOCATION_STRIDE) {
      locations.push({ left: o.locations[i], top: o.locations[i + 1], right: o.locations[i + 2], bottom: o.locations[i + 3], elevationFlags: 0, name: "" });
    }
  }
  // The records are partial on purpose: a clip here is only ever drawn, never pasted.
  return {
    width: scene.width, height: scene.height, era: scene.era, tiles: null, ground: null,
    units: units as unknown as Clip["units"], doodads: doodads as unknown as Clip["doodads"], sprites: sprites as unknown as Clip["sprites"],
    locations, fog: null,
  };
}

export class Stage {
  /** What is shown and exported: the whole extent, the map in its top-left corner, black around it. */
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private terrain: HTMLCanvasElement | null = null;
  private terrainEra = -1;

  private readonly api: PluginApi;
  readonly ppt: number;
  readonly extent: { width: number; height: number };

  /** `readback` for a stage whose pixels are read after every frame (the GIF export). */
  constructor(api: PluginApi, ppt: number, extent: { width: number; height: number }, readback = false) {
    this.api = api;
    this.ppt = ppt;
    this.extent = extent;
    this.canvas = canvas(extent.width * ppt, extent.height * ppt);
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: readback })!;
  }

  /** Fetch the tileset graphics a scene on `era` is drawn with. False when they were never extracted. */
  async prepare(era: number): Promise<boolean> {
    const id = TILESETS[era & 7];
    return (await this.api.tileset.load(id)) && (await this.api.graphics.load()).tileset;
  }

  /** Draw `scene` and clear its dirty mark. False when its tileset's graphics are not in memory. */
  draw(scene: Scene, options: DrawOptions): boolean {
    const { ppt } = this;
    const w = scene.width * ppt, h = scene.height * ppt;
    let full = scene.dirty === "all";
    if (!this.terrain || this.terrain.width !== w || this.terrain.height !== h || this.terrainEra !== scene.era) {
      this.terrain = canvas(w, h);
      this.terrainEra = scene.era;
      full = true;
    }
    const rect: Rect | null = full ? { x0: 0, y0: 0, x1: scene.width, y1: scene.height } : (scene.dirty as Rect | null);
    let ok = true;
    if (rect && rect.x1 > rect.x0 && rect.y1 > rect.y0) {
      const cells = cutRect(scene.tiles, scene.width, rect);
      const clip: Clip = {
        width: rect.x1 - rect.x0, height: rect.y1 - rect.y0, era: scene.era, tiles: cells, ground: cells,
        units: [], doodads: [], sprites: [], locations: [], fog: null,
      };
      const image = this.api.graphics.renderClip(clip, {
        pixelsPerTile: ppt, parts: { terrain: true, doodads: true, units: false, sprites: false, locations: false, fog: false },
      });
      const t = this.terrain.getContext("2d")!;
      t.fillStyle = BACKGROUND;
      t.fillRect(rect.x0 * ppt, rect.y0 * ppt, (rect.x1 - rect.x0) * ppt, (rect.y1 - rect.y0) * ppt);
      if (image) t.drawImage(image.image, rect.x0 * ppt, rect.y0 * ppt);
      else ok = false;
    }
    scene.dirty = ok ? null : "all";

    const ctx = this.ctx;
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.terrain, 0, 0);
    if (options.units || options.sprites || options.locations) {
      // Doodads are asked for so their overlay sprites are drawn; their tiles are already in the terrain.
      const objects = this.api.graphics.renderClip(objectClip(scene, options), {
        pixelsPerTile: ppt, parts: { terrain: false, doodads: options.sprites, units: options.units, sprites: options.sprites, locations: options.locations, fog: false },
      });
      if (objects) ctx.drawImage(objects.image, 0, 0);
    }
    const hl = options.highlight;
    if (hl) {
      const pad = Math.max(1, Math.round(ppt / 2));
      ctx.strokeStyle = HIGHLIGHT;
      ctx.lineWidth = Math.max(1, Math.round(ppt / 3));
      ctx.strokeRect(hl.x0 * ppt - pad + 0.5, hl.y0 * ppt - pad + 0.5, (hl.x1 - hl.x0) * ppt + 2 * pad - 1, (hl.y1 - hl.y0) * ppt + 2 * pad - 1);
    }
    return ok;
  }
}

/** Pixels per tile that make the longer side about `target` pixels, between 1 and `max`. */
export function fitPpt(extent: { width: number; height: number }, target: number, max = 8): number {
  return Math.max(1, Math.min(max, Math.floor(target / Math.max(1, extent.width, extent.height))));
}
