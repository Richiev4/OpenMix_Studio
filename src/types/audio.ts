export type FadeCurve = 'linear' | 'scurve' | 'exponential';

export type SnapMode = 'bar' | 'half-beat' | 'quarter-beat' | 'off';

export type AutomationParam = 'volume' | 'pan' | 'filterCutoff' | 'fxWet' | 'speed';

export type AutomationCurveType = 'linear' | 'smooth' | 'step';

export type ExportFormat = 'wav16' | 'wav24' | 'mp3' | 'aac' | 'webm';

export type LossyBitrateKbps = 128 | 192 | 256 | 320;

export type BassMixMode = 'none' | 'swap' | 'crossfade';

export type EqBandMixMode = 'none' | 'crossfade';

export type FilterMixMode = 'none' | 'hpf-out' | 'lpf-in' | 'dual';

export type MixPresetId = 'bass-swap' | 'smooth-blend' | 'filter-sweep' | 'volume-only' | 'custom';

export interface AutoMixDefaults {
  /** Whether dropping/adding a track auto-overlaps and applies transition curves with the previous track */
  enabled: boolean;
  /** Selected preset name or 'custom' */
  preset: MixPresetId;
  /** Number of 4/4 bars to overlap the previous track */
  overlapBars: number;
  /** Crossfade clip volume over the overlap duration */
  volumeCrossfade: boolean;
  /** Fade curve shape applied to volume crossfades */
  fadeCurve: FadeCurve;
  /** Bass (Low EQ) transition style */
  bassMode: BassMixMode;
  /** Low EQ cut depth in dB during transition (negative value, e.g., -24) */
  bassCutDb: number;
  /** Mid EQ transition style */
  midMode: EqBandMixMode;
  /** High EQ transition style */
  highMode: EqBandMixMode;
  /** Filter sweep transition style */
  filterMode: FilterMixMode;
}

export interface ClipMixEnvelope {
  /** Duration of this incoming or outgoing transition in seconds */
  durationSec: number;
  /** Overlap length in bars associated with this transition */
  overlapBars: number;
  /** Whether clip volume fades during this transition */
  volumeCrossfade: boolean;
  /** Bass (Low EQ) transition mode */
  bassMode: BassMixMode;
  /** Low EQ cut depth in dB (negative value, e.g., -24) */
  bassCutDb: number;
  /** Mid EQ crossfade mode */
  midMode: EqBandMixMode;
  /** High EQ crossfade mode */
  highMode: EqBandMixMode;
  /** Filter sweep mode */
  filterMode: FilterMixMode;
  /** Optional ID of the adjacent paired clip in this transition */
  pairedClipId?: string;
}

export interface TrackAsset {
  id: string;
  name: string;
  fileName: string;
  /** Path relative to a linked DJ Folder (e.g., "House/Groove.wav") when imported from a folder */
  relativePath?: string;
  fileSize: number;
  lastModified?: number;
  duration: number;
  sampleRate: number;
  channels: number;
  audioBuffer: AudioBuffer;
  /** Downsampled peak amplitudes [0..1] for fast canvas rendering */
  waveformPeaks: Float32Array;
  /** Low/Mid/High energy bands [0..1] per peak bucket for RGB-style frequency coloring */
  waveformBands: {
    low: Float32Array;
    mid: Float32Array;
    high: Float32Array;
  };
  bpm: number;
  beatOffsetSec: number;
  /** True when the user has manually edited the beatgrid/BPM/offset and protected it from auto-rescan */
  manualBeatgrid?: boolean;
  musicalKey: string;
  camelotCode: string;
  orderIndex: number;
}

export interface AutomationPoint {
  id: string;
  timeSec: number;
  /** Normalized [0..1] value mapped to the parameter range */
  value: number;
  curve: AutomationCurveType;
}

export interface AutomationLane {
  param: AutomationParam;
  visible: boolean;
  points: AutomationPoint[];
}

