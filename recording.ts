/**
 * The recording model, with no editor and no DOM in it: what one frame holds, how a frame
 * is taken from the map as it stands after a commit, and how the map at any frame is put
 * back together for playback. `plugin.ts` feeds it; the tests drive it directly.
 *
 * A frame keeps only what changed. The tiles are the rectangle of MTXM cells that differ
 * from the frame before (found by comparing the whole map, which costs well under a
 * millisecond even at 256 × 256, so a commit's `area` is never trusted to be complete);
 * the objects are the whole lists, packed, and only on the frames where they changed.
 * Every `KEY_EVERY`th frame, and every frame where the map's size or tileset changed,
 * carries the whole tile array instead, so seeking never replays more than that many.
 */
import type { CommitReason, Rect } from "@scm-js/plugin-api";

/** A whole-map copy of the tiles every this many frames, so a seek replays at most this many patches. */
export const KEY_EVERY = 64;

/** Units `[unitId, owner, x, y]`, doodads `[doodadId, owner, x, y]`, sprites `[spriteId, flags, owner, x, y]`, locations `[left, top, right, bottom]` — flattened. */
export interface Objects {
  units: Int32Array;
  doodads: Int32Array;
  sprites: Int32Array;
  locations: Int32Array;
}

export const UNIT_STRIDE = 4;
export const DOODAD_STRIDE = 4;
export const SPRITE_STRIDE = 5;
export const LOCATION_STRIDE = 4;

export interface Frame {
  /** Milliseconds of editing before this frame (idle gaps longer than `IDLE_CAP` count as that). */
  t: number;
  reason: CommitReason | "start";
  /** The Edit menu's words for the change. */
  label: string;
  /** Where the editor said the change fell; drawn as the highlight. */
  area: Rect | null;
  width: number;
  height: number;
  /** Tileset index (ERA & 7), which is what a clip's `era` is. */
  era: number;
  /** The whole MTXM, on a key frame. */
  key?: Uint16Array;
  /** The changed rectangle's new MTXM cells, row by row. */
  patch?: { rect: Rect; tiles: Uint16Array };
  /** The object lists as they now stand, when any of them changed. */
  objects?: Objects;
}

/** The map as the recorder sees it: a live view, read and copied, never kept. */
export interface MapState {
  width: number;
  height: number;
  era: number;
  tiles: Uint16Array;
  units: readonly { unitId: number; owner: number; x: number; y: number }[];
  doodads: readonly { doodadId: number; owner: number; x: number; y: number }[];
  sprites: readonly { spriteId: number; flags: number; owner: number; x: number; y: number }[];
  locations: readonly { left: number; top: number; right: number; bottom: number }[];
}

/** A pause longer than this counts as this long, so "time spent" means editing, not a night's sleep. */
export const IDLE_CAP = 60_000;

export function packObjects(state: MapState): Objects {
  const units = new Int32Array(state.units.length * UNIT_STRIDE);
  state.units.forEach((u, i) => units.set([u.unitId, u.owner, u.x, u.y], i * UNIT_STRIDE));
  const doodads = new Int32Array(state.doodads.length * DOODAD_STRIDE);
  state.doodads.forEach((d, i) => doodads.set([d.doodadId, d.owner, d.x, d.y], i * DOODAD_STRIDE));
  const sprites = new Int32Array(state.sprites.length * SPRITE_STRIDE);
  state.sprites.forEach((s, i) => sprites.set([s.spriteId, s.flags, s.owner, s.x, s.y], i * SPRITE_STRIDE));
  // Unused slots are all zeroes, and Anywhere covers the whole map; neither is worth drawing.
  const used = state.locations.filter((l, i) => i !== 63 && (l.left | l.top | l.right | l.bottom) !== 0);
  const locations = new Int32Array(used.length * LOCATION_STRIDE);
  used.forEach((l, i) => locations.set([l.left, l.top, l.right, l.bottom], i * LOCATION_STRIDE));
  return { units, doodads, sprites, locations };
}

