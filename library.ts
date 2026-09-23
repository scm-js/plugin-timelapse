/**
 * Where recordings are kept: IndexedDB, because a recording is megabytes of typed arrays
 * and `api.storage` is a few megabytes of JSON for the whole editor. Two stores — one
 * summary per recording, and the frames keyed `[recording, index]` — so taking a frame is
 * one small append, never a rewrite of the recording.
 *
 * Everything here answers rather than throws: a browser with IndexedDB turned off (a
 * private window in some browsers) gets `Library.open()` → null, and the plugin records
 * into memory only and says so.
 */
import type { Frame } from "./recording";

export interface RecordingInfo {
  id: string;
  /** The map's name when the recording began. */
  mapName: string;
  /** The file it was opened from or last saved to; how a reopened map finds its recording. */
  fileName: string | null;
  created: number;
  updated: number;
  /** Frames kept, the start frame included. */
  frames: number;
  /** Editing time covered (see `IDLE_CAP`). */
  elapsed: number;
  /** Roughly what the frames take up. */
  bytes: number;
}

const DB = "scmjs-timelapse";
const INFO = "recordings";
const FRAMES = "frames";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("aborted"));
  });
}

export class Library {
  private readonly db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  static async open(): Promise<Library | null> {
    if (typeof indexedDB === "undefined") return null;
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(INFO)) db.createObjectStore(INFO, { keyPath: "id" });
        if (!db.objectStoreNames.contains(FRAMES)) db.createObjectStore(FRAMES);
      };
      return new Library(await request(req));
    } catch {
      return null;
    }
  }

  /** Every recording's summary, newest first. */
  async list(): Promise<RecordingInfo[]> {
    const all = await request(this.db.transaction(INFO).objectStore(INFO).getAll() as IDBRequest<RecordingInfo[]>);
    return all.sort((a, b) => b.updated - a.updated);
  }

  async frames(id: string): Promise<Frame[]> {
    const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
    return request(this.db.transaction(FRAMES).objectStore(FRAMES).getAll(range) as IDBRequest<Frame[]>);
  }

  async saveInfo(info: RecordingInfo): Promise<void> {
    const tx = this.db.transaction(INFO, "readwrite");
    tx.objectStore(INFO).put(info);
    await done(tx);
  }

  /** One frame and the summary that now counts it, in one transaction, so the two never disagree. */
  async addFrame(info: RecordingInfo, index: number, frame: Frame): Promise<void> {
    const tx = this.db.transaction([FRAMES, INFO], "readwrite");
    tx.objectStore(FRAMES).put(frame, [info.id, index]);
    tx.objectStore(INFO).put({ ...info });
    await done(tx);
  }

  async remove(id: string): Promise<void> {
    const tx = this.db.transaction([INFO, FRAMES], "readwrite");
    tx.objectStore(INFO).delete(id);
    tx.objectStore(FRAMES).delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
    await done(tx);
  }

  close() {
    this.db.close();
  }
}

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
