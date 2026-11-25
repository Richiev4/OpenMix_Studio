import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Crosshair,
  Magnet,
  Maximize2,
  Pause,
  Play,
  Repeat,
  Square,
  Volume2,
  VolumeX,
  Wand2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { autoAlignOverlapShiftSec, formatTimecode } from '../audio/analysis';
import {
  evaluateBpmAt,
  getBarAndBeatAt,
  getBeatsAtTime,
  getEffectiveBpmRatio,
  getOctaveFoldedAssetBpm,
  getReferenceBeatPhase,
  getTimeAtBeat,
  integrateClipSourceOffsetSec,
  snapClipStartToBeatGrid,
  type TempoMapSource,
} from '../audio/tempoMap';
import { resolveTrackAccentColor, useTheme } from '../theme/themes';
import type { NleClip, NleProjectState, NleTrack, TempoPoint, TrackAsset } from '../types/audio';

type PrecisionSnap = 'free' | '1ms' | 'quarter-beat' | 'beat';

interface SuperZoomModalProps {
  isOpen: boolean;
  onClose: () => void;
  project: NleProjectState;
  assetsMap: Map<string, TrackAsset>;
  initialSelectedClipRef: { trackId: string; clipId: string } | null;
  onSelectClipRef?: (ref: { trackId: string; clipId: string } | null) => void;
  onUpdateProject: (patch: Partial<NleProjectState>) => void;
  onTogglePlay: () => void;
  onStop: () => void;
  onSeek: (sec: number) => void;
  onUpdateTrack: (trackId: string, patch: Partial<NleTrack>) => void;
  onMoveClip: (
    fromTrackId: string,
    toTrackId: string,
    clipId: string,
    startSec: number,
    rippleClipIds?: ReadonlySet<string>
  ) => void;
  onCommitTempoChange?: () => void;
  onUpdateTrackBeatOffset?: (trackId: string, beatOffsetSec: number) => void;
}

const MIN_SUPER_ZOOM = 20;
const MAX_SUPER_ZOOM = 2400;
const TRACK_SIDEBAR_WIDTH = 196;
const RULER_HEIGHT = 40;