function sameArray(a: Int32Array, b: Int32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function sameObjects(a: Objects, b: Objects): boolean {
  return sameArray(a.units, b.units) && sameArray(a.doodads, b.doodads) && sameArray(a.sprites, b.sprites) && sameArray(a.locations, b.locations);
}

/** The bounding rectangle of the cells where `a` and `b` differ, or null when they are equal. Same size assumed. */
export function diffRect(a: Uint16Array, b: Uint16Array, width: number): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue;
    const x = i % width, y = (i - x) / width;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    y1 = y;
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

export function cutRect(tiles: Uint16Array, width: number, rect: Rect): Uint16Array {
  const w = rect.x1 - rect.x0;
  const out = new Uint16Array(w * (rect.y1 - rect.y0));
  for (let y = rect.y0; y < rect.y1; y++) out.set(tiles.subarray(y * width + rect.x0, y * width + rect.x1), (y - rect.y0) * w);
  return out;
}

export function pasteRect(tiles: Uint16Array, width: number, rect: Rect, cells: Uint16Array) {
  const w = rect.x1 - rect.x0;
  for (let y = rect.y0; y < rect.y1; y++) tiles.set(cells.subarray((y - rect.y0) * w, (y - rect.y0 + 1) * w), y * width + rect.x0);
}

/** The map as a frame shows it: what the recorder compares against, and what a scene is. */
export interface Snapshot {
  tiles: Uint16Array;
  objects: Objects;
  width: number;
  height: number;
  era: number;
}

/** Whether two snapshots show the same map — how a reopened file is known to be where its recording left off. */
export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return a.width === b.width && a.height === b.height && a.era === b.era && a.tiles.length === b.tiles.length
    && diffRect(a.tiles, b.tiles, a.width) === null && sameObjects(a.objects, b.objects);
}

/**
 * Takes frames. Made from the map as it stood before the first recorded change (or from
 * the last frame of a recording being continued), then handed the map after each commit.
 */
export class Recorder {
  private tiles: Uint16Array;
  private objects: Objects;
  private width: number;
  private height: number;
  private era: number;
  /** Frames taken so far, the start frame included — the next frame's index. */
  count: number;
  /** Editing time so far, and the clock reading it was last advanced at. */
  private t: number;
  private lastClock: number;

  constructor(start: Snapshot, count: number, t: number, clock: number) {
    this.tiles = start.tiles.slice();
    this.objects = start.objects;
    this.width = start.width;
    this.height = start.height;
    this.era = start.era;
    this.count = count;
    this.t = t;
    this.lastClock = clock;
  }

  /** A fresh recording's first frame: the map before anything was recorded. */
  static start(state: MapState, clock: number): { recorder: Recorder; frame: Frame } {
    const objects = packObjects(state);
    const recorder = new Recorder({ tiles: state.tiles, objects, width: state.width, height: state.height, era: state.era }, 1, 0, clock);
    const frame: Frame = {
      t: 0, reason: "start", label: "", area: null, width: state.width, height: state.height, era: state.era,
      key: state.tiles.slice(), objects,
    };
    return { recorder, frame };
  }

  /** Where the recorder has got to: the map as its last frame shows it. Not a copy — read it, do not keep it. */
  state(): Snapshot {
    return { tiles: this.tiles, objects: this.objects, width: this.width, height: this.height, era: this.era };
  }

  /** Editing time so far. */
  elapsed(): number {
    return this.t;
  }

  /**
   * The frame for the map after a commit, or null when nothing visible changed (a dialog's
   * tables, a location renamed, an edit undone by the next one before it was seen).
   */
  take(state: MapState, event: { reason: CommitReason; label: string; area: Rect | null }, clock: number): Frame | null {
    const resized = state.width !== this.width || state.height !== this.height || state.era !== this.era;
    const objects = packObjects(state);
    const objectsChanged = !sameObjects(objects, this.objects);
    const rect = resized ? null : diffRect(this.tiles, state.tiles, this.width);
    if (!resized && !rect && !objectsChanged) return null;

    this.t += Math.min(IDLE_CAP, Math.max(0, clock - this.lastClock));
    this.lastClock = clock;
    const frame: Frame = {
      t: this.t, reason: event.reason, label: event.label, area: event.area ? { ...event.area } : null,
      width: state.width, height: state.height, era: state.era,
    };
    if (resized || this.count % KEY_EVERY === 0) frame.key = state.tiles.slice();
    else if (rect) frame.patch = { rect, tiles: cutRect(state.tiles, state.width, rect) };
    if (objectsChanged || resized) frame.objects = objects;

    this.tiles = state.tiles.slice();
    this.objects = objects;
    this.width = state.width;
    this.height = state.height;
    this.era = state.era;
    this.count++;
    return frame;
  }

