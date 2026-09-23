/**
 * Timelapse — a plugin for the scmJS map editor (https://github.com/scm-js/scm-js).
 *
 * Records the map while you build it, one frame per change, and plays the recording back
 * as an animation you can export as a GIF or a WebM video. The recording lives in the
 * browser (IndexedDB), and opening the same file again carries on the same recording, so
 * a map built over a week plays back as one film.
 *
 * `recording.ts` is the model (frames, diffs, seeking; it has the tests), `library.ts` the
 * storage, `render.ts` the drawing through `graphics.renderClip`, `export.ts` the two file
 * formats. This file listens to the editor and puts the panel, the dialog, the status
 * cell and the preferences page on the screen. The editor is reached through the
 * `"commit"` event (one call per change, with its label and where it fell),
 * `document.scenario()` read after each one, and `tileset.load(id)` for recordings of
 * maps on another tileset than the open one.
 */
import type { CommitEvent, DocumentEvent, PanelHandle, PluginApi, StatusItemHandle } from "@scm-js/plugin-api";
import { exportGif, exportVideo, gifDelay, videoType, type ExportPlan } from "./export";
import { KO } from "./ko";
import { Library, newId, type RecordingInfo } from "./library";
import {
  extent, formatBytes, formatDuration, frameBytes, Recorder, sameSnapshot, sampleFrames, seek, type Frame, type MapState, type Scene,
} from "./recording";
import { fitPpt, Stage } from "./render";

/* ── DOM ────────────────────────────────────────────────── */

/** The transport icons, drawn rather than typed: the editor's font has no media symbols. */
const ICONS = {
  first: '<path d="M3 2h1.6v10H3zM12 2v10L5.5 7z"/>',
  last: '<path d="M9.4 2H11v10H9.4zM2 2v10l6.5-5z"/>',
  play: '<path d="M3.5 2v10l8.5-5z"/>',
  pause: '<path d="M3 2h3v10H3zM8 2h3v10H8z"/>',
};

function icon(name: keyof typeof ICONS): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 14 14");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name];
  return svg;
}

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "className") el.className = String(v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k in el && typeof v !== "string") (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}

const STYLE = `
.tl { display: flex; flex-direction: column; flex: 1; min-height: 0; gap: 6px; font-size: var(--fs-sm, 11.5px); }
.tl .tl-bar { display: flex; gap: 4px; align-items: center; }
.tl .tl-bar .select { flex: 1; min-width: 0; }
.tl .tl-stage { position: relative; flex: 1; min-height: 160px; display: flex; align-items: center; justify-content: center; background: #000; border: 1px solid var(--border, #2c3341); border-radius: var(--radius, 3px); overflow: hidden; }
.tl .tl-stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
.tl .tl-empty { padding: 18px; text-align: center; color: var(--text-faint, #5d6675); line-height: 1.5; max-width: 320px; }
.tl .tl-controls { display: flex; gap: 6px; align-items: center; }
.tl .tl-controls input[type=range] { flex: 1; min-width: 0; accent-color: var(--teal, #4fd1c5); }
.tl .tl-controls .tl-count { color: var(--text-dim, #99a2b3); font-variant-numeric: tabular-nums; white-space: nowrap; }
.tl .tl-controls .btn { min-width: 30px; padding: 0 6px; }
.tl .tl-caption { display: flex; gap: 8px; min-height: 16px; color: var(--text-dim, #99a2b3); white-space: nowrap; overflow: hidden; }
.tl .tl-caption b { color: var(--text, #dde2ea); font-weight: normal; overflow: hidden; text-overflow: ellipsis; }
.tl .tl-caption .grow { flex: 1; }
.tl .tl-opts { display: flex; flex-wrap: wrap; gap: 2px 12px; align-items: center; }
.tl .tl-opts .check { height: 18px; }
.tl .tl-opts .select { width: auto; }
.tl .tl-foot { display: flex; gap: 4px; align-items: center; }
.tl .tl-foot .grow { flex: 1; }
.tl .tl-foot .btn { padding: 0 8px; }
.tl .tl-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #e05252; margin-right: 5px; vertical-align: 0; }
.tl-dlg { display: flex; flex-direction: column; gap: 10px; }
.tl-dlg .tl-estimate { color: var(--text-dim, #99a2b3); }
`;

