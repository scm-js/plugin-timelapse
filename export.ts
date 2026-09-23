/**
 * Turning a recording into a file: an animated GIF (gifenc) or a WebM video (the
 * browser's own MediaRecorder).
 *
 * The GIF uses one palette for the whole animation, taken from the first and last frames
 * together — StarCraft draws everything through a 256-colour palette already, so very
 * little is lost — and every frame after the first leaves the pixels that did not change
 * transparent over the one before. A timelapse changes a few tiles a frame, so those runs
 * of one index compress to almost nothing, which is what keeps a few hundred frames of a
 * big map a size worth sharing.
 */
import { applyPalette, GIFEncoder, quantize } from "gifenc";
import { seek, type Frame, type Scene } from "./recording";
import type { DrawOptions, Stage } from "./render";

export interface ExportPlan {
  frames: readonly Frame[];
  /** Which frames, in order. */
  indices: number[];
  fps: number;
  /** Seconds the finished map stays up before the animation starts again. */
  hold: number;
  options: Omit<DrawOptions, "highlight"> & { highlight: boolean };
}

export interface ExportProgress {
  (done: number, total: number): void;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Draw each planned frame onto the stage in turn, handing the stage to `each` after every one. */
async function play(stage: Stage, plan: ExportPlan, signal: AbortSignal, each: (k: number) => Promise<void> | void) {
  let scene: Scene | null = null;
  for (let k = 0; k < plan.indices.length; k++) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const i = plan.indices[k];
    scene = seek(plan.frames, i, scene);
    const frame = plan.frames[i];
    stage.draw(scene, { ...plan.options, highlight: plan.options.highlight ? frame.area : null });
    await each(k);
  }
}

/** GIF frame delays are in hundredths of a second, and most viewers treat anything under 2 as 10. */
export function gifDelay(fps: number): number {
  return Math.max(20, Math.round(100 / fps) * 10);
}

export async function exportGif(stage: Stage, plan: ExportPlan, progress: ExportProgress, signal: AbortSignal): Promise<Blob> {
  const { width, height } = stage.canvas;
  const ctx = stage.canvas.getContext("2d", { willReadFrequently: true })!;
  const pixels = () => ctx.getImageData(0, 0, width, height).data;

  // The palette: the first and last frames side by side, so both the empty map and the finished one are in it.
  let scene = seek(plan.frames, plan.indices[0], null);
  stage.draw(scene, { ...plan.options, highlight: null });
  const first = pixels().slice();
  scene = seek(plan.frames, plan.indices[plan.indices.length - 1], null);
  stage.draw(scene, { ...plan.options, highlight: null });
  const last = pixels();
  const both = new Uint8ClampedArray(first.length * 2);
  both.set(first);
  both.set(last, first.length);
  const palette = quantize(both, 255);
  const transparent = palette.length;
  palette.push([0, 0, 0]);

  const gif = GIFEncoder();
  const delay = gifDelay(plan.fps);
  let shown: Uint8Array | null = null;
  await play(stage, plan, signal, async (k) => {
    const index = applyPalette(pixels(), palette);
    const lastFrame = k === plan.indices.length - 1;
    const frameDelay = lastFrame ? Math.max(delay, Math.round(plan.hold * 100) * 10) : delay;
    if (shown) {
      // Pixels that match what is already on screen become transparent and show it through.
      const out = new Uint8Array(index.length);
      for (let p = 0; p < index.length; p++) {
        if (index[p] === shown[p]) out[p] = transparent;
        else { out[p] = index[p]; shown[p] = index[p]; }
      }
      gif.writeFrame(out, width, height, { transparent: true, transparentIndex: transparent, delay: frameDelay, dispose: 1 });
    } else {
      gif.writeFrame(index, width, height, { palette, delay: frameDelay, dispose: 1 });
      shown = index;
    }
    progress(k + 1, plan.indices.length);
    await tick();
  });
  gif.finish();
  return new Blob([gif.bytes() as Uint8Array<ArrayBuffer>], { type: "image/gif" });
}

/** The first video type this browser can record, or null. */
export function videoType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const type of ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

/**
 * The video is recorded as it plays, in real time: a canvas stream only carries frames as
 * they are painted, so a 300-frame export at 30 fps takes ten seconds plus the hold.
 */
export async function exportVideo(stage: Stage, plan: ExportPlan, progress: ExportProgress, signal: AbortSignal): Promise<Blob> {
  const type = videoType();
  if (!type) throw new Error("This browser cannot record video.");
  const stream = stage.canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
  recorder.start();
  const step = 1000 / plan.fps;
  let next = performance.now();
  try {
    await play(stage, plan, signal, async (k) => {
      track.requestFrame?.();
      progress(k + 1, plan.indices.length);
      next += step;
      await sleep(Math.max(0, next - performance.now()));
    });
    // Hold the last picture: paint it again now and then so the stream keeps time.
    const holdUntil = performance.now() + plan.hold * 1000;
    while (performance.now() < holdUntil) {
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      track.requestFrame?.();
      await sleep(Math.min(250, holdUntil - performance.now()));
    }
  } finally {
    recorder.stop();
    await stopped;
    for (const t of stream.getTracks()) t.stop();
  }
  return new Blob(chunks, { type: type.split(";")[0] });
}