function formatTimecodeMs(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.floor((safe - Math.floor(safe)) * 1000);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function clampSuperZoom(v: number): number {
  return Math.max(MIN_SUPER_ZOOM, Math.min(MAX_SUPER_ZOOM, Math.round(v * 10) / 10));
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return `rgba(6, 182, 212, ${alpha})`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

interface GridTick {
  timeSec: number;
  beatIndex: number; // integer or fractional beat index
  kind: 'bar' | 'beat' | 'half' | 'quarter';
  barNum: number;
  beatInBar: number;
}

function computeVisibleGridTicks(
  project: TempoMapSource,
  startSec: number,
  endSec: number,
  zoomPxPerSec: number
): GridTick[] {
  const ticks: GridTick[] = [];
  if (endSec <= startSec) return ticks;

  const avgBpm = evaluateBpmAt(project, (startSec + endSec) * 0.5);
  const pxPerBeat = (60 / Math.max(40, avgBpm)) * zoomPxPerSec;

  const stepBeats =
    pxPerBeat >= 140 ? 0.25 : pxPerBeat >= 55 ? 0.5 : pxPerBeat >= 14 ? 1 : 4;

  const startBeats = getBeatsAtTime(project, Math.max(0, startSec));
  const endBeats = getBeatsAtTime(project, Math.max(0, endSec));

  const firstIdx = Math.max(0, Math.floor(startBeats / stepBeats));
  const lastIdx = Math.ceil(endBeats / stepBeats);
  const maxIter = 3000;

  let count = 0;
  for (let i = firstIdx; i <= lastIdx && count < maxIter; i++) {
    count++;
    const beatPos = i * stepBeats;
    const t = getTimeAtBeat(project, beatPos);
    if (t < startSec - 0.001 || t > endSec + 0.001) continue;

    const roundedBeat = Math.round(beatPos * 4) / 4;
    const isInteger = Math.abs(roundedBeat - Math.round(roundedBeat)) < 1e-4;
    const intBeat = Math.round(roundedBeat);
    const isBar = isInteger && intBeat % 4 === 0;
    const isHalf = !isInteger && Math.abs((roundedBeat * 2) % 1) < 1e-4;

    const kind: GridTick['kind'] = isBar
      ? 'bar'
      : isInteger
        ? 'beat'
        : isHalf
          ? 'half'
          : 'quarter';

    const barNum = Math.floor(Math.max(0, roundedBeat) / 4) + 1;
    const beatInBar = Math.floor(Math.max(0, roundedBeat) % 4) + 1;

    ticks.push({
      timeSec: t,
      beatIndex: roundedBeat,
      kind,
      barNum,
      beatInBar,
    });
  }
  return ticks;
}

interface HighResTrackCanvasProps {
  track: NleTrack;
  trackAccentColor: string;
  masterBpm: number;
  tempoPoints: TempoPoint[];
  loopStartSec: number;
  loopEndSec: number;
  assetsMap: Map<string, TrackAsset>;
  selectedClipId: string | null;
  visibleStartSec: number;
  visibleEndSec: number;
  zoomPxPerSec: number;
  viewportWidth: number;
  laneHeight: number;
  verticalGain: number;
  showMasterGrid: boolean;
  showClipBeats: boolean;
  gridTicks: GridTick[];
}

const HighResTrackCanvas: React.FC<HighResTrackCanvasProps> = React.memo(({
  track,
  trackAccentColor,
  masterBpm,
  tempoPoints,
  loopStartSec,
  loopEndSec,
  assetsMap,
  selectedClipId,
  visibleStartSec,
  visibleEndSec,
  zoomPxPerSec,
  viewportWidth,
  laneHeight,
  verticalGain,
  showMasterGrid,
  showClipBeats,
  gridTicks,
}) => {
  const { theme } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewportWidth <= 0 || laneHeight <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(10, Math.round(viewportWidth));
    const h = Math.max(40, Math.round(laneHeight));
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const timeToX = (sec: number) => (sec - visibleStartSec) * zoomPxPerSec;

    // 1. Dim regions outside the loop window
    const loopStartX = timeToX(loopStartSec);
    const loopEndX = timeToX(loopEndSec);
    if (loopStartX > 0) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.fillRect(0, 0, Math.min(w, loopStartX), h);
    }
    if (loopEndX < w) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.fillRect(Math.max(0, loopEndX), 0, w - Math.max(0, loopEndX), h);
    }

    // 2. Center zero-crossing axis line
    const midY = h / 2;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.fillRect(0, Math.round(midY) + 0.5, w, 1);

    // 3. Master bar/beat/sub-beat grid lines behind waveforms
    if (showMasterGrid) {
      for (const tick of gridTicks) {
        const x = Math.round(timeToX(tick.timeSec)) + 0.5;
        if (x < -1 || x > w + 1) continue;
        if (tick.kind === 'bar') {
          ctx.fillStyle = theme.canvas.gridBarRgba;
          ctx.fillRect(x, 0, 1.2, h);
        } else if (tick.kind === 'beat') {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.13)';
          ctx.fillRect(x, 0, 1, h);
        } else if (tick.kind === 'half') {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
          ctx.fillRect(x, 0, 1, h);
        } else {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
          ctx.fillRect(x, 0, 1, h);
        }
      }
    }

    // 4. High-resolution PCM waveforms + clip beat markers for every visible clip
    const tempoSrc = { masterBpm, tempoPoints };
    const hasTempoPoints = tempoPoints.length > 0;
    const waveHalfH = (h - 24) * 0.46;

    for (const clip of track.clips) {
      const clipEndSec = clip.startSec + clip.durationSec;
      if (clipEndSec <= visibleStartSec || clip.startSec >= visibleEndSec) continue;

      const asset = assetsMap.get(clip.trackAssetId);
      const drawStartSec = Math.max(clip.startSec, visibleStartSec);
      const drawEndSec = Math.min(clipEndSec, visibleEndSec);
      const xStart = Math.max(0, Math.floor(timeToX(drawStartSec)));
      const xEnd = Math.min(w, Math.ceil(timeToX(drawEndSec)));
      if (xEnd <= xStart) continue;

      const isSelected = clip.id === selectedClipId;
      const clipTop = 6;
      const clipH = h - 12;

      // Clip card background
      ctx.fillStyle = isSelected
        ? hexToRgba(trackAccentColor, 0.13)
        : hexToRgba(trackAccentColor, 0.06);
      ctx.fillRect(xStart, clipTop, xEnd - xStart, clipH);

      // Clip top & bottom border
      ctx.strokeStyle = isSelected
        ? hexToRgba(trackAccentColor, 0.9)
        : hexToRgba(trackAccentColor, 0.35);
      ctx.lineWidth = isSelected ? 1.5 : 1;
      ctx.strokeRect(xStart + 0.5, clipTop + 0.5, Math.max(1, xEnd - xStart - 1), clipH - 1);

      if (!asset) continue;

      const canStretch = clip.stretchToMasterBpm && asset.bpm > 0;
      const hasTempoMap = canStretch && hasTempoPoints;
      const constRatio = canStretch ? getEffectiveBpmRatio(masterBpm, asset.bpm) : 1;
      const matchedAssetBpm = canStretch
        ? getOctaveFoldedAssetBpm(
            asset.bpm,
            hasTempoMap ? evaluateBpmAt(tempoSrc, Math.max(0, clip.startSec)) : masterBpm
          )
        : asset.bpm;

      const buf = asset.audioBuffer;
      const sampleRate = buf.sampleRate;
      const totalSamples = buf.length;
      const ch0 = buf.getChannelData(0);
      const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;

      // Render high-res min/max waveform column-by-column directly from AudioBuffer
      const fillColor = hexToRgba(trackAccentColor, isSelected ? 0.85 : 0.65);
      const rmsColor = hexToRgba(trackAccentColor, isSelected ? 0.35 : 0.22);

      // Precompute local source sample index for any timeline timestamp
      const timelineToSourceSec = (tSec: number): number => {
        const localOutSec = tSec - clip.startSec;
        const srcDelta = hasTempoMap
          ? integrateClipSourceOffsetSec(tempoSrc, clip.startSec, localOutSec, asset.bpm)
          : localOutSec * constRatio;
        return clip.offsetSec + srcDelta;
      };

      const avgSamplesPerPx =
        ((timelineToSourceSec(drawEndSec) - timelineToSourceSec(drawStartSec)) * sampleRate) /
        Math.max(1, xEnd - xStart);

      // Ultra-zoom polyline mode when < 2 samples per pixel
      if (avgSamplesPerPx <= 2) {
        ctx.beginPath();
        ctx.strokeStyle = fillColor;
        ctx.lineWidth = 1.5;
        let started = false;
        for (let px = xStart; px <= xEnd; px++) {
          const tSec = visibleStartSec + px / zoomPxPerSec;
          const srcSec = timelineToSourceSec(tSec);
          if (srcSec < 0 || srcSec >= asset.duration) continue;
          const sIdx = Math.min(totalSamples - 1, Math.max(0, Math.round(srcSec * sampleRate)));
          const val = ch1 ? (ch0[sIdx] + ch1[sIdx]) * 0.5 : ch0[sIdx];
          const clamped = Math.max(-1, Math.min(1, val * verticalGain));
          const y = midY - clamped * waveHalfH;
          if (!started) {
            ctx.moveTo(px, y);
            started = true;
          } else {
            ctx.lineTo(px, y);
          }
        }
        ctx.stroke();
      } else {
        // High-precision peak & RMS envelope per pixel column
        const maxScanSamples = 320;
        for (let px = xStart; px < xEnd; px++) {
          const t0 = visibleStartSec + px / zoomPxPerSec;
          const t1 = visibleStartSec + (px + 1) / zoomPxPerSec;
          const s0 = timelineToSourceSec(t0);
          const s1 = timelineToSourceSec(t1);
          if (s1 <= 0 || s0 >= asset.duration) continue;

          const idx0 = Math.max(0, Math.floor(s0 * sampleRate));
          const idx1 = Math.min(totalSamples - 1, Math.max(idx0, Math.ceil(s1 * sampleRate)));
          const span = idx1 - idx0 + 1;
          const stride = span > maxScanSamples ? Math.ceil(span / maxScanSamples) : 1;

          let minV = 0;
          let maxV = 0;
          let sumSq = 0;
          let samplesRead = 0;

          for (let i = idx0; i <= idx1; i += stride) {
            const v = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
            if (v < minV) minV = v;
            if (v > maxV) maxV = v;
            sumSq += v * v;
            samplesRead++;
          }

          const gMin = Math.max(-1, Math.min(1, minV * verticalGain));
          const gMax = Math.max(-1, Math.min(1, maxV * verticalGain));
          const rms = samplesRead > 0 ? Math.min(1, Math.sqrt(sumSq / samplesRead) * verticalGain) : 0;

          const yTop = midY - gMax * waveHalfH;
          const yBot = midY - gMin * waveHalfH;
          const barH = Math.max(1.2, yBot - yTop);

          // Peak span
          ctx.fillStyle = rmsColor;
          ctx.fillRect(px, yTop, 1, barH);

          // Brighter inner core / peak outline
          ctx.fillStyle = fillColor;
          const rmsH = Math.max(1, rms * waveHalfH * 2);
          ctx.fillRect(px, midY - rmsH / 2, 1, rmsH);
          ctx.fillRect(px, yTop, 1, 1.4);
          ctx.fillRect(px, yBot - 1.4, 1, 1.4);
        }
      }

      // 5. Per-clip Beat & Downbeat Markers (drawn crisp on top of waveform)
      if (showClipBeats && asset.bpm > 0) {
        const beatPeriodSec = 60 / asset.bpm;
        const safeBeatOffset = Number.isFinite(asset.beatOffsetSec) ? asset.beatOffsetSec : 0;
        const visSrcStart = Math.max(0, timelineToSourceSec(drawStartSec) - beatPeriodSec);
        const visSrcEnd = Math.min(asset.duration, timelineToSourceSec(drawEndSec) + beatPeriodSec);

        if (visSrcEnd > visSrcStart) {
          const startTimelineBeats = hasTempoMap ? getBeatsAtTime(tempoSrc, clip.startSec) : 0;
          const firstBeatIdx = Math.ceil((visSrcStart - safeBeatOffset - 1e-6) / beatPeriodSec);
          const lastBeatIdx = Math.floor((visSrcEnd - safeBeatOffset + 1e-6) / beatPeriodSec);
          const avgClipBeatPx =
            (beatPeriodSec / Math.max(0.0001, constRatio)) * zoomPxPerSec;
          const showHalfBeats = avgClipBeatPx >= 150;
          const step = showHalfBeats ? 0.5 : 1;

          const maxMarkers = 1200;
          let mCount = 0;

          for (
            let beatVal = firstBeatIdx;
            beatVal <= lastBeatIdx && mCount < maxMarkers;
            beatVal += step
          ) {
            mCount++;
            const isWholeBeat = Math.abs(beatVal - Math.round(beatVal)) < 1e-4;
            const intIdx = Math.round(beatVal);
            const isDownbeat = isWholeBeat && ((intIdx % 4) + 4) % 4 === 0;

            const srcBeatSec = safeBeatOffset + beatVal * beatPeriodSec;
            const deltaSourceSec = srcBeatSec - clip.offsetSec;
            if (deltaSourceSec < -1e-4) continue;

            const localOutSec = hasTempoMap
              ? getTimeAtBeat(tempoSrc, startTimelineBeats + deltaSourceSec * (matchedAssetBpm / 60)) -
                clip.startSec
              : deltaSourceSec / Math.max(0.0001, constRatio);

            if (localOutSec < 0 || localOutSec > clip.durationSec) continue;
            const timelineBeatSec = clip.startSec + localOutSec;
            if (timelineBeatSec < visibleStartSec - 0.005 || timelineBeatSec > visibleEndSec + 0.005) {
              continue;
            }

            const mx = Math.round(timeToX(timelineBeatSec)) + 0.5;
            if (isDownbeat) {
              // Strong downbeat line + accent top marker triangle
              ctx.fillStyle = theme.canvas.accentLineRgba;
              ctx.fillRect(mx - 0.5, clipTop, 1.5, clipH);

              // Top diamond/cap indicator
              ctx.beginPath();
              ctx.moveTo(mx, clipTop + 8);
              ctx.lineTo(mx - 4.5, clipTop);
              ctx.lineTo(mx + 4.5, clipTop);
              ctx.closePath();
              ctx.fill();

              // Beat bar index badge when spaced cleanly
              if (avgClipBeatPx * 4 >= 44) {
                const clipBarNum = Math.floor(intIdx / 4) + 1;
                ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
                ctx.fillStyle = theme.canvas.accent;
                ctx.fillText(`B${clipBarNum}`, mx + 4, clipTop + 11);
              }
            } else if (isWholeBeat) {
              // Crisp quarter-note beat line
              ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
              ctx.fillRect(mx, clipTop, 1, clipH);

              // Top & bottom tick caps
              ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
              ctx.fillRect(mx - 1, clipTop, 3, 4);
              ctx.fillRect(mx - 1, clipTop + clipH - 4, 3, 4);

              if (avgClipBeatPx >= 56) {
                const beatNumInBar = (((intIdx % 4) + 4) % 4) + 1;
                ctx.font = '500 9px ui-monospace, SFMono-Regular, Menlo, monospace';
                ctx.fillStyle = 'rgba(226, 232, 240, 0.72)';
                ctx.fillText(`.${beatNumInBar}`, mx + 3, clipTop + 11);
              }
            } else {
              // Half-beat tick (dashed)
              ctx.save();
              ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
              ctx.setLineDash([3, 3]);
              ctx.beginPath();
              ctx.moveTo(mx, clipTop + 6);
              ctx.lineTo(mx, clipTop + clipH - 6);
              ctx.stroke();
              ctx.restore();
            }
          }
        }
      }
    }

    // 6. Loop boundary vertical brackets
    if (loopStartX >= 0 && loopStartX <= w) {
      ctx.fillStyle = theme.canvas.secondaryLineRgba;
      ctx.fillRect(Math.round(loopStartX), 0, 1.5, h);
    }
    if (loopEndX >= 0 && loopEndX <= w) {
      ctx.fillStyle = theme.canvas.secondaryLineRgba;
      ctx.fillRect(Math.round(loopEndX), 0, 1.5, h);
    }
  }, [
    track,
    trackAccentColor,
    theme,
    masterBpm,
    tempoPoints,
    loopStartSec,
    loopEndSec,
    assetsMap,
    selectedClipId,
    visibleStartSec,
    visibleEndSec,
    zoomPxPerSec,
    viewportWidth,
    laneHeight,
    verticalGain,
    showMasterGrid,
    showClipBeats,
    gridTicks,
  ]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: viewportWidth, height: laneHeight }}
      className="block pointer-events-none"
    />
  );
});

