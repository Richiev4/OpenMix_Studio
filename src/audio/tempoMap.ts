import type { NleProjectState, NleTrack, SnapMode, TempoPoint, TrackAsset } from '../types/audio';

export const MIN_PROJECT_BPM = 50;
export const MAX_PROJECT_BPM = 200;

export function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm)) return 120;
  return Math.max(MIN_PROJECT_BPM, Math.min(MAX_PROJECT_BPM, bpm));
}

/**
 * Mixxx EngineSync / BpmControl style octave folding:
 * Folds an asset's BPM by 2x or 0.5x when it is a half-time / double-time companion to
 * `referenceBpm` (e.g., 70 BPM vs 140 BPM or 87 BPM vs 174 BPM).
 */
export function getOctaveFoldedAssetBpm(assetBpm: number, referenceBpm: number): number {
  if (!Number.isFinite(assetBpm) || assetBpm <= 0) {
    return Number.isFinite(referenceBpm) && referenceBpm > 0 ? referenceBpm : 120;
  }
  if (!Number.isFinite(referenceBpm) || referenceBpm <= 0) return assetBpm;
  const ratio = referenceBpm / assetBpm;
  if (ratio > 1.48) {
    return assetBpm * 2;
  }
  if (ratio < 0.68) {
    return assetBpm * 0.5;
  }
  return assetBpm;
}

/**
 * Mixxx EngineSync / BpmControl style octave-aware BPM matching:
 * Folds half-time / double-time tempo pairs (e.g., 70 BPM vs 140 BPM or 87 BPM vs 174 BPM)
 * so the playback stretch ratio stays natural near 1.0x while locking every beat on the grid.
 */
export function getEffectiveBpmRatio(targetBpm: number, assetBpm: number): number {
  if (!Number.isFinite(targetBpm) || !Number.isFinite(assetBpm) || targetBpm <= 0 || assetBpm <= 0) {
    return 1.0;
  }
  const foldedAssetBpm = getOctaveFoldedAssetBpm(assetBpm, targetBpm);
  const ratio = targetBpm / foldedAssetBpm;
  return Math.max(0.4, Math.min(2.2, ratio));
}

/**
 * Returns the asset's effective BPM folded by 2x or 0.5x when it is a half-time / double-time
 * companion to `referenceBpm`, clamped to the valid project tempo range for tempo-map ramps.
 */
export function getBeatMatchedAssetBpm(assetBpm: number, referenceBpm: number): number {
  if (!Number.isFinite(assetBpm) || assetBpm <= 0) return clampBpm(referenceBpm);
  if (!Number.isFinite(referenceBpm) || referenceBpm <= 0) return clampBpm(assetBpm);
  const ratio = referenceBpm / assetBpm;
  if (ratio > 1.48 && assetBpm * 2 <= MAX_PROJECT_BPM) {
    return clampBpm(assetBpm * 2);
  }
  if (ratio < 0.68 && assetBpm * 0.5 >= MIN_PROJECT_BPM) {
    return clampBpm(assetBpm * 0.5);
  }
  return clampBpm(assetBpm);
}

export type TempoMapSource = Pick<NleProjectState, 'masterBpm' | 'tempoPoints'>;

/**
 * Returns tempo points sorted ascending by timeline timestamp.
 */
export function getSortedTempoPoints(points: TempoPoint[] | undefined): TempoPoint[] {
  if (!points || points.length === 0) return [];
  if (points.length === 1) return points;
  return [...points].sort((a, b) => a.timeSec - b.timeSec);
}

/**
 * Evaluates the instantaneous project BPM at any timeline timestamp (in seconds).
 */
export function evaluateBpmAt(project: TempoMapSource, timeSec: number): number {
  const pts = getSortedTempoPoints(project.tempoPoints);
  if (pts.length === 0) return clampBpm(project.masterBpm);
  if (pts.length === 1) return clampBpm(pts[0].bpm);
  if (timeSec <= pts[0].timeSec) return clampBpm(pts[0].bpm);
  if (timeSec >= pts[pts.length - 1].timeSec) return clampBpm(pts[pts.length - 1].bpm);

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (timeSec >= a.timeSec && timeSec <= b.timeSec) {
      const span = Math.max(0.0001, b.timeSec - a.timeSec);
      const t = (timeSec - a.timeSec) / span;
      if (a.curve === 'step') return clampBpm(a.bpm);
      if (a.curve === 'smooth') {
        const s = 0.5 - 0.5 * Math.cos(Math.PI * t);
        return clampBpm(a.bpm + (b.bpm - a.bpm) * s);
      }
      return clampBpm(a.bpm + (b.bpm - a.bpm) * t);
    }
  }
  return clampBpm(pts[pts.length - 1].bpm);
}

