export type HelpCategoryId =
  | 'quick-start'
  | 'dj-folder'
  | 'playlist-beatgrid'
  | 'timeline-mixing'
  | 'tempo-fx'
  | 'projects-export'
  | 'shortcuts';

export interface HelpArticle {
  id: string;
  title: string;
  summary: string;
  steps?: string[];
  tips?: string[];
  keywords: string[];
}

export interface HelpSection {
  id: Exclude<HelpCategoryId, 'shortcuts'>;
  title: string;
  shortTitle: string;
  description: string;
  articles: HelpArticle[];
}

export interface KeyboardShortcutItem {
  keys: string[];
  action: string;
  context: 'Global Timeline' | 'Beatgrid Editor' | 'Beat Edit Window' | 'Controls';
}

export const HELP_SECTIONS: HelpSection[] = [
  {
    id: 'quick-start',
    title: 'Quick Start',
    shortTitle: 'Quick Start',
    description: 'Go from raw local audio files to a beatmatched, export-ready DJ mix in minutes.',
    articles: [
      {
        id: 'qs-workflow',
        title: '5-Step Mix Workflow',
        summary:
          'OpenMix Studio combines a local DJ Folder browser, a Current Playlist crate, and a multi-track non-linear timeline.',
        steps: [
          'Link your local music directory in the DJ Folder panel (top-left) or drag audio files/folders directly onto DJ Folder or Current Playlist.',
          'Click "Scan BPM/Key" in DJ Folder to pre-analyze tempo and Camelot key compatibility before importing tracks.',
          'Add tracks to Current Playlist, audition them clean/unfiltered, and refine any off-grid tracks in the Beatgrid Editor.',
          'Drag tracks onto timeline lanes (or click Add to Timeline) to auto-place beatmatched clips with overlapping Auto-Mix transitions.',
          'Sculpt transitions with the Dynamic Mix Point / Clip Options menu and the Beat Edit window, dial in FX & automation, then open Mix -> Export Mix.',
        ],
        tips: [
          'Use "Hide Library" or "Hide Timeline" in the top bar to dedicate full screen height to crate digging or arrangement.',
          'Drag the vertical and horizontal dividers between DJ Folder, Current Playlist, and the Timeline to customize your layout.',
        ],
        keywords: ['start', 'guide', 'workflow', 'getting started', 'basics', 'layout', 'panels'],
      },
      {
        id: 'qs-themes',
        title: 'Studio Themes & Workspace Focus',
        summary:
          'Switch color palettes and collapse individual panels at any time without interrupting playback.',
        steps: [
          'Open the Theme menu in the top header to switch between Studio Amber and OM Neon; your preference is saved automatically.',
          'Use the collapse buttons on DJ Folder or Current Playlist, or Hide Library / Hide Timeline in the header, to focus on one area.',
        ],
        keywords: ['theme', 'amber', 'neon', 'color', 'collapse', 'resize', 'header'],
      },
    ],
  },
  {
    id: 'dj-folder',
    title: 'DJ Folder & Pre-Analysis',
    shortTitle: 'DJ Folder',
    description: 'Index local music folders, pre-scan BPM & Camelot keys, track changes, and find harmonic matches.',
    articles: [
      {
        id: 'df-linking',
        title: 'Linking, Syncing & Change Tracking',
        summary:
          'OpenMix Studio reads local audio directly in your browser without uploading files to any server.',
        steps: [
          'Click "Link DJ Folder" (or drag a folder onto the panel) to grant read-only access and browse subfolders inside the studio.',
          'On future visits, click "Reconnect & Scan" or the Refresh icon to re-verify folder access and detect added, modified, or removed files automatically.',
          'Click any track to import it into Current Playlist, or click "Add All" to import every unadded track in the current folder view (duplicates are skipped).',
        ],
        tips: [
          'If your browser falls back to standard directory selection and displays an "Upload" prompt, files still stay 100% local in your browser database.',
          'Newly added or modified files detected on resync are automatically queued for BPM/Key analysis.',
        ],
        keywords: ['folder', 'local', 'import', 'sync', 'permission', 'directory', 'library', 'subfolder', 'add all'],
      },
      {
        id: 'df-analysis',
        title: 'Background BPM/Key Scanning & Compatibility Fit',
        summary:
          'Pre-analyze your folder into IndexedDB for instant future sessions and rank tracks by harmonic & tempo compatibility.',
        steps: [
          'Click "Scan BPM/Key" in the DJ Folder header to analyze uncached tracks sequentially while playback stays smooth (click again to pause).',
          'Use "Re-scan BPM/Key" anytime to re-analyze folder metadata; tracks with manually edited beatgrids are automatically preserved.',
          'Choose a reference in "Fit vs:" (Last Playlist track, Timeline BPM, or any playlist track), toggle "Fit Only" to hide incompatible tracks, or sort by Best Fit, BPM, Key, Title, Track No, or Length.',
        ],
        keywords: ['bpm', 'key', 'camelot', 'scan', 'rescan', 'analyze', 'cache', 'harmonic', 'fit', 'compatible', 'sort'],
      },
    ],
  },
  {
    id: 'playlist-beatgrid',
    title: 'Playlist & Beatgrid Editor',
    shortTitle: 'Playlist & Beatgrid',
    description: 'Audition tracks clean, manage set order, and lock sub-millisecond beatgrids with Mixxx QM detection.',
    articles: [
      {
        id: 'pb-crate',
        title: 'Current Playlist, Clean Preview & Timeline Order',
        summary:
          'Your Current Playlist holds decoded tracks ready for instant drag-and-drop placement onto timeline lanes.',
        steps: [
          'Click a track’s Play button to audition it clean and unfiltered without interrupting timeline playback, and click the preview progress bar to scrub.',
          'Toggle "Timeline Order" to keep your playlist automatically synced with chronological clip order on the timeline, or turn it off to drag-reorder manually or sort by column headers.',
          'Click a track’s Edit icon to adjust BPM (including ÷2 / ×2) and musical key inline, or click "Re-scan" in the playlist header to re-analyze unedited tracks.',
        ],
        tips: [
          'Tracks already placed on the timeline display a clip count badge and live playback progress.',
          'Use Mix -> Export Playlist (.txt) to download a formatted setlist of your current playlist.',
        ],
        keywords: ['playlist', 'crate', 'preview', 'audition', 'reorder', 'timeline order', 'rescan', 'tracklist', 'txt'],
      },
      {
        id: 'pb-beatgrid',
        title: 'Precision Beatgrid Editor',
        summary:
          'Verify beatgrids with an audible metronome, Mixxx QM tempo detection, direct waveform marker dragging, and sub-millisecond nudging.',
        steps: [
          'Open the Beatgrid Editor from a track’s inline edit controls in Current Playlist.',
          'Press Space to audition with the audible Click metronome, navigate via the Track Overview minimap, and zoom with mouse wheel, +/-, 4 Bars, or Fit (with 1×/2×/3× Gain, ½ Beats, and Follow toggles).',
          'Use "Detect Track" (full-track Mixxx QM analysis), "Detect Here" (analyze around the playhead and project back to 0:00), Tap (T), or ÷2 / ×2 / ±0.1 to lock tempo.',
          'Press B (Set Beat 1 Here) on a kick downbeat, shift by ±1 Beat, nudge with Arrow keys (±1 ms, Shift ±0.5 ms, Alt ±10 ms), drag any beat marker to shift the grid (Shift+Drag for fine), or Alt+Drag a beat marker to stretch/compress BPM.',
          'Save to lock the manual beatgrid; future folder or playlist rescans will never overwrite manual edits.',
        ],
        keywords: ['beatgrid', 'downbeat', 'tap tempo', 'metronome', 'click', 'mixxx', 'detect', 'offset', 'nudge', 'stretch', 'bpm', 'key', 'manual'],
      },
    ],
  },
  {
    id: 'timeline-mixing',
    title: 'Timeline, Transitions & Beat Edit',
    shortTitle: 'Timeline & Mix',
    description: 'Arrange clips across lanes, shape volume & bass curves, and lock kicks in Beat Edit.',
    articles: [
      {
        id: 'tm-clips',
        title: 'Placing, Moving, Splitting & Looping Clips',
        summary:
          'Arrange tracks across unlimited timeline lanes with variable-tempo grid snapping, ripple movement, and quick loop auditioning.',
        steps: [
          'Drag tracks from Current Playlist onto any lane, or click Add to Timeline to place beat-aligned clips onto alternating lanes. Hold Alt while dropping to place at the exact cursor without Auto-Mix overlap.',
          'Drag clips horizontally or across lanes, trim left/right edges, click Split to slice at the playhead, and click Add Track for extra lanes.',
          'Set Snap (Bar / 1/2 Beat / 1/4 Beat / Off), toggle Ripple to shift downstream clips together across all lanes, and zoom with Ctrl/Cmd + Scroll or Fit.',
          'Drag across the top Loop Strip in the ruler to draw a loop (hold Alt to bypass snap), drag its edges to resize or body to slide, double-click to toggle, or press L, [, and ].',
        ],
        keywords: ['timeline', 'clip', 'drag', 'split', 'snap', 'ripple', 'lane', 'loop', 'zoom', 'alt'],
      },
      {
        id: 'tm-transitions',
        title: 'Auto-Mix Defaults, Clip Options & Dynamic Mix Point',
        summary:
          'Configure automatic overlapping transitions and sculpt per-clip Volume & Bass (Low EQ) fade curves in real time.',
        steps: [
          'Click "Auto-Mix" in the timeline toolbar to pick a mix preset, default overlap length (2B–32B or custom), Volume Crossfade curve (S-Curve / Linear / Exp), Bass Swap or Bass Crossfade with cut depth (-12 to -36 dB), Mid/High EQ crossfades, and Filter sweeps.',
          'Open a clip’s draggable floating Clip Options menu (double-click its header to reset position) to adjust Gain (-24 to +12 dB), Pitch (-12 to +12 st), Beat-Match Stretch, Auto-Lock Beats, Align to Mix Grid, Beat Grid & Nudge, Mix Transition (Sync Pair / Re-align), Duplicate, or Delete.',
          'Enable "Dynamic" in the floating menu so it automatically switches to a dual-track Mix Point view (OUT + IN cards) whenever the playhead sits inside an overlap.',
          'Toggle Vol or Bass fades on/off independently, shape Vol Bend and Bass Bend (or Bass Swap center point) sliders, or drag fade and curve-bend handles directly on clips in the timeline.',
        ],
        keywords: ['transition', 'auto-mix', 'preset', 'crossfade', 'bass swap', 'curve', 'bend', 'dynamic', 'mix point', 'clip options', 'gain', 'pitch', 'filter'],
      },
      {
        id: 'tm-beat-edit',
        title: 'Beat Edit Window (High-Magnification Alignment)',
        summary:
          'Zoom into any looped transition with stacked high-resolution waveforms to lock kicks and beat markers to sub-millisecond precision.',
        steps: [
          'Set a loop around your transition and click "Beat Edit" next to the Loop controls in the timeline toolbar.',
          'Use the embedded loop transport, draggable Loop In/Out handles (Shift = fine), drag snap modes (Free / 1ms / 1/16 / Beat), Gain (1×/2×/3×), Grid / Clip Beats overlays, Loop Tracks filter, and per-track Mute/Solo.',
          'Click a clip to select it, then drag directly (hold Shift for 10× fine precision) or use Arrow keys / Nudge Clip buttons (±0.5 to ±10 ms).',
          'Use Beat Grid micro-nudges or "Match Upper / Match Lower Beats" to slip beat markers without moving audio, or click "Snap Beat" and "Auto-Align Kicks" to cross-correlate overlapping kick transients.',
        ],
        keywords: ['beat edit', 'super zoom', 'phase', 'beatmatch', 'overlap', 'auto-align', 'kicks', 'match upper', 'match lower', 'snap beat', 'nudge'],
      },
    ],
  },
  {
    id: 'tempo-fx',
    title: 'Tempo Map, Key Lock & FX',
    shortTitle: 'Tempo & FX',
    description: 'Control dynamic BPM ramps, Key Lock vs. Repitch playback, per-track FX racks, automation, and master metering.',
    articles: [
      {
        id: 'tf-tempo',
        title: 'Tempo Map, Key Lock & Beat Markers',
        summary:
          'Blend tracks across different tempos smoothly using automatic tempo ramps and selectable pitch preservation.',
        steps: [
          'Toggle "Key Lock" (pitch-preserving time-stretch) or "Repitch" (zero-artifact vinyl speed mode) in the timeline toolbar, and toggle "Beats" to show or hide per-clip beat & downbeat markers.',
          'Click "Tempo Map" to view and edit the variable BPM lane; OpenMix Studio automatically syncs tempo transitions between consecutive tracks of different BPMs (use Auto-Sync / Sync Map to re-sync after manual edits).',
          'Click the Tempo Map curve to add nodes (Alt+Click to bypass snap), drag nodes to adjust BPM/timing, double-click a node to delete it, or switch ramp shapes between Linear, Smooth, and Step.',
        ],
        keywords: ['tempo', 'bpm', 'key lock', 'repitch', 'vinyl', 'time stretch', 'pitch', 'tempo map', 'ramp', 'beat markers'],
      },
      {
        id: 'tf-fx-auto',
        title: 'Track Effects Rack, Automation & Master Meter',
        summary:
          'Each lane includes a dedicated mixer strip, 3-band EQ, resonant filter, delay, reverb, drive, and keyframe automation alongside a live stereo master meter.',
        steps: [
          'Click the FX button on a track header to expand its 3-band EQ (Low/Mid/High), resonant Filter, Delay, Reverb, and Drive controls.',
          'Click the Automation button on a track header to draw keyframe curves for Volume, Pan, Filter Cutoff, FX Wet, or Speed.',
          'Use Mute (M), Solo (S), track faders, and the right-hand Master Meter panel (live stereo L/R RMS & peak-hold bars, master volume fader, and mute) to maintain clean headroom.',
        ],
        tips: [
          'Click the latched peak/clip dB readout at the top of the Master Meter panel to reset peak hold and clip warnings.',
          'Click any knob or the master fader and use Arrow keys for precise adjustments, or double-click knobs to reset to default.',
        ],
        keywords: ['effects', 'fx', 'eq', 'filter', 'delay', 'reverb', 'drive', 'automation', 'mute', 'solo', 'meter', 'master', 'clipping'],
      },
    ],
  },
  {
    id: 'projects-export',
    title: 'Saving, Relinking & Exporting',
    shortTitle: 'Save & Export',
    description: 'Resume autosaved sessions, share lightweight mix manifests, relink audio, and render master files.',
    articles: [
      {
        id: 'pe-save',
        title: 'Autosave, Save/Load Mix & Track Relinking',
        summary:
          'Projects save your complete arrangement, beatgrids, fades, tempo map, FX, and automation as compact JSON manifests without duplicating large audio files.',
        steps: [
          'OpenMix Studio automatically autosaves your workspace in browser IndexedDB. Resume directly from the Welcome Screen or the Restore & Relink banner on your next visit.',
          'Open Mix -> Save Mix to download a portable .openmix.json project file, Mix -> Load Mix to open one, or Mix -> New Mix to start fresh (with an option to save first).',
          'When loading a mix whose audio files are not yet decoded, the Relink Tracks modal matches them automatically against your linked DJ Folder or lets you locate individual files.',
        ],
        keywords: ['save', 'load', 'autosave', 'relink', 'json', 'manifest', 'project', 'new mix', 'welcome'],
      },
      {
        id: 'pe-export',
        title: 'Exporting Your Master Mix & Tracklist',
        summary:
          'Render the complete offline NLE mixdown with all time-stretching, tempo ramps, transitions, FX, and automation baked in.',
        steps: [
          'Open Mix -> Export Mix from the top studio header.',
          'Choose lossless WAV (24-bit or 16-bit) or compressed MP3, AAC (browser-supported), or WebM Opus with selectable bitrate (128–320 kbps).',
          'Toggle "Peak-normalize master output to -0.5 dBFS", enter your output filename, check the estimated file size, and click "Render & Download".',
        ],
        tips: [
          'For long sets approaching the 4 GB WAV RIFF limit, switch to WAV 16-bit, MP3, AAC, or WebM Opus.',
          'Open Mix -> Export Playlist (.txt) anytime to export a clean text tracklist of your mix.',
        ],
        keywords: ['export', 'render', 'wav', 'mp3', 'aac', 'webm', 'opus', 'bitrate', 'normalize', 'download', 'mixdown', 'playlist'],
      },
    ],
  },
];