export interface TrackEffectSettings {
  filterEnabled: boolean;
  /** -1 (LPF) .. 0 (Bypass) .. +1 (HPF) */
  filterValue: number;
  filterResonance: number;
  eqLow: number; // -18..+12 dB
  eqMid: number;
  eqHigh: number;
  delayEnabled: boolean;
  delayTimeSec: number;
  delayFeedback: number;
  delayWet: number;
  reverbEnabled: boolean;
  reverbSize: number; // 0.2..3.0 s
  reverbWet: number;
  driveEnabled: boolean;
  driveAmount: number; // 0..1
}

export interface NleClip {
  id: string;
  trackAssetId: string;
  laneId: string;
  /** Position on the global timeline in seconds */
  startSec: number;
  /** Trim offset from start of source AudioBuffer in seconds */
  offsetSec: number;
  /** Active audible duration on the timeline in seconds */
  durationSec: number;
  fadeInSec: number;
  fadeOutSec: number;
  /** Optional delay from clip start before Volume Fade In begins (silence before this point) */
  fadeInStartSec?: number;
  /** Optional inset from clip end where Volume Fade Out finishes (silence after this point) */
  fadeOutEndSec?: number;
  /** Non-destructive toggle for per-clip Volume Fade In (defaults to true when omitted) */
  fadeInEnabled?: boolean;
  /** Non-destructive toggle for per-clip Volume Fade Out (defaults to true when omitted) */
  fadeOutEnabled?: boolean;
  /** Independent per-clip Bass (Low EQ) fade-in duration in seconds */
  bassFadeInSec?: number;
  /** Independent per-clip Bass (Low EQ) fade-out duration in seconds */
  bassFadeOutSec?: number;
  /** Non-destructive toggle for per-clip Bass Fade In (defaults to true when omitted) */
  bassFadeInEnabled?: boolean;
  /** Non-destructive toggle for per-clip Bass Fade Out (defaults to true when omitted) */
  bassFadeOutEnabled?: boolean;
  /** Optional delay from clip start before Bass Fade In begins (full cut before this point) */
  bassFadeInStartSec?: number;
  /** Optional inset from clip end where Bass Fade Out finishes (full cut after this point) */
  bassFadeOutEndSec?: number;
  fadeCurve: FadeCurve;
  /** Independent curve shape for clip start fade-in (falls back to fadeCurve) */
  fadeInCurve?: FadeCurve;
  /** Independent curve shape for clip end fade-out (falls back to fadeCurve) */
  fadeOutCurve?: FadeCurve;
  /** Manual curve bend for Volume Fade In (-1 = concave/late, 0 = default, +1 = convex/early) */
  fadeInCurveTension?: number;
  /** Manual curve bend for Volume Fade Out (-1 = fast drop, 0 = default, +1 = hold longer) */
  fadeOutCurveTension?: number;
  /** Manual curve bend or swap-point shift for Bass Fade In (-1..+1, 0 = default) */
  bassFadeInCurveTension?: number;
  /** Manual curve bend or swap-point shift for Bass Fade Out (-1..+1, 0 = default) */
  bassFadeOutCurveTension?: number;
  /** Time-stretch clip to match project masterBpm without pitch shift */
  stretchToMasterBpm: boolean;
  pitchSemitones: number;
  gainDb: number; // -24..+12 dB
  /** Per-clip incoming transition envelope (when mixing in from a previous track) */
  mixIn?: ClipMixEnvelope;
  /** Per-clip outgoing transition envelope (when mixing out to a subsequent track) */
  mixOut?: ClipMixEnvelope;
}

export interface NleTrack {
  id: string;
  name: string;
  accentColor: string;
  volume: number; // 0..1.25
  pan: number; // -1..+1
  muted: boolean;
  soloed: boolean;
  showEffects: boolean;
  showAutomation: boolean;
  activeAutomationParam: AutomationParam;
  effects: TrackEffectSettings;
  automationLanes: Record<AutomationParam, AutomationLane>;
  clips: NleClip[];
}