/* ── Settings ───────────────────────────────────────────── */

interface Settings {
  /** Record every map as it is edited, without being asked. */
  auto: boolean;
  /** How many recordings to keep; the oldest go when a new one starts. */
  keep: number;
  fps: number;
  units: boolean;
  sprites: boolean;
  locations: boolean;
  highlight: boolean;
  exportFormat: "gif" | "video";
  /** Pixels per tile in the file; 0 picks one for about 512 pixels across. */
  exportPpt: number;
  exportFps: number;
  exportMax: number;
  exportHold: number;
  open: boolean;
}

const DEFAULTS: Settings = {
  auto: true, keep: 30, fps: 12, units: true, sprites: true, locations: false, highlight: true,
  exportFormat: "gif", exportPpt: 0, exportFps: 12, exportMax: 300, exportHold: 2, open: false,
};

/* ── The recordings being taken ─────────────────────────── */

/** A map that is being recorded. */
interface Live {
  doc: number;
  info: RecordingInfo;
  recorder: Recorder;
  /** Every frame, the start frame included, for playback while it is still going. */
  frames: Frame[];
  paused: boolean;
}

/**
 * A map that is open but not yet recorded: the map as it stood when it came to the front,
 * ready to be the first frame, and — when its file has a recording that ends exactly
 * where the map now is — that recording to carry on instead.
 */
interface Pending {
  start: { recorder: Recorder; frame: Frame };
  continueWith: { info: RecordingInfo; frames: Frame[] } | null;
}

function mapState(api: PluginApi): MapState | null {
  const scn = api.document.scenario();
  if (!scn) return null;
  return {
    width: scn.width, height: scn.height, era: scn.era & 7, tiles: scn.tiles,
    units: scn.units, doodads: scn.doodads, sprites: scn.sprites, locations: scn.locations,
  };
}

class Timelapse {
  settings: Settings;
  library: Library | null = null;
  /** Whether IndexedDB refused; recordings are then kept for this session only. */
  memoryOnly = false;
  readonly live = new Map<number, Live>();
  private readonly pending = new Map<number, Pending>();
  /** The recordings' summaries, newest first, kept in step with the library. */
  infos: RecordingInfo[] = [];
  private status: StatusItemHandle | null = null;
  panel: PanelHandle | null = null;
  player: Player | null = null;
  private readonly style: HTMLStyleElement;

  readonly api: PluginApi;

  constructor(api: PluginApi) {
    this.api = api;
    this.settings = { ...DEFAULTS, ...api.storage.get<Partial<Settings>>("settings", {}) };
    this.style = h("style", null, STYLE);
    document.head.append(this.style);
  }

  t = (text: string, params?: Record<string, string | number>) => this.api.i18n.t(text, params);

