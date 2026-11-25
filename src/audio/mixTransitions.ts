import type {
  AutoMixDefaults,
  BassMixMode,
  ClipMixEnvelope,
  EqBandMixMode,
  FadeCurve,
  FilterMixMode,
  MixPresetId,
  NleClip,
  NleProjectState,
  NleTrack,
  TrackAsset,
} from '../types/audio';
import {
  evaluateBpmAt,
  getBeatMatchedAssetBpm,
  getBeatsAtTime,
  getTimeAtBeat,
  syncTempoMapToTimeline,
  type TempoMapSource,
} from './tempoMap';

export const DEFAULT_AUTO_MIX_OPTIONS: AutoMixDefaults = {
  enabled: true,
  preset: 'bass-swap',
  overlapBars: 8,
  volumeCrossfade: true,
  fadeCurve: 'scurve',
  bassMode: 'swap',
  bassCutDb: -24,
  midMode: 'crossfade',
  highMode: 'crossfade',
  filterMode: 'none',
};

export interface MixPresetSpec {
  id: Exclude<MixPresetId, 'custom'>;
  label: string;
  description: string;
  options: Omit<AutoMixDefaults, 'enabled' | 'preset' | 'overlapBars'>;
}

export const MIX_PRESETS: MixPresetSpec[] = [
  {
    id: 'bass-swap',
    label: 'Bass Swap',
    description: 'Volume crossfade + midpoint Bass swap + High blend',
    options: {
      volumeCrossfade: true,
      fadeCurve: 'scurve',
      bassMode: 'swap',
      bassCutDb: -24,
      midMode: 'crossfade',
      highMode: 'crossfade',
      filterMode: 'none',
    },
  },
  {
    id: 'smooth-blend',
    label: 'Smooth Blend',
    description: 'Gradual Volume + Low/Mid/High EQ crossfade',
    options: {
      volumeCrossfade: true,
      fadeCurve: 'scurve',
      bassMode: 'crossfade',
      bassCutDb: -24,
      midMode: 'crossfade',
      highMode: 'crossfade',
      filterMode: 'none',
    },
  },
  {
    id: 'filter-sweep',
    label: 'Filter Sweep',
    description: 'HPF out on previous track + LPF sweep in on next',
    options: {
      volumeCrossfade: true,
      fadeCurve: 'scurve',
      bassMode: 'swap',
      bassCutDb: -24,
      midMode: 'none',
      highMode: 'none',
      filterMode: 'dual',
    },
  },
  {
    id: 'volume-only',
    label: 'Volume Only',
    description: 'Pure equal-shape volume crossfade without EQ or filter',
    options: {
      volumeCrossfade: true,
      fadeCurve: 'scurve',
      bassMode: 'none',
      bassCutDb: -24,
      midMode: 'none',
      highMode: 'none',
      filterMode: 'none',
    },
  },
];

/**
 * Normalizes a potentially missing or partial AutoMixDefaults object from saved state.
 */
export function resolveAutoMixDefaults(
  raw?: Partial<AutoMixDefaults> | null
): AutoMixDefaults {
  if (!raw) return { ...DEFAULT_AUTO_MIX_OPTIONS };
  return {
    enabled: raw.enabled ?? DEFAULT_AUTO_MIX_OPTIONS.enabled,
    preset: raw.preset ?? DEFAULT_AUTO_MIX_OPTIONS.preset,
    overlapBars: clampOverlapBars(raw.overlapBars ?? DEFAULT_AUTO_MIX_OPTIONS.overlapBars),
    volumeCrossfade: raw.volumeCrossfade ?? DEFAULT_AUTO_MIX_OPTIONS.volumeCrossfade,
    fadeCurve: raw.fadeCurve ?? DEFAULT_AUTO_MIX_OPTIONS.fadeCurve,
    bassMode: raw.bassMode ?? DEFAULT_AUTO_MIX_OPTIONS.bassMode,
    bassCutDb: clampBassCutDb(raw.bassCutDb ?? DEFAULT_AUTO_MIX_OPTIONS.bassCutDb),
    midMode: raw.midMode ?? DEFAULT_AUTO_MIX_OPTIONS.midMode,
    highMode: raw.highMode ?? DEFAULT_AUTO_MIX_OPTIONS.highMode,
    filterMode: raw.filterMode ?? DEFAULT_AUTO_MIX_OPTIONS.filterMode,
  };
}

export function clampOverlapBars(bars: number): number {
  if (!Number.isFinite(bars)) return 8;
  return Math.max(0, Math.min(64, Math.round(bars * 4) / 4));
}

export function clampBassCutDb(db: number): number {
  if (!Number.isFinite(db)) return -24;
  return Math.max(-36, Math.min(-6, Math.round(db)));
}

/**
 * Applies a named mix preset while preserving enabled state and overlap bar count.
 */
export function applyMixPreset(
  presetId: Exclude<MixPresetId, 'custom'>,
  current: AutoMixDefaults
): AutoMixDefaults {
  const spec = MIX_PRESETS.find((p) => p.id === presetId) ?? MIX_PRESETS[0];
  return {
    ...current,
    preset: spec.id,
    ...spec.options,
  };
}

/**
 * Computes exact duration (seconds) of `overlapBars` (4 beats/bar) ending at `endTimeSec`
 * under the project's active Tempo Map.
 */