/**
 * Exact analytical integral of beats over a single segment [a, b] up to local time tEnd <= b.timeSec.
 */
function integrateSegmentBeats(
  bpmA: number,
  bpmB: number,
  curve: TempoPoint['curve'],
  tStart: number,
  tEnd: number,
  segDuration: number
): number {
  if (tEnd <= tStart || segDuration <= 0.00001) {
    return ((tEnd - tStart) * bpmA) / 60;
  }
  const u = Math.max(0, Math.min(1, (tEnd - tStart) / segDuration));
  const dt = tEnd - tStart;

  if (curve === 'step') {
    return (bpmA * dt) / 60;
  }
  if (curve === 'smooth') {
    // Integral of [a + (b - a)*(0.5 - 0.5*cos(pi*x))] from 0 to u, scaled by segDuration / 60
    const avgFactor =
      bpmA * u + (bpmB - bpmA) * (0.5 * u - Math.sin(Math.PI * u) / (2 * Math.PI));
    return (segDuration * avgFactor) / 60;
  }
  // Linear
  const endBpm = bpmA + (bpmB - bpmA) * u;
  return (((bpmA + endBpm) * 0.5) * dt) / 60;
}

/**
 * Computes exact cumulative musical beats elapsed from t = 0 to t = timeSec
 * by analytically integrating BPM(t) / 60 across the tempo curve.
 */
export function getBeatsAtTime(project: TempoMapSource, timeSec: number): number {
  const safeTime = Math.max(0, timeSec);
  const pts = getSortedTempoPoints(project.tempoPoints);
  if (pts.length === 0) {
    return (safeTime * clampBpm(project.masterBpm)) / 60;
  }
  if (pts.length === 1) {
    return (safeTime * clampBpm(pts[0].bpm)) / 60;
  }

  let beats = 0;

  // Before first tempo point
  const first = pts[0];
  if (safeTime <= first.timeSec) {
    return (safeTime * clampBpm(first.bpm)) / 60;
  }
  if (first.timeSec > 0) {
    beats += (first.timeSec * clampBpm(first.bpm)) / 60;
  }

  // Piecewise segments
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const segStart = Math.max(0, a.timeSec);
    const segEnd = Math.max(segStart, b.timeSec);
    const segDur = Math.max(0.0001, b.timeSec - a.timeSec);

    if (safeTime <= segEnd) {
      if (safeTime > segStart) {
        beats += integrateSegmentBeats(
          clampBpm(a.bpm),
          clampBpm(b.bpm),
          a.curve,
          segStart,
          safeTime,
          segDur
        );
      }
      return beats;
    }

    if (segEnd > segStart) {
      beats += integrateSegmentBeats(
        clampBpm(a.bpm),
        clampBpm(b.bpm),
        a.curve,
        segStart,
        segEnd,
        segDur
      );
    }
  }

  // Tail after last tempo point
  const last = pts[pts.length - 1];
  const tailStart = Math.max(0, last.timeSec);
  if (safeTime > tailStart) {
    beats += ((safeTime - tailStart) * clampBpm(last.bpm)) / 60;
  }
  return beats;
}

/**
 * Inverts getBeatsAtTime() via binary search to find the exact timeline timestamp (sec)
 * corresponding to a cumulative musical beat position.
 */
export function getTimeAtBeat(project: TempoMapSource, targetBeat: number): number {
  const safeBeat = Math.max(0, targetBeat);
  const pts = getSortedTempoPoints(project.tempoPoints);
  if (pts.length === 0) {
    return (safeBeat * 60) / clampBpm(project.masterBpm);
  }
  if (pts.length === 1) {
    return (safeBeat * 60) / clampBpm(pts[0].bpm);
  }

  let lo = 0;
  let hi = (safeBeat * 60) / MIN_PROJECT_BPM + 1;

  for (let iter = 0; iter < 28; iter++) {
    const mid = (lo + hi) * 0.5;
    if (getBeatsAtTime(project, mid) < safeBeat) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) * 0.5;
}

/**
 * Returns 1-indexed musical Bar and Beat at a given timeline timestamp.
 */