  save(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch };
    this.api.storage.set("settings", this.settings);
  }

  async init() {
    this.library = await Library.open();
    this.memoryOnly = this.library === null;
    if (this.library) {
      try { this.infos = await this.library.list(); } catch (err) { this.api.log("Could not read the recordings", err); }
    }
    const id = this.api.document.id();
    if (id !== null) this.prepare(id);
    this.player?.refreshList();
  }

  /* ── Following the editor ── */

  /** Note the map in front as it stands, so its first change has a frame to start from. */
  prepare(doc: number) {
    const state = mapState(this.api);
    if (!state || this.live.has(doc)) return;
    const pending: Pending = { start: Recorder.start(state, Date.now()), continueWith: null };
    this.pending.set(doc, pending);
    const fileName = this.api.document.info()?.fileName ?? null;
    if (fileName && this.library) void this.findContinuation(doc, pending, fileName);
  }

  /** The newest recording of this file, if the map is exactly as it left it. */
  private async findContinuation(doc: number, pending: Pending, fileName: string) {
    const info = this.infos.find((i) => i.fileName === fileName && ![...this.live.values()].some((l) => l.info.id === i.id));
    if (!info || !this.library) return;
    try {
      const frames = await this.library.frames(info.id);
      if (frames.length === 0 || this.pending.get(doc) !== pending) return;
      const end = seek(frames, frames.length - 1, null);
      if (sameSnapshot(end, pending.start.recorder.state())) pending.continueWith = { info, frames };
    } catch (err) {
      this.api.log("Could not read a recording", err);
    }
  }

  onDocument(e: DocumentEvent) {
    const open = new Set(this.api.document.list().map((d) => d.id));
    for (const [doc, live] of this.live) if (!open.has(doc)) { this.live.delete(doc); if (this.player?.showing === live.info.id) this.player.refreshList(); }
    for (const doc of [...this.pending.keys()]) if (!open.has(doc)) this.pending.delete(doc);
    if (e.id !== null) {
      const live = this.live.get(e.id);
      if (live) live.recorder.touch(Date.now());
      // A map read again (a plugin's repair, a raw section edit) before anything was recorded starts from what it is now.
      else if (e.reason !== "switch" || !this.pending.has(e.id)) this.prepare(e.id);
    }
    this.updateStatus();
    this.player?.followDocument();
  }

  onFile() {
    const doc = this.api.document.id();
    const live = doc === null ? undefined : this.live.get(doc);
    const fileName = this.api.document.info()?.fileName ?? null;
    if (live && fileName && live.info.fileName !== fileName) {
      live.info.fileName = fileName;
      void this.library?.saveInfo({ ...live.info }).catch((err) => this.api.log("Could not save a recording", err));
    }
  }

  onCommit(e: CommitEvent) {
    if (e.id === null) return;
    let live: Live | null | undefined = this.live.get(e.id);
    if (!live) {
      if (!this.settings.auto) return;
      live = this.begin(e.id);
      if (!live) return;
    }
    if (live.paused) return;
    const state = mapState(this.api);
    if (!state) return;
    const frame = live.recorder.take(state, e, Date.now());
    if (frame) this.append(live, frame);
  }

  /** Start recording the map `doc` — from its pending start, or carrying on its file's recording. */
  begin(doc: number): Live | null {
    let pending = this.pending.get(doc);
    if (!pending) {
      this.prepare(doc);
      pending = this.pending.get(doc);
      if (!pending) return null;
    }
    this.pending.delete(doc);
    const now = Date.now();
    let live: Live;
    if (pending.continueWith) {
      const { info, frames } = pending.continueWith;
      const end = seek(frames, frames.length - 1, null);
      live = { doc, info: { ...info }, recorder: new Recorder(end, frames.length, frames[frames.length - 1].t, now), frames, paused: false };
    } else {
      const docInfo = this.api.document.info();
      const info: RecordingInfo = {
        id: newId(), mapName: docInfo?.name || this.t("Untitled map"), fileName: docInfo?.fileName ?? null,
        created: now, updated: now, frames: 0, elapsed: 0, bytes: 0,
      };
      live = { doc, info, recorder: pending.start.recorder, frames: [], paused: false };
      this.append(live, pending.start.frame);
      void this.prune();
    }
    this.live.set(doc, live);
    this.infos = [live.info, ...this.infos.filter((i) => i.id !== live.info.id)];
    this.updateStatus();
    this.player?.refreshList();
    return live;
  }

  private append(live: Live, frame: Frame) {
    const index = live.frames.length;
    live.frames.push(frame);
    live.info.frames = live.frames.length;
    live.info.elapsed = frame.t;
    live.info.updated = Date.now();
    live.info.bytes += frameBytes(frame);
    if (this.library) {
      this.library.addFrame(live.info, index, frame).catch((err) => {
        this.api.log("Could not store a frame", err);
        if (!this.memoryOnly) {
          this.memoryOnly = true;
          this.api.ui.toast({ kind: "warn", title: this.t("Timelapse could not save to the browser's storage"), detail: this.t("The recording goes on for this session, but it will not be there after a reload.") });
        }
      });
    }
    this.updateStatus();
    this.player?.framesAdded(live);
  }

  /** Keep the newest `keep` recordings; the ones being recorded always stay. */
  private async prune() {
    const liveIds = new Set([...this.live.values()].map((l) => l.info.id));
    const extra = this.infos.filter((i) => !liveIds.has(i.id)).slice(Math.max(0, this.settings.keep - liveIds.size - 1));
    for (const info of extra) await this.remove(info.id);
  }

  async remove(id: string) {
    for (const [doc, live] of this.live) {
      if (live.info.id === id) { this.live.delete(doc); this.prepare(doc); }
    }
    this.infos = this.infos.filter((i) => i.id !== id);
    try { await this.library?.remove(id); } catch (err) { this.api.log("Could not delete a recording", err); }
    this.updateStatus();
    this.player?.refreshList();
  }

  async removeAll() {
    for (const info of [...this.infos]) await this.remove(info.id);
  }

  /** The front map's recording, if it has one. */
  front(): Live | null {
    const doc = this.api.document.id();
    return doc === null ? null : this.live.get(doc) ?? null;
  }

  /** Record, pause or resume the map in front. */
  toggleRecording() {
    const doc = this.api.document.id();
    if (doc === null) return;
    const live = this.live.get(doc);
    if (!live) this.begin(doc);
    else {
      live.paused = !live.paused;
      if (!live.paused) live.recorder.touch(Date.now());
    }
    this.updateStatus();
    this.player?.updateFooter();
  }

  updateStatus() {
    const live = this.front();
    if (!live) {
      this.status?.remove();
      this.status = null;
      return;
    }
    const text = live.paused ? this.t("Timelapse paused") : this.t("● {n, plural, one {# frame} other {# frames}}", { n: live.frames.length });
    const title = live.paused ? this.t("Timelapse is paused for this map. Click to open it.") : this.t("Timelapse is recording this map. Click to watch it.");
    if (this.status?.isShown()) this.status.set({ text, title });
    else this.status = this.api.ui.statusItem({ text, title, onClick: () => this.openPanel() });
  }

  /* ── The panel ── */

  openPanel() {
    if (this.panel?.isOpen()) return;
    this.save({ open: true });
    this.panel = this.api.ui.panel({
      title: this.t("Timelapse"),
      width: 480,
      height: 460,
      resizable: true,
      mount: (body) => {
        this.player = new Player(this);
        body.append(this.player.root);
        this.player.refreshList();
        return () => { this.player?.stop(); this.player = null; };
      },
      onClose: () => { this.panel = null; if (!this.disposed) this.save({ open: false }); },
    });
  }

  togglePanel() {
    if (this.panel?.isOpen()) this.panel.close();
    else this.openPanel();
  }

  /** The language changed: everything on screen was built in the old one. */
  relabel() {
    this.updateStatus();
    if (this.panel?.isOpen()) {
      const showing = this.player?.showing ?? null;
      this.panel.close();
      this.openPanel();
      if (showing) void this.player?.show(showing);
    }
  }

  /* ── Export ── */

  exportDialog(info: RecordingInfo, frames: readonly Frame[]) {
    const { api, t } = this;
    const w = api.ui.widgets;
    const s = this.settings;
    const size = extent(frames);
    const autoPpt = fitPpt(size, 512);
    const video = videoType();
    const format = w.select([
      { value: "gif", label: t("Animated GIF") },
      { value: "video", label: video ? t("Video (WebM)") : t("Video (not available in this browser)"), disabled: !video },
    ], { value: video ? s.exportFormat : "gif" });
    const ppt = w.select([1, 2, 3, 4, 6, 8, 12, 16].map((n) => ({
      value: n, label: t("{n} px per tile — {w} × {h}", { n, w: size.width * n, h: size.height * n }),
    })), { value: s.exportPpt || autoPpt });
    const fps = w.number({ value: s.exportFps, min: 1, max: 50, step: 1 });
    const max = w.number({ value: Math.min(s.exportMax, frames.length), min: 2, max: frames.length, step: 1 });
    const hold = w.number({ value: s.exportHold, min: 0, max: 30, step: 0.5 });
    const units = w.checkbox(t("Units"), { value: s.units });
    const sprites = w.checkbox(t("Doodads and sprites"), { value: s.sprites });
    const locations = w.checkbox(t("Locations"), { value: s.locations });
    const highlight = w.checkbox(t("Box around each change"), { value: s.highlight });
    const estimate = h("div", { className: "tl-estimate" });
    const status = w.statusLine();

    const plan = (): ExportPlan => {
      const n = Math.max(2, Math.min(frames.length, Math.round(Number(max.value) || frames.length)));
      return {
        frames, indices: sampleFrames(frames.length, n), fps: Math.max(1, Math.min(50, Number(fps.value) || 12)), hold: Math.max(0, Number(hold.value) || 0),
        options: { units: units.input.checked, sprites: sprites.input.checked, locations: locations.input.checked, highlight: highlight.input.checked },
      };
    };
    const updateEstimate = () => {
      const p = plan();
      const perFrame = format.value === "gif" ? gifDelay(p.fps) / 1000 : 1 / p.fps;
      const seconds = p.indices.length * perFrame + p.hold;
      estimate.textContent = t("{frames} of {total} frames, {seconds} s long", { frames: p.indices.length, total: frames.length, seconds: seconds.toFixed(1) });
    };
    for (const el of [format, ppt, fps, max, hold]) el.addEventListener("input", updateEstimate);
    updateEstimate();

    let abort: AbortController | null = null;
    api.ui.dialog({
      title: t("Export Timelapse"),
      size: "md",
      mount: (body) => {
        body.append(h("div", { className: "tl-dlg" },
          w.form([
            { label: t("Format"), field: format },
            { label: t("Size"), field: ppt },
            { label: t("Frames at most"), field: max },
            { label: t("Frames per second"), field: fps },
            { label: t("Hold the end (seconds)"), field: hold },
          ]),
          w.row(units, sprites, locations, highlight),
          estimate,
          format.value === "gif" && frames.length > 600 && w.hint(t("A long recording makes a large GIF. Fewer frames or a smaller size keep it easy to share.")),
          status,
        ));
        return () => abort?.abort();
      },
      buttons: [
        { label: t("Cancel") },
        {
          label: t("Export"), primary: true,
          run: async () => {
            const p = plan();
            const kind = format.value === "video" ? "video" : "gif";
            this.save({
              exportFormat: kind, exportPpt: Number(ppt.value) === autoPpt ? 0 : Number(ppt.value), exportFps: p.fps, exportMax: p.indices.length, exportHold: p.hold,
            });
            const stage = new Stage(api, Number(ppt.value), size, kind === "gif");
            for (const era of new Set(frames.map((f) => f.era))) {
              if (!(await stage.prepare(era))) {
                status.set(t("The tileset graphics this recording needs are not installed (Help ▸ Game Data…)."), "error");
                return false;
              }
            }
            abort = new AbortController();
            const signal = abort.signal;
            status.cancel(() => abort?.abort(), t("Stop"));
            const label = kind === "gif" ? t("Encoding frames") : t("Recording the video");
            try {
              const blob = kind === "gif"
                ? await exportGif(stage, p, (d, n) => status.progress(t("{label} — {d} of {n}", { label, d, n }), d / n), signal)
                : await exportVideo(stage, p, (d, n) => status.progress(t("{label} — {d} of {n}", { label, d, n }), d / n), signal);
              status.cancel(null);
              const ext = kind === "gif" ? "gif" : blob.type.includes("mp4") ? "mp4" : "webm";
              const name = `${(info.mapName || "map").replace(/[\\/:*?"<>|]+/g, " ").trim()} timelapse.${ext}`;
              status.set(t("{size} — choose where to save it", { size: formatBytes(blob.size) }));
              const saved = await api.ui.saveFile(blob, name);
              if (!saved) { status.set(t("Not saved.")); return false; }
              api.ui.toast({ kind: "ok", title: t("Timelapse saved"), detail: `${saved.fileName} · ${formatBytes(blob.size)}` });
              return true;
            } catch (err) {
              status.cancel(null);
              if (signal.aborted) { status.set(t("Stopped.")); return false; }
              api.log("Export failed", err);
              status.set(t("The export failed: {error}", { error: err instanceof Error ? err.message : String(err) }), "error");
              return false;
            } finally {
              abort = null;
            }
          },
        },
      ],
    });
  }

  /* ── Preferences ── */

  preferencesPage() {
    const { api, t } = this;
    api.ui.preferencesPage({
      mount: (body) => {
        const w = api.ui.widgets;
        const auto = w.checkbox(t("Record every map while I edit it"), { value: this.settings.auto, onChange: (v) => this.save({ auto: v }) });
        const keep = w.number({ value: this.settings.keep, min: 1, max: 500, step: 1, onChange: (v) => this.save({ keep: Math.max(1, Math.round(v) || DEFAULTS.keep) }) });
        const usage = w.hint("");
        const showUsage = () => {
          const bytes = this.infos.reduce((n, i) => n + i.bytes, 0);
          usage.textContent = this.memoryOnly
            ? t("The browser's storage is not available, so recordings last only until the page is reloaded.")
            : t("{n, plural, one {# recording} other {# recordings}}, about {size}, kept in this browser.", { n: this.infos.length, size: formatBytes(bytes) });
        };
        showUsage();
        const clear = w.button(t("Delete all recordings…"), {
          danger: true,
          onClick: async () => {
            if (!(await api.ui.confirm(t("Delete every recording? This cannot be undone."), { danger: true, confirmLabel: t("Delete all") }))) return;
            await this.removeAll();
            showUsage();
          },
        });
        body.append(
          w.group(t("Recording"),
            auto,
            w.hint(t("Off, nothing is recorded until you press Record in the Timelapse panel.")),
            w.form([{ label: t("Recordings to keep"), field: keep }]),
            w.hint(t("When a new recording starts, the oldest beyond this number are deleted.")),
          ),
          w.group(t("Storage"), usage, w.row(clear)),
        );
      },
      reset: () => { this.save({ auto: DEFAULTS.auto, keep: DEFAULTS.keep }); },
    });
  }

  private disposed = false;

  dispose() {
    this.disposed = true;
    this.player?.stop();
    this.panel?.close();
    this.status?.remove();
    this.library?.close();
    this.style.remove();
  }
}