export const SuperZoomModal: React.FC<SuperZoomModalProps> = ({
  isOpen,
  onClose,
  project,
  assetsMap,
  initialSelectedClipRef,
  onSelectClipRef,
  onUpdateProject,
  onTogglePlay,
  onStop,
  onSeek,
  onUpdateTrack,
  onMoveClip,
  onCommitTempoChange,
  onUpdateTrackBeatOffset,
}) => {
  const { themeId } = useTheme();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lanesContainerRef = useRef<HTMLDivElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(900);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [zoomPxPerSec, setZoomPxPerSec] = useState(240);
  const [verticalGain, setVerticalGain] = useState<1 | 2 | 3>(1);
  const [precisionSnap, setPrecisionSnap] = useState<PrecisionSnap>('free');
  const [showMasterGrid, setShowMasterGrid] = useState(true);
  const [showClipBeats, setShowClipBeats] = useState(true);
  const [showOnlyLoopTracks, setShowOnlyLoopTracks] = useState(true);
  const [hoverSec, setHoverSec] = useState<number | null>(null);
  const [selectedRef, setSelectedRef] = useState<{ trackId: string; clipId: string } | null>(
    initialSelectedClipRef
  );
  const [dragHud, setDragHud] = useState<{
    clipId: string;
    deltaMs: number;
    startSec: number;
    fineMode: boolean;
  } | null>(null);
  const [alignMessage, setAlignMessage] = useState<string | null>(null);

  const pendingZoomScrollRef = useRef<{ anchorSec: number; viewportOffsetPx: number } | null>(null);
  const suppressScrollEventRef = useRef(false);
  const projectRef = useRef(project);
  const assetsMapRef = useRef(assetsMap);
  const zoomRef = useRef(zoomPxPerSec);
  const initialSelectedRef = useRef(initialSelectedClipRef);
  const windowStartRef = useRef(0);
  const onCloseRef = useRef(onClose);
  const onTogglePlayRef = useRef(onTogglePlay);
  projectRef.current = project;
  assetsMapRef.current = assetsMap;
  zoomRef.current = zoomPxPerSec;
  initialSelectedRef.current = initialSelectedClipRef;
  onCloseRef.current = onClose;
  onTogglePlayRef.current = onTogglePlay;

  const tempoSrc = useMemo<TempoMapSource>(
    () => ({ masterBpm: project.masterBpm, tempoPoints: project.tempoPoints }),
    [project.masterBpm, project.tempoPoints]
  );

  const loopSpanSec = Math.max(0.25, project.loopEndSec - project.loopStartSec);
  const padSec = Math.min(0.6, Math.max(0.15, loopSpanSec * 0.05));
  const windowStartSec = Math.max(0, project.loopStartSec - padSec);
  const windowEndSec = project.loopEndSec + padSec;
  const windowSpanSec = Math.max(0.3, windowEndSec - windowStartSec);
  windowStartRef.current = windowStartSec;

  // Determine which tracks overlap the loop region
  const tracksInLoop = useMemo(() => {
    const overlapping = project.tracks.filter((track) =>
      track.clips.some(
        (c) => c.startSec < project.loopEndSec && c.startSec + c.durationSec > project.loopStartSec
      )
    );
    return overlapping.length > 0 ? overlapping : project.tracks;
  }, [project.tracks, project.loopStartSec, project.loopEndSec]);

  const displayedTracks = showOnlyLoopTracks ? tracksInLoop : project.tracks;

  // Sync initial selection & auto-fit loop zoom whenever the modal opens
  useEffect(() => {
    if (!isOpen) return;

    // Auto-select a sensible clip inside the loop
    const loopClips: Array<{ trackId: string; clip: NleClip }> = [];
    for (const t of projectRef.current.tracks) {
      for (const c of t.clips) {
        if (
          c.startSec < projectRef.current.loopEndSec &&
          c.startSec + c.durationSec > projectRef.current.loopStartSec
        ) {
          loopClips.push({ trackId: t.id, clip: c });
        }
      }
    }

    const initClipRef = initialSelectedRef.current;
    const initValid =
      initClipRef &&
      loopClips.some(
        (x) => x.trackId === initClipRef.trackId && x.clip.id === initClipRef.clipId
      );

    if (initValid && initClipRef) {
      setSelectedRef(initClipRef);
    } else if (loopClips.length > 0) {
      // Pick the latest-starting clip in the loop (usually the incoming track being beatmatched)
      const sorted = [...loopClips].sort((a, b) => b.clip.startSec - a.clip.startSec);
      setSelectedRef({ trackId: sorted[0].trackId, clipId: sorted[0].clip.id });
    } else {
      setSelectedRef(initClipRef);
    }

    // Fit loop nicely across viewport after layout mounts
    const raf = requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      const w = Math.max(300, scroller.clientWidth);
      setViewportWidth(w);
      const span = Math.max(0.3, projectRef.current.loopEndSec - projectRef.current.loopStartSec);
      const pad = Math.min(0.6, Math.max(0.15, span * 0.05));
      const fitZoom = clampSuperZoom(w / (span + pad * 2));
      setZoomPxPerSec(fitZoom);
      suppressScrollEventRef.current = true;
      scroller.scrollLeft = 0;
      setScrollLeft((prev) => (prev === 0 ? prev : 0));
      requestAnimationFrame(() => {
        suppressScrollEventRef.current = false;
      });
    });

    return () => cancelAnimationFrame(raf);
  }, [isOpen]);

  // Measure viewport width responsively
  useEffect(() => {
    if (!isOpen) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    let rafId = 0;
    const updateSize = () => {
      rafId = 0;
      if (scroller.clientWidth <= 0) return;
      const next = Math.max(300, scroller.clientWidth);
      setViewportWidth((prev) => (Math.abs(prev - next) <= 1 ? prev : next));
    };
    const scheduleUpdate = () => {
      if (rafId !== 0) return;
      rafId = requestAnimationFrame(updateSize);
    };
    scheduleUpdate();
    const ro = new ResizeObserver(scheduleUpdate);
    ro.observe(scroller);
    return () => {
      ro.disconnect();
      if (rafId !== 0) cancelAnimationFrame(rafId);
    };
  }, [isOpen]);

  // Apply anchor-preserved scroll position after zoom change
  useLayoutEffect(() => {
    const pending = pendingZoomScrollRef.current;
    const scroller = scrollRef.current;
    if (!pending || !scroller) return;
    pendingZoomScrollRef.current = null;
    const targetLeft = Math.max(
      0,
      (pending.anchorSec - windowStartRef.current) * zoomPxPerSec - pending.viewportOffsetPx
    );
    suppressScrollEventRef.current = true;
    scroller.scrollLeft = targetLeft;
    const actualLeft = scroller.scrollLeft;
    setScrollLeft((prev) => (Math.abs(prev - actualLeft) < 0.5 ? prev : actualLeft));
    requestAnimationFrame(() => {
      suppressScrollEventRef.current = false;
    });
  }, [zoomPxPerSec]);

  // Ctrl/Cmd + Wheel zoom (or standard wheel zoom over canvas)
  useEffect(() => {
    if (!isOpen) return;
    const scroller = scrollRef.current;
    if (!scroller) return;

    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.deltaY === 0) return;

      const curZoom = zoomRef.current;
      const clampedDelta = Math.max(-180, Math.min(180, e.deltaY));
      const factor = Math.exp(-clampedDelta * 0.0032);
      const nextZoom = clampSuperZoom(curZoom * factor);
      if (nextZoom === curZoom) return;

      const rect = scroller.getBoundingClientRect();
      const offsetX = Math.max(0, Math.min(scroller.clientWidth, e.clientX - rect.left));
      const anchorSec = windowStartRef.current + (scroller.scrollLeft + offsetX) / curZoom;

      pendingZoomScrollRef.current = {
        anchorSec,
        viewportOffsetPx: offsetX,
      };
      setZoomPxPerSec(nextZoom);
    };

    scroller.addEventListener('wheel', handleWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', handleWheel);
  }, [isOpen]);

  const selectedEntry = useMemo(() => {
    if (!selectedRef) return null;
    const track = project.tracks.find((t) => t.id === selectedRef.trackId);
    if (!track) return null;
    const clip = track.clips.find((c) => c.id === selectedRef.clipId);
    if (!clip) return null;
    const asset = assetsMap.get(clip.trackAssetId);
    return { track, clip, asset };
  }, [project.tracks, selectedRef, assetsMap]);

  const selectClip = useCallback(
    (ref: { trackId: string; clipId: string } | null) => {
      setSelectedRef(ref);
      onSelectClipRef?.(ref);
    },
    [onSelectClipRef]
  );

  // Nudge selected clip position with millisecond precision
  const nudgeSelectedClipMs = useCallback(
    (deltaMs: number) => {
      if (!selectedEntry) return;
      const nextStart = Math.max(0, Math.round((selectedEntry.clip.startSec + deltaMs / 1000) * 10000) / 10000);
      onMoveClip(selectedEntry.track.id, selectedEntry.track.id, selectedEntry.clip.id, nextStart);
      onCommitTempoChange?.();
    },
    [selectedEntry, onMoveClip, onCommitTempoChange]
  );

  // Nudge beatOffsetSec on the selected clip's asset (shifts beat markers without moving audio)
  const nudgeSelectedBeatGridMs = useCallback(
    (deltaMs: number) => {
      if (!selectedEntry?.asset || !onUpdateTrackBeatOffset) return;
      const nextOffset = Math.max(
        0,
        Math.round((selectedEntry.asset.beatOffsetSec + deltaMs / 1000) * 10000) / 10000
      );
      onUpdateTrackBeatOffset(selectedEntry.asset.id, nextOffset);
    },
    [selectedEntry, onUpdateTrackBeatOffset]
  );

  const handleSnapSelectedToNearestBeat = useCallback(() => {
    if (!selectedEntry) return;
    const liveProj = projectRef.current;
    const subsequentIds =
      liveProj.rippleMove !== false
        ? new Set(
            liveProj.tracks.flatMap((t) =>
              t.clips
                .filter(
                  (c) =>
                    c.id !== selectedEntry.clip.id &&
                    c.startSec > selectedEntry.clip.startSec + 1e-4
                )
                .map((c) => c.id)
            )
          )
        : undefined;
    const snapped = snapClipStartToBeatGrid({
      project: liveProj,
      rawStartSec: selectedEntry.clip.startSec,
      snapMode: 'quarter-beat',
      offsetSec: selectedEntry.clip.offsetSec,
      durationSec: selectedEntry.clip.durationSec,
      stretchToMasterBpm: selectedEntry.clip.stretchToMasterBpm,
      asset: selectedEntry.asset,
      assetsMap: assetsMapRef.current,
      excludeClipId: selectedEntry.clip.id,
      excludeClipIds: subsequentIds,
    });
    const deltaMs = (snapped - selectedEntry.clip.startSec) * 1000;
    onMoveClip(selectedEntry.track.id, selectedEntry.track.id, selectedEntry.clip.id, snapped);
    onCommitTempoChange?.();
    setAlignMessage(`Snapped to beat (${deltaMs >= 0 ? '+' : ''}${deltaMs.toFixed(1)} ms)`);
    window.setTimeout(() => setAlignMessage(null), 2400);
  }, [selectedEntry, onMoveClip, onCommitTempoChange]);

  // Identify overlapping upper and/or lower clip relative to the selected track
  const { upperMatchTarget, lowerMatchTarget } = useMemo(() => {
    if (!selectedEntry) {
      return { upperMatchTarget: null, lowerMatchTarget: null };
    }
    const selTrackIdx = displayedTracks.findIndex((t) => t.id === selectedEntry.track.id);
    if (selTrackIdx === -1) {
      return { upperMatchTarget: null, lowerMatchTarget: null };
    }

    const selStart = selectedEntry.clip.startSec;
    const selEnd = selStart + selectedEntry.clip.durationSec;

    const findNearestInDirection = (
      dir: 'upper' | 'lower'
    ): { track: NleTrack; clip: NleClip; asset: TrackAsset } | null => {
      const step = dir === 'upper' ? -1 : 1;
      for (let idx = selTrackIdx + step; idx >= 0 && idx < displayedTracks.length; idx += step) {
        const track = displayedTracks[idx];
        let best: { clip: NleClip; asset: TrackAsset; score: number } | null = null;
        for (const other of track.clips) {
          const otherAsset = assetsMap.get(other.trackAssetId);
          if (!otherAsset || !Number.isFinite(otherAsset.bpm) || otherAsset.bpm <= 0) continue;
          const ovStart = Math.max(selStart, other.startSec);
          const ovEnd = Math.min(selEnd, other.startSec + other.durationSec);
          const ov = ovEnd - ovStart;
          if (ov <= 0.05) continue;
          const loopOv =
            Math.max(0, Math.min(ovEnd, project.loopEndSec) - Math.max(ovStart, project.loopStartSec));
          const score = loopOv > 0 ? 10000 + loopOv : ov;
          if (!best || score > best.score) {
            best = { clip: other, asset: otherAsset, score };
          }
        }
        if (best) {
          return { track, clip: best.clip, asset: best.asset };
        }
      }
      return null;
    };

    return {
      upperMatchTarget: findNearestInDirection('upper'),
      lowerMatchTarget: findNearestInDirection('lower'),
    };
  }, [selectedEntry, displayedTracks, assetsMap, project.loopStartSec, project.loopEndSec]);

  // Shift the selected clip's beat markers (beatOffsetSec) to line up with the upper or lower clip's beat markers without moving audio
  const handleMatchClipBeats = useCallback(
    (direction: 'upper' | 'lower') => {
      const target = direction === 'upper' ? upperMatchTarget : lowerMatchTarget;
      if (!selectedEntry?.asset || selectedEntry.asset.bpm <= 0 || !target || !onUpdateTrackBeatOffset) {
        return;
      }

      const liveProj = projectRef.current;
      const selClip = selectedEntry.clip;
      const selAsset = selectedEntry.asset;
      const refClip = target.clip;
      const refAsset = target.asset;

      const ovStart = Math.max(selClip.startSec, refClip.startSec);
      const ovEnd = Math.min(selClip.startSec + selClip.durationSec, refClip.startSec + refClip.durationSec);
      const loopOvStart = Math.max(ovStart, liveProj.loopStartSec);
      const loopOvEnd = Math.min(ovEnd, liveProj.loopEndSec);
      const probeSec =
        loopOvEnd > loopOvStart
          ? (loopOvStart + loopOvEnd) * 0.5
          : (ovStart + ovEnd) * 0.5;

      // 1. Find the reference clip's nearest beat marker timestamp to the overlap midpoint
      const refBeatPeriodSec = 60 / refAsset.bpm;
      const refSafeBeatOffset = Number.isFinite(refAsset.beatOffsetSec) ? refAsset.beatOffsetSec : 0;
      const refCanStretch = refClip.stretchToMasterBpm && refAsset.bpm > 0;
      const refHasTempoMap = refCanStretch && liveProj.tempoPoints.length > 0;
      const refConstRatio = refCanStretch
        ? getEffectiveBpmRatio(liveProj.masterBpm, refAsset.bpm)
        : 1;
      const refMatchedBpm = refCanStretch
        ? getOctaveFoldedAssetBpm(
            refAsset.bpm,
            refHasTempoMap
              ? evaluateBpmAt(liveProj, Math.max(0, refClip.startSec))
              : liveProj.masterBpm
          )
        : refAsset.bpm;

      const refLocalOut = probeSec - refClip.startSec;
      const refSrcDelta = refHasTempoMap
        ? integrateClipSourceOffsetSec(liveProj, refClip.startSec, refLocalOut, refAsset.bpm)
        : refLocalOut * refConstRatio;
      const refSrcSec = refClip.offsetSec + refSrcDelta;
      const refNearestBeatIdx = Math.round((refSrcSec - refSafeBeatOffset) / refBeatPeriodSec);
      const refBeatSrcSec = refSafeBeatOffset + refNearestBeatIdx * refBeatPeriodSec;
      const refBeatDeltaSrc = refBeatSrcSec - refClip.offsetSec;

      const refBeatTimelineSec = refHasTempoMap
        ? getTimeAtBeat(
            liveProj,
            getBeatsAtTime(liveProj, refClip.startSec) + refBeatDeltaSrc * (refMatchedBpm / 60)
          )
        : refClip.startSec + refBeatDeltaSrc / Math.max(0.0001, refConstRatio);

      // 2. Convert that timeline timestamp into the selected clip's source time (without moving the clip)
      const selBeatPeriodSec = 60 / selAsset.bpm;
      const selCurBeatOffset = Number.isFinite(selAsset.beatOffsetSec) ? selAsset.beatOffsetSec : 0;
      const selCanStretch = selClip.stretchToMasterBpm && selAsset.bpm > 0;
      const selHasTempoMap = selCanStretch && liveProj.tempoPoints.length > 0;
      const selConstRatio = selCanStretch
        ? getEffectiveBpmRatio(liveProj.masterBpm, selAsset.bpm)
        : 1;

      const selLocalOut = refBeatTimelineSec - selClip.startSec;
      const selSrcDelta = selHasTempoMap
        ? integrateClipSourceOffsetSec(liveProj, selClip.startSec, selLocalOut, selAsset.bpm)
        : selLocalOut * selConstRatio;
      const targetSrcSec = selClip.offsetSec + selSrcDelta;

      // 3. Shift beatOffsetSec by the shortest delta so a beat marker sits directly at targetSrcSec
      const nearestSelBeatIdx = Math.round((targetSrcSec - selCurBeatOffset) / selBeatPeriodSec);
      const deltaSrcSec = targetSrcSec - (selCurBeatOffset + nearestSelBeatIdx * selBeatPeriodSec);

      let nextBeatOffset = selCurBeatOffset + deltaSrcSec;
      if (!Number.isFinite(nextBeatOffset) || !Number.isFinite(selBeatPeriodSec) || selBeatPeriodSec <= 0) {
        return;
      }
      while (nextBeatOffset < 0) {
        nextBeatOffset += selBeatPeriodSec * 4;
      }

      const finalOffset = Math.round(nextBeatOffset * 10000) / 10000;
      onUpdateTrackBeatOffset(selAsset.id, finalOffset);

      const deltaMs = deltaSrcSec * 1000;
      setAlignMessage(
        `Matched ${direction} beat markers (${deltaMs >= 0 ? '+' : ''}${deltaMs.toFixed(1)} ms)`
      );
      window.setTimeout(() => setAlignMessage(null), 2600);
    },
    [selectedEntry, upperMatchTarget, lowerMatchTarget, onUpdateTrackBeatOffset]
  );

  const handleAutoAlignTransients = useCallback(() => {
    if (!selectedEntry?.asset) return;
    const { track, clip, asset } = selectedEntry;

    // Find best overlapping clip on another track (or same track); prefer earlier clip when Ripple Move is active
    let bestRef: { clip: NleClip; asset: TrackAsset; overlap: number } | null = null;
    let bestEarlierRef: { clip: NleClip; asset: TrackAsset; overlap: number } | null = null;
    for (const t of projectRef.current.tracks) {
      for (const other of t.clips) {
        if (other.id === clip.id) continue;
        const otherAsset = assetsMapRef.current.get(other.trackAssetId);
        if (!otherAsset) continue;
        const ov =
          Math.min(clip.startSec + clip.durationSec, other.startSec + other.durationSec) -
          Math.max(clip.startSec, other.startSec);
        if (ov > 0.8) {
          if (other.startSec <= clip.startSec + 1e-4 && (!bestEarlierRef || ov > bestEarlierRef.overlap)) {
            bestEarlierRef = { clip: other, asset: otherAsset, overlap: ov };
          }
          if (!bestRef || ov > bestRef.overlap) {
            bestRef = { clip: other, asset: otherAsset, overlap: ov };
          }
        }
      }
    }
    if (projectRef.current.rippleMove !== false && bestEarlierRef) {
      bestRef = bestEarlierRef;
    }

    if (!bestRef) {
      setAlignMessage('No overlapping track found in loop to auto-align against');
      window.setTimeout(() => setAlignMessage(null), 2600);
      return;
    }

    const res = autoAlignOverlapShiftSec({
      project: projectRef.current,
      targetClip: clip,
      targetAsset: asset,
      referenceClip: bestRef.clip,
      referenceAsset: bestRef.asset,
    });

    if (!res) {
      setAlignMessage('Could not lock kick transients cleanly');
      window.setTimeout(() => setAlignMessage(null), 2400);
      return;
    }

    const nextStart = Math.max(0, clip.startSec + res.deltaSec);
    onMoveClip(track.id, track.id, clip.id, nextStart);
    onCommitTempoChange?.();
    const ms = res.deltaSec * 1000;
    setAlignMessage(
      `Locked transients (${ms >= 0 ? '+' : ''}${ms.toFixed(1)} ms · ${Math.round(res.confidence * 100)}% conf)`
    );
    window.setTimeout(() => setAlignMessage(null), 3000);
  }, [selectedEntry, onMoveClip, onCommitTempoChange]);

  const stepZoom = useCallback(
    (direction: 'in' | 'out') => {
      const scroller = scrollRef.current;
      const curZoom = zoomRef.current;
      const nextZoom = clampSuperZoom(direction === 'in' ? curZoom * 1.45 : curZoom / 1.45);
      if (nextZoom === curZoom) return;

      if (scroller) {
        const playheadX = (projectRef.current.playheadSec - windowStartRef.current) * curZoom - scroller.scrollLeft;
        const anchorPlayhead = playheadX >= 0 && playheadX <= scroller.clientWidth;
        pendingZoomScrollRef.current = {
          anchorSec: anchorPlayhead
            ? projectRef.current.playheadSec
            : windowStartRef.current + (scroller.scrollLeft + scroller.clientWidth / 2) / curZoom,
          viewportOffsetPx: anchorPlayhead ? playheadX : scroller.clientWidth / 2,
        };
      }
      setZoomPxPerSec(nextZoom);
    },
    []
  );

  const handleFitLoop = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    pendingZoomScrollRef.current = null;
    const w = Math.max(300, scroller.clientWidth);
    const fitZoom = clampSuperZoom(w / windowSpanSec);
    setZoomPxPerSec(fitZoom);
    scroller.scrollLeft = 0;
    setScrollLeft(0);
  }, [windowSpanSec]);

  // Keyboard shortcuts while Super Zoom is open
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
        onTogglePlayRef.current();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        const stepMs = e.shiftKey ? 0.5 : e.altKey ? 10 : 1;
        nudgeSelectedClipMs(-stepMs);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        const stepMs = e.shiftKey ? 0.5 : e.altKey ? 10 : 1;
        nudgeSelectedClipMs(stepMs);
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        stepZoom('in');
      } else if (e.key === '-') {
        e.preventDefault();
        stepZoom('out');
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, nudgeSelectedClipMs, stepZoom]);

  // Compute nearest beat phase delta (in ms) for selected clip
  const selectedBeatPhaseMs = useMemo(() => {
    if (!selectedEntry?.asset || selectedEntry.asset.bpm <= 0) return null;
    const { clip, asset } = selectedEntry;
    const beatPeriodSec = 60 / asset.bpm;
    const safeBeatOffset = Number.isFinite(asset.beatOffsetSec) ? asset.beatOffsetSec : 0;
    // Pick a beat near the center of the loop
    const probeSec = Math.max(
      clip.startSec,
      Math.min(clip.startSec + clip.durationSec, (project.loopStartSec + project.loopEndSec) * 0.5)
    );
    const localOut = probeSec - clip.startSec;
    const canStretch = clip.stretchToMasterBpm && asset.bpm > 0;
    const srcSec =
      clip.offsetSec +
      (canStretch
        ? integrateClipSourceOffsetSec(tempoSrc, clip.startSec, localOut, asset.bpm)
        : localOut);
    const nearestClipBeatIdx = Math.round((srcSec - safeBeatOffset) / beatPeriodSec);
    const clipBeatSrcSec = safeBeatOffset + nearestClipBeatIdx * beatPeriodSec;
    const deltaSrc = clipBeatSrcSec - clip.offsetSec;

    const startTimelineBeats = getBeatsAtTime(tempoSrc, clip.startSec);
    const matchedSelBpm = canStretch
      ? getOctaveFoldedAssetBpm(
          asset.bpm,
          evaluateBpmAt(tempoSrc, Math.max(0, clip.startSec))
        )
      : asset.bpm;
    const clipBeatTimelineSec = canStretch
      ? getTimeAtBeat(tempoSrc, startTimelineBeats + deltaSrc * (matchedSelBpm / 60))
      : clip.startSec + deltaSrc;

    const masterBeatsAtClipBeat = getBeatsAtTime(tempoSrc, clipBeatTimelineSec);
    const nearestMasterBeat = Math.round(masterBeatsAtClipBeat);
    const nearestMasterSec = getTimeAtBeat(tempoSrc, nearestMasterBeat);
    return (clipBeatTimelineSec - nearestMasterSec) * 1000;
  }, [selectedEntry, tempoSrc, project.loopStartSec, project.loopEndSec]);

  const totalContentWidthPx = Math.max(viewportWidth, Math.ceil(windowSpanSec * zoomPxPerSec));
  const visibleStartSec = windowStartSec + scrollLeft / zoomPxPerSec;
  const visibleEndSec = visibleStartSec + viewportWidth / zoomPxPerSec;

  const gridTicks = useMemo(
    () =>
      isOpen
        ? computeVisibleGridTicks(tempoSrc, visibleStartSec, visibleEndSec, zoomPxPerSec)
        : [],
    [isOpen, tempoSrc, visibleStartSec, visibleEndSec, zoomPxPerSec]
  );

  // Compute dynamic tall lane height so waveforms are super clear
  const laneHeight = useMemo(() => {
    const count = Math.max(1, displayedTracks.length);
    if (count === 1) return 220;
    if (count === 2) return 176;
    if (count === 3) return 134;
    return 108;
  }, [displayedTracks.length]);

  const { bar: playheadBar, beat: playheadBeat, bpm: liveBpm } = getBarAndBeatAt(
    tempoSrc,
    project.playheadSec
  );

  const loopDurationBars = useMemo(() => {
    const s = getBeatsAtTime(tempoSrc, project.loopStartSec);
    const e = getBeatsAtTime(tempoSrc, project.loopEndSec);
    return Math.max(0, (e - s) / 4);
  }, [tempoSrc, project.loopStartSec, project.loopEndSec]);

  if (!isOpen) return null;

  const timeToViewportX = (sec: number) => (sec - visibleStartSec) * zoomPxPerSec;

  // Ruler scrubbing
  const handleRulerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const seekAtClientX = (clientX: number) => {
      const localX = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const sec = Math.max(0, visibleStartSec + localX / zoomPxPerSec);
      onSeek(sec);
    };
    seekAtClientX(e.clientX);
    const onMove = (ev: PointerEvent) => seekAtClientX(ev.clientX);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Drag Loop In / Loop Out handles inside Super Zoom ruler
  const startLoopHandleDrag = (e: React.PointerEvent, edge: 'start' | 'end') => {
    e.stopPropagation();
    e.preventDefault();
    const startClientX = e.clientX;
    const origStart = projectRef.current.loopStartSec;
    const origEnd = projectRef.current.loopEndSec;

    const onMove = (ev: PointerEvent) => {
      const fine = ev.shiftKey ? 0.1 : 1;
      const dt = ((ev.clientX - startClientX) / zoomRef.current) * fine;
      if (edge === 'start') {
        const next = Math.max(0, Math.min(origEnd - 0.1, origStart + dt));
        onUpdateProject({ loopStartSec: next, loopEnabled: true });
      } else {
        const next = Math.max(origStart + 0.1, origEnd + dt);
        onUpdateProject({ loopEndSec: next, loopEnabled: true });
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Ultra-precise clip dragging directly on a track lane
  const handleLanePointerDown = (e: React.PointerEvent<HTMLDivElement>, track: NleTrack) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const clickSec = visibleStartSec + localX / zoomPxPerSec;

    // Find clip under pointer
    const hitClip = track.clips.find(
      (c) => clickSec >= c.startSec && clickSec <= c.startSec + c.durationSec
    );

    if (!hitClip) {
      // Clicking empty lane seeks playhead cleanly
      onSeek(Math.max(0, clickSec));
      return;
    }

    e.stopPropagation();
    e.preventDefault();
    selectClip({ trackId: track.id, clipId: hitClip.id });

    const startClientX = e.clientX;
    const origStart = hitClip.startSec;
    const asset = assetsMap.get(hitClip.trackAssetId);

    const initialRippleClipIds = new Set<string>();
    for (const t of projectRef.current.tracks) {
      for (const c of t.clips) {
        if (c.id !== hitClip.id && c.startSec > origStart + 1e-4) {
          initialRippleClipIds.add(c.id);
        }
      }
    }

    setDragHud({
      clipId: hitClip.id,
      deltaMs: 0,
      startSec: origStart,
      fineMode: e.shiftKey,
    });

    const onMove = (ev: PointerEvent) => {
      const rippleActive = projectRef.current.rippleMove !== false;
      const fineFactor = ev.shiftKey ? 0.1 : 1;
      const dx = (ev.clientX - startClientX) * fineFactor;
      const rawNext = Math.max(0, origStart + dx / zoomRef.current);

      let nextSec = rawNext;
      if (precisionSnap === '1ms') {
        nextSec = Math.round(rawNext * 1000) / 1000;
      } else if (precisionSnap === 'quarter-beat') {
        nextSec = snapClipStartToBeatGrid({
          project: projectRef.current,
          rawStartSec: rawNext,
          snapMode: 'quarter-beat',
          offsetSec: hitClip.offsetSec,
          durationSec: hitClip.durationSec,
          stretchToMasterBpm: hitClip.stretchToMasterBpm,
          asset,
          assetsMap: assetsMapRef.current,
          excludeClipId: hitClip.id,
          excludeClipIds: rippleActive ? initialRippleClipIds : undefined,
        });
      } else if (precisionSnap === 'beat') {
        // Snap to full beat aligned with the overlapping clip's reference beat phase
        const liveProj = projectRef.current;
        const refPhase = getReferenceBeatPhase(
          liveProj,
          assetsMapRef.current,
          hitClip.id,
          { startSec: rawNext, endSec: rawNext + hitClip.durationSec },
          rippleActive ? initialRippleClipIds : undefined
        );
        const effectiveRef = refPhase === null ? 0 : ((refPhase % 1) + 1) % 1;
        if (asset && asset.bpm > 0) {
          const safeOffset = Number.isFinite(asset.beatOffsetSec) ? asset.beatOffsetSec : 0;
          const effBpm = hitClip.stretchToMasterBpm ? asset.bpm : evaluateBpmAt(liveProj, rawNext);
          const rawLead = ((safeOffset - hitClip.offsetSec) * effBpm) / 60;
          const leadBeat = ((rawLead % 1) + 1) % 1;
          const rawBeats = getBeatsAtTime(liveProj, rawNext) + leadBeat;
          let snappedBeat = Math.round(rawBeats - effectiveRef) + effectiveRef;
          if (Number.isFinite(snappedBeat) && Number.isFinite(leadBeat)) {
            while (snappedBeat - leadBeat < -1e-4) snappedBeat += 1;
            nextSec = Math.max(0, getTimeAtBeat(liveProj, Math.max(0, snappedBeat - leadBeat)));
          }
        } else {
          const rawBeats = getBeatsAtTime(liveProj, rawNext);
          nextSec = Math.max(0, getTimeAtBeat(liveProj, Math.round(rawBeats - effectiveRef) + effectiveRef));
        }
      } else {
        // Free mode: 0.1ms precision
        nextSec = Math.round(rawNext * 10000) / 10000;
      }

      onMoveClip(
        track.id,
        track.id,
        hitClip.id,
        nextSec,
        rippleActive ? initialRippleClipIds : undefined
      );
      setDragHud({
        clipId: hitClip.id,
        deltaMs: (nextSec - origStart) * 1000,
        startSec: nextSec,
        fineMode: ev.shiftKey,
      });
    };

    const onUp = () => {
      setDragHud(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      onCommitTempoChange?.();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleLanesPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x >= 0 && x <= rect.width) {
      setHoverSec(Math.max(0, visibleStartSec + x / zoomPxPerSec));
    } else {
      setHoverSec(null);
    }
  };

  const playheadX = timeToViewportX(project.playheadSec);
  const hoverX = hoverSec !== null ? timeToViewportX(hoverSec) : null;
  const loopStartX = timeToViewportX(project.loopStartSec);
  const loopEndX = timeToViewportX(project.loopEndSec);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5 select-none"
      role="dialog"
      aria-modal="true"
      aria-label="Beat Edit Alignment Window"
    >
      <div className="w-full h-full max-w-[1680px] max-h-[94vh] rounded-xl bg-om-base border border-om-secondary/30 shadow-2xl flex flex-col overflow-hidden">
        {/* Top Window Bar: Title, Loop Transport, Precision & Zoom Controls */}
        <div className="px-4 py-2.5 bg-om-panel-alt border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-om-secondary/15 border border-om-secondary/35 text-om-secondary">
              <Crosshair className="w-3.5 h-3.5" />
              <span className="text-xs font-semibold tracking-wide uppercase">Beat Edit</span>
            </div>

            <div className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded bg-om-base border border-white/[0.07] font-mono tabular-nums text-[11px] text-om-text-muted">
              <Repeat className="w-3 h-3 text-om-secondary" />
              <span className="text-om-text">{formatTimecode(project.loopStartSec, true)}</span>
              <span className="text-om-text-icon">→</span>
              <span className="text-om-text">{formatTimecode(project.loopEndSec, true)}</span>
              <span className="text-om-text-icon">·</span>
              <span className="text-om-secondary">
                {loopDurationBars >= 0.25
                  ? `${Number(loopDurationBars.toFixed(2))} bars`
                  : `${loopSpanSec.toFixed(2)}s`}
              </span>
            </div>

            {/* Embedded Transport */}
            <div className="flex items-center gap-1.5 ml-1">
              <button
                type="button"
                onClick={onTogglePlay}
                title="Play / Pause Loop (Space)"
                className={`h-7 px-3 rounded text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer ${
                  project.isPlaying
                    ? 'bg-om-accent text-om-accent-ink'
                    : 'bg-om-control hover:bg-om-control-hover text-om-text border border-white/[0.08]'
                }`}
              >
                {project.isPlaying ? (
                  <>
                    <Pause className="w-3 h-3 fill-current" />
                    Pause
                  </>
                ) : (
                  <>
                    <Play className="w-3 h-3 fill-current" />
                    Play Loop
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={onStop}
                title="Stop"
                className="h-7 w-7 rounded bg-om-control hover:bg-om-control-hover border border-white/[0.08] flex items-center justify-center text-om-text-secondary cursor-pointer"
              >
                <Square className="w-3 h-3 fill-current" />
              </button>

              <button
                type="button"
                onClick={() => onSeek(project.loopStartSec)}
                title="Jump Playhead to Loop Start"
                className="h-7 px-2 rounded bg-om-control hover:bg-om-control-hover border border-white/[0.08] text-[11px] font-mono text-om-secondary cursor-pointer"
              >
                In
              </button>

              <div className="px-2.5 py-1 rounded bg-om-base border border-white/[0.08] font-mono tabular-nums text-[11px] flex items-center gap-2">
                <span className="text-om-text font-semibold">
                  {formatTimecodeMs(project.playheadSec)}
                </span>
                <span className="text-om-text-icon">·</span>
                <span className="text-om-secondary">
                  {playheadBar}:{playheadBeat}
                </span>
                <span className="text-om-text-icon">·</span>
                <span className="text-om-accent">{liveBpm.toFixed(1)}</span>
              </div>
            </div>
          </div>

          {/* Right Controls: Precision Snap, Visual Overlays, Zoom, Close */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Drag Snap Precision Selector */}
            <div className="inline-flex items-center rounded bg-om-base border border-white/[0.08] p-0.5 text-[11px]">
              {(
                [
                  { id: 'free', label: 'Free' },
                  { id: '1ms', label: '1ms' },
                  { id: 'quarter-beat', label: '1/16' },
                  { id: 'beat', label: 'Beat' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setPrecisionSnap(opt.id)}
                  className={`px-2 py-0.5 rounded transition-colors cursor-pointer ${
                    precisionSnap === opt.id
                      ? 'bg-om-secondary/25 text-om-secondary font-semibold'
                      : 'text-om-text-dim hover:text-om-text'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Waveform Vertical Gain Boost */}
            <button
              type="button"
              onClick={() => setVerticalGain((g) => (g === 1 ? 2 : g === 2 ? 3 : 1))}
              title="Cycle vertical waveform magnification (1× / 2× / 3×)"
              className="h-7 px-2 rounded bg-om-control hover:bg-om-control-hover border border-white/[0.08] text-[11px] font-mono text-om-text-secondary cursor-pointer"
            >
              Gain {verticalGain}×
            </button>

            {/* Grid & Clip Beat Toggles */}
            <button
              type="button"
              onClick={() => setShowMasterGrid((v) => !v)}
              className={`h-7 px-2 rounded border text-[11px] transition-colors cursor-pointer ${
                showMasterGrid
                  ? 'bg-om-secondary/15 border-om-secondary/40 text-om-secondary'
                  : 'bg-om-control border-white/[0.08] text-om-text-subtle'
              }`}
            >
              Grid
            </button>
            <button
              type="button"
              onClick={() => setShowClipBeats((v) => !v)}
              className={`h-7 px-2 rounded border text-[11px] transition-colors cursor-pointer ${
                showClipBeats
                  ? 'bg-om-accent/15 border-om-accent/40 text-om-accent'
                  : 'bg-om-control border-white/[0.08] text-om-text-subtle'
              }`}
            >
              Clip Beats
            </button>

            {tracksInLoop.length < project.tracks.length && (
              <button
                type="button"
                onClick={() => setShowOnlyLoopTracks((v) => !v)}
                className={`h-7 px-2 rounded border text-[11px] transition-colors cursor-pointer ${
                  showOnlyLoopTracks
                    ? 'bg-white/[0.08] border-white/[0.16] text-om-text'
                    : 'bg-om-control border-white/[0.08] text-om-text-dim'
                }`}
              >
                {showOnlyLoopTracks ? `Loop Tracks (${tracksInLoop.length})` : `All (${project.tracks.length})`}
              </button>
            )}

            {/* Super Zoom Controls */}
            <div className="inline-flex items-center gap-1 rounded bg-om-control border border-white/[0.08] px-1.5 h-7">
              <button
                type="button"
                onClick={() => stepZoom('out')}
                title="Zoom Out (-)"
                className="p-0.5 text-om-text-muted hover:text-om-text cursor-pointer"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <input
                type="range"
                min={Math.log(MIN_SUPER_ZOOM)}
                max={Math.log(MAX_SUPER_ZOOM)}
                step={0.02}
                value={Math.log(Math.max(MIN_SUPER_ZOOM, zoomPxPerSec))}
                onChange={(e) => {
                  const next = clampSuperZoom(Math.exp(parseFloat(e.target.value)));
                  const scroller = scrollRef.current;
                  if (scroller) {
                    const centerSec =
                      windowStartRef.current + (scroller.scrollLeft + scroller.clientWidth / 2) / zoomRef.current;
                    pendingZoomScrollRef.current = {
                      anchorSec: centerSec,
                      viewportOffsetPx: scroller.clientWidth / 2,
                    };
                  }
                  setZoomPxPerSec(next);
                }}
                className="w-20 accent-om-secondary cursor-pointer"
                title="Beat Edit Magnification (Ctrl/Cmd + Scroll)"
              />
              <button
                type="button"
                onClick={() => stepZoom('in')}
                title="Zoom In (+)"
                className="p-0.5 text-om-text-muted hover:text-om-text cursor-pointer"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
              <span className="text-[10px] font-mono tabular-nums text-om-text-muted w-12 text-right">
                {Math.round(zoomPxPerSec)}px/s
              </span>
              <button
                type="button"
                onClick={handleFitLoop}
                title="Fit Loop Region to Window"
                className="ml-0.5 px-1.5 py-0.5 rounded bg-om-base hover:bg-white/[0.08] text-[10px] text-om-text-secondary inline-flex items-center gap-1 cursor-pointer"
              >
                <Maximize2 className="w-2.5 h-2.5" />
                Fit
              </button>
            </div>

            <button
              type="button"
              onClick={onClose}
              title="Close Beat Edit (Esc)"
              className="h-7 w-7 rounded bg-om-control hover:bg-om-danger/20 hover:text-om-danger border border-white/[0.08] flex items-center justify-center text-om-text-muted transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Main Super Zoom Workspace: Left Track Headers + Right Virtualized High-Res Canvas */}
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* Left Fixed Track Labels Sidebar */}
          <div
            style={{ width: TRACK_SIDEBAR_WIDTH }}
            className="shrink-0 bg-om-sub border-r border-white/[0.08] flex flex-col overflow-y-auto"
          >
            {/* Top-left corner matching Ruler height */}
            <div
              style={{ height: RULER_HEIGHT }}
              className="shrink-0 px-3 border-b border-white/[0.08] flex flex-col justify-center bg-om-panel"
            >
              <span className="text-[10px] font-semibold uppercase tracking-wider text-om-text-subtle">
                Beat Alignment
              </span>
              <span className="text-[10px] text-om-text-icon">
                Shift+Drag = 10× Fine
              </span>
            </div>

            {/* Track Sidebar Rows */}
            {displayedTracks.map((track, tIdx) => {
              const clipsInView = track.clips.filter(
                (c) => c.startSec < windowEndSec && c.startSec + c.durationSec > windowStartSec
              );
              const primaryClip =
                clipsInView.find((c) => c.id === selectedRef?.clipId) ?? clipsInView[0] ?? null;
              const primaryAsset = primaryClip ? assetsMap.get(primaryClip.trackAssetId) : undefined;
              const isSelectedTrack = selectedRef?.trackId === track.id;
              const resolvedAccent = resolveTrackAccentColor(track.accentColor, tIdx, themeId);

              return (
                <div
                  key={track.id}
                  style={{ height: laneHeight }}
                  onClick={() => {
                    if (primaryClip) {
                      selectClip({ trackId: track.id, clipId: primaryClip.id });
                    }
                  }}
                  className={`shrink-0 px-3 py-2.5 border-b border-white/[0.08] flex flex-col justify-between transition-colors cursor-pointer ${
                    isSelectedTrack ? 'bg-white/[0.04]' : 'hover:bg-white/[0.02]'
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between gap-1.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: resolvedAccent }}
                        />
                        <span className="text-xs font-semibold text-om-text truncate">
                          {track.name}
                        </span>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onUpdateTrack(track.id, { muted: !track.muted });
                          }}
                          title={track.muted ? 'Unmute track' : 'Mute track'}
                          className={`h-5 w-5 rounded flex items-center justify-center text-[10px] cursor-pointer ${
                            track.muted
                              ? 'bg-om-danger/25 text-om-danger'
                              : 'bg-white/[0.05] text-om-text-dim hover:text-om-text'
                          }`}
                        >
                          {track.muted ? <VolumeX className="w-3 h-3" /> : <Volume2 className="w-3 h-3" />}
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onUpdateTrack(track.id, { soloed: !track.soloed });
                          }}
                          title="Solo track"
                          className={`h-5 w-5 rounded text-[10px] font-bold cursor-pointer ${
                            track.soloed
                              ? 'bg-om-accent text-om-accent-ink'
                              : 'bg-white/[0.05] text-om-text-dim hover:text-om-text'
                          }`}
                        >
                          S
                        </button>
                      </div>
                    </div>

                    {primaryAsset ? (
                      <div className="mt-1.5 space-y-0.5">
                        <div className="text-[11px] text-om-text-secondary truncate" title={primaryAsset.name}>
                          {primaryAsset.name}
                        </div>
                        <div className="text-[10px] font-mono text-om-text-subtle flex items-center gap-1.5">
                          <span>{primaryAsset.bpm.toFixed(1)} BPM</span>
                          <span>·</span>
                          <span>{primaryAsset.camelotCode}</span>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2 text-[10px] text-om-text-icon italic">No clip in loop</div>
                    )}
                  </div>

                  {primaryClip && (
                    <div className="pt-1 border-t border-white/[0.05] flex items-center justify-between text-[10px] font-mono tabular-nums text-om-text-dim">
                      <span>Start</span>
                      <span className="text-om-text">{formatTimecodeMs(primaryClip.startSec)}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Right Horizontally Scrollable Zoom Viewport */}
          <div
            ref={scrollRef}
            onScroll={(e) => {
              if (suppressScrollEventRef.current) return;
              const next = e.currentTarget.scrollLeft;
              setScrollLeft((prev) => (Math.abs(prev - next) < 0.5 ? prev : next));
            }}
            className="flex-1 min-w-0 overflow-x-auto overflow-y-auto relative bg-om-deepest"
          >
            <div style={{ width: totalContentWidthPx }} className="relative min-h-full">
              {/* Sticky Viewport Container (always sized to visible viewportWidth for crisp 60fps canvas rendering) */}
              <div
                style={{ width: viewportWidth }}
                className="sticky left-0 top-0"
              >
                {/* Top High-Precision Bar/Beat/ms Ruler */}
                <div
                  style={{ height: RULER_HEIGHT }}
                  onPointerDown={handleRulerPointerDown}
                  onPointerMove={handleLanesPointerMove}
                  onPointerLeave={() => setHoverSec(null)}
                  className="relative bg-om-panel-alt border-b border-white/[0.1] cursor-ew-resize overflow-hidden"
                >
                  {/* Loop highlight bar in top strip of ruler */}
                  {loopEndX > 0 && loopStartX < viewportWidth && (
                    <div
                      style={{
                        left: Math.max(0, loopStartX),
                        width: Math.max(2, Math.min(viewportWidth, loopEndX) - Math.max(0, loopStartX)),
                      }}
                      className="absolute top-0 h-2 bg-om-secondary/45 border-b border-om-secondary/70 pointer-events-none"
                    />
                  )}

                  {/* Draggable Loop In Handle */}
                  {loopStartX >= -8 && loopStartX <= viewportWidth + 8 && (
                    <div
                      style={{ left: loopStartX - 5 }}
                      onPointerDown={(e) => startLoopHandleDrag(e, 'start')}
                      title="Drag Loop In boundary (Shift = fine)"
                      className="absolute top-0 h-4 w-2.5 bg-om-secondary rounded-b-sm cursor-ew-resize z-20 flex items-center justify-center shadow"
                    >
                      <div className="w-0.5 h-2 bg-om-deepest" />
                    </div>
                  )}

                  {/* Draggable Loop Out Handle */}
                  {loopEndX >= -8 && loopEndX <= viewportWidth + 8 && (
                    <div
                      style={{ left: loopEndX - 5 }}
                      onPointerDown={(e) => startLoopHandleDrag(e, 'end')}
                      title="Drag Loop Out boundary (Shift = fine)"
                      className="absolute top-0 h-4 w-2.5 bg-om-secondary rounded-b-sm cursor-ew-resize z-20 flex items-center justify-center shadow"
                    >
                      <div className="w-0.5 h-2 bg-om-deepest" />
                    </div>
                  )}

                  {/* Grid Tick Marks & Bar:Beat Labels */}
                  {gridTicks.map((tick) => {
                    const x = timeToViewportX(tick.timeSec);
                    if (x < -30 || x > viewportWidth + 30) return null;
                    const isBar = tick.kind === 'bar';
                    const isBeat = tick.kind === 'beat';
                    return (
                      <div
                        key={`${tick.beatIndex}_${tick.kind}`}
                        style={{ left: x }}
                        className="absolute bottom-0 pointer-events-none"
                      >
                        <div
                          className={
                            isBar
                              ? 'w-px h-5 bg-om-secondary/80'
                              : isBeat
                                ? 'w-px h-3.5 bg-white/40'
                                : tick.kind === 'half'
                                  ? 'w-px h-2 bg-white/20'
                                  : 'w-px h-1.5 bg-white/10'
                          }
                        />
                        {isBar && (
                          <div className="absolute bottom-4 left-1.5 flex items-baseline gap-1.5 whitespace-nowrap">
                            <span className="text-[10px] font-mono font-semibold text-om-secondary">
                              {tick.barNum}.1
                            </span>
                            {zoomPxPerSec >= 90 && (
                              <span className="text-[9px] font-mono text-om-text-faint">
                                {formatTimecodeMs(tick.timeSec)}
                              </span>
                            )}
                          </div>
                        )}
                        {isBeat && zoomPxPerSec >= 60 && (
                          <span className="absolute bottom-3.5 left-1 text-[9px] font-mono text-om-text-muted whitespace-nowrap">
                            {tick.barNum}.{tick.beatInBar}
                          </span>
                        )}
                      </div>
                    );
                  })}

                  {/* Playhead triangle in ruler */}
                  {playheadX >= -6 && playheadX <= viewportWidth + 6 && (
                    <div
                      style={{ left: playheadX - 5 }}
                      className="absolute bottom-0 w-0 h-0 border-l-[5px] border-r-[5px] border-t-[7px] border-l-transparent border-r-transparent border-t-om-accent pointer-events-none z-20"
                    />
                  )}
                </div>

                {/* Track Waveform Lanes Container */}
                <div
                  ref={lanesContainerRef}
                  onPointerMove={handleLanesPointerMove}
                  onPointerLeave={() => setHoverSec(null)}
                  className="relative"
                >
                  {displayedTracks.map((track, tIdx) => (
                    <div
                      key={track.id}
                      style={{ height: laneHeight }}
                      onPointerDown={(e) => handleLanePointerDown(e, track)}
                      className="relative border-b border-white/[0.08] cursor-grab active:cursor-grabbing overflow-hidden"
                    >
                      <HighResTrackCanvas
                        track={track}
                        trackAccentColor={resolveTrackAccentColor(track.accentColor, tIdx, themeId)}
                        masterBpm={project.masterBpm}
                        tempoPoints={project.tempoPoints}
                        loopStartSec={project.loopStartSec}
                        loopEndSec={project.loopEndSec}
                        assetsMap={assetsMap}
                        selectedClipId={
                          selectedRef?.trackId === track.id ? selectedRef.clipId : null
                        }
                        visibleStartSec={visibleStartSec}
                        visibleEndSec={visibleEndSec}
                        zoomPxPerSec={zoomPxPerSec}
                        viewportWidth={viewportWidth}
                        laneHeight={laneHeight}
                        verticalGain={verticalGain}
                        showMasterGrid={showMasterGrid}
                        showClipBeats={showClipBeats}
                        gridTicks={gridTicks}
                      />

                      {/* Subtle Clip Title Tag inside lane */}
                      {track.clips.map((clip) => {
                        const clipEnd = clip.startSec + clip.durationSec;
                        if (clipEnd <= visibleStartSec || clip.startSec >= visibleEndSec) return null;
                        const asset = assetsMap.get(clip.trackAssetId);
                        const tagX = Math.max(8, timeToViewportX(clip.startSec) + 8);
                        if (tagX > viewportWidth - 40) return null;
                        const isSel = selectedRef?.clipId === clip.id;
                        return (
                          <div
                            key={clip.id}
                            style={{ left: tagX }}
                            className={`absolute bottom-2 px-1.5 py-0.5 rounded text-[10px] font-medium pointer-events-none truncate max-w-[240px] ${
                              isSel
                                ? 'bg-om-base/90 text-om-text border border-white/20'
                                : 'bg-om-base/70 text-om-text-muted'
                            }`}
                          >
                            {asset?.name ?? 'Clip'}
                          </div>
                        );
                      })}
                    </div>
                  ))}

                  {/* Cross-Lane Alignment Crosshair Line on Hover */}
                  {hoverX !== null && hoverX >= 0 && hoverX <= viewportWidth && (
                    <div
                      style={{ left: hoverX }}
                      className="absolute top-0 bottom-0 w-px bg-white/30 pointer-events-none z-10"
                    >
                      {hoverSec !== null && (
                        <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-om-base/90 border border-white/15 text-[9px] font-mono tabular-nums text-om-text whitespace-nowrap">
                          {formatTimecodeMs(hoverSec)}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Live Playhead Line across all Super Zoom lanes */}
                  {playheadX >= 0 && playheadX <= viewportWidth && (
                    <div
                      style={{ left: playheadX }}
                      className="absolute top-0 bottom-0 w-[1.5px] bg-om-accent om-playhead-beam pointer-events-none z-20"
                    />
                  )}

                  {/* Floating Drag Delta HUD */}
                  {dragHud && (
                    <div className="absolute top-3 right-3 z-30 px-3 py-1.5 rounded-md bg-om-base/95 border border-om-secondary/50 shadow-xl font-mono tabular-nums text-xs flex items-center gap-2.5 pointer-events-none">
                      <span className="text-om-secondary font-semibold">
                        Δ {dragHud.deltaMs >= 0 ? '+' : ''}
                        {dragHud.deltaMs.toFixed(1)} ms
                      </span>
                      <span className="text-om-text-icon">·</span>
                      <span className="text-om-text">
                        Start {formatTimecodeMs(dragHud.startSec)}
                      </span>
                      {dragHud.fineMode && (
                        <span className="px-1.5 py-0.5 rounded bg-om-accent/20 text-om-accent text-[10px] font-semibold">
                          10× FINE
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Ultra-Precision Positioning & Beat Grid Inspector Bar */}
        <div className="px-4 py-2.5 bg-om-panel-alt border-t border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
          {selectedEntry ? (
            <>
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{
                      backgroundColor: resolveTrackAccentColor(
                        selectedEntry.track.accentColor,
                        project.tracks.findIndex((t) => t.id === selectedEntry.track.id),
                        themeId
                      ),
                    }}
                  />
                  <span className="text-xs font-semibold text-om-text max-w-[200px] truncate">
                    {selectedEntry.asset?.name ?? selectedEntry.track.name}
                  </span>
                </div>

                <div className="px-2 py-0.5 rounded bg-om-base border border-white/[0.08] font-mono tabular-nums text-[11px] flex items-center gap-2">
                  <span className="text-om-text-subtle">Start</span>
                  <span className="text-om-text">{formatTimecodeMs(selectedEntry.clip.startSec)}</span>
                  {selectedBeatPhaseMs !== null && (
                    <>
                      <span className="text-om-text-icon">·</span>
                      <span
                        className={
                          Math.abs(selectedBeatPhaseMs) <= 2.5
                            ? 'text-om-positive'
                            : Math.abs(selectedBeatPhaseMs) <= 12
                              ? 'text-om-accent'
                              : 'text-om-danger'
                        }
                        title="Phase offset between clip beat marker and nearest master beat"
                      >
                        Grid {selectedBeatPhaseMs >= 0 ? '+' : ''}
                        {selectedBeatPhaseMs.toFixed(1)}ms
                      </span>
                    </>
                  )}
                </div>

                {/* Clip Position Micro-Nudge Group */}
                <div className="flex items-center gap-1">
                  <span className="text-[10px] uppercase tracking-wider text-om-text-subtle mr-1">
                    Nudge Clip
                  </span>
                  {([-10, -5, -1, -0.5, 0.5, 1, 5, 10] as const).map((ms) => (
                    <button
                      key={ms}
                      type="button"
                      onClick={() => nudgeSelectedClipMs(ms)}
                      title={`Shift clip ${ms > 0 ? '+' : ''}${ms}ms (Arrow keys: ±1ms, Shift+Arrow: ±0.5ms)`}
                      className="h-6 px-1.5 rounded bg-om-control hover:bg-om-control-hover border border-white/[0.08] font-mono tabular-nums text-[10px] text-om-text hover:text-om-secondary cursor-pointer"
                    >
                      {ms > 0 ? `+${ms}` : ms}ms
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                {/* Beat Grid Offset Micro-Nudge (moves beat markers on the waveform without moving audio) */}
                {selectedEntry.asset && onUpdateTrackBeatOffset && (
                  <div className="flex items-center gap-1 pr-2 border-r border-white/[0.08]">
                    <span
                      className="text-[10px] uppercase tracking-wider text-om-accent/85 mr-1"
                      title="Slip this track's beat markers to sit directly on its kick transient without moving audio"
                    >
                      Beat Grid
                    </span>
                    {([-5, -1, 1, 5] as const).map((ms) => (
                      <button
                        key={ms}
                        type="button"
                        onClick={() => nudgeSelectedBeatGridMs(ms)}
                        title={`Shift track beat markers by ${ms > 0 ? '+' : ''}${ms}ms`}
                        className="h-6 px-1.5 rounded bg-om-control hover:bg-om-control-hover border border-om-accent/20 font-mono tabular-nums text-[10px] text-om-accent cursor-pointer"
                      >
                        {ms > 0 ? `+${ms}` : ms}ms
                      </button>
                    ))}
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleSnapSelectedToNearestBeat}
                  className="h-7 px-2.5 rounded bg-om-control hover:bg-om-control-hover border border-white/[0.08] text-[11px] font-medium text-om-text inline-flex items-center gap-1.5 cursor-pointer"
                  title="Snap clip beat markers to the nearest master grid beat"
                >
                  <Magnet className="w-3 h-3 text-om-secondary" />
                  Snap Beat
                </button>

                {upperMatchTarget && lowerMatchTarget ? (
                  <>
                    <button
                      type="button"
                      disabled={!selectedEntry.asset || selectedEntry.asset.bpm <= 0 || !onUpdateTrackBeatOffset}
                      onClick={() => handleMatchClipBeats('upper')}
                      className="h-7 px-2.5 rounded bg-om-accent/15 hover:bg-om-accent/25 border border-om-accent/40 text-[11px] font-semibold text-om-accent inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
                      title={`Shift this clip's beat markers to line up with upper clip (${upperMatchTarget.asset.name}) without moving audio`}
                    >
                      <ArrowUp className="w-3 h-3" />
                      Match Upper
                    </button>
                    <button
                      type="button"
                      disabled={!selectedEntry.asset || selectedEntry.asset.bpm <= 0 || !onUpdateTrackBeatOffset}
                      onClick={() => handleMatchClipBeats('lower')}
                      className="h-7 px-2.5 rounded bg-om-accent/15 hover:bg-om-accent/25 border border-om-accent/40 text-[11px] font-semibold text-om-accent inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
                      title={`Shift this clip's beat markers to line up with lower clip (${lowerMatchTarget.asset.name}) without moving audio`}
                    >
                      <ArrowDown className="w-3 h-3" />
                      Match Lower
                    </button>
                  </>
                ) : upperMatchTarget ? (
                  <button
                    type="button"
                    disabled={!selectedEntry.asset || selectedEntry.asset.bpm <= 0 || !onUpdateTrackBeatOffset}
                    onClick={() => handleMatchClipBeats('upper')}
                    className="h-7 px-2.5 rounded bg-om-accent/15 hover:bg-om-accent/25 border border-om-accent/40 text-[11px] font-semibold text-om-accent inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
                    title={`Shift this clip's beat markers to line up with upper clip (${upperMatchTarget.asset.name}) without moving audio`}
                  >
                    <ArrowUp className="w-3 h-3" />
                    Match Upper Beats
                  </button>
                ) : lowerMatchTarget ? (
                  <button
                    type="button"
                    disabled={!selectedEntry.asset || selectedEntry.asset.bpm <= 0 || !onUpdateTrackBeatOffset}
                    onClick={() => handleMatchClipBeats('lower')}
                    className="h-7 px-2.5 rounded bg-om-accent/15 hover:bg-om-accent/25 border border-om-accent/40 text-[11px] font-semibold text-om-accent inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
                    title={`Shift this clip's beat markers to line up with lower clip (${lowerMatchTarget.asset.name}) without moving audio`}
                  >
                    <ArrowDown className="w-3 h-3" />
                    Match Lower Beats
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled
                    className="h-7 px-2.5 rounded bg-om-control border border-white/[0.08] text-[11px] font-medium text-om-text-subtle inline-flex items-center gap-1.5 opacity-45 cursor-not-allowed"
                    title="Select a clip overlapping an upper or lower track with detected BPM to match beat markers"
                  >
                    <ArrowUp className="w-3 h-3" />
                    Match Beats
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleAutoAlignTransients}
                  className="h-7 px-2.5 rounded bg-om-secondary/15 hover:bg-om-secondary/25 border border-om-secondary/40 text-[11px] font-semibold text-om-secondary inline-flex items-center gap-1.5 cursor-pointer"
                  title="Cross-correlate kick transients with the overlapping track in this loop"
                >
                  <Wand2 className="w-3 h-3" />
                  Auto-Align Kicks
                </button>

                {alignMessage && (
                  <span className="text-[11px] font-mono text-om-positive bg-om-positive/10 border border-om-positive/30 px-2 py-0.5 rounded">
                    {alignMessage}
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="text-xs text-om-text-subtle">
              Click any clip waveform above to select and micro-position it · Use Arrow keys (±1ms) or drag directly (hold Shift for 10× fine precision).
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
