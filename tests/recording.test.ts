import { describe, expect, it } from "vitest";
import { diffRect, extent, KEY_EVERY, Recorder, sameSnapshot, sampleFrames, seek, type Frame, type MapState } from "../recording";

function map(width = 8, height = 6): MapState & { tiles: Uint16Array; units: { unitId: number; owner: number; x: number; y: number }[] } {
  return { width, height, era: 0, tiles: new Uint16Array(width * height), units: [], doodads: [], sprites: [], locations: [] };
}

const edit = (label = "Paint") => ({ reason: "edit" as const, label, area: null });

describe("recorder", () => {
  it("keeps only the changed rectangle of tiles", () => {
    const m = map();
    const { recorder, frame } = Recorder.start(m, 0);
    expect(frame.key).toHaveLength(48);
    m.tiles[1 * 8 + 2] = 5;
    m.tiles[3 * 8 + 4] = 7;
    const f = recorder.take(m, edit(), 10)!;
    expect(f.key).toBeUndefined();
    expect(f.patch!.rect).toEqual({ x0: 2, y0: 1, x1: 5, y1: 4 });
    expect(f.patch!.tiles).toHaveLength(9);
    expect(f.objects).toBeUndefined();
  });

  it("takes no frame when nothing visible changed", () => {
    const m = map();
    const { recorder } = Recorder.start(m, 0);
    expect(recorder.take(m, { reason: "tables", label: "", area: null }, 5)).toBeNull();
    expect(recorder.count).toBe(1);
  });

  it("carries the object lists only on frames where they changed", () => {
    const m = map();
    const { recorder } = Recorder.start(m, 0);
    m.units.push({ unitId: 176, owner: 11, x: 48, y: 80 });
    const f = recorder.take(m, edit("Place"), 1)!;
    expect(Array.from(f.objects!.units)).toEqual([176, 11, 48, 80]);
    m.tiles[0] = 1;
    expect(recorder.take(m, edit(), 2)!.objects).toBeUndefined();
  });

  it("writes a key frame after a resize and every KEY_EVERY frames", () => {
    let m = map();
    const { recorder } = Recorder.start(m, 0);
    for (let i = 1; i < KEY_EVERY; i++) {
      m.tiles[i % m.tiles.length] = i;
      expect(recorder.take(m, edit(), i)!.key).toBeUndefined();
    }
    m.tiles[0] = 999;
    expect(recorder.take(m, edit(), KEY_EVERY)!.key).toBeDefined();
    m = { ...map(10, 6) };
    const f = recorder.take(m, { reason: "whole", label: "Resize map", area: null }, KEY_EVERY + 1)!;
    expect(f.width).toBe(10);
    expect(f.key).toHaveLength(60);
  });

  it("counts a long pause as a minute of editing", () => {
    const m = map();
    const { recorder } = Recorder.start(m, 0);
    m.tiles[0] = 1;
    recorder.take(m, edit(), 3_600_000);
    expect(recorder.elapsed()).toBe(60_000);
  });

  it("knows a map that is exactly where its recording left off", () => {
    const m = map();
    const { recorder, frame } = Recorder.start(m, 0);
    m.tiles[3] = 4;
    const frames = [frame, recorder.take(m, edit(), 1)!];
    const end = seek(frames, 1, null);
    const reopened = Recorder.start(m, 5).recorder;
    expect(sameSnapshot(end, reopened.state())).toBe(true);
    m.tiles[4] = 4;
    expect(sameSnapshot(end, Recorder.start(m, 6).recorder.state())).toBe(false);
  });
});

describe("playback", () => {
  function record(steps: number): { frames: Frame[]; states: Uint16Array[] } {
    const m = map(16, 16);
    const { recorder, frame } = Recorder.start(m, 0);
    const frames = [frame];
    const states = [m.tiles.slice()];
    for (let i = 1; i <= steps; i++) {
      m.tiles[(i * 37) % m.tiles.length] = i;
      if (i % 10 === 0) m.units.push({ unitId: i, owner: 0, x: i, y: i });
      frames.push(recorder.take(m, edit(`step ${i}`), i)!);
      states.push(m.tiles.slice());
    }
    return { frames, states };
  }

  it("puts back the map at any frame, forwards and backwards", () => {
    const { frames, states } = record(150);
    let scene = null;
    for (const i of [0, 1, 70, 71, 150, 3, 128, 64, 65, 149]) {
      scene = seek(frames, i, scene);
      expect(scene.index).toBe(i);
      expect(Array.from(scene.tiles)).toEqual(Array.from(states[i]));
    }
    expect(seek(frames, 150, null).objects.units.length).toBe(15 * 4);
    expect(seek(frames, 9, null).objects.units.length).toBe(0);
  });

  it("marks what changed since the scene was last drawn", () => {
    const { frames } = record(3);
    const scene = seek(frames, 0, null);
    expect(scene.dirty).toBe("all");
    scene.dirty = null;
    seek(frames, 2, scene);
    expect(scene.dirty).toEqual({ x0: 5, y0: 2, x1: 11, y1: 5 });
  });

  it("samples evenly, keeping the first and the last", () => {
    expect(sampleFrames(5, 10)).toEqual([0, 1, 2, 3, 4]);
    expect(sampleFrames(101, 5)).toEqual([0, 25, 50, 75, 100]);
    expect(sampleFrames(10, 1)).toEqual([9]);
    expect(sampleFrames(0, 5)).toEqual([]);
  });

  it("finds the largest size over a recording", () => {
    const { frames } = record(2);
    expect(extent([...frames, { ...frames[0], width: 20 }])).toEqual({ width: 20, height: 16 });
  });

  it("finds the rectangle two tile arrays differ in", () => {
    const a = new Uint16Array(12), b = a.slice();
    expect(diffRect(a, b, 4)).toBeNull();
    b[5] = 1;
    b[11] = 1;
    expect(diffRect(a, b, 4)).toEqual({ x0: 1, y0: 1, x1: 4, y1: 3 });
  });
});