/* ── The player ─────────────────────────────────────────── */

class Player {
  readonly root: HTMLElement;
  /** The recording on show. */
  showing: string | null = null;
  private frames: Frame[] = [];
  private scene: Scene | null = null;
  private stage: Stage | null = null;
  private index = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private graphicsMissing = false;
  private loadSerial = 0;

  private readonly picker: HTMLSelectElement;
  private readonly stageBox: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly caption: HTMLElement;
  private readonly foot: HTMLElement;

  private readonly app: Timelapse;

  constructor(app: Timelapse) {
    this.app = app;
    const { api, t } = app;
    const w = api.ui.widgets;
    const s = app.settings;
    this.picker = w.select([], { onChange: (id) => void this.show(id) });
    this.stageBox = h("div", { className: "tl-stage" });
    this.slider = h("input", { type: "range", min: "0", max: "0", value: "0" });
    this.slider.addEventListener("input", () => { this.pause(); this.goTo(Number(this.slider.value)); });
    this.count = h("span", { className: "tl-count" });
    this.playButton = w.button("", { title: t("Play"), onClick: () => this.togglePlay() });
    this.playButton.append(icon("play"));
    const first = w.button("", { title: t("First frame"), onClick: () => { this.pause(); this.goTo(0); } });
    first.append(icon("first"));
    const last = w.button("", { title: t("Last frame"), onClick: () => { this.pause(); this.goTo(this.frames.length - 1); } });
    last.append(icon("last"));
    this.caption = h("div", { className: "tl-caption" });
    const fps = w.select([2, 5, 8, 12, 20, 30, 60].map((n) => ({ value: n, label: t("{n} fps", { n }) })), {
      value: s.fps, onChange: (v) => { app.save({ fps: Number(v) }); if (this.timer) { this.pause(); this.play(); } },
    });
    const tick = (key: "units" | "sprites" | "locations" | "highlight", label: string) =>
      w.checkbox(label, { value: s[key], onChange: (v) => { app.save({ [key]: v }); this.redraw(); } });
    this.foot = h("div", { className: "tl-foot" });

    this.root = h("div", { className: "tl" },
      h("div", { className: "tl-bar" }, this.picker),
      this.stageBox,
      h("div", { className: "tl-controls" }, first, this.playButton, last, this.slider, this.count),
      this.caption,
      h("div", { className: "tl-opts" }, fps, tick("units", t("Units")), tick("sprites", t("Doodads and sprites")), tick("locations", t("Locations")), tick("highlight", t("Box around each change"))),
      this.foot,
    );
  }

