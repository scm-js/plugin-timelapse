# Timelapse

A plugin for [scmJS](https://github.com/scm-js/scm-js), the browser-based StarCraft 1 /
Brood War map editor. It records the map while you build it and plays the recording back
as an animation, which you can export as a GIF or a video.

Every change to the map becomes one frame: a brush stroke, a pasted base, a row of
minerals, an undo. Playback shows the map going from empty to finished, with a box around
each change so you can follow it. Open the same file again the next day and the recording
continues from where it stopped, so a map built over a week plays back as one film.

## Install

In scmJS: **Plugins ▸ Browse Plugins…** lists Timelapse; press **Install**. Or open
**Plugins ▸ Manage Plugins…**, paste

```
https://github.com/scm-js/plugin-timelapse
```

and press **Add**. To pin a version, add a ref: `github:scm-js/plugin-timelapse@v0.1.0`.

## Use

Recording starts on its own. Once the plugin is on, the first change you make to a map
starts a recording of it, and the status bar shows a cell with the number of frames so far
(*● 42 frames*). Click the cell, or use **View ▸ Timelapse…**, to open the panel.

### The panel

The picker at the top lists the recordings, newest first; the one being recorded is marked
*(recording)*. Below it:

- **The picture**: the map at the frame you are on. The box shows where that frame's
  change happened.
- **First frame, play/pause, last frame, and the slider** for scrubbing. Playback stops at
  the end; press play again to watch it from the start.
- **The line under it**: what the frame was (*Paint Dirt (isometric)*, *Undo: Place
  unit*, *Someone else's edits* on a shared map), and how much editing time had passed.
- **Frame rate and ticks**: how fast it plays, and whether units, doodads and sprites,
  locations and the change box are drawn.
- **Export…**, **Delete…**, and **Record / Pause recording / Resume recording** for the map
  in front.

If the panel is on the last frame while you work, it follows along, so you can watch the
recording being made. Recordings of maps on other tilesets play too; the plugin loads
that tileset's graphics to draw them.

### Exporting

**Export…** opens a dialog:

- **Format**: an animated GIF, or a WebM video where the browser can record one.
- **Size**: pixels per tile. The default makes the picture about 512 pixels across.
- **Frames at most**: a long recording is thinned evenly to this many frames, always
  keeping the first and the last. The dialog shows how long the result will be.
- **Frames per second** and **Hold the end**: the speed, and how long the finished map
  stays on screen before the animation starts again.
- The same ticks as the panel.

A GIF is built in the page, one frame after another, with a line showing progress and a
**Stop** button. It uses one palette for the whole animation, and each frame stores only
the pixels that changed. Three hundred small edits on a 128 × 128 map, at 512 × 512
pixels, came to about half a megabyte and took a few seconds. A video is recorded as it
plays, so it takes as long as the video is long.

### What counts as a frame

One frame per change the editor records: a stroke, a paste, a placement, an edit made by
another plugin, an undo or redo, a resize or tileset change, and other people's edits on a
shared map. A change that shows nothing on the map, such as renaming the map or editing
triggers, adds no frame. Time away from the editor counts as one minute at most, so the
editing time shown is time spent working.

### Settings

**Edit ▸ Preferences ▸ Plugins ▸ Timelapse**:

- **Record every map while I edit it**: on by default. Off, nothing is recorded until you
  press **Record** in the panel.
- **Recordings to keep**: 30 by default. When a new recording starts, the oldest beyond
  this number are deleted. A recording that is still going is never deleted this way.
- How much space the recordings take, and **Delete all recordings…**.

### Where it lives

Recordings are kept in this browser's IndexedDB storage, under `scmjs-timelapse`. They are
not part of the map file, not uploaded anywhere, and not shared with other browsers or
machines. Clearing the site's data removes them. If the browser refuses the storage (some
private windows do), the plugin records for the session only and says so.

A frame stores only the rectangle of tiles that changed and, when objects changed, the
positions of the units, doodads and sprites. Every 64th frame keeps the whole tile layer
so that scrubbing stays quick: 32 KB on a 128 × 128 map, 128 KB on a 256 × 256 one. A few
thousand changes on a 128 × 128 map therefore come to a megabyte or two. The panel shows
each recording's size beside its editing time.

A recording carries on when the map you open has the same file name as the recording and
is exactly as the recording's last frame left it. A map changed in another editor in
between starts a new recording.

## Development

```sh
npm install
npm test          # the recording model and the Korean catalogue
npm run typecheck
npm run build     # dist/plugin.js, the bundle the editor loads
npm run dev       # the same, rebuilt on every change
```

Serve the folder with any static server that sends `Access-Control-Allow-Origin: *` and
add its address (`http://localhost:3000/`) in Plugins ▸ Manage Plugins….

| File | What is in it |
| --- | --- |
| `recording.ts` | The model: frames, the diff against the last frame, key frames, seeking. No DOM; `tests/recording.test.ts` covers it. |
| `library.ts` | IndexedDB: one summary per recording and the frames keyed by recording and index. |
| `render.ts` | Drawing a frame with `graphics.renderClip`: the terrain redrawn only where it changed, the objects over it. |
| `export.ts` | GIF with [gifenc](https://github.com/mattdesl/gifenc) (one palette, unchanged pixels transparent) and video with `MediaRecorder`. |
| `plugin.ts` | Listening to the editor, the panel, the export dialog, the status cell and the preferences page. |
| `ko.ts` | The Korean catalogue; `tests/ko.test.ts` fails when a string is missing from it. |

The editor side it relies on is the `"commit"` event, which tells a listener what each
change was and where it fell, and `tileset.load(id)` for drawing a recording of a map on
another tileset. Both are described in the editor's
[plugin guide](https://github.com/scm-js/scm-js/blob/main/docs/plugins.md).

## Licence

MIT. gifenc is MIT, © Matt DesLauriers.