export function getBarAndBeatAt(
  project: TempoMapSource,
  timeSec: number
): { bar: number; beat: number; bpm: number } {
  const totalBeats = getBeatsAtTime(project, Math.max(0, timeSec)) + 1e-6;
  const bar = Math.floor(totalBeats / 4) + 1;
  const beat = Math.floor(totalBeats % 4) + 1;
  const bpm = evaluateBpmAt(project, Math.max(0, timeSec));
  return { bar, beat, bpm };
}

/**
 * Snaps a raw timeline timestamp to the nearest bar/beat subdivision under the active tempo map.
 */
export function snapSecondsWithTempoMap(
  project: TempoMapSource,
  rawSec: number,
  snapMode: SnapMode
): number {
  const safe = Math.max(0, rawSec);
  if (snapMode === 'off') return safe;
  const beatStep =
    snapMode === 'bar' ? 4 : snapMode === 'half-beat' ? 0.5 : 0.25;
  const beats = getBeatsAtTime(project, safe);
  const snappedBeats = Math.max(0, Math.round(beats / beatStep) * beatStep);
  return getTimeAtBeat(project, snappedBeats);
}

/**
 * Returns the beat phase offset (in [0, 4) timeline beats) of the most relevant existing
 * beat-grid clip on the timeline (excluding `excludeClipId`): prefers the clip with the
 * largest timeline overlap with `targetRange`, otherwise falls back to the earliest clip.
 */
export function getReferenceBeatPhase(
  project: TempoMapSource & { tracks: NleTrack[] },
  assetsMap: Map<string, TrackAsset>,
  excludeClipId?: string,
  targetRange?: { startSec: number; endSec: number },
  excludeClipIds?: ReadonlySet<string>
): number | null {
  let chosenClip: {
    startSec: number;
    offsetSec: number;
    bpm: number;
    beatOffsetSec: number;
    stretchToMasterBpm: boolean;
  } | null = null;
  let bestOverlapSec = 0;

  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (excludeClipId && clip.id === excludeClipId) continue;
      if (excludeClipIds?.has(clip.id)) continue;
      const asset = assetsMap.get(clip.trackAssetId);
      if (!asset || !Number.isFinite(asset.bpm) || asset.bpm <= 0) continue;

      if (targetRange) {
        const clipEnd = clip.startSec + clip.durationSec;
        const overlap =
          Math.min(clipEnd, targetRange.endSec) - Math.max(clip.startSec, targetRange.startSec);
        if (overlap > 0.05 && overlap > bestOverlapSec) {
          bestOverlapSec = overlap;
          chosenClip = {
            startSec: clip.startSec,
            offsetSec: clip.offsetSec,
            bpm: asset.bpm,
            beatOffsetSec: Number.isFinite(asset.beatOffsetSec) ? asset.beatOffsetSec : 0,
            stretchToMasterBpm: clip.stretchToMasterBpm,
          };
          continue;
        }
      }

      if (bestOverlapSec <= 0 && (!chosenClip || clip.startSec < chosenClip.startSec)) {
        chosenClip = {
          startSec: clip.startSec,
          offsetSec: clip.offsetSec,
          bpm: asset.bpm,
          beatOffsetSec: Number.isFinite(asset.beatOffsetSec) ? asset.beatOffsetSec : 0,
          stretchToMasterBpm: clip.stretchToMasterBpm,
        };
      }
    }
  }

  if (!chosenClip) return null;
  const clipStartBeats = getBeatsAtTime(project, Math.max(0, chosenClip.startSec));
  const localMapBpm = evaluateBpmAt(project, Math.max(0, chosenClip.startSec));
  const effBpm = chosenClip.stretchToMasterBpm
    ? getBeatMatchedAssetBpm(chosenClip.bpm, localMapBpm)
    : localMapBpm;
  const rawLeadBeats =
    ((chosenClip.beatOffsetSec - chosenClip.offsetSec) * effBpm) / 60;
  return (((clipStartBeats + rawLeadBeats) % 4) + 4) % 4;
}

/**
 * Snaps a clip's `startSec` so that its internal beat/downbeat grid (`beatOffsetSec` & `offsetSec`)
 * aligns to the timeline bar/beat grid (or the overlapping/reference clip phase) instead of its raw file edge.
 */