export function getOverlapDurationBeforeTime(
  tempoSrc: TempoMapSource,
  endTimeSec: number,
  overlapBars: number
): number {
  if (overlapBars <= 0 || endTimeSec <= 0) return 0;
  const endBeats = getBeatsAtTime(tempoSrc, endTimeSec);
  const overlapBeats = overlapBars * 4;
  const startBeats = Math.max(0, endBeats - overlapBeats);
  const startSec = getTimeAtBeat(tempoSrc, startBeats);
  return Math.max(0, endTimeSec - startSec);
}

/**
 * Computes exact duration (seconds) of `overlapBars` (4 beats/bar) starting at `startTimeSec`
 * under the project's active Tempo Map.
 */
export function getOverlapDurationFromStart(
  tempoSrc: TempoMapSource,
  startTimeSec: number,
  overlapBars: number
): number {
  if (overlapBars <= 0) return 0;
  const startBeats = getBeatsAtTime(tempoSrc, Math.max(0, startTimeSec));
  const endSec = getTimeAtBeat(tempoSrc, startBeats + overlapBars * 4);
  return Math.max(0, endSec - Math.max(0, startTimeSec));
}

export interface ClipLookupResult {
  track: NleTrack;
  clip: NleClip;
  endSec: number;
}

/**
 * Finds the previous clip across all lanes to mix with.
 * Prefers clips ending near or before `referenceSec` if provided, otherwise returns the latest clip overall.
 */
export function findPreviousClip(
  tracks: NleTrack[],
  excludeClipId?: string,
  preferBeforeEndSec?: number
): ClipLookupResult | null {
  const all: ClipLookupResult[] = [];
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (excludeClipId && clip.id === excludeClipId) continue;
      all.push({
        track,
        clip,
        endSec: clip.startSec + clip.durationSec,
      });
    }
  }
  if (all.length === 0) return null;

  if (preferBeforeEndSec !== undefined) {
    const candidates = all.filter((item) => item.clip.startSec < preferBeforeEndSec - 0.05);
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.endSec - a.endSec);
      return candidates[0];
    }
  }

  all.sort((a, b) => b.endSec - a.endSec);
  return all[0];
}

/**
 * Finds a clip by ID across all tracks.
 */
export function findClipById(
  tracks: NleTrack[],
  clipId?: string
): ClipLookupResult | null {
  if (!clipId) return null;
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.id === clipId) {
        return { track, clip, endSec: clip.startSec + clip.durationSec };
      }
    }
  }
  return null;
}

/**
 * Creates a ClipMixEnvelope from AutoMixDefaults and an exact transition duration.
 */
export function buildMixEnvelopeFromDefaults(
  defaults: AutoMixDefaults,
  durationSec: number,
  pairedClipId?: string
): ClipMixEnvelope {
  return {
    durationSec: Math.round(Math.max(0, durationSec) * 1000) / 1000,
    overlapBars: defaults.overlapBars,
    volumeCrossfade: defaults.volumeCrossfade,
    bassMode: defaults.bassMode,
    bassCutDb: defaults.bassCutDb,
    midMode: defaults.midMode,
    highMode: defaults.highMode,
    filterMode: defaults.filterMode,
    pairedClipId,
  };
}

/**
 * Evaluates whether a ClipMixEnvelope has any audible EQ or filter processing.
 */
export function hasActiveEqOrFilterTransition(env?: ClipMixEnvelope | null): boolean {
  if (!env || env.durationSec <= 0.01) return false;
  return (
    env.bassMode !== 'none' ||
    env.midMode !== 'none' ||
    env.highMode !== 'none' ||
    env.filterMode !== 'none'
  );
}

export const DEFAULT_BASS_FADE_CUT_DB = -24;

/**
 * Returns whether a clip's Volume fade is enabled for the given direction.
 * Defaults to true when omitted for backward compatibility.
 */
export function isClipVolumeFadeEnabled(clip: NleClip, direction: 'in' | 'out'): boolean {
  return (direction === 'in' ? clip.fadeInEnabled : clip.fadeOutEnabled) !== false;
}

/**
 * Resolves a clip's configured Volume fade settings regardless of whether
 * the volume fade is currently bypassed, so UI controls can preserve durations/offsets.
 */
export function getConfiguredClipVolumeFade(
  clip: NleClip,
  direction: 'in' | 'out'
): {
  offsetSec: number;
  durationSec: number;
  enabled: boolean;
  curve: FadeCurve;
  curveTension: number;
} {
  const enabled = isClipVolumeFadeEnabled(clip, direction);
  const offsetSec = Math.max(
    0,
    (direction === 'in' ? clip.fadeInStartSec : clip.fadeOutEndSec) ?? 0
  );
  const durationSec = Math.max(0, direction === 'in' ? clip.fadeInSec : clip.fadeOutSec);
  const curve = (direction === 'in' ? clip.fadeInCurve : clip.fadeOutCurve) ?? clip.fadeCurve;
  const curveTension = clampCurveTension(
    direction === 'in' ? clip.fadeInCurveTension : clip.fadeOutCurveTension
  );
  return {
    offsetSec,
    durationSec,
    enabled,
    curve,
    curveTension,
  };
}

/**
 * Resolves a clip's active Volume fade bounds, returning zero offset/duration when bypassed.
 */