export interface TempoPoint {
  id: string;
  timeSec: number;
  /** Instantaneous timeline BPM at this anchor point */
  bpm: number;
  curve: AutomationCurveType;
}

export interface NleProjectState {
  masterBpm: number;
  /** Preserve musical pitch during tempo changes (true = Key Lock, false = Vinyl/Repitch) */
  keyLock?: boolean;
  /** Master output gain multiplier (0..1.25, defaults to 0.92) */
  masterVolume?: number;
  showTempoLane: boolean;
  showBeatMarkers?: boolean;
  tempoPoints: TempoPoint[];
  snapMode: SnapMode;
  /** When true (default), moving an earlier clip shifts all subsequent clips across all tracks by the same delta */
  rippleMove?: boolean;
  zoomPxPerSec: number;
  playheadSec: number;
  isPlaying: boolean;
  loopEnabled: boolean;
  loopStartSec: number;
  loopEndSec: number;
  defaultMixOptions?: AutoMixDefaults;
  tracks: NleTrack[];
}

/** Lightweight track metadata stored in saved project files without raw audio buffers */
export interface SerializedTrackRef {
  id: string;
  name: string;
  fileName: string;
  relativePath?: string;
  fileSize: number;
  duration: number;
  bpm: number;
  beatOffsetSec: number;
  manualBeatgrid?: boolean;
  musicalKey: string;
  camelotCode: string;
  orderIndex: number;
}

/** Portable JSON project manifest saved to disk or IndexedDB autosave */
export interface SavedProjectManifest {
  version: 1;
  projectName: string;
  savedAt: string;
  djFolderName?: string;
  trackRefs: SerializedTrackRef[];
  project: Omit<NleProjectState, 'isPlaying'>;
}

/** Lightweight audio metadata extracted before full track import */
export interface TrackAnalysisMeta {
  bpm: number;
  beatOffsetSec: number;
  manualBeatgrid?: boolean;
  musicalKey: string;
  camelotCode: string;
  duration: number;
  analyzedAt: number;
}

export type CompatibilityTier = 'perfect' | 'great' | 'good' | 'stretch' | 'clash';

/** Harmonic (Camelot) and tempo compatibility score between two tracks */
export interface TrackCompatibility {
  score: number; // 0..100
  tier: CompatibilityTier;
  keyRelation: string;
  bpmDiffPct: number;
  isHalfOrDoubleTime: boolean;
}

/** Audio file discovered inside a linked DJ Folder */
export interface FolderAudioFile {
  file: File;
  fileName: string;
  relativePath: string;
  fileSize: number;
  lastModified: number;
  /** Pre-analyzed BPM/Key/duration metadata (cached in IndexedDB) */
  analysis?: TrackAnalysisMeta;
  /** True if decoding failed during pre-scan */
  analysisError?: boolean;
}

export interface MissingTrackInfo {
  trackRef: SerializedTrackRef;
  reason: 'not-found' | 'decode-error';
}

/** Lightweight file metadata entry stored in IndexedDB to detect folder changes across sessions */
export interface FolderFileSnapshotEntry {
  relativePath: string;
  fileName: string;
  fileSize: number;
  lastModified: number;
}

/** Persisted snapshot of the last scanned DJ Folder contents */
export interface DjFolderSnapshot {
  folderName: string;
  scannedAt: number;
  files: FolderFileSnapshotEntry[];
}

/** Summary of file additions, modifications, and removals detected against a prior snapshot */
export interface DjFolderDiffSummary {
  /** True when a prior snapshot for the same folder existed to compare against */
  hasBaseline: boolean;
  addedPaths: string[];
  modifiedPaths: string[];
  removedPaths: string[];
  scannedAt: number;
}