export const KEYBOARD_SHORTCUTS: KeyboardShortcutItem[] = [
  { keys: ['Space'], action: 'Play / Pause timeline', context: 'Global Timeline' },
  { keys: ['L'], action: 'Toggle loop (creates 4-bar loop if none set)', context: 'Global Timeline' },
  { keys: ['['], action: 'Set loop In point at playhead', context: 'Global Timeline' },
  { keys: [']'], action: 'Set loop Out point at playhead', context: 'Global Timeline' },
  { keys: ['Ctrl / Cmd + Scroll'], action: 'Zoom timeline around cursor', context: 'Global Timeline' },
  { keys: ['Alt + Drop / Drag'], action: 'Bypass Auto-Mix overlap on drop or bypass snap on loop/tempo', context: 'Global Timeline' },
  { keys: ['?'], action: 'Toggle Help Center', context: 'Global Timeline' },
  { keys: ['F1'], action: 'Open Help Center', context: 'Global Timeline' },
  { keys: ['Esc'], action: 'Close active modal, floating menu, or dropdown', context: 'Global Timeline' },

  { keys: ['Space'], action: 'Play / Pause track preview with metronome', context: 'Beatgrid Editor' },
  { keys: ['B'], action: 'Set Beat 1 (downbeat) at current playhead', context: 'Beatgrid Editor' },
  { keys: ['T'], action: 'Tap tempo to estimate BPM', context: 'Beatgrid Editor' },
  { keys: ['←', '→'], action: 'Nudge beatgrid offset (±1 ms)', context: 'Beatgrid Editor' },
  { keys: ['Shift + ← / →'], action: 'Fine nudge beatgrid offset (±0.5 ms)', context: 'Beatgrid Editor' },
  { keys: ['Alt + ← / →'], action: 'Coarse nudge beatgrid offset (±10 ms)', context: 'Beatgrid Editor' },
  { keys: ['Drag Beat Marker'], action: 'Shift beatgrid on waveform (hold Shift for fine)', context: 'Beatgrid Editor' },
  { keys: ['Alt + Drag Beat'], action: 'Stretch / compress BPM anchored at Beat 1', context: 'Beatgrid Editor' },
  { keys: ['+', '-', 'Scroll'], action: 'Zoom beatgrid waveform in / out', context: 'Beatgrid Editor' },
  { keys: ['Esc'], action: 'Close Beatgrid Editor', context: 'Beatgrid Editor' },

  { keys: ['Space'], action: 'Play / Pause loop in Beat Edit', context: 'Beat Edit Window' },
  { keys: ['←', '→'], action: 'Nudge selected clip (±1 ms)', context: 'Beat Edit Window' },
  { keys: ['Shift + ← / →'], action: 'Fine nudge selected clip (±0.5 ms)', context: 'Beat Edit Window' },
  { keys: ['Alt + ← / →'], action: 'Coarse nudge selected clip (±10 ms)', context: 'Beat Edit Window' },
  { keys: ['Shift + Drag'], action: '10× fine clip slide or fine loop boundary drag', context: 'Beat Edit Window' },
  { keys: ['+', '-', 'Ctrl + Scroll'], action: 'Zoom Beat Edit view in / out', context: 'Beat Edit Window' },
  { keys: ['Esc'], action: 'Close Beat Edit window', context: 'Beat Edit Window' },

  { keys: ['↑ / →', '↓ / ←'], action: 'Increment / decrement focused knob or master fader', context: 'Controls' },
  { keys: ['Double-Click'], action: 'Reset knob to default or reset floating menu position', context: 'Controls' },
];