export function getEffectiveClipVolumeFade(
  clip: NleClip,
  direction: 'in' | 'out'
): {
  offsetSec: number;
  durationSec: number;
  curve: FadeCurve;
  curveTension: number;
} {
  const configured = getConfiguredClipVolumeFade(clip, direction);
  if (!configured.enabled) {
    return {
      offsetSec: 0,
      durationSec: 0,
      curve: configured.curve,
      curveTension: configured.curveTension,
    };
  }
  return {
    offsetSec: configured.offsetSec,
    durationSec: configured.durationSec,
    curve: configured.curve,
    curveTension: configured.curveTension,
  };
}

/**
 * Returns whether a clip's Bass (Low EQ) fade is enabled for the given direction.
 * Defaults to true when omitted for backward compatibility.
 */
export function isClipBassFadeEnabled(clip: NleClip, direction: 'in' | 'out'): boolean {
  return (direction === 'in' ? clip.bassFadeInEnabled : clip.bassFadeOutEnabled) !== false;
}

export function clampCurveTension(tension?: number): number {
  if (typeof tension !== 'number' || !Number.isFinite(tension)) return 0;
  return Math.max(-1, Math.min(1, tension));
}

/**
 * Applies a continuous concave/convex bend (`tension` in [-1..+1]) to a normalized [0..1] level.
 * Positive tension bows the curve upward (higher midpoint level); negative bows downward.
 */
export function applyCurveTension(y: number, tension = 0): number {
  const clampedY = Math.max(0, Math.min(1, y));
  const t = clampCurveTension(tension);
  if (Math.abs(t) < 0.001) return clampedY;
  if (t > 0) {
    return 1 - Math.pow(1 - clampedY, 1 + t * 3);
  }
  return Math.pow(clampedY, 1 + Math.abs(t) * 3);
}

/**
 * Evaluates a normalized [0..1] Volume fade gain for normalized progress `x` in [0..1]
 * (0 = silent end, 1 = full volume end) with optional manual curve tension.
 */
export function evaluateVolumeFadeGain(
  x: number,
  curve: FadeCurve,
  tension = 0
): number {
  const clamped = Math.max(0, Math.min(1, x));
  let base: number;
  if (curve === 'linear') base = clamped;
  else if (curve === 'scurve') base = 0.5 - 0.5 * Math.cos(Math.PI * clamped);
  else base = Math.pow(clamped, 2.2);
  return applyCurveTension(base, tension);
}

/**
 * Resolves the normalized [0.12..0.88] swap center position for DJ Bass Swap curves.
 * Positive tension raises midpoint bass (earlier swap-in, later swap-out).
 */
export function getBassSwapCenterFraction(
  direction: 'in' | 'out',
  tension = 0
): number {
  const t = clampCurveTension(tension);
  const center = direction === 'in' ? 0.5 - t * 0.38 : 0.5 + t * 0.38;
  return Math.max(0.12, Math.min(0.88, center));
}

/**
 * Resolves a clip's configured Bass (Low EQ) fade settings regardless of whether
 * the bass fade is currently bypassed, so UI controls can preserve durations/offsets.
 */
export function getConfiguredClipBassFade(
  clip: NleClip,
  direction: 'in' | 'out'
): {
  offsetSec: number;
  durationSec: number;
  mode: Exclude<BassMixMode, 'none'>;
  cutDb: number;
  enabled: boolean;
  curveTension: number;
} {
  const enabled = isClipBassFadeEnabled(clip, direction);
  const explicitOffset =
    direction === 'in' ? clip.bassFadeInStartSec : clip.bassFadeOutEndSec;
  const offsetSec = Math.max(0, explicitOffset ?? 0);
  const explicitDur = direction === 'in' ? clip.bassFadeInSec : clip.bassFadeOutSec;
  const curveTension = clampCurveTension(
    direction === 'in' ? clip.bassFadeInCurveTension : clip.bassFadeOutCurveTension
  );
  const env = direction === 'in' ? clip.mixIn : clip.mixOut;
  const mode: Exclude<BassMixMode, 'none'> =
    env && env.bassMode !== 'none' ? env.bassMode : 'crossfade';
  const cutDb = env ? env.bassCutDb : DEFAULT_BASS_FADE_CUT_DB;

  if (explicitDur !== undefined) {
    return {
      offsetSec,
      durationSec: Math.max(0, explicitDur),
      mode,
      cutDb,
      enabled,
      curveTension,
    };
  }

  if (env && env.bassMode !== 'none' && env.durationSec > 0.01) {
    return {
      offsetSec,
      durationSec: env.durationSec,
      mode: env.bassMode,
      cutDb: env.bassCutDb,
      enabled,
      curveTension,
    };
  }

  return {
    offsetSec,
    durationSec: 0,
    mode: 'crossfade',
    cutDb: DEFAULT_BASS_FADE_CUT_DB,
    enabled,
    curveTension,
  };
}

/**
 * Resolves a clip's active Bass (Low EQ) fade duration, mode, and cut depth,
 * honoring independent `bassFadeInSec`/`bassFadeOutSec` values and per-clip
 * `bassFadeInEnabled`/`bassFadeOutEnabled` toggles while remaining backward-compatible.
 */