export function snapClipStartToBeatGrid(params: {
  project: TempoMapSource & { tracks: NleTrack[] };
  rawStartSec: number;
  snapMode: SnapMode;
  offsetSec: number;
  durationSec?: number;
  stretchToMasterBpm: boolean;
  asset?: Pick<TrackAsset, 'bpm' | 'beatOffsetSec'>;
  assetsMap: Map<string, TrackAsset>;
  excludeClipId?: string;
  excludeClipIds?: ReadonlySet<string>;
}): number {
  const {
    project,
    rawStartSec,
    snapMode,
    offsetSec,
    durationSec,
    stretchToMasterBpm,
    asset,
    assetsMap,
    excludeClipId,
    excludeClipIds,
  } = params;

  const safeRaw = Math.max(0, rawStartSec);
  if (snapMode === 'off') return safeRaw;

  if (!asset || !Number.isFinite(asset.bpm) || asset.bpm <= 0) {
    return snapSecondsWithTempoMap(project, safeRaw, snapMode);
  }

  const beatOffsetSec = Number.isFinite(asset.beatOffsetSec) ? asset.beatOffsetSec : 0;
  const beatStep = snapMode === 'bar' ? 4 : snapMode === 'half-beat' ? 0.5 : 0.25;
  const targetRange =
    durationSec && durationSec > 0
      ? { startSec: safeRaw, endSec: safeRaw + durationSec }
      : undefined;

  const snapWithProject = (srcProject: TempoMapSource & { tracks: NleTrack[] }): number => {
    const refPhase = getReferenceBeatPhase(
      srcProject,
      assetsMap,
      excludeClipId,
      targetRange,
      excludeClipIds
    );
    if (refPhase === null && safeRaw <= 0.08) {
      return 0;
    }

    const localMapBpm = evaluateBpmAt(srcProject, safeRaw);
    const effectiveBpm = stretchToMasterBpm
      ? getBeatMatchedAssetBpm(asset.bpm, localMapBpm)
      : localMapBpm;
    const rawLeadBeats = ((beatOffsetSec - offsetSec) * effectiveBpm) / 60;
    const leadBeats =
      snapMode === 'bar'
        ? ((rawLeadBeats % 4) + 4) % 4
        : ((rawLeadBeats % 1) + 1) % 1;

    const effectiveRef =
      refPhase === null
        ? 0
        : snapMode === 'bar'
          ? refPhase
          : ((refPhase % 1) + 1) % 1;

    const rawBeatPos = getBeatsAtTime(srcProject, safeRaw) + leadBeats;
    let snappedBeatPos =
      Math.round((rawBeatPos - effectiveRef) / beatStep) * beatStep + effectiveRef;

    while (snappedBeatPos - leadBeats < -1e-4) {
      snappedBeatPos += beatStep;
    }

    return Math.max(0, getTimeAtBeat(srcProject, snappedBeatPos - leadBeats));
  };

  let origMovingStartSec: number | null = null;
  if (excludeClipId && excludeClipIds && excludeClipIds.size > 0) {
    for (const t of project.tracks) {
      const found = t.clips.find((c) => c.id === excludeClipId);
      if (found) {
        origMovingStartSec = found.startSec;
        break;
      }
    }
  }

  let candidateSec = snapWithProject(project);
  if (excludeClipId) {
    for (let pass = 0; pass < 2; pass++) {
      const rippleDelta =
        origMovingStartSec !== null ? candidateSec - origMovingStartSec : 0;
      const nextTracks = project.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => {
          if (c.id === excludeClipId) {
            return { ...c, startSec: candidateSec };
          }
          if (origMovingStartSec !== null && excludeClipIds?.has(c.id)) {
            return { ...c, startSec: Math.max(0, c.startSec + rippleDelta) };
          }
          return c;
        }),
      }));
      const synced = syncTempoMapToTimeline(
        { masterBpm: project.masterBpm, tracks: nextTracks },
        assetsMap
      );
      const nextSec = snapWithProject({
        masterBpm: synced.masterBpm,
        tempoPoints: synced.tempoPoints,
        tracks: nextTracks,
      });
      if (Math.abs(nextSec - candidateSec) < 0.0002) {
        candidateSec = nextSec;
        break;
      }
      candidateSec = nextSec;
    }
  }

  return candidateSec;
}

export interface TempoGridBar {
  barIndex: number; // 0-indexed
  timeSec: number;
  bpm: number;
}

/**
 * Generates bar boundary positions [0 .. maxSec] aligned to the variable tempo curve.
 */