  /** Let the clock catch up without taking a frame — a map coming back to the front after a while behind. */
  touch(clock: number) {
    this.lastClock = clock;
  }
}

/* ── Playback ───────────────────────────────────────────── */

/** The map at one frame, as playback holds it. */
export interface Scene extends Snapshot {
  index: number;
  /** The tiles changed since the scene was last drawn, or `"all"`. Cleared by whoever draws. */
  dirty: Rect | "all" | null;
}

const EMPTY_OBJECTS: Objects = { units: new Int32Array(0), doodads: new Int32Array(0), sprites: new Int32Array(0), locations: new Int32Array(0) };

function union(a: Rect | "all" | null, b: Rect): Rect | "all" {
  if (a === "all") return a;
  if (!a) return { ...b };
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

/** Move `scene` forward by one frame (the frame after `scene.index`). */
export function applyFrame(scene: Scene, frame: Frame, index: number) {
  if (frame.key) {
    const resized = frame.width !== scene.width || frame.height !== scene.height || frame.era !== scene.era;
    scene.width = frame.width;
    scene.height = frame.height;
    scene.era = frame.era;
    if (resized || scene.tiles.length !== frame.key.length) {
      scene.tiles = frame.key.slice();
      scene.dirty = "all";
    } else {
      const rect = diffRect(scene.tiles, frame.key, frame.width);
      scene.tiles.set(frame.key);
      if (rect) scene.dirty = union(scene.dirty, rect);
    }
  } else if (frame.patch) {
    pasteRect(scene.tiles, scene.width, frame.patch.rect, frame.patch.tiles);
    scene.dirty = union(scene.dirty, frame.patch.rect);
  }
  if (frame.objects) scene.objects = frame.objects;
  scene.index = index;
}

/** The last key frame at or before `index`. The first frame is always one. */
export function keyBefore(frames: readonly Frame[], index: number): number {
  for (let i = Math.min(index, frames.length - 1); i > 0; i--) if (frames[i].key) return i;
  return 0;
}

/** The objects in force at `index`: the nearest frame at or before it that carries them. */
function objectsAt(frames: readonly Frame[], index: number): Objects {
  for (let i = index; i >= 0; i--) { const o = frames[i].objects; if (o) return o; }
  return EMPTY_OBJECTS;
}

/**
 * The scene at `index`. Reuses `from` when it is at or before `index` and past the last
 * key frame (playing forward, or a short scrub); otherwise starts again at that key frame.
 */
export function seek(frames: readonly Frame[], index: number, from: Scene | null): Scene {
  const target = Math.max(0, Math.min(index, frames.length - 1));
  const key = keyBefore(frames, target);
  let scene: Scene;
  if (from && from.index <= target && from.index >= key) {
    scene = from;
  } else {
    const k = frames[key];
    scene = { index: key, width: k.width, height: k.height, era: k.era, tiles: k.key!.slice(), objects: objectsAt(frames, key), dirty: "all" };
  }
  for (let i = scene.index + 1; i <= target; i++) applyFrame(scene, frames[i], i);
  return scene;
}

/** Which frames to show when a recording is to be at most `max` long: evenly spaced, first and last always in. */
export function sampleFrames(count: number, max: number): number[] {
  if (count <= 0) return [];
  if (max >= count) return Array.from({ length: count }, (_, i) => i);
  if (max < 2) return [count - 1];
  const out: number[] = [];
  for (let k = 0; k < max; k++) {
    const i = Math.round((k * (count - 1)) / (max - 1));
    if (out[out.length - 1] !== i) out.push(i);
  }
  return out;
}

/** The largest size the map takes anywhere in the recording, so every exported frame is the same size. */
export function extent(frames: readonly Frame[]): { width: number; height: number } {
  let width = 0, height = 0;
  for (const f of frames) { if (f.width > width) width = f.width; if (f.height > height) height = f.height; }
  return { width, height };
}

/** "3 h 12 min", "14 min", "40 s". */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Roughly what a frame costs to keep, for the recordings list. */
export function frameBytes(f: Frame): number {
  let n = 64;
  if (f.key) n += f.key.byteLength;
  if (f.patch) n += f.patch.tiles.byteLength;
  if (f.objects) n += f.objects.units.byteLength + f.objects.doodads.byteLength + f.objects.sprites.byteLength + f.objects.locations.byteLength;
  return n;
}