export function getEffectiveClipBassFade(
  clip: NleClip,
  direction: 'in' | 'out'
): {
  offsetSec: number;
  durationSec: number;
  mode: Exclude<BassMixMode, 'none'>;
  cutDb: number;
  curveTension: number;
} {
  const configured = getConfiguredClipBassFade(clip, direction);
  if (!configured.enabled) {
    return {
      offsetSec: 0,
      durationSec: 0,
      mode: configured.mode,
      cutDb: configured.cutDb,
      curveTension: configured.curveTension,
    };
  }
  return {
    offsetSec: configured.offsetSec,
    durationSec: configured.durationSec,
    mode: configured.mode,
    cutDb: configured.cutDb,
    curveTension: configured.curveTension,
  };
}

/**
 * Evaluates normalized Bass (Low EQ) level [0..1] (0 = full cut, 1 = 0 dB unity)
 * at normalized transition progress `t` in [0..1] with optional manual curve tension.
 */
export function evaluateBassTransitionFraction(
  t: number,
  direction: 'in' | 'out',
  mode: Exclude<BassMixMode, 'none'>,
  tension = 0
): number {
  const clamped = Math.max(0, Math.min(1, t));
  if (mode === 'swap') {
    // Smooth DJ bass swap centered around configurable midpoint (default 42%..58%)
    const center = getBassSwapCenterFraction(direction, tension);
    const halfWin = 0.08;
    const swapT = Math.max(0, Math.min(1, (clamped - (center - halfWin)) / (halfWin * 2)));
    const smooth = 0.5 - 0.5 * Math.cos(Math.PI * swapT);
    return direction === 'in' ? smooth : 1 - smooth;
  }
  const smooth = 0.5 - 0.5 * Math.cos(Math.PI * clamped);
  const base = direction === 'in' ? smooth : 1 - smooth;
  return applyCurveTension(base, tension);
}

/**
 * Generates normalized Web Audio curve values for a clip's Bass/Mid/High EQ transition in dB.
 * `direction === 'in'` transitions from cut -> 0 dB.
 * `direction === 'out'` transitions from 0 dB -> cut.
 */
export function buildEqTransitionCurve(
  direction: 'in' | 'out',
  mode: BassMixMode | EqBandMixMode,
  cutDb: number,
  steps = 64,
  tension = 0
): Float32Array {
  const arr = new Float32Array(steps);
  if (mode === 'none') {
    arr.fill(0);
    return arr;
  }

  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const gainFrac = evaluateBassTransitionFraction(t, direction, mode, tension);
    arr[i] = cutDb * (1 - gainFrac);
  }
  return arr;
}

/**
 * Generates exponential frequency sweep values (Hz) for incoming LPF or outgoing HPF transitions.
 */
export function buildFilterSweepCurve(
  direction: 'in' | 'out',
  filterMode: FilterMixMode,
  steps = 64
): { type: 'lowpass' | 'highpass'; values: Float32Array } | null {
  if (direction === 'in' && (filterMode === 'lpf-in' || filterMode === 'dual')) {
    const values = new Float32Array(steps);
    const minHz = 220;
    const maxHz = 20000;
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const curved = Math.pow(t, 1.35);
      values[i] = minHz * Math.pow(maxHz / minHz, curved);
    }
    return { type: 'lowpass', values };
  }

  if (direction === 'out' && (filterMode === 'hpf-out' || filterMode === 'dual')) {
    const values = new Float32Array(steps);
    const minHz = 24;
    const maxHz = 2400;
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const curved = Math.pow(t, 1.6);
      values[i] = minHz * Math.pow(maxHz / minHz, curved);
    }
    return { type: 'highpass', values };
  }

  return null;
}

/**
 * Formats a concise human-readable badge string summarizing active mix parameters on a clip.
 */
export function formatMixSummaryBadges(
  env?: ClipMixEnvelope | null,
  options?: { bassEnabled?: boolean }
): string[] {
  if (!env || env.durationSec <= 0.01) return [];
  const bassEnabled = options?.bassEnabled ?? true;
  const badges: string[] = [];
  if (env.overlapBars > 0) {
    badges.push(`${env.overlapBars}B`);
  }
  if (bassEnabled) {
    if (env.bassMode === 'swap') badges.push('BASS SWAP');
    else if (env.bassMode === 'crossfade') badges.push('BASS XF');
  }
  if (env.midMode === 'crossfade') badges.push('MID XF');
  if (env.highMode === 'crossfade') badges.push('HI XF');
  if (env.filterMode === 'dual') badges.push('FILTER');
  else if (env.filterMode === 'lpf-in') badges.push('LPF IN');
  else if (env.filterMode === 'hpf-out') badges.push('HPF OUT');
  return badges;
}

/**
 * Computes an incoming clip's start position and overlap duration aligned to the
 * outgoing clip's musical beat/bar grid (`beatOffsetSec`) so transients lock together
 * instead of flamming during transitions.
 */