export function getBarGridPositions(
  project: TempoMapSource,
  maxSec: number
): TempoGridBar[] {
  const pts = getSortedTempoPoints(project.tempoPoints);
  if (pts.length === 0) {
    const bpm = clampBpm(project.masterBpm);
    const barSec = (60 / bpm) * 4;
    const count = Math.min(2000, Math.ceil(maxSec / barSec));
    const bars: TempoGridBar[] = [];
    for (let i = 0; i < count; i++) {
      bars.push({ barIndex: i, timeSec: i * barSec, bpm });
    }
    return bars;
  }

  const totalBeats = getBeatsAtTime(project, maxSec);
  const count = Math.min(2000, Math.ceil(totalBeats / 4) + 1);
  const bars: TempoGridBar[] = [];
  for (let i = 0; i < count; i++) {
    const t = getTimeAtBeat(project, i * 4);
    if (t > maxSec) break;
    bars.push({
      barIndex: i,
      timeSec: t,
      bpm: evaluateBpmAt(project, t),
    });
  }
  return bars;
}

/**
 * Computes source-buffer seconds consumed over [clipStartSec, clipStartSec + localOutSec]
 * when beat-matching an asset to the project's variable tempo curve.
 */
export function integrateClipSourceOffsetSec(
  project: TempoMapSource,
  clipStartSec: number,
  localOutSec: number,
  assetBpm: number
): number {
  if (assetBpm <= 0) return localOutSec;
  const beats =
    getBeatsAtTime(project, clipStartSec + Math.max(0, localOutSec)) -
    getBeatsAtTime(project, clipStartSec);
  const startMapBpm = evaluateBpmAt(project, Math.max(0, clipStartSec));
  const matchedBpm = getOctaveFoldedAssetBpm(assetBpm, startMapBpm);
  return (beats * 60) / matchedBpm;
}

/**
 * Checks whether project BPM is strictly constant across [startSec, endSec]
 * and returns that constant BPM, or null if BPM varies across the range.
 */
export function getConstantBpmInRange(
  project: TempoMapSource,
  startSec: number,
  endSec: number
): number | null {
  const pts = getSortedTempoPoints(project.tempoPoints);
  if (pts.length === 0) return clampBpm(project.masterBpm);
  if (pts.length === 1) return clampBpm(pts[0].bpm);

  const startBpm = evaluateBpmAt(project, startSec);
  const endBpm = evaluateBpmAt(project, endSec);
  if (Math.abs(startBpm - endBpm) > 0.005) return null;

  for (const pt of pts) {
    if (pt.timeSec > startSec && pt.timeSec < endSec) {
      if (Math.abs(clampBpm(pt.bpm) - startBpm) > 0.005) {
        return null;
      }
    }
  }
  return startBpm;
}

/**
 * Returns min/max BPM observed across [startSec, endSec] for display badges.
 */
export function getBpmRangeForClip(
  project: TempoMapSource,
  startSec: number,
  durationSec: number
): { minBpm: number; maxBpm: number; isVariable: boolean } {
  const endSec = startSec + Math.max(0, durationSec);
  let minBpm = evaluateBpmAt(project, startSec);
  let maxBpm = minBpm;

  const endBpm = evaluateBpmAt(project, endSec);
  minBpm = Math.min(minBpm, endBpm);
  maxBpm = Math.max(maxBpm, endBpm);

  const pts = getSortedTempoPoints(project.tempoPoints);
  for (const pt of pts) {
    if (pt.timeSec >= startSec && pt.timeSec <= endSec) {
      const b = clampBpm(pt.bpm);
      minBpm = Math.min(minBpm, b);
      maxBpm = Math.max(maxBpm, b);
    }
  }
  return {
    minBpm,
    maxBpm,
    isVariable: Math.abs(maxBpm - minBpm) >= 0.25,
  };
}

/**
 * Generates a deterministic cache-key signature for all tempo nodes influencing [startSec, endSec].
 */