  /** Fill the recording picker, and show the front map's recording (or the newest) if nothing is on show yet. */
  refreshList() {
    const { t } = this.app;
    const liveIds = new Map([...this.app.live.values()].map((l) => [l.info.id, l]));
    this.picker.replaceChildren(...this.app.infos.map((info) => {
      const live = liveIds.get(info.id);
      const when = new Date(info.updated).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      const mark = live ? (live.paused ? t(" (paused)") : t(" (recording)")) : "";
      return h("option", { value: info.id }, `${info.mapName} — ${when}${mark}`);
    }));
    const stillThere = this.showing !== null && this.app.infos.some((i) => i.id === this.showing);
    if (!stillThere) {
      const target = this.app.front()?.info.id ?? this.app.infos[0]?.id ?? null;
      this.showing = null;
      if (target) void this.show(target);
      else this.empty();
    } else {
      this.picker.value = this.showing!;
    }
    this.updateFooter();
  }

  /** The front map changed: show its recording, if it has one. */
  followDocument() {
    const live = this.app.front();
    if (live && live.info.id !== this.showing) void this.show(live.info.id);
    this.refreshList();
  }

  private empty() {
    const { t } = this.app;
    this.stop();
    this.frames = [];
    this.stage = null;
    this.scene = null;
    this.stageBox.replaceChildren(h("div", { className: "tl-empty" }, this.app.settings.auto
      ? t("Nothing recorded yet. Change the map and every change becomes a frame here.")
      : t("Recording is off. Press Record to start recording the map in front.")));
    this.slider.max = "0";
    this.count.textContent = "";
    this.caption.replaceChildren();
  }