export function computeBeatAlignedOverlap(params: {
  tempoSrc: TempoMapSource;
  prevClip: NleClip;
  prevAsset?: Pick<TrackAsset, 'bpm' | 'beatOffsetSec'>;
  incomingDurationSec: number;
  incomingOffsetSec?: number;
  incomingAsset?: Pick<TrackAsset, 'bpm' | 'beatOffsetSec'>;
  overlapBars: number;
}): {
  alignedStartSec: number;
  overlapSec: number;
} {
  const {
    tempoSrc,
    prevClip,
    prevAsset,
    incomingDurationSec,
    incomingOffsetSec = 0,
    incomingAsset,
    overlapBars,
  } = params;

  const prevEnd = prevClip.startSec + prevClip.durationSec;
  const rawOverlapSec = getOverlapDurationBeforeTime(tempoSrc, prevEnd, overlapBars);
  const maxAllowedOverlap = Math.min(
    prevClip.durationSec * 0.75,
    incomingDurationSec * 0.75
  );
  const fallbackOverlap = Math.max(0, Math.min(rawOverlapSec, maxAllowedOverlap));

  const sameNativeBpm =
    prevAsset &&
    incomingAsset &&
    prevAsset.bpm > 0 &&
    incomingAsset.bpm > 0 &&
    Math.abs(prevAsset.bpm - incomingAsset.bpm) < 0.05;

  if (
    overlapBars <= 0 ||
    fallbackOverlap <= 0.05 ||
    (!prevClip.stretchToMasterBpm && !sameNativeBpm) ||
    !prevAsset ||
    !incomingAsset ||
    prevAsset.bpm <= 0 ||
    incomingAsset.bpm <= 0
  ) {
    return {
      alignedStartSec: Math.max(0, prevEnd - fallbackOverlap),
      overlapSec: fallbackOverlap,
    };
  }

  const prevMapBpm = evaluateBpmAt(tempoSrc, Math.max(0, prevClip.startSec));
  const prevBpm = getBeatMatchedAssetBpm(prevAsset.bpm, prevMapBpm);
  const prevBeatOffset = Number.isFinite(prevAsset.beatOffsetSec)
    ? prevAsset.beatOffsetSec
    : 0;
  const inBpm = getBeatMatchedAssetBpm(incomingAsset.bpm, prevBpm);
  const inBeatOffset = Number.isFinite(incomingAsset.beatOffsetSec)
    ? incomingAsset.beatOffsetSec
    : 0;

  const prevStartTimelineBeats = getBeatsAtTime(tempoSrc, prevClip.startSec);
  const prevEndTimelineBeats = getBeatsAtTime(tempoSrc, prevEnd);
  const prevOffsetBeats = ((prevClip.offsetSec - prevBeatOffset) * prevBpm) / 60;
  const beatGridBase = prevStartTimelineBeats - prevOffsetBeats;
  const rawInLeadBeats = ((inBeatOffset - Math.max(0, incomingOffsetSec)) * inBpm) / 60;
  const inLeadBeats = ((rawInLeadBeats % 4) + 4) % 4;

  const targetStartTimelineBeats = prevEndTimelineBeats - overlapBars * 4;
  const rawK = targetStartTimelineBeats + inLeadBeats - beatGridBase;

  const tryBeatIndex = (
    k: number
  ): { startSec: number; overlapSec: number } | null => {
    const bTarget = beatGridBase + k;
    const bStart = bTarget - inLeadBeats;
    if (bStart < 0) return null;
    const startSec = getTimeAtBeat(tempoSrc, bStart);
    const overlapSec = prevEnd - startSec;
    if (overlapSec > 0.05 && overlapSec <= maxAllowedOverlap) {
      return { startSec, overlapSec };
    }
    return null;
  };

  // Prefer 4-beat downbeat alignment when within [50%..100%] of allowed overlap
  const barK = Math.round(rawK / 4) * 4;
  for (const offset of [0, 4, -4]) {
    const res = tryBeatIndex(barK + offset);
    if (res && res.overlapSec >= fallbackOverlap * 0.5) {
      return {
        alignedStartSec: res.startSec,
        overlapSec: res.overlapSec,
      };
    }
  }

  // Fallback to nearest individual beat alignment
  const beatK = Math.round(rawK);
  for (let step = 0; step <= 8; step++) {
    const plus = tryBeatIndex(beatK + step);
    if (plus) return { alignedStartSec: plus.startSec, overlapSec: plus.overlapSec };
    if (step > 0) {
      const minus = tryBeatIndex(beatK - step);
      if (minus) return { alignedStartSec: minus.startSec, overlapSec: minus.overlapSec };
    }
  }

  return {
    alignedStartSec: Math.max(0, prevEnd - fallbackOverlap),
    overlapSec: fallbackOverlap,
  };
}

/**
 * Computes how a newly dropped/added clip should be positioned and configured
 * when Auto-Mix is enabled, returning the new clip + optional patch for the previous clip.
 */