export function getTempoSignatureForRange(
  project: TempoMapSource,
  startSec: number,
  endSec: number
): string {
  const pts = getSortedTempoPoints(project.tempoPoints);
  if (pts.length === 0) {
    return `const_${clampBpm(project.masterBpm).toFixed(2)}`;
  }

  // Find anchor before startSec, points inside, and anchor after endSec
  let beforeIdx = -1;
  let afterIdx = -1;
  const relevant: TempoPoint[] = [];

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.timeSec <= startSec) {
      beforeIdx = i;
    } else if (p.timeSec < endSec) {
      relevant.push(p);
    } else if (afterIdx === -1) {
      afterIdx = i;
    }
  }

  const slice: TempoPoint[] = [];
  if (beforeIdx >= 0) slice.push(pts[beforeIdx]);
  slice.push(...relevant);
  if (afterIdx >= 0) slice.push(pts[afterIdx]);

  return slice
    .map(
      (p) =>
        `${(p.timeSec - startSec).toFixed(3)}:${clampBpm(p.bpm).toFixed(2)}:${p.curve}`
    )
    .join('|');
}

export interface TimelineTempoEntry {
  id: string;
  clipId?: string;
  trackName: string;
  /** Timeline timestamp (seconds) where this track/tempo state starts or finishes transitioning */
  timeSec: number;
  /** Native BPM of this entry (clamped to valid project BPM range) */
  bpm: number;
  /** Previous entry BPM when transitioning from an earlier track */
  prevBpm?: number;
  /** Start timestamp (seconds) of the transition window from the previous track */
  transitionFromSec?: number;
  /** End timestamp (seconds) of the transition window into this track */
  transitionToSec?: number;
  /** Whether this is the initial starting entry of the timeline */
  isStart: boolean;
}

/**
 * Computes a chronological sequence of track BPM entries and transition windows
 * across the entire timeline so the footer Tempo Indicator Line can show the starting BPM,
 * each incoming track's BPM, and the transition window between consecutive tracks.
 */
export function getTimelineTempoEntries(
  project: Pick<NleProjectState, 'masterBpm' | 'tracks'>,
  assetsMap: Map<string, TrackAsset>
): TimelineTempoEntry[] {
  const orderedClips: Array<{
    clipId: string;
    startSec: number;
    endSec: number;
    mixInDurationSec: number;
    bpm: number;
    trackName: string;
  }> = [];

  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const asset = assetsMap.get(clip.trackAssetId);
      if (!asset || !Number.isFinite(asset.bpm) || asset.bpm <= 0) continue;
      const safeStart = Math.max(0, clip.startSec);
      const safeDur = Math.max(0.05, clip.durationSec);
      orderedClips.push({
        clipId: clip.id,
        startSec: safeStart,
        endSec: safeStart + safeDur,
        mixInDurationSec: Math.max(0, clip.mixIn?.durationSec ?? 0),
        bpm: clampBpm(Math.round(asset.bpm * 100) / 100),
        trackName: asset.name,
      });
    }
  }

  // Fallback when no clips with valid BPM exist yet
  if (orderedClips.length === 0) {
    return [
      {
        id: 'tempo_start_default',
        trackName: 'Project BPM',
        timeSec: 0,
        bpm: clampBpm(project.masterBpm),
        isStart: true,
      },
    ];
  }

  // Sort chronologically by clip start; break ties by longest clip first
  orderedClips.sort((a, b) => {
    const dt = a.startSec - b.startSec;
    if (Math.abs(dt) > 0.05) return dt;
    return b.endSec - b.startSec - (a.endSec - a.startSec);
  });

  const entries: TimelineTempoEntry[] = [];
  const first = orderedClips[0];

  entries.push({
    id: `entry_${first.clipId}`,
    clipId: first.clipId,
    trackName: first.trackName,
    timeSec: first.startSec,
    bpm: first.bpm,
    isStart: true,
  });

  let prevEndSec = first.endSec;
  let prevBpm = first.bpm;
  let prevStartSec = first.startSec;

  for (let i = 1; i < orderedClips.length; i++) {
    const cur = orderedClips[i];

    // Skip simultaneous stacked layers (e.g. stems/samples starting at virtually the same beat)
    if (Math.abs(cur.startSec - prevStartSec) < 0.25 && cur.endSec <= prevEndSec + 0.25) {
      continue;
    }

    // Determine the transition window [transStart, transEnd] between the outgoing and incoming track:
    // - Overlapping tracks: the overlap window from incoming start to outgoing end (or mixIn span)
    // - Gapped tracks: the gap from outgoing end to incoming start
    // - Back-to-back tracks: boundary at incoming start (or mixIn span if configured)
    let transStart = cur.startSec;
    let transEnd = cur.startSec;

    if (cur.startSec < prevEndSec - 0.05) {
      transStart = cur.startSec;
      const overlapEnd = Math.min(prevEndSec, cur.endSec);
      const mixInEnd =
        cur.mixInDurationSec > 0.05
          ? Math.min(cur.endSec, cur.startSec + cur.mixInDurationSec)
          : overlapEnd;
      transEnd = Math.max(overlapEnd, mixInEnd);
    } else if (cur.startSec > prevEndSec + 0.05) {
      transStart = prevEndSec;
      transEnd = cur.startSec;
    } else if (cur.mixInDurationSec > 0.05) {
      transStart = cur.startSec;
      transEnd = Math.min(cur.endSec, cur.startSec + cur.mixInDurationSec);
    }

    const targetBpm = getBeatMatchedAssetBpm(cur.bpm, prevBpm);

    entries.push({
      id: `entry_${cur.clipId}`,
      clipId: cur.clipId,
      trackName: cur.trackName,
      timeSec: transEnd,
      bpm: targetBpm,
      prevBpm,
      transitionFromSec: transStart,
      transitionToSec: transEnd,
      isStart: false,
    });

    prevStartSec = cur.startSec;
    prevEndSec = Math.max(prevEndSec, cur.endSec);
    prevBpm = targetBpm;
  }

  return entries;
}