  async show(id: string) {
    const { t } = this.app;
    this.pause();
    this.showing = id;
    this.picker.value = id;
    const serial = ++this.loadSerial;
    const live = [...this.app.live.values()].find((l) => l.info.id === id);
    let frames: Frame[];
    if (live) frames = live.frames;
    else {
      this.stageBox.replaceChildren(this.app.api.ui.widgets.spinner({ label: t("Loading the recording…") }));
      try { frames = (await this.app.library?.frames(id)) ?? []; } catch { frames = []; }
      if (serial !== this.loadSerial) return;
    }
    this.frames = frames;
    if (frames.length === 0) { this.empty(); return; }
    this.makeStage();
    this.graphicsMissing = false;
    for (const era of new Set(frames.map((f) => f.era))) {
      if (!(await this.stage!.prepare(era))) this.graphicsMissing = true;
      if (serial !== this.loadSerial) return;
    }
    this.scene = null;
    this.goTo(frames.length - 1);
    this.updateFooter();
  }

  private makeStage() {
    const size = extent(this.frames);
    if (this.stage && this.stage.extent.width === size.width && this.stage.extent.height === size.height) return;
    this.stage = new Stage(this.app.api, fitPpt(size, 768), size);
    this.scene = null;
    this.stageBox.replaceChildren(this.stage.canvas);
  }