export function computeAutoMixPlacement(params: {
  project: NleProjectState;
  targetTrackId: string;
  assetId: string;
  assetDuration: number;
  requestedStartSec: number;
  assetsMap?: Map<string, TrackAsset>;
  bypassAutoMix?: boolean;
  isQuickAdd?: boolean;
}): {
  newClip: NleClip;
  previousClipPatch?: {
    trackId: string;
    clipId: string;
    patch: Partial<NleClip>;
  };
} {
  const {
    project,
    targetTrackId,
    assetId,
    assetDuration,
    requestedStartSec,
    assetsMap,
    bypassAutoMix = false,
    isQuickAdd = false,
  } = params;

  const mixDefaults = resolveAutoMixDefaults(project.defaultMixOptions);
  const clipId = `clip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const prevResult =
    mixDefaults.enabled && !bypassAutoMix
      ? findPreviousClip(project.tracks)
      : null;

  if (!prevResult) {
    return {
      newClip: {
        id: clipId,
        trackAssetId: assetId,
        laneId: targetTrackId,
        startSec: Math.max(0, requestedStartSec),
        offsetSec: 0,
        durationSec: assetDuration,
        fadeInSec: 0,
        fadeOutSec: 0,
        bassFadeInSec: 0,
        bassFadeOutSec: 0,
        fadeCurve: mixDefaults.fadeCurve,
        fadeInCurve: mixDefaults.fadeCurve,
        fadeOutCurve: mixDefaults.fadeCurve,
        stretchToMasterBpm: true,
        pitchSemitones: 0,
        gainDb: 0,
      },
    };
  }

  const prevClip = prevResult.clip;
  const prevAsset = assetsMap?.get(prevClip.trackAssetId);
  const incomingAsset = assetsMap?.get(assetId);

  let { alignedStartSec, overlapSec } = computeBeatAlignedOverlap({
    tempoSrc: project,
    prevClip,
    prevAsset,
    incomingDurationSec: assetDuration,
    incomingAsset,
    overlapBars: mixDefaults.overlapBars,
  });

  // Second pass with the projected tempo ramp when incoming track has a different BPM
  // so overlapSec and beat alignment stay exact across the actual transition ramp.
  if (
    assetsMap &&
    prevAsset &&
    incomingAsset &&
    Math.abs(getBeatMatchedAssetBpm(incomingAsset.bpm, prevAsset.bpm) - prevAsset.bpm) >= 0.005
  ) {
    const tentativeClip: NleClip = {
      id: clipId,
      trackAssetId: assetId,
      laneId: targetTrackId,
      startSec: Math.max(0, alignedStartSec),
      offsetSec: 0,
      durationSec: assetDuration,
      fadeInSec: 0,
      fadeOutSec: 0,
      fadeCurve: mixDefaults.fadeCurve,
      stretchToMasterBpm: true,
      pitchSemitones: 0,
      gainDb: 0,
    };
    const projectedTracks = project.tracks.map((t) =>
      t.id === targetTrackId ? { ...t, clips: [...t.clips, tentativeClip] } : t
    );
    const projectedTempo = syncTempoMapToTimeline(
      { masterBpm: project.masterBpm, tracks: projectedTracks },
      assetsMap
    );
    const refined = computeBeatAlignedOverlap({
      tempoSrc: projectedTempo,
      prevClip,
      prevAsset,
      incomingDurationSec: assetDuration,
      incomingAsset,
      overlapBars: mixDefaults.overlapBars,
    });
    alignedStartSec = refined.alignedStartSec;
    overlapSec = refined.overlapSec;
  }

  // Position incoming clip to overlap the end of the previous clip on the beat grid
  const alignedStart = Math.max(
    0,
    isQuickAdd || mixDefaults.enabled ? alignedStartSec : requestedStartSec
  );

  const effectiveFadeSec = mixDefaults.volumeCrossfade ? overlapSec : 0;
  const effectiveBassFadeSec = mixDefaults.bassMode !== 'none' ? overlapSec : 0;

  const mixIn = buildMixEnvelopeFromDefaults(mixDefaults, overlapSec, prevClip.id);
  const mixOut = buildMixEnvelopeFromDefaults(mixDefaults, overlapSec, clipId);

  const newClip: NleClip = {
    id: clipId,
    trackAssetId: assetId,
    laneId: targetTrackId,
    startSec: alignedStart,
    offsetSec: 0,
    durationSec: assetDuration,
    fadeInSec: effectiveFadeSec,
    fadeOutSec: 0,
    bassFadeInSec: effectiveBassFadeSec,
    bassFadeOutSec: 0,
    fadeCurve: mixDefaults.fadeCurve,
    fadeInCurve: mixDefaults.fadeCurve,
    fadeOutCurve: mixDefaults.fadeCurve,
    stretchToMasterBpm: true,
    pitchSemitones: 0,
    gainDb: 0,
    mixIn: overlapSec > 0 ? mixIn : undefined,
  };

  return {
    newClip,
    previousClipPatch:
      overlapSec > 0
        ? {
            trackId: prevResult.track.id,
            clipId: prevClip.id,
            patch: {
              fadeOutSec: effectiveFadeSec,
              bassFadeOutSec: effectiveBassFadeSec,
              fadeOutCurve: mixDefaults.fadeCurve,
              mixOut,
            },
          }
        : undefined,
  };
}

/**
 * Keeps paired incoming/outgoing transition durations and volume fades synchronized
 * with the real overlap window when either clip in a mix pair is moved on the timeline.
 */
export function syncPairedMixOnClipMove(
  tracks: NleTrack[],
  movedClipId: string,
  tempoSrc: TempoMapSource
): NleTrack[] {
  const movedLookup = findClipById(tracks, movedClipId);
  if (!movedLookup) return tracks;

  const patches = new Map<string, Partial<NleClip>>();

  const syncPair = (outClip: NleClip, inClip: NleClip) => {
    const outEnd = outClip.startSec + outClip.durationSec;
    const inEnd = inClip.startSec + inClip.durationSec;
    const overlapStart = Math.max(outClip.startSec, inClip.startSec);
    const overlapEnd = Math.min(outEnd, inEnd);
    const rawOverlap =
      inClip.startSec >= outClip.startSec - 0.05 ? Math.max(0, overlapEnd - overlapStart) : 0;

    const maxDur = Math.min(outClip.durationSec * 0.85, inClip.durationSec * 0.85);
    const nextDur =
      rawOverlap > 0.05 ? Math.round(Math.min(rawOverlap, maxDur) * 1000) / 1000 : 0;

    const nextBars =
      nextDur > 0.05
        ? clampOverlapBars(
            (getBeatsAtTime(tempoSrc, overlapStart + nextDur) -
              getBeatsAtTime(tempoSrc, overlapStart)) /
              4
          )
        : 0;

    if (inClip.mixIn) {
      patches.set(inClip.id, {
        ...(patches.get(inClip.id) ?? {}),
        fadeInSec: inClip.mixIn.volumeCrossfade ? nextDur : 0,
        bassFadeInSec: inClip.mixIn.bassMode !== 'none' ? nextDur : 0,
        mixIn: {
          ...inClip.mixIn,
          durationSec: nextDur,
          overlapBars: nextBars,
        },
      });
    }

    if (outClip.mixOut) {
      patches.set(outClip.id, {
        ...(patches.get(outClip.id) ?? {}),
        fadeOutSec: outClip.mixOut.volumeCrossfade ? nextDur : 0,
        bassFadeOutSec: outClip.mixOut.bassMode !== 'none' ? nextDur : 0,
        mixOut: {
          ...outClip.mixOut,
          durationSec: nextDur,
          overlapBars: nextBars,
        },
      });
    }
  };

  const moved = movedLookup.clip;
  if (moved.mixIn?.pairedClipId) {
    const prevLookup = findClipById(tracks, moved.mixIn.pairedClipId);
    if (prevLookup) {
      syncPair(prevLookup.clip, moved);
    }
  }
  if (moved.mixOut?.pairedClipId) {
    const nextLookup = findClipById(tracks, moved.mixOut.pairedClipId);
    if (nextLookup) {
      syncPair(moved, nextLookup.clip);
    }
  }

  if (patches.size === 0) return tracks;

  return tracks.map((t) => {
    let changed = false;
    const nextClips = t.clips.map((c) => {
      const p = patches.get(c.id);
      if (!p) return c;
      changed = true;
      return { ...c, ...p };
    });
    return changed ? { ...t, clips: nextClips } : t;
  });
}

export interface IncomingMixContext {
  trackId: string;
  clip: NleClip;
  pairedPrevClip: NleClip | null;
  overlapSec: number;
}

/**
 * Resolves whether a timeline clip is mixing with a preceding clip (via an active `mixIn`
 * envelope or a direct timeline overlap with an earlier clip) and returns its paired context.
 */
export function findIncomingMixContext(
  tracks: NleTrack[],
  trackId: string,
  clip: NleClip
): IncomingMixContext | null {
  const hasActiveMixIn = Boolean(clip.mixIn && clip.mixIn.durationSec > 0.01);
  let pairedPrevClip: NleClip | null = null;

  if (clip.mixIn?.pairedClipId) {
    pairedPrevClip = findClipById(tracks, clip.mixIn.pairedClipId)?.clip ?? null;
  }

  let bestOverlap = 0;
  let overlappingPrev: NleClip | null = null;
  const clipEnd = clip.startSec + clip.durationSec;

  for (const t of tracks) {
    for (const other of t.clips) {
      if (other.id === clip.id) continue;
      if (other.startSec >= clip.startSec - 0.05) continue;
      const otherEnd = other.startSec + other.durationSec;
      const ov = Math.min(clipEnd, otherEnd) - Math.max(clip.startSec, other.startSec);
      if (ov > 0.05 && ov > bestOverlap) {
        bestOverlap = ov;
        overlappingPrev = other;
      }
    }
  }

  if (!pairedPrevClip && overlappingPrev) {
    pairedPrevClip = overlappingPrev;
  }

  if (!hasActiveMixIn && !overlappingPrev) {
    return null;
  }

  const overlapSec = hasActiveMixIn
    ? clip.mixIn!.durationSec
    : Math.round(bestOverlap * 1000) / 1000;

  return {
    trackId,
    clip,
    pairedPrevClip,
    overlapSec,
  };
}

function clipSideMatchesPreset(
  clip: NleClip,
  env: ClipMixEnvelope,
  direction: 'in' | 'out',
  spec: MixPresetSpec
): boolean {
  const opts = spec.options;
  if (
    env.volumeCrossfade !== opts.volumeCrossfade ||
    env.bassMode !== opts.bassMode ||
    env.midMode !== opts.midMode ||
    env.highMode !== opts.highMode ||
    env.filterMode !== opts.filterMode
  ) {
    return false;
  }
  if (opts.bassMode !== 'none' && Math.abs(env.bassCutDb - opts.bassCutDb) > 0.5) {
    return false;
  }

  const volCfg = getConfiguredClipVolumeFade(clip, direction);
  if (opts.volumeCrossfade) {
    if (
      !volCfg.enabled ||
      volCfg.offsetSec > 0.02 ||
      Math.abs(volCfg.durationSec - env.durationSec) > 0.06 ||
      volCfg.curve !== opts.fadeCurve ||
      Math.abs(volCfg.curveTension) > 0.01
    ) {
      return false;
    }
  } else if (volCfg.enabled && (volCfg.durationSec > 0.02 || volCfg.offsetSec > 0.02)) {
    return false;
  }

  const bassCfg = getConfiguredClipBassFade(clip, direction);
  if (opts.bassMode !== 'none') {
    if (
      !bassCfg.enabled ||
      bassCfg.offsetSec > 0.02 ||
      Math.abs(bassCfg.durationSec - env.durationSec) > 0.06 ||
      Math.abs(bassCfg.curveTension) > 0.01
    ) {
      return false;
    }
  } else if (bassCfg.enabled && (bassCfg.durationSec > 0.02 || bassCfg.offsetSec > 0.02)) {
    return false;
  }

  return true;
}

/**
 * Detects which built-in mix preset matches a clip's incoming transition (and paired outgoing
 * clip, if present). Returns `'custom'` whenever any parameter or curve has been manually edited.
 */
export function detectClipMixPreset(
  clip: NleClip,
  pairedPrevClip?: NleClip | null
): MixPresetId {
  const inEnv = clip.mixIn;
  if (!inEnv || inEnv.durationSec <= 0.01) {
    return 'custom';
  }

  for (const spec of MIX_PRESETS) {
    if (!clipSideMatchesPreset(clip, inEnv, 'in', spec)) continue;
    if (pairedPrevClip) {
      const outEnv = pairedPrevClip.mixOut;
      if (!outEnv || outEnv.durationSec <= 0.01) continue;
      if (Math.abs(outEnv.durationSec - inEnv.durationSec) > 0.06) continue;
      if (!clipSideMatchesPreset(pairedPrevClip, outEnv, 'out', spec)) continue;
    }
    return spec.id;
  }

  return 'custom';
}

/**
 * Applies a named mix preset to a clip's incoming transition and its paired outgoing clip,
 * resetting manual fade/curve overrides while preserving the current overlap window.
 */
export function applyPresetToClipMix(
  tracks: NleTrack[],
  trackId: string,
  clipId: string,
  presetId: Exclude<MixPresetId, 'custom'>,
  tempoSrc: TempoMapSource
): NleTrack[] {
  const targetTrack = tracks.find((t) => t.id === trackId);
  const targetClip = targetTrack?.clips.find((c) => c.id === clipId);
  if (!targetClip) return tracks;

  const ctx = findIncomingMixContext(tracks, trackId, targetClip);
  if (!ctx) return tracks;

  const spec = MIX_PRESETS.find((p) => p.id === presetId);
  if (!spec) return tracks;

  const prevClip = ctx.pairedPrevClip;
  const maxDur = prevClip
    ? Math.min(targetClip.durationSec * 0.85, prevClip.durationSec * 0.85)
    : targetClip.durationSec * 0.85;
  const durationSec = Math.round(Math.max(0, Math.min(ctx.overlapSec, maxDur)) * 1000) / 1000;
  if (durationSec <= 0.01) return tracks;

  const existingBars = targetClip.mixIn?.overlapBars;
  const overlapBars =
    existingBars && existingBars > 0
      ? existingBars
      : clampOverlapBars(
          (getBeatsAtTime(tempoSrc, targetClip.startSec + durationSec) -
            getBeatsAtTime(tempoSrc, targetClip.startSec)) /
            4
        );

  const opts = spec.options;
  const volDur = opts.volumeCrossfade ? durationSec : 0;
  const bassDur = opts.bassMode !== 'none' ? durationSec : 0;

  const nextMixIn: ClipMixEnvelope = {
    durationSec,
    overlapBars,
    volumeCrossfade: opts.volumeCrossfade,
    bassMode: opts.bassMode,
    bassCutDb: opts.bassCutDb,
    midMode: opts.midMode,
    highMode: opts.highMode,
    filterMode: opts.filterMode,
    pairedClipId: prevClip?.id,
  };

  const nextMixOut: ClipMixEnvelope = {
    ...nextMixIn,
    pairedClipId: targetClip.id,
  };

  return tracks.map((t) => {
    let changed = false;
    const nextClips = t.clips.map((c) => {
      if (c.id === targetClip.id) {
        changed = true;
        return {
          ...c,
          fadeInSec: volDur,
          fadeInStartSec: 0,
          fadeInEnabled: true,
          fadeInCurve: opts.fadeCurve,
          fadeInCurveTension: 0,
          bassFadeInSec: bassDur,
          bassFadeInStartSec: 0,
          bassFadeInEnabled: true,
          bassFadeInCurveTension: 0,
          mixIn: nextMixIn,
        };
      }
      if (prevClip && c.id === prevClip.id) {
        changed = true;
        return {
          ...c,
          fadeOutSec: volDur,
          fadeOutEndSec: 0,
          fadeOutEnabled: true,
          fadeOutCurve: opts.fadeCurve,
          fadeOutCurveTension: 0,
          bassFadeOutSec: bassDur,
          bassFadeOutEndSec: 0,
          bassFadeOutEnabled: true,
          bassFadeOutCurveTension: 0,
          mixOut: nextMixOut,
        };
      }
      return c;
    });
    return changed ? { ...t, clips: nextClips } : t;
  });
}