/**
 * Converts timeline track BPM entries into TempoPoint[] automation ramps so the
 * audio engine smoothly transitions BPM across each track overlap/transition window.
 */
export function buildTempoPointsFromEntries(entries: TimelineTempoEntry[]): TempoPoint[] {
  if (entries.length === 0) return [];
  const startBpm = clampBpm(entries[0].bpm);
  const points: TempoPoint[] = [
    {
      id: 'tempo_sync_0',
      timeSec: 0,
      bpm: startBpm,
      curve: 'linear',
    },
  ];

  let lastBpm = startBpm;
  let lastTime = 0;

  for (let i = 1; i < entries.length; i++) {
    const entry = entries[i];
    if (Math.abs(entry.bpm - lastBpm) < 0.005) continue;

    const fromSec = Math.max(lastTime, entry.transitionFromSec ?? entry.timeSec);
    const toSec = Math.max(fromSec, entry.transitionToSec ?? entry.timeSec);

    if (toSec - fromSec >= 0.05) {
      // Hold previous BPM until transition start, then ramp linearly to target BPM
      if (fromSec > lastTime + 0.02) {
        points.push({
          id: `tempo_sync_from_${i}`,
          timeSec: fromSec,
          bpm: lastBpm,
          curve: 'linear',
        });
      } else {
        points[points.length - 1] = {
          ...points[points.length - 1],
          curve: 'linear',
        };
      }
      points.push({
        id: `tempo_sync_to_${i}`,
        timeSec: toSec,
        bpm: entry.bpm,
        curve: 'linear',
      });
      lastTime = toSec;
    } else {
      // Instant cut / back-to-back transition: hold previous BPM via step until boundary
      const cutSec = Math.max(lastTime + 0.02, fromSec);
      points[points.length - 1] = {
        ...points[points.length - 1],
        curve: 'step',
      };
      points.push({
        id: `tempo_sync_step_${i}`,
        timeSec: cutSec,
        bpm: entry.bpm,
        curve: 'linear',
      });
      lastTime = cutSec;
    }

    lastBpm = entry.bpm;
  }

  return points;
}

/**
 * Automatically derives project masterBpm and tempoPoints ramp automation from
 * the chronological track BPMs and transition windows currently on the timeline.
 */
export function syncTempoMapToTimeline(
  project: Pick<NleProjectState, 'masterBpm' | 'tracks'>,
  assetsMap: Map<string, TrackAsset>
): { masterBpm: number; tempoPoints: TempoPoint[] } {
  const entries = getTimelineTempoEntries(project, assetsMap);
  if (entries.length === 0 || entries[0].id === 'tempo_start_default') {
    return {
      masterBpm: clampBpm(project.masterBpm),
      tempoPoints: [],
    };
  }

  const startBpm = clampBpm(entries[0].bpm);
  const hasBpmChanges = entries.some(
    (entry, idx) => idx > 0 && Math.abs(entry.bpm - entries[idx - 1].bpm) >= 0.005
  );

  if (!hasBpmChanges) {
    return {
      masterBpm: startBpm,
      tempoPoints: [],
    };
  }

  return {
    masterBpm: startBpm,
    tempoPoints: buildTempoPointsFromEntries(entries),
  };
}