  private goTo(index: number) {
    if (!this.stage || this.frames.length === 0) return;
    this.index = Math.max(0, Math.min(index, this.frames.length - 1));
    this.scene = seek(this.frames, this.index, this.scene);
    this.redraw();
  }

  redraw() {
    const { t } = this.app;
    if (!this.stage || !this.scene) return;
    const s = this.app.settings;
    const frame = this.frames[this.index];
    const ok = this.stage.draw(this.scene, { units: s.units, sprites: s.sprites, locations: s.locations, highlight: s.highlight ? frame.area : null });
    if (!ok && !this.graphicsMissing) this.graphicsMissing = true;
    if (this.graphicsMissing && this.stageBox.lastChild === this.stage.canvas) {
      this.stageBox.append(h("div", { className: "tl-empty", style: "position:relative" }, t("The tileset graphics this recording needs are not installed (Help ▸ Game Data…).")));
    }
    this.slider.max = String(this.frames.length - 1);
    this.slider.value = String(this.index);
    this.count.textContent = `${this.index + 1} / ${this.frames.length}`;
    this.caption.replaceChildren(h("b", null, this.describe(frame)), h("span", { className: "grow" }), h("span", null, t("{time} in", { time: formatDuration(frame.t) })));
  }

  private describe(frame: Frame): string {
    const { t } = this.app;
    switch (frame.reason) {
      case "start": return t("The map when recording began");
      case "undo": return t("Undo {label}", { label: frame.label });
      case "redo": return t("Redo {label}", { label: frame.label });
      case "remote": return t("Someone else's edits");
      default: return frame.label || t("Map settings");
    }
  }

  /** A frame was added to a recording that is being taken. */
  framesAdded(live: Live) {
    if (live.info.id !== this.showing) {
      if (this.frames.length === 0 && this.app.front() === live) void this.show(live.info.id);
      return;
    }
    if (this.frames !== live.frames) this.frames = live.frames;
    const size = extent(this.frames);
    if (!this.stage || size.width > this.stage.extent.width || size.height > this.stage.extent.height) this.makeStage();
    // Sitting on the last frame means watching the map being built: keep up.
    if (!this.timer && this.index >= this.frames.length - 2) this.goTo(this.frames.length - 1);
    else { this.slider.max = String(this.frames.length - 1); this.count.textContent = `${this.index + 1} / ${this.frames.length}`; }
  }

  togglePlay() {
    if (this.timer) this.pause();
    else this.play();
  }

  play() {
    if (this.frames.length < 2) return;
    if (this.index >= this.frames.length - 1) { this.goTo(0); }
    this.playButton.replaceChildren(icon("pause"));
    this.playButton.title = this.app.t("Pause");
    this.timer = setInterval(() => {
      if (this.index >= this.frames.length - 1) { this.pause(); return; }
      this.goTo(this.index + 1);
    }, 1000 / this.app.settings.fps);
  }

  pause() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.playButton.replaceChildren(icon("play"));
    this.playButton.title = this.app.t("Play");
  }

  stop() {
    this.pause();
    this.loadSerial++;
  }

  updateFooter() {
    const { api, t } = this.app;
    const w = api.ui.widgets;
    const live = this.app.front();
    const info = this.app.infos.find((i) => i.id === this.showing) ?? null;
    const record = !api.document.isOpen() ? null
      : !live ? w.button(t("Record"), { title: t("Start recording the map in front"), onClick: () => this.app.toggleRecording() })
      : w.button(live.paused ? t("Resume recording") : t("Pause recording"), { onClick: () => this.app.toggleRecording() });
    if (record && live && !live.paused) record.prepend(h("span", { className: "tl-dot" }));
    const summary = info ? h("span", { className: "tl-count" }, t("{time} of editing · {size}", { time: formatDuration(info.elapsed), size: formatBytes(info.bytes) })) : null;
    this.foot.replaceChildren(...[
      w.button(t("Export…"), { primary: true, disabled: this.frames.length < 2 || !info, onClick: () => { if (info) { this.pause(); this.app.exportDialog(info, this.frames); } } }),
      w.button(t("Delete…"), {
        disabled: !info,
        onClick: async () => {
          if (!info) return;
          if (!(await api.ui.confirm(t("Delete the recording of “{name}”? This cannot be undone.", { name: info.mapName }), { danger: true, confirmLabel: t("Delete") }))) return;
          this.showing = null;
          await this.app.remove(info.id);
        },
      }),
      h("span", { className: "grow" }),
      summary,
      record,
    ].filter((n): n is HTMLElement => n !== null));
  }
}

/* ── Activation ─────────────────────────────────────────── */

export default function activate(api: PluginApi): () => void {
  api.i18n.register({ ko: KO });
  const app = new Timelapse(api);

  api.commands.register({ id: "open", title: "Timelapse", run: () => app.togglePanel() });
  api.commands.register({ id: "record", title: "Record or Pause Timelapse", run: () => app.toggleRecording() });
  api.menu.add("View", { label: app.t("Timelapse…"), icon: "plugin", command: "open" });

  api.events.on("commit", (e) => app.onCommit(e));
  api.events.on("document", (e) => app.onDocument(e));
  api.events.on("file", () => app.onFile());
  api.events.on("gameData", () => app.player?.redraw());
  api.events.on("language", () => app.relabel());
  app.preferencesPage();

  void app.init().then(() => { if (app.settings.open) app.openPanel(); });
  return () => app.dispose();
}
