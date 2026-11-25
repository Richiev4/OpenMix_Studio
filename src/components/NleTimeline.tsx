import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeftRight,
  ArrowLeftToLine,
  ArrowRightToLine,
  ChevronDown,
  Copy,
  Crosshair,
  GripHorizontal,
  Link2,
  Lock,
  Pause,
  Play,
  Plus,
  Repeat,
  Scissors,
  SkipBack,
  Sliders,
  Square,
  Trash2,
  TrendingUp,
  Unlock,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  autoAlignOverlapShiftSec,
  detectBeatOffsetForBuffer,
  formatTimecode,
} from '../audio/analysis';
import {
  applyMixPreset,
  buildMixEnvelopeFromDefaults,
  clampBassCutDb,
  clampCurveTension,
  clampOverlapBars,
  evaluateBassTransitionFraction,
  evaluateVolumeFadeGain,
  findClipById,
  findPreviousClip,
  formatMixSummaryBadges,
  getBassSwapCenterFraction,
  getConfiguredClipBassFade,
  getConfiguredClipVolumeFade,
  getEffectiveClipBassFade,
  getOverlapDurationBeforeTime,
  getOverlapDurationFromStart,
  hasActiveEqOrFilterTransition,
  MIX_PRESETS,
  resolveAutoMixDefaults,
} from '../audio/mixTransitions';
import { DEFAULT_MASTER_VOLUME, evaluateAutomationAt, getProjectMixDuration } from '../audio/nleEngine';
import {
  buildTempoPointsFromEntries,
  clampBpm,
  evaluateBpmAt,
  getBarGridPositions,
  getBeatsAtTime,
  getBpmRangeForClip,
  getEffectiveBpmRatio,
  getOctaveFoldedAssetBpm,
  getSortedTempoPoints,
  getTimeAtBeat,
  getTimelineTempoEntries,
  integrateClipSourceOffsetSec,
  MAX_PROJECT_BPM,
  MIN_PROJECT_BPM,
  snapClipStartToBeatGrid,
  snapSecondsWithTempoMap,
} from '../audio/tempoMap';
import type {
  AutoMixDefaults,
  AutomationCurveType,
  AutomationParam,
  BassMixMode,
  ClipMixEnvelope,
  EqBandMixMode,
  FadeCurve,
  FilterMixMode,
  NleClip,
  NleProjectState,
  NleTrack,
  SnapMode,
  TempoPoint,
  TrackAsset,
} from '../types/audio';
import { AutoMixPreview } from './AutoMixPreview';
import { ClipFadeCard } from './ClipFadeCard';
import { Knob } from './Knob';
import { MasterMeterPanel } from './MasterMeterPanel';
import { SuperZoomModal } from './SuperZoomModal';
import { resolveTrackAccentColor, useTheme } from '../theme/themes';

interface NleTimelineProps {
  project: NleProjectState;
  assetsMap: Map<string, TrackAsset>;
  onUpdateProject: (patch: Partial<NleProjectState>) => void;
  onTogglePlay: () => void;
  onStop: () => void;
  onSeek: (sec: number) => void;
  onAddTrack: () => void;
  onRemoveTrack: (trackId: string) => void;
  onUpdateTrack: (trackId: string, patch: Partial<NleTrack>) => void;
  onAddClipAt: (
    trackId: string,
    assetId: string,
    startSec: number,
    options?: { bypassAutoMix?: boolean; isQuickAdd?: boolean }
  ) => void;
  onUpdateClip: (trackId: string, clipId: string, patch: Partial<NleClip>) => void;
  onMoveClip: (
    fromTrackId: string,
    toTrackId: string,
    clipId: string,
    startSec: number,
    rippleClipIds?: ReadonlySet<string>
  ) => void;
  onUpdateClipTransition: (
    trackId: string,
    clipId: string,
    direction: 'in' | 'out',
    nextEnv: ClipMixEnvelope | undefined,
    options?: { realignToPrev?: boolean; syncPair?: boolean }
  ) => void;
  onDeleteClip: (trackId: string, clipId: string) => void;
  onDuplicateClip: (trackId: string, clipId: string) => void;
  onSplitAtPlayhead: (selectedClipId: string | null) => void;
  onCommitTempoChange?: () => void;
  onUpdateTrackBeatOffset?: (trackId: string, beatOffsetSec: number) => void;
}

const TRACK_HEADER_WIDTH = 228;
const TEMPO_LANE_HEIGHT = 92;
const TEMPO_LANE_PAD_Y = 10;
const MIN_ZOOM_PX_PER_SEC = 0.25;
const MAX_ZOOM_PX_PER_SEC = 120;
const ZOOM_STEP_FACTOR = 1.35;

function clampZoomPxPerSec(value: number): number {
  const clamped = Math.max(MIN_ZOOM_PX_PER_SEC, Math.min(MAX_ZOOM_PX_PER_SEC, value));
  if (clamped < 2) return Math.round(clamped * 100) / 100;
  if (clamped < 10) return Math.round(clamped * 10) / 10;
  return Math.round(clamped);
}

function stepZoomPxPerSec(current: number, direction: 'in' | 'out'): number {
  const factor = direction === 'in' ? ZOOM_STEP_FACTOR : 1 / ZOOM_STEP_FACTOR;
  return clampZoomPxPerSec(current * factor);
}

function getAdaptiveBarStep(zoomPxPerSec: number, masterBpm: number, minSpacingPx: number): number {
  const avgBarSec = (60 / Math.max(40, masterBpm)) * 4;
  const pxPerBar = avgBarSec * zoomPxPerSec;
  const steps = [1, 2, 4, 8, 16, 32, 64, 128, 256];
  for (const step of steps) {
    if (pxPerBar * step >= minSpacingPx) return step;
  }
  return 256;
}

const AUTOMATION_PARAMS: { id: AutomationParam; label: string; color: string }[] = [
  { id: 'volume', label: 'Volume', color: '#F59E0B' },
  { id: 'pan', label: 'Pan', color: '#06B6D4' },
  { id: 'filterCutoff', label: 'Filter Cutoff', color: '#10B981' },
  { id: 'fxWet', label: 'FX Wet', color: '#A78BFA' },
  { id: 'speed', label: 'Speed', color: '#F472B6' },
];

function bpmToLaneY(bpm: number): number {
  const norm =
    (clampBpm(bpm) - MIN_PROJECT_BPM) / (MAX_PROJECT_BPM - MIN_PROJECT_BPM);
  const usableH = TEMPO_LANE_HEIGHT - TEMPO_LANE_PAD_Y * 2;
  return TEMPO_LANE_HEIGHT - TEMPO_LANE_PAD_Y - norm * usableH;
}

function laneYToBpm(y: number): number {
  const usableH = TEMPO_LANE_HEIGHT - TEMPO_LANE_PAD_Y * 2;
  const clampedY = Math.max(
    TEMPO_LANE_PAD_Y,
    Math.min(TEMPO_LANE_HEIGHT - TEMPO_LANE_PAD_Y, y)
  );
  const norm = (TEMPO_LANE_HEIGHT - TEMPO_LANE_PAD_Y - clampedY) / usableH;
  const raw = MIN_PROJECT_BPM + norm * (MAX_PROJECT_BPM - MIN_PROJECT_BPM);
  return clampBpm(Math.round(raw * 2) / 2);
}

function formatCurveTensionReadout(
  tension: number,
  options?: { isSwap?: boolean; direction?: 'in' | 'out' }
): string {
  const t = clampCurveTension(tension);
  if (options?.isSwap) {
    const centerPct = Math.round(getBassSwapCenterFraction(options.direction ?? 'in', t) * 100);
    return `${centerPct}%`;
  }
  const pct = Math.round(t * 100);
  if (pct === 0) return '0%';
  return pct > 0 ? `+${pct}%` : `${pct}%`;
}

function buildFadeSvgPaths(
  direction: 'in' | 'out',
  curve: FadeCurve,
  startX: number,
  width: number,
  height: number,
  tension = 0
): { linePath: string; shadePath: string; midX: number; midY: number } {
  const safeTension = clampCurveTension(tension);
  const steps = curve === 'linear' && Math.abs(safeTension) < 0.001 ? 1 : 24;
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const xNorm = direction === 'in' ? t : 1 - t;
    const gain = evaluateVolumeFadeGain(xNorm, curve, safeTension);
    const px = startX + t * width;
    const py = height * (1 - gain);
    pts.push(`${px.toFixed(2)},${py.toFixed(2)}`);
  }
  const linePath = `M ${pts.join(' L ')}`;
  const shadePath =
    direction === 'in'
      ? `M ${startX.toFixed(2)},0 L ${pts.join(' L ')} Z`
      : `M ${pts.join(' L ')} L ${(startX + width).toFixed(2)},0 Z`;
  const midGain = evaluateVolumeFadeGain(0.5, curve, safeTension);
  return {
    linePath,
    shadePath,
    midX: startX + width * 0.5,
    midY: height * (1 - midGain),
  };
}

function buildBassFadeSvgPaths(
  direction: 'in' | 'out',
  mode: Exclude<BassMixMode, 'none'>,
  startX: number,
  width: number,
  height: number,
  tension = 0
): { linePath: string; shadePath: string; swapMidX: number } {
  const safeTension = clampCurveTension(tension);
  const steps = mode === 'swap' ? 32 : 24;
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const bassLevel = evaluateBassTransitionFraction(t, direction, mode, safeTension);
    const px = startX + t * width;
    // Map bass level [0..1] slightly inset from top/bottom edges so both Volume and Bass curves remain clearly legible when overlapping
    const py = 3 + (height - 6) * (1 - bassLevel);
    pts.push(`${px.toFixed(2)},${py.toFixed(2)}`);
  }
  const linePath = `M ${pts.join(' L ')}`;
  const shadePath = `M ${startX.toFixed(2)},${height} L ${pts.join(' L ')} L ${(startX + width).toFixed(2)},${height} Z`;
  const swapCenter = getBassSwapCenterFraction(direction, safeTension);
  return {
    linePath,
    shadePath,
    swapMidX: startX + width * swapCenter,
  };
}

interface ClipWaveformProps {
  asset: TrackAsset | undefined;
  clipStartSec: number;
  offsetSec: number;
  durationSec: number;
  stretchToMasterBpm: boolean;
  masterBpm: number;
  tempoPoints: TempoPoint[];
  showBeatMarkers: boolean;
  widthPx: number;
  heightPx: number;
  accentColor: string;
}

const ClipWaveformCanvas: React.FC<ClipWaveformProps> = ({
  asset,
  clipStartSec,
  offsetSec,
  durationSec,
  stretchToMasterBpm,
  masterBpm,
  tempoPoints,
  showBeatMarkers,
  widthPx,
  heightPx,
  accentColor,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !asset) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(10, Math.round(widthPx));
    const h = Math.max(20, Math.round(heightPx));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const peaks = asset.waveformPeaks;
    const total = peaks.length;
    const midY = h / 2;

    const canStretch = stretchToMasterBpm && asset.bpm > 0;
    const hasTempoMap = canStretch && tempoPoints.length > 0;
    const constRatio = canStretch ? getEffectiveBpmRatio(masterBpm, asset.bpm) : 1;
    const tempoSrc = { masterBpm, tempoPoints };
    const matchedAssetBpm = canStretch
      ? getOctaveFoldedAssetBpm(
          asset.bpm,
          hasTempoMap ? evaluateBpmAt(tempoSrc, Math.max(0, clipStartSec)) : masterBpm
        )
      : asset.bpm;

    // Collect beat marker pixel positions prior to drawing waveform bars so grid lines sit cleanly behind peaks
    const beatMarkers: Array<{ x: number; isDownbeat: boolean }> = [];
    if (showBeatMarkers && asset.bpm > 0 && Number.isFinite(durationSec) && durationSec > 0) {
      const beatPeriodSec = 60 / asset.bpm;
      const safeBeatOffset = Number.isFinite(asset.beatOffsetSec) ? asset.beatOffsetSec : 0;
      const totalSourceSpan = hasTempoMap
        ? integrateClipSourceOffsetSec(tempoSrc, clipStartSec, durationSec, asset.bpm)
        : durationSec * constRatio;
      const minSourceSec = Math.max(0, offsetSec);
      const maxSourceSec = Math.min(asset.duration, offsetSec + Math.max(0, totalSourceSpan));

      if (maxSourceSec > minSourceSec) {
        const approxBeatsVisible = (maxSourceSec - minSourceSec) / beatPeriodSec;
        const approxBeatPx = w / Math.max(1, approxBeatsVisible);

        // Step down to 4-beat downbeats when zoomed out, or hide entirely if too dense
        if (approxBeatPx * 4 >= 6) {
          const onlyDownbeats = approxBeatPx < 7;
          const startTimelineBeats = hasTempoMap ? getBeatsAtTime(tempoSrc, clipStartSec) : 0;
          const firstBeatIdx = Math.ceil((minSourceSec - safeBeatOffset - 1e-6) / beatPeriodSec);
          const lastBeatIdx = Math.floor((maxSourceSec - safeBeatOffset + 1e-6) / beatPeriodSec);
          const maxIterations = 4000;
          let count = 0;

          for (let beatIdx = firstBeatIdx; beatIdx <= lastBeatIdx && count < maxIterations; beatIdx++) {
            count++;
            const isDownbeat = ((beatIdx % 4) + 4) % 4 === 0;
            if (onlyDownbeats && !isDownbeat) continue;

            const srcBeatSec = safeBeatOffset + beatIdx * beatPeriodSec;
            const deltaSourceSec = srcBeatSec - offsetSec;
            if (deltaSourceSec < -1e-4) continue;

            const localOutSec = hasTempoMap
              ? getTimeAtBeat(tempoSrc, startTimelineBeats + deltaSourceSec * (matchedAssetBpm / 60)) -
                clipStartSec
              : deltaSourceSec / Math.max(0.0001, constRatio);

            if (localOutSec < 0 || localOutSec > durationSec) continue;
            const x = (localOutSec / durationSec) * w;
            if (x >= 1 && x <= w - 1) {
              beatMarkers.push({ x, isDownbeat });
            }
          }
        }
      }
    }

    // Draw background beat & downbeat guide lines behind waveform
    for (const marker of beatMarkers) {
      const snappedX = Math.round(marker.x) + 0.5;
      ctx.fillStyle = marker.isDownbeat
        ? 'rgba(255, 255, 255, 0.24)'
        : 'rgba(255, 255, 255, 0.08)';
      ctx.fillRect(snappedX, 0, 1, h);
    }

    // Draw waveform amplitude bars
    ctx.fillStyle = accentColor;
    for (let x = 0; x < w; x += 2) {
      const localOutSec = (x / w) * durationSec;
      const srcDelta = hasTempoMap
        ? integrateClipSourceOffsetSec(tempoSrc, clipStartSec, localOutSec, asset.bpm)
        : localOutSec * constRatio;
      const localSec = offsetSec + srcDelta;
      if (localSec >= asset.duration) continue;
      const frac = Math.max(0, Math.min(0.9999, localSec / Math.max(0.01, asset.duration)));
      const idx = Math.floor(frac * total);
      const amp = peaks[idx] ?? 0;
      const barH = Math.max(2, amp * (h * 0.82));
      ctx.fillRect(x, midY - barH / 2, 1.4, barH);
    }

    // Draw crisp top/bottom beat tick caps so markers stay legible over dense waveform peaks
    for (const marker of beatMarkers) {
      const snappedX = Math.round(marker.x) + 0.5;
      if (marker.isDownbeat) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
        ctx.fillRect(snappedX, 0, 1.2, 6);
        ctx.fillRect(snappedX, h - 6, 1.2, 6);
      } else {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.34)';
        ctx.fillRect(snappedX, 0, 1, 3.5);
        ctx.fillRect(snappedX, h - 3.5, 1, 3.5);
      }
    }
  }, [
    asset,
    clipStartSec,
    offsetSec,
    durationSec,
    stretchToMasterBpm,
    masterBpm,
    tempoPoints,
    showBeatMarkers,
    widthPx,
    heightPx,
    accentColor,
  ]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: widthPx, height: heightPx }}
      className="pointer-events-none block opacity-85"
    />
  );
};

export const NleTimeline: React.FC<NleTimelineProps> = ({
  project,
  assetsMap,
  onUpdateProject,
  onTogglePlay,
  onStop,
  onSeek,
  onAddTrack,
  onRemoveTrack,
  onUpdateTrack,
  onAddClipAt,
  onUpdateClip,
  onMoveClip,
  onUpdateClipTransition,
  onDeleteClip,
  onDuplicateClip,
  onSplitAtPlayhead,
  onCommitTempoChange,
  onUpdateTrackBeatOffset,
}) => {
  const { themeId, theme } = useTheme();
  const automationParams = useMemo(
    () =>
      AUTOMATION_PARAMS.map((p) => ({
        ...p,
        color: theme.automationColors[p.id],
      })),
    [theme]
  );
  const [selectedClipRef, setSelectedClipRef] = useState<{
    trackId: string;
    clipId: string;
  } | null>(null);
  const [activeFxTrackId, setActiveFxTrackId] = useState<string | null>(null);
  const [dragOverTrackId, setDragOverTrackId] = useState<string | null>(null);
  const [autoCurveType, setAutoCurveType] = useState<AutomationCurveType>('linear');
  const [tempoCurveType, setTempoCurveType] = useState<AutomationCurveType>('linear');
  const [selectedTempoPointId, setSelectedTempoPointId] = useState<string | null>(null);
  const [draggingTempoPointId, setDraggingTempoPointId] = useState<string | null>(null);
  const [showMixDefaultsModal, setShowMixDefaultsModal] = useState(false);
  const [showOptionsMenu, setShowOptionsMenu] = useState(false);
  const optionsMenuRef = useRef<HTMLDivElement | null>(null);
  const [showSuperZoom, setShowSuperZoom] = useState(false);
  const [showClipMixEditor, setShowClipMixEditor] = useState(false);
  const [showBeatGridEditor, setShowBeatGridEditor] = useState(false);
  const [clipMixDirection, setClipMixDirection] = useState<'in' | 'out'>('in');
  const [syncPairedClip, setSyncPairedClip] = useState(true);
  const [autoLockStatus, setAutoLockStatus] = useState<{ clipId: string; label: string } | null>(
    null
  );
  const [activeFadeDrag, setActiveFadeDrag] = useState<{
    clipId: string;
    mode:
      | 'fade-in-start'
      | 'fade-in'
      | 'fade-in-curve'
      | 'fade-out'
      | 'fade-out-end'
      | 'fade-out-curve'
      | 'bass-fade-in-start'
      | 'bass-fade-in'
      | 'bass-fade-in-curve'
      | 'bass-fade-out'
      | 'bass-fade-out-end'
      | 'bass-fade-out-curve';
    label: string;
  } | null>(null);
  const [loopDragInfo, setLoopDragInfo] = useState<{
    mode: 'start' | 'end' | 'move' | 'draw';
    startSec: number;
    endSec: number;
  } | null>(null);
  const [clipMenuState, setClipMenuState] = useState<{
    trackId: string;
    clipId: string;
    x: number;
    y: number;
  } | null>(null);
  const [clipMenuTopOffset, setClipMenuTopOffset] = useState(0);
  const autoLockTimerRef = useRef<number | null>(null);
  const [dynamicMixMenuEnabled, setDynamicMixMenuEnabled] = useState<boolean>(false);
  const [dismissedMixKey, setDismissedMixKey] = useState<string | null>(null);
  const [floatingMenuPos, setFloatingMenuPos] = useState<{ x: number; y: number } | null>(() => {
    try {
      const raw = localStorage.getItem('om_dynamic_mix_pos');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') {
        return { x: parsed.x, y: parsed.y };
      }
      return null;
    } catch {
      return null;
    }
  });
  const [isDraggingFloatingMenu, setIsDraggingFloatingMenu] = useState(false);
  const floatingMenuRef = useRef<HTMLDivElement | null>(null);

  const resetFloatingMenuPos = () => {
    setFloatingMenuPos(null);
    setClipMenuTopOffset(0);
    try {
      localStorage.removeItem('om_dynamic_mix_pos');
    } catch {
      // ignore storage errors
    }
  };

  const handleFloatingMenuDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    const panel = floatingMenuRef.current;
    if (!panel) return;
    e.preventDefault();
    e.stopPropagation();

    const rect = panel.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    const panelW = rect.width;
    const panelH = rect.height;
    let latestPos = { x: rect.left, y: rect.top };

    setIsDraggingFloatingMenu(true);

    const onMove = (ev: PointerEvent) => {
      const maxX = Math.max(8, window.innerWidth - panelW - 8);
      const maxY = Math.max(8, window.innerHeight - panelH - 8);
      const nextX = Math.max(8, Math.min(maxX, ev.clientX - offsetX));
      const nextY = Math.max(8, Math.min(maxY, ev.clientY - offsetY));
      latestPos = { x: Math.round(nextX), y: Math.round(nextY) };
      setFloatingMenuPos(latestPos);
    };

    const onUp = () => {
      setIsDraggingFloatingMenu(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      try {
        localStorage.setItem('om_dynamic_mix_pos', JSON.stringify(latestPos));
      } catch {
        // ignore storage errors
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  useEffect(() => {
    if (!floatingMenuPos) return;
    const clampToViewport = () => {
      const panel = floatingMenuRef.current;
      const panelW = panel?.offsetWidth ?? Math.min(620, window.innerWidth - 24);
      const panelH = panel?.offsetHeight ?? 240;
      const maxX = Math.max(8, window.innerWidth - panelW - 8);
      const maxY = Math.max(8, window.innerHeight - panelH - 8);
      setFloatingMenuPos((prev) => {
        if (!prev) return prev;
        const cx = Math.max(8, Math.min(maxX, prev.x));
        const cy = Math.max(8, Math.min(maxY, prev.y));
        if (cx === prev.x && cy === prev.y) return prev;
        return { x: cx, y: cy };
      });
    };
    window.addEventListener('resize', clampToViewport);
    return () => window.removeEventListener('resize', clampToViewport);
  }, [floatingMenuPos]);

  const activePlayheadMixPair = useMemo(() => {
    const t = project.playheadSec;
    const candidates: Array<{
      track: NleTrack;
      trackIdx: number;
      clip: NleClip;
      endSec: number;
    }> = [];
    project.tracks.forEach((track, trackIdx) => {
      for (const clip of track.clips) {
        const endSec = clip.startSec + clip.durationSec;
        if (t >= clip.startSec - 1e-4 && t <= endSec + 1e-4) {
          candidates.push({ track, trackIdx, clip, endSec });
        }
      }
    });
    if (candidates.length < 2) return null;

    let best: {
      out: (typeof candidates)[number];
      inc: (typeof candidates)[number];
      overlapStartSec: number;
      overlapEndSec: number;
      overlapDurationSec: number;
      score: number;
    } | null = null;

    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i];
        const b = candidates[j];
        if (a.track.id === b.track.id) continue;

        const overlapStartSec = Math.max(a.clip.startSec, b.clip.startSec);
        const overlapEndSec = Math.min(a.endSec, b.endSec);
        const overlapDurationSec = overlapEndSec - overlapStartSec;
        if (overlapDurationSec <= 0.05) continue;

        let out = a;
        let inc = b;
        const aPairedToB = a.clip.mixOut?.pairedClipId === b.clip.id || b.clip.mixIn?.pairedClipId === a.clip.id;
        const bPairedToA = b.clip.mixOut?.pairedClipId === a.clip.id || a.clip.mixIn?.pairedClipId === b.clip.id;

        if (bPairedToA && !aPairedToB) {
          out = b;
          inc = a;
        } else if (!aPairedToB && (b.clip.startSec < a.clip.startSec - 1e-4 || (Math.abs(b.clip.startSec - a.clip.startSec) <= 1e-4 && b.endSec < a.endSec))) {
          out = b;
          inc = a;
        }

        const unmutedBonus = (!out.track.muted ? 2 : 0) + (!inc.track.muted ? 2 : 0);
        const pairedBonus = aPairedToB || bPairedToA ? 10 : 0;
        const score = pairedBonus + unmutedBonus - Math.abs(out.clip.startSec - inc.clip.startSec) * 0.0001;

        if (!best || score > best.score) {
          best = { out, inc, overlapStartSec, overlapEndSec, overlapDurationSec, score };
        }
      }
    }

    if (!best) return null;
    return {
      key: `${best.out.clip.id}:${best.inc.clip.id}`,
      outTrack: best.out.track,
      outTrackIdx: best.out.trackIdx,
      outClip: best.out.clip,
      outAsset: assetsMap.get(best.out.clip.trackAssetId),
      inTrack: best.inc.track,
      inTrackIdx: best.inc.trackIdx,
      inClip: best.inc.clip,
      inAsset: assetsMap.get(best.inc.clip.trackAssetId),
      overlapStartSec: best.overlapStartSec,
      overlapEndSec: best.overlapEndSec,
      overlapDurationSec: best.overlapDurationSec,
    };
  }, [project.tracks, project.playheadSec, assetsMap]);

  useEffect(() => {
    if (dismissedMixKey && activePlayheadMixPair?.key !== dismissedMixKey) {
      setDismissedMixKey(null);
    }
  }, [activePlayheadMixPair?.key, dismissedMixKey]);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const trackLaneRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const pendingZoomScrollRef = useRef<{ anchorSec: number; viewportOffsetPx: number } | null>(
    null
  );
  const zoomPxPerSecRef = useRef(project.zoomPxPerSec);
  const playheadSecRef = useRef(project.playheadSec);
  const projectRef = useRef(project);
  const assetsMapRef = useRef(assetsMap);
  const onUpdateProjectRef = useRef(onUpdateProject);
  const wheelZoomTargetRef = useRef(project.zoomPxPerSec);

  zoomPxPerSecRef.current = project.zoomPxPerSec;
  playheadSecRef.current = project.playheadSec;
  projectRef.current = project;
  assetsMapRef.current = assetsMap;
  onUpdateProjectRef.current = onUpdateProject;

  const mixDefaults = useMemo(
    () => resolveAutoMixDefaults(project.defaultMixOptions),
    [project.defaultMixOptions]
  );

  const updateMixDefaults = (patch: Partial<AutoMixDefaults>, markCustom = true) => {
    onUpdateProject({
      defaultMixOptions: {
        ...mixDefaults,
        ...patch,
        preset: patch.preset ?? (markCustom ? 'custom' : mixDefaults.preset),
      },
    });
  };

  useEffect(() => {
    if (!showMixDefaultsModal) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowMixDefaultsModal(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showMixDefaultsModal]);

  useEffect(() => {
    if (!showOptionsMenu) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (optionsMenuRef.current && !optionsMenuRef.current.contains(e.target as Node)) {
        setShowOptionsMenu(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowOptionsMenu(false);
      }
    };
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [showOptionsMenu]);

  const isDynamicMixViewActive =
    dynamicMixMenuEnabled &&
    Boolean(activePlayheadMixPair) &&
    (Boolean(clipMenuState) || dismissedMixKey !== activePlayheadMixPair?.key);
  const isFloatingMenuOpen = isDynamicMixViewActive || Boolean(clipMenuState);

  const toggleDynamicMixMenu = () => {
    setDynamicMixMenuEnabled((prev) => {
      const next = !prev;
      if (next) {
        setDismissedMixKey(null);
      } else if (!clipMenuState && activePlayheadMixPair) {
        const useOut =
          selectedClipRef && selectedClipRef.clipId === activePlayheadMixPair.outClip.id;
        const targetTrack = useOut
          ? activePlayheadMixPair.outTrack
          : activePlayheadMixPair.inTrack;
        const targetClip = useOut
          ? activePlayheadMixPair.outClip
          : activePlayheadMixPair.inClip;
        const rect = floatingMenuRef.current?.getBoundingClientRect();
        setClipMenuTopOffset(0);
        setClipMenuState({
          trackId: targetTrack.id,
          clipId: targetClip.id,
          x: rect ? Math.round(rect.left) : Math.round((window.innerWidth - 600) / 2),
          y: rect ? Math.round(rect.top) : Math.max(8, window.innerHeight - 360),
        });
      }
      return next;
    });
  };

  const closeFloatingMenu = () => {
    setClipMenuState(null);
    if (activePlayheadMixPair) {
      setDismissedMixKey(activePlayheadMixPair.key);
    }
  };

  const openClipFloatingMenu = (
    trackId: string,
    clipId: string,
    x: number,
    y: number,
    toggleIfSame = false
  ) => {
    const isSameSingleClipOpen =
      !isDynamicMixViewActive &&
      clipMenuState?.trackId === trackId &&
      clipMenuState?.clipId === clipId;
    if (toggleIfSame && isSameSingleClipOpen) {
      closeFloatingMenu();
      return;
    }
    if (isDynamicMixViewActive) {
      setDynamicMixMenuEnabled(false);
    }
    setClipMenuTopOffset(0);
    setClipMenuState({ trackId, clipId, x, y });
  };

  useEffect(() => {
    if (!isFloatingMenuOpen) {
      setShowBeatGridEditor((prev) => (prev ? false : prev));
      setShowClipMixEditor((prev) => (prev ? false : prev));
      setClipMenuTopOffset((prev) => (prev === 0 ? prev : 0));
      return;
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setClipMenuState(null);
        if (activePlayheadMixPair) {
          setDismissedMixKey(activePlayheadMixPair.key);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFloatingMenuOpen, activePlayheadMixPair]);

  useLayoutEffect(() => {
    if (!isFloatingMenuOpen || !floatingMenuRef.current) return;
    const rect = floatingMenuRef.current.getBoundingClientRect();
    const maxBottom = window.innerHeight - 8;
    if (rect.bottom > maxBottom) {
      const overflow = rect.bottom - maxBottom;
      if (floatingMenuPos) {
        setFloatingMenuPos((prev) => {
          if (!prev) return prev;
          const nextY = Math.max(8, Math.round(prev.y - overflow));
          return nextY === prev.y ? prev : { x: prev.x, y: nextY };
        });
      } else if (clipMenuState) {
        setClipMenuTopOffset((prev) => {
          const clamped = Math.max(-(clipMenuState.y - 4), prev - overflow);
          return Math.abs(clamped - prev) < 0.5 ? prev : clamped;
        });
      }
    }
  }, [
    isFloatingMenuOpen,
    isDynamicMixViewActive,
    clipMenuState,
    floatingMenuPos,
    showBeatGridEditor,
    showClipMixEditor,
    clipMixDirection,
  ]);

  const mixEnd = getProjectMixDuration(project);
  const timelineTotalSec = Math.max(120, Math.ceil(mixEnd + 30));
  const timelineWidthPx = Math.round(timelineTotalSec * project.zoomPxPerSec);

  useLayoutEffect(() => {
    const pending = pendingZoomScrollRef.current;
    const container = scrollContainerRef.current;
    if (!pending || !container) return;
    pendingZoomScrollRef.current = null;
    const targetScrollLeft = Math.max(
      0,
      pending.anchorSec * project.zoomPxPerSec - pending.viewportOffsetPx
    );
    container.scrollLeft = targetScrollLeft;
  }, [project.zoomPxPerSec]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.deltaY === 0) return;

      const currentZoom = zoomPxPerSecRef.current;
      if (clampZoomPxPerSec(wheelZoomTargetRef.current) !== currentZoom) {
        wheelZoomTargetRef.current = currentZoom;
      }

      const clampedDelta = Math.max(-180, Math.min(180, e.deltaY));
      const scale = Math.exp(-clampedDelta * 0.0028);
      const rawNext = Math.max(
        MIN_ZOOM_PX_PER_SEC,
        Math.min(MAX_ZOOM_PX_PER_SEC, wheelZoomTargetRef.current * scale)
      );
      wheelZoomTargetRef.current = rawNext;

      const nextZoom = clampZoomPxPerSec(rawNext);
      if (nextZoom === currentZoom) return;

      const rect = container.getBoundingClientRect();
      const visibleLaneWidth = Math.max(100, container.clientWidth - TRACK_HEADER_WIDTH);
      const laneOffsetPx = e.clientX - rect.left - TRACK_HEADER_WIDTH;

      if (laneOffsetPx >= 0 && laneOffsetPx <= visibleLaneWidth) {
        pendingZoomScrollRef.current = {
          anchorSec: Math.max(0, (container.scrollLeft + laneOffsetPx) / currentZoom),
          viewportOffsetPx: laneOffsetPx,
        };
      } else {
        const currentScreenX = playheadSecRef.current * currentZoom - container.scrollLeft;
        const isPlayheadVisible = currentScreenX >= 0 && currentScreenX <= visibleLaneWidth;
        pendingZoomScrollRef.current = {
          anchorSec: playheadSecRef.current,
          viewportOffsetPx: isPlayheadVisible ? currentScreenX : visibleLaneWidth / 2,
        };
      }

      onUpdateProjectRef.current({ zoomPxPerSec: nextZoom });
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, []);

  const handleStepZoom = (direction: 'in' | 'out') => {
    const nextZoom = stepZoomPxPerSec(project.zoomPxPerSec, direction);
    if (nextZoom === project.zoomPxPerSec) return;

    const container = scrollContainerRef.current;
    if (container) {
      const visibleLaneWidth = Math.max(100, container.clientWidth - TRACK_HEADER_WIDTH);
      const currentScreenX = project.playheadSec * project.zoomPxPerSec - container.scrollLeft;
      const isPlayheadVisible = currentScreenX >= 0 && currentScreenX <= visibleLaneWidth;
      pendingZoomScrollRef.current = {
        anchorSec: project.playheadSec,
        viewportOffsetPx: isPlayheadVisible ? currentScreenX : visibleLaneWidth / 2,
      };
    }

    onUpdateProject({ zoomPxPerSec: nextZoom });
  };

  const handleFitTimeline = () => {
    pendingZoomScrollRef.current = null;
    const containerWidth =
      scrollContainerRef.current?.clientWidth ?? Math.max(600, window.innerWidth - 320);
    const availableWidth = Math.max(200, containerWidth - TRACK_HEADER_WIDTH - 24);
    const targetSpanSec = mixEnd > 0 ? mixEnd + 12 : timelineTotalSec;
    const fitZoom = clampZoomPxPerSec(availableWidth / Math.max(30, targetSpanSec));
    onUpdateProject({ zoomPxPerSec: fitZoom });
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollLeft = 0;
    }
  };

  const activeFxTrack = useMemo(
    () => project.tracks.find((t) => t.id === activeFxTrackId) ?? null,
    [project.tracks, activeFxTrackId]
  );

  // Variable-tempo bar positions for ruler & lane gridlines
  const barTicks = useMemo(
    () => getBarGridPositions(project, timelineTotalSec),
    [project.masterBpm, project.tempoPoints, timelineTotalSec]
  );

  const rulerLabelStep = useMemo(
    () => getAdaptiveBarStep(project.zoomPxPerSec, project.masterBpm, 40),
    [project.zoomPxPerSec, project.masterBpm]
  );

  const gridLineStep = useMemo(
    () => getAdaptiveBarStep(project.zoomPxPerSec, project.masterBpm, 12),
    [project.zoomPxPerSec, project.masterBpm]
  );

  const barGridSvgPath = useMemo(() => {
    return barTicks
      .filter((b) => b.barIndex % gridLineStep === 0)
      .map((b) => `M ${(b.timeSec * project.zoomPxPerSec).toFixed(1)} 0 V 200`)
      .join(' ');
  }, [barTicks, gridLineStep, project.zoomPxPerSec]);

  const sortedTempoPoints = useMemo(
    () => getSortedTempoPoints(project.tempoPoints),
    [project.tempoPoints]
  );

  const livePlayheadBpm = evaluateBpmAt(project, project.playheadSec);

  const timelineTempoEntries = useMemo(
    () => getTimelineTempoEntries(project, assetsMap),
    [project.masterBpm, project.tracks, assetsMap]
  );

  const tempoTrackSummary = useMemo(() => {
    const hasTrackBpmChanges = timelineTempoEntries.some(
      (entry, idx) => idx > 0 && Math.abs(entry.bpm - timelineTempoEntries[idx - 1].bpm) >= 0.2
    );

    const distinctChain: string[] = [];
    for (const entry of timelineTempoEntries) {
      const label = Number.isInteger(entry.bpm) ? entry.bpm.toFixed(0) : entry.bpm.toFixed(1);
      if (distinctChain.length === 0 || distinctChain[distinctChain.length - 1] !== label) {
        distinctChain.push(label);
      }
    }

    return { hasTrackBpmChanges, distinctChain };
  }, [timelineTempoEntries]);

  // Clip pointer interactions (move, trim-left, trim-right, dual-end volume & bass fade handles, and curve bend handles)
  const startClipDrag = (
    e: React.PointerEvent,
    track: NleTrack,
    clip: NleClip,
    mode:
      | 'move'
      | 'trim-left'
      | 'trim-right'
      | 'fade-in-start'
      | 'fade-in'
      | 'fade-in-curve'
      | 'fade-out'
      | 'fade-out-end'
      | 'fade-out-curve'
      | 'bass-fade-in-start'
      | 'bass-fade-in'
      | 'bass-fade-in-curve'
      | 'bass-fade-out'
      | 'bass-fade-out-end'
      | 'bass-fade-out-curve'
  ) => {
    e.stopPropagation();
    e.preventDefault();
    setSelectedClipRef({ trackId: track.id, clipId: clip.id });

    const startX = e.clientX;
    const startY = e.clientY;
    const origStart = clip.startSec;
    const origOffset = clip.offsetSec;
    const origDuration = clip.durationSec;
    const origFadeInStart = Math.max(0, clip.fadeInStartSec ?? 0);
    const origFadeIn = clip.fadeInSec;
    const origFadeOutEnd = Math.max(0, clip.fadeOutEndSec ?? 0);
    const origFadeOut = clip.fadeOutSec;
    const origFadeInTension = clampCurveTension(clip.fadeInCurveTension);
    const origFadeOutTension = clampCurveTension(clip.fadeOutCurveTension);
    const origBassIn = getConfiguredClipBassFade(clip, 'in');
    const origBassOut = getConfiguredClipBassFade(clip, 'out');
    const origBassFadeInStart = origBassIn.offsetSec;
    const origBassFadeIn = origBassIn.durationSec;
    const origBassFadeOutEnd = origBassOut.offsetSec;
    const origBassFadeOut = origBassOut.durationSec;
    const origBassInTension = origBassIn.curveTension;
    const origBassOutTension = origBassOut.curveTension;
    const asset = assetsMap.get(clip.trackAssetId);
    const maxAvailSource = asset ? asset.duration : 600;

    const round2 = (v: number) => Math.round(Math.max(0, v) * 100) / 100;
    const roundSigned2 = (v: number) => Math.round(clampCurveTension(v) * 100) / 100;

    if (mode !== 'move' && mode !== 'trim-left' && mode !== 'trim-right') {
      const initialLabel =
        mode === 'fade-in-start'
          ? `VOL IN START +${origFadeInStart.toFixed(2)}s (${origFadeIn.toFixed(2)}s)`
          : mode === 'fade-in'
            ? `VOL IN ${origFadeIn.toFixed(2)}s`
            : mode === 'fade-in-curve'
              ? `VOL IN CURVE ${formatCurveTensionReadout(origFadeInTension)}`
              : mode === 'fade-out'
                ? `VOL OUT ${origFadeOut.toFixed(2)}s`
                : mode === 'fade-out-end'
                  ? `VOL OUT END -${origFadeOutEnd.toFixed(2)}s (${origFadeOut.toFixed(2)}s)`
                  : mode === 'fade-out-curve'
                    ? `VOL OUT CURVE ${formatCurveTensionReadout(origFadeOutTension)}`
                    : mode === 'bass-fade-in-start'
                      ? `BASS IN START +${origBassFadeInStart.toFixed(2)}s (${origBassFadeIn.toFixed(2)}s)`
                      : mode === 'bass-fade-in'
                        ? `BASS IN ${origBassFadeIn.toFixed(2)}s`
                        : mode === 'bass-fade-in-curve'
                          ? origBassIn.mode === 'swap'
                            ? `BASS IN SWAP ${formatCurveTensionReadout(origBassInTension, { isSwap: true, direction: 'in' })}`
                            : `BASS IN CURVE ${formatCurveTensionReadout(origBassInTension)}`
                          : mode === 'bass-fade-out'
                            ? `BASS OUT ${origBassFadeOut.toFixed(2)}s`
                            : mode === 'bass-fade-out-end'
                              ? `BASS OUT END -${origBassFadeOutEnd.toFixed(2)}s (${origBassFadeOut.toFixed(2)}s)`
                              : origBassOut.mode === 'swap'
                                ? `BASS OUT SWAP ${formatCurveTensionReadout(origBassOutTension, { isSwap: true, direction: 'out' })}`
                                : `BASS OUT CURVE ${formatCurveTensionReadout(origBassOutTension)}`;
      setActiveFadeDrag({ clipId: clip.id, mode, label: initialLabel });
    }

    let activeTrackId = track.id;
    const initialRippleClipIds = new Set<string>();
    if (mode === 'move') {
      for (const t of projectRef.current.tracks) {
        for (const c of t.clips) {
          if (c.id !== clip.id && c.startSec > origStart + 1e-4) {
            initialRippleClipIds.add(c.id);
          }
        }
      }
    }

    const onMove = (ev: PointerEvent) => {
      const liveProject = projectRef.current;
      const liveAssetsMap = assetsMapRef.current;
      const liveAsset = liveAssetsMap.get(clip.trackAssetId) ?? asset;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const dt = dx / liveProject.zoomPxPerSec;

      if (mode === 'move') {
        const rippleActive = liveProject.rippleMove !== false;
        const rawNext = Math.max(0, origStart + dt);
        const snapped = ev.altKey
          ? rawNext
          : snapClipStartToBeatGrid({
              project: liveProject,
              rawStartSec: rawNext,
              snapMode: liveProject.snapMode,
              offsetSec: clip.offsetSec,
              durationSec: clip.durationSec,
              stretchToMasterBpm: clip.stretchToMasterBpm,
              asset: liveAsset,
              assetsMap: liveAssetsMap,
              excludeClipId: clip.id,
              excludeClipIds: rippleActive ? initialRippleClipIds : undefined,
            });

        let targetTrackId = activeTrackId;
        for (const t of liveProject.tracks) {
          const laneEl = trackLaneRefs.current.get(t.id);
          if (!laneEl) continue;
          const rect = laneEl.getBoundingClientRect();
          if (ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
            targetTrackId = t.id;
            break;
          }
        }

        setDragOverTrackId(targetTrackId !== track.id ? targetTrackId : null);
        onMoveClip(
          activeTrackId,
          targetTrackId,
          clip.id,
          snapped,
          rippleActive ? initialRippleClipIds : undefined
        );
        if (targetTrackId !== activeTrackId) {
          activeTrackId = targetTrackId;
          setSelectedClipRef({ trackId: targetTrackId, clipId: clip.id });
        }
      } else if (mode === 'trim-left') {
        const clampedDt = Math.max(
          -origStart,
          Math.min(origDuration - 0.15, dt)
        );
        const nextStart = Math.max(0, origStart + clampedDt);
        const actualDt = nextStart - origStart;
        const srcDelta =
          clip.stretchToMasterBpm && liveAsset && liveAsset.bpm > 0
            ? actualDt >= 0
              ? integrateClipSourceOffsetSec(liveProject, origStart, actualDt, liveAsset.bpm)
              : -integrateClipSourceOffsetSec(liveProject, nextStart, -actualDt, liveAsset.bpm)
            : actualDt;

        if (origOffset + srcDelta < 0) {
          const clampedSrcRatio = origOffset / Math.max(0.0001, -srcDelta);
          const safeStart = Math.max(0, origStart + actualDt * clampedSrcRatio);
          const safeDur = Math.max(0.15, origDuration - (safeStart - origStart));
          onUpdateClip(activeTrackId, clip.id, {
            startSec: safeStart,
            offsetSec: 0,
            durationSec: safeDur,
          });
        } else {
          onUpdateClip(activeTrackId, clip.id, {
            startSec: nextStart,
            offsetSec: Math.max(0, origOffset + srcDelta),
            durationSec: Math.max(0.15, origDuration - actualDt),
          });
        }
      } else if (mode === 'trim-right') {
        const maxDur = Math.max(0.2, maxAvailSource - origOffset);
        const rawDur = Math.max(0.15, Math.min(maxDur, origDuration + dt));
        onUpdateClip(activeTrackId, clip.id, { durationSec: rawDur });
      } else if (mode === 'fade-in-start') {
        const maxVolEnd = Math.max(0, origDuration - origFadeOutEnd - origFadeOut - 0.02);
        const origEnd = origFadeInStart + origFadeIn;
        const nextStart = round2(Math.max(0, Math.min(maxVolEnd, origFadeInStart + dt)));
        const nextDur = round2(Math.max(0, origEnd - nextStart));
        setActiveFadeDrag({
          clipId: clip.id,
          mode,
          label: `VOL IN +${nextStart.toFixed(2)}s · ${nextDur.toFixed(2)}s`,
        });
        onUpdateClip(activeTrackId, clip.id, {
          fadeInStartSec: nextStart,
          fadeInSec: nextDur,
          fadeInEnabled: true,
          bassFadeInSec: origBassFadeIn,
          mixIn: clip.mixIn
            ? { ...clip.mixIn, volumeCrossfade: nextDur > 0 || nextStart > 0 }
            : undefined,
        });
      } else if (mode === 'fade-in') {
        const maxVolEnd = Math.max(origFadeInStart, origDuration - origFadeOutEnd - origFadeOut - 0.02);
        const nextEnd = Math.max(origFadeInStart, Math.min(maxVolEnd, origFadeInStart + origFadeIn + dt));
        const rounded = round2(nextEnd - origFadeInStart);
        setActiveFadeDrag({
          clipId: clip.id,
          mode,
          label:
            origFadeInStart > 0.01
              ? `VOL IN ${rounded.toFixed(2)}s (→${(origFadeInStart + rounded).toFixed(2)}s)`
              : `VOL IN ${rounded.toFixed(2)}s`,
        });
        onUpdateClip(activeTrackId, clip.id, {
          fadeInSec: rounded,
          fadeInEnabled: true,
          bassFadeInSec: origBassFadeIn,
          mixIn: clip.mixIn
            ? { ...clip.mixIn, volumeCrossfade: rounded > 0 || origFadeInStart > 0 }
            : undefined,
        });
      } else if (mode === 'fade-out') {
        const maxOutSpan = Math.max(origFadeOutEnd, origDuration - origFadeInStart - origFadeIn - 0.02);
        const nextTotalFromEnd = Math.max(
          origFadeOutEnd,
          Math.min(maxOutSpan, origFadeOutEnd + origFadeOut - dt)
        );
        const rounded = round2(nextTotalFromEnd - origFadeOutEnd);
        setActiveFadeDrag({
          clipId: clip.id,
          mode,
          label:
            origFadeOutEnd > 0.01
              ? `VOL OUT ${rounded.toFixed(2)}s (-${origFadeOutEnd.toFixed(2)}s)`
              : `VOL OUT ${rounded.toFixed(2)}s`,
        });
        onUpdateClip(activeTrackId, clip.id, {
          fadeOutSec: rounded,
          fadeOutEnabled: true,
          bassFadeOutSec: origBassFadeOut,
          mixOut: clip.mixOut
            ? { ...clip.mixOut, volumeCrossfade: rounded > 0 || origFadeOutEnd > 0 }
            : undefined,
        });
      } else if (mode === 'fade-out-end') {
        const maxOutInset = Math.max(0, origDuration - origFadeInStart - origFadeIn - 0.02);
        const origStartFromEnd = origFadeOutEnd + origFadeOut;
        const nextInset = round2(Math.max(0, Math.min(maxOutInset, origFadeOutEnd - dt)));
        const nextDur = round2(Math.max(0, origStartFromEnd - nextInset));
        setActiveFadeDrag({
          clipId: clip.id,
          mode,
          label: `VOL OUT -${nextInset.toFixed(2)}s · ${nextDur.toFixed(2)}s`,
        });
        onUpdateClip(activeTrackId, clip.id, {
          fadeOutEndSec: nextInset,
          fadeOutSec: nextDur,
          fadeOutEnabled: true,
          bassFadeOutSec: origBassFadeOut,
          mixOut: clip.mixOut
            ? { ...clip.mixOut, volumeCrossfade: nextDur > 0 || nextInset > 0 }
            : undefined,
        });
      } else if (mode === 'bass-fade-in-start') {
        const maxBassEnd = Math.max(0, origDuration - origBassFadeOutEnd - origBassFadeOut - 0.02);
        const origEnd = origBassFadeInStart + origBassFadeIn;
        const nextStart = round2(Math.max(0, Math.min(maxBassEnd, origBassFadeInStart + dt)));
        const nextDur = round2(Math.max(0, origEnd - nextStart));
        setActiveFadeDrag({
          clipId: clip.id,
          mode,
          label: `BASS IN +${nextStart.toFixed(2)}s · ${nextDur.toFixed(2)}s`,
        });
        onUpdateClip(activeTrackId, clip.id, {
          bassFadeInStartSec: nextStart,
          bassFadeInSec: nextDur,
          bassFadeInEnabled: true,
          mixIn: clip.mixIn
            ? {
                ...clip.mixIn,
                bassMode:
                  nextDur > 0 || nextStart > 0
                    ? clip.mixIn.bassMode === 'none'
                      ? 'crossfade'
                      : clip.mixIn.bassMode
                    : 'none',
              }
            : undefined,
        });
      } else if (mode === 'bass-fade-in') {
        const maxBassEnd = Math.max(
          origBassFadeInStart,
          origDuration - origBassFadeOutEnd - origBassFadeOut - 0.02
        );
        const nextEnd = Math.max(
          origBassFadeInStart,
          Math.min(maxBassEnd, origBassFadeInStart + origBassFadeIn + dt)
        );
        const rounded = round2(nextEnd - origBassFadeInStart);
        setActiveFadeDrag({
          clipId: clip.id,
          mode,
          label:
            origBassFadeInStart > 0.01
              ? `BASS IN ${rounded.toFixed(2)}s (→${(origBassFadeInStart + rounded).toFixed(2)}s)`
              : `BASS IN ${rounded.toFixed(2)}s`,
        });
        onUpdateClip(activeTrackId, clip.id, {
          bassFadeInSec: rounded,
          bassFadeInEnabled: true,
          mixIn: clip.mixIn
            ? {
                ...clip.mixIn,
                bassMode:
                  rounded > 0 || origBassFadeInStart > 0
                    ? clip.mixIn.bassMode === 'none'
                      ? 'crossfade'
                      : clip.mixIn.bassMode
                    : 'none',
              }
            : undefined,
        });
      } else if (mode === 'bass-fade-out') {
        const maxBassOutSpan = Math.max(
          origBassFadeOutEnd,
          origDuration - origBassFadeInStart - origBassFadeIn - 0.02
        );
        const nextTotalFromEnd = Math.max(
          origBassFadeOutEnd,
          Math.min(maxBassOutSpan, origBassFadeOutEnd + origBassFadeOut - dt)
        );
        const rounded = round2(nextTotalFromEnd - origBassFadeOutEnd);
        setActiveFadeDrag({
          clipId: clip.id,
          mode,
          label:
            origBassFadeOutEnd > 0.01
              ? `BASS OUT ${rounded.toFixed(2)}s (-${origBassFadeOutEnd.toFixed(2)}s)`
              : `BASS OUT ${rounded.toFixed(2)}s`,
        });
        onUpdateClip(activeTrackId, clip.id, {
          bassFadeOutSec: rounded,
          bassFadeOutEnabled: true,
          mixOut: clip.mixOut
            ? {
                ...clip.mixOut,
                bassMode:
                  rounded > 0 || origBassFadeOutEnd > 0
                    ? clip.mixOut.bassMode === 'none'
                      ? 'crossfade'
                      : clip.mixOut.bassMode
                    : 'none',
              }
            : undefined,
        });
      } else if (mode === 'bass-fade-out-end') {
        const maxBassInset = Math.max(0, origDuration - origBassFadeInStart - origBassFadeIn - 0.02);
        const origStartFromEnd = origBassFadeOutEnd + origBassFadeOut;
        const nextInset = round2(Math.max(0, Math.min(maxBassInset, origBassFadeOutEnd - dt)));
        const nextDur = round2(Math.max(0, origStartFromEnd - nextInset));
        setActiveFadeDrag({
          clipId: clip.id,
          mode,
          label: `BASS OUT -${nextInset.toFixed(2)}s · ${nextDur.toFixed(2)}s`,
        });
        onUpdateClip(activeTrackId, clip.id, {
          bassFadeOutEndSec: nextInset,
          bassFadeOutSec: nextDur,
          bassFadeOutEnabled: true,
          mixOut: clip.mixOut
            ? {
                ...clip.mixOut,
                bassMode:
                  nextDur > 0 || nextInset > 0
                    ? clip.mixOut.bassMode === 'none'
                      ? 'crossfade'
                      : clip.mixOut.bassMode
                    : 'none',
              }
            : undefined,
        });
      } else if (mode === 'fade-in-curve') {
        const raw = clampCurveTension(origFadeInTension - dy / 44);
        const snapped = !ev.altKey && Math.abs(raw) < 0.03 ? 0 : roundSigned2(raw);
        setActiveFadeDrag({
          clipId: clip.id,
          mode,
          label: `VOL IN CURVE ${formatCurveTensionReadout(snapped)}`,
        });
        onUpdateClip(activeTrackId, clip.id, {
          fadeInCurveTension: snapped,
          fadeInEnabled: true,
        });
      } else if (mode === 'fade-out-curve') {
        const raw = clampCurveTension(origFadeOutTension - dy / 44);
        const snapped = !ev.altKey && Math.abs(raw) < 0.03 ? 0 : roundSigned2(raw);
        setActiveFadeDrag({
          clipId: clip.id,
          mode,
          label: `VOL OUT CURVE ${formatCurveTensionReadout(snapped)}`,
        });
        onUpdateClip(activeTrackId, clip.id, {
          fadeOutCurveTension: snapped,
          fadeOutEnabled: true,
        });
      } else if (mode === 'bass-fade-in-curve') {
        let raw: number;
        if (origBassIn.mode === 'swap') {
          const fadeWidthPx = Math.max(20, origBassFadeIn * liveProject.zoomPxPerSec);
          const origCenter = getBassSwapCenterFraction('in', origBassInTension);
          const nextCenter = Math.max(0.12, Math.min(0.88, origCenter + dx / fadeWidthPx));
          raw = clampCurveTension((0.5 - nextCenter) / 0.38);
        } else {
          raw = clampCurveTension(origBassInTension - dy / 44);
        }
        const snapped = !ev.altKey && Math.abs(raw) < 0.03 ? 0 : roundSigned2(raw);
        setActiveFadeDrag({
          clipId: clip.id,
          mode,
          label:
            origBassIn.mode === 'swap'
              ? `BASS IN SWAP ${formatCurveTensionReadout(snapped, { isSwap: true, direction: 'in' })}`
              : `BASS IN CURVE ${formatCurveTensionReadout(snapped)}`,
        });
        onUpdateClip(activeTrackId, clip.id, {
          bassFadeInCurveTension: snapped,
          bassFadeInEnabled: true,
        });
      } else if (mode === 'bass-fade-out-curve') {
        let raw: number;
        if (origBassOut.mode === 'swap') {
          const fadeWidthPx = Math.max(20, origBassFadeOut * liveProject.zoomPxPerSec);
          const origCenter = getBassSwapCenterFraction('out', origBassOutTension);
          const nextCenter = Math.max(0.12, Math.min(0.88, origCenter + dx / fadeWidthPx));
          raw = clampCurveTension((nextCenter - 0.5) / 0.38);
        } else {
          raw = clampCurveTension(origBassOutTension - dy / 44);
        }
        const snapped = !ev.altKey && Math.abs(raw) < 0.03 ? 0 : roundSigned2(raw);
        setActiveFadeDrag({
          clipId: clip.id,
          mode,
          label:
            origBassOut.mode === 'swap'
              ? `BASS OUT SWAP ${formatCurveTensionReadout(snapped, { isSwap: true, direction: 'out' })}`
              : `BASS OUT CURVE ${formatCurveTensionReadout(snapped)}`,
        });
        onUpdateClip(activeTrackId, clip.id, {
          bassFadeOutCurveTension: snapped,
          bassFadeOutEnabled: true,
        });
      }
    };

    const onUp = () => {
      setDragOverTrackId(null);
      setActiveFadeDrag(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (mode === 'move' || mode === 'trim-left' || mode === 'trim-right') {
        onCommitTempoChange?.();
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const resetClipFadeHandle = (
    e: React.MouseEvent,
    track: NleTrack,
    clip: NleClip,
    mode:
      | 'fade-in-start'
      | 'fade-in'
      | 'fade-in-curve'
      | 'fade-out'
      | 'fade-out-end'
      | 'fade-out-curve'
      | 'bass-fade-in-start'
      | 'bass-fade-in'
      | 'bass-fade-in-curve'
      | 'bass-fade-out'
      | 'bass-fade-out-end'
      | 'bass-fade-out-curve'
  ) => {
    e.stopPropagation();
    e.preventDefault();
    if (mode === 'fade-in-start') {
      const preservedBassIn = getConfiguredClipBassFade(clip, 'in').durationSec;
      const nextDur = Math.round(((clip.fadeInStartSec ?? 0) + clip.fadeInSec) * 100) / 100;
      onUpdateClip(track.id, clip.id, {
        fadeInStartSec: 0,
        fadeInSec: nextDur,
        fadeInEnabled: true,
        bassFadeInSec: preservedBassIn,
      });
    } else if (mode === 'fade-in') {
      const preservedBassIn = getConfiguredClipBassFade(clip, 'in').durationSec;
      onUpdateClip(track.id, clip.id, {
        fadeInStartSec: 0,
        fadeInSec: 0,
        fadeInCurveTension: 0,
        bassFadeInSec: preservedBassIn,
        mixIn: clip.mixIn ? { ...clip.mixIn, volumeCrossfade: false } : undefined,
      });
    } else if (mode === 'fade-in-curve') {
      onUpdateClip(track.id, clip.id, { fadeInCurveTension: 0 });
    } else if (mode === 'fade-out') {
      const preservedBassOut = getConfiguredClipBassFade(clip, 'out').durationSec;
      onUpdateClip(track.id, clip.id, {
        fadeOutEndSec: 0,
        fadeOutSec: 0,
        fadeOutCurveTension: 0,
        bassFadeOutSec: preservedBassOut,
        mixOut: clip.mixOut ? { ...clip.mixOut, volumeCrossfade: false } : undefined,
      });
    } else if (mode === 'fade-out-end') {
      const preservedBassOut = getConfiguredClipBassFade(clip, 'out').durationSec;
      const nextDur = Math.round(((clip.fadeOutEndSec ?? 0) + clip.fadeOutSec) * 100) / 100;
      onUpdateClip(track.id, clip.id, {
        fadeOutEndSec: 0,
        fadeOutSec: nextDur,
        fadeOutEnabled: true,
        bassFadeOutSec: preservedBassOut,
      });
    } else if (mode === 'fade-out-curve') {
      onUpdateClip(track.id, clip.id, { fadeOutCurveTension: 0 });
    } else if (mode === 'bass-fade-in-start') {
      const curBassIn = getConfiguredClipBassFade(clip, 'in');
      const nextDur = Math.round((curBassIn.offsetSec + curBassIn.durationSec) * 100) / 100;
      onUpdateClip(track.id, clip.id, {
        bassFadeInStartSec: 0,
        bassFadeInSec: nextDur,
        bassFadeInEnabled: true,
      });
    } else if (mode === 'bass-fade-in') {
      onUpdateClip(track.id, clip.id, {
        bassFadeInStartSec: 0,
        bassFadeInSec: 0,
        bassFadeInCurveTension: 0,
        mixIn: clip.mixIn ? { ...clip.mixIn, bassMode: 'none' } : undefined,
      });
    } else if (mode === 'bass-fade-in-curve') {
      onUpdateClip(track.id, clip.id, { bassFadeInCurveTension: 0 });
    } else if (mode === 'bass-fade-out') {
      onUpdateClip(track.id, clip.id, {
        bassFadeOutEndSec: 0,
        bassFadeOutSec: 0,
        bassFadeOutCurveTension: 0,
        mixOut: clip.mixOut ? { ...clip.mixOut, bassMode: 'none' } : undefined,
      });
    } else if (mode === 'bass-fade-out-curve') {
      onUpdateClip(track.id, clip.id, { bassFadeOutCurveTension: 0 });
    } else {
      const curBassOut = getConfiguredClipBassFade(clip, 'out');
      const nextDur = Math.round((curBassOut.offsetSec + curBassOut.durationSec) * 100) / 100;
      onUpdateClip(track.id, clip.id, {
        bassFadeOutEndSec: 0,
        bassFadeOutSec: nextDur,
        bassFadeOutEnabled: true,
      });
    }
  };

  const getDefaultVolumeFadeSec = (clip: NleClip, direction: 'in' | 'out'): number => {
    const bassFade = getConfiguredClipBassFade(clip, direction).durationSec;
    const envDur = direction === 'in' ? clip.mixIn?.durationSec ?? 0 : clip.mixOut?.durationSec ?? 0;
    const barDur =
      direction === 'in'
        ? getOverlapDurationFromStart(project, clip.startSec, Math.max(1, mixDefaults.overlapBars || 4))
        : getOverlapDurationBeforeTime(
            project,
            clip.startSec + clip.durationSec,
            Math.max(1, mixDefaults.overlapBars || 4)
          );
    const candidate = bassFade > 0.05 ? bassFade : envDur > 0.05 ? envDur : barDur > 0.1 ? barDur : 4;
    return Math.round(Math.max(0.5, Math.min(clip.durationSec * 0.45, candidate)) * 100) / 100;
  };

  const toggleClipVolumeFadeDirection = (
    trackId: string,
    clip: NleClip,
    direction: 'in' | 'out'
  ) => {
    const cfg = getConfiguredClipVolumeFade(clip, direction);
    const hasConfigured = cfg.durationSec > 0.01 || cfg.offsetSec > 0.01;
    const isActiveNow = cfg.enabled && hasConfigured;

    if (direction === 'in') {
      if (isActiveNow) {
        onUpdateClip(trackId, clip.id, { fadeInEnabled: false });
      } else if (hasConfigured) {
        onUpdateClip(trackId, clip.id, { fadeInEnabled: true });
      } else {
        const nextDur = getDefaultVolumeFadeSec(clip, 'in');
        const preservedBassIn = getConfiguredClipBassFade(clip, 'in').durationSec;
        onUpdateClip(trackId, clip.id, {
          fadeInSec: nextDur,
          fadeInEnabled: true,
          bassFadeInSec: preservedBassIn,
          mixIn: clip.mixIn ? { ...clip.mixIn, volumeCrossfade: true } : undefined,
        });
      }
      return;
    }

    if (isActiveNow) {
      onUpdateClip(trackId, clip.id, { fadeOutEnabled: false });
    } else if (hasConfigured) {
      onUpdateClip(trackId, clip.id, { fadeOutEnabled: true });
    } else {
      const nextDur = getDefaultVolumeFadeSec(clip, 'out');
      const preservedBassOut = getConfiguredClipBassFade(clip, 'out').durationSec;
      onUpdateClip(trackId, clip.id, {
        fadeOutSec: nextDur,
        fadeOutEnabled: true,
        bassFadeOutSec: preservedBassOut,
        mixOut: clip.mixOut ? { ...clip.mixOut, volumeCrossfade: true } : undefined,
      });
    }
  };

  const getDefaultBassFadeSec = (clip: NleClip, direction: 'in' | 'out'): number => {
    const volFade = direction === 'in' ? clip.fadeInSec : clip.fadeOutSec;
    const envDur = direction === 'in' ? clip.mixIn?.durationSec ?? 0 : clip.mixOut?.durationSec ?? 0;
    const barDur =
      direction === 'in'
        ? getOverlapDurationFromStart(project, clip.startSec, Math.max(1, mixDefaults.overlapBars || 4))
        : getOverlapDurationBeforeTime(
            project,
            clip.startSec + clip.durationSec,
            Math.max(1, mixDefaults.overlapBars || 4)
          );
    const candidate = volFade > 0.05 ? volFade : envDur > 0.05 ? envDur : barDur > 0.1 ? barDur : 4;
    return Math.round(Math.max(0.5, Math.min(clip.durationSec * 0.45, candidate)) * 100) / 100;
  };

  const toggleClipBassFadeDirection = (
    trackId: string,
    clip: NleClip,
    direction: 'in' | 'out'
  ) => {
    const cfg = getConfiguredClipBassFade(clip, direction);
    const hasConfigured = cfg.durationSec > 0.01 || cfg.offsetSec > 0.01;
    const isActiveNow = cfg.enabled && hasConfigured;

    if (direction === 'in') {
      if (isActiveNow) {
        onUpdateClip(trackId, clip.id, { bassFadeInEnabled: false });
      } else if (hasConfigured) {
        onUpdateClip(trackId, clip.id, { bassFadeInEnabled: true });
      } else {
        const nextDur = getDefaultBassFadeSec(clip, 'in');
        onUpdateClip(trackId, clip.id, {
          bassFadeInSec: nextDur,
          bassFadeInEnabled: true,
          mixIn: clip.mixIn
            ? {
                ...clip.mixIn,
                bassMode: clip.mixIn.bassMode === 'none' ? 'crossfade' : clip.mixIn.bassMode,
              }
            : undefined,
        });
      }
      return;
    }

    if (isActiveNow) {
      onUpdateClip(trackId, clip.id, { bassFadeOutEnabled: false });
    } else if (hasConfigured) {
      onUpdateClip(trackId, clip.id, { bassFadeOutEnabled: true });
    } else {
      const nextDur = getDefaultBassFadeSec(clip, 'out');
      onUpdateClip(trackId, clip.id, {
        bassFadeOutSec: nextDur,
        bassFadeOutEnabled: true,
        mixOut: clip.mixOut
          ? {
              ...clip.mixOut,
              bassMode: clip.mixOut.bassMode === 'none' ? 'crossfade' : clip.mixOut.bassMode,
            }
          : undefined,
      });
    }
  };

  // Loop region helpers
  const MIN_LOOP_SEC = 0.25;

  const snapLoopSec = (rawSec: number, bypassSnap: boolean): number => {
    const clamped = Math.max(0, Math.min(timelineTotalSec, rawSec));
    if (bypassSnap) return Math.round(clamped * 1000) / 1000;
    const liveProj = projectRef.current;
    return Math.max(
      0,
      Math.min(timelineTotalSec, snapSecondsWithTempoMap(liveProj, clamped, liveProj.snapMode))
    );
  };

  const getDefaultLoopSpanSec = (anchorSec: number): number => {
    const liveProj = projectRef.current;
    const bpm = Math.max(40, evaluateBpmAt(liveProj, anchorSec));
    return (60 / bpm) * 16; // 4 bars
  };

  const handleSetLoopInAtPlayhead = () => {
    const liveProj = projectRef.current;
    const nextStart = Math.max(0, liveProj.playheadSec);
    const nextEnd =
      liveProj.loopEndSec > nextStart + MIN_LOOP_SEC
        ? liveProj.loopEndSec
        : Math.min(timelineTotalSec, nextStart + getDefaultLoopSpanSec(nextStart));
    onUpdateProject({
      loopStartSec: nextStart,
      loopEndSec: nextEnd,
      loopEnabled: true,
    });
  };

  const handleSetLoopOutAtPlayhead = () => {
    const liveProj = projectRef.current;
    const nextEnd = Math.max(MIN_LOOP_SEC, liveProj.playheadSec);
    const nextStart =
      liveProj.loopStartSec < nextEnd - MIN_LOOP_SEC
        ? liveProj.loopStartSec
        : Math.max(0, nextEnd - getDefaultLoopSpanSec(nextEnd));
    onUpdateProject({
      loopStartSec: nextStart,
      loopEndSec: nextEnd,
      loopEnabled: true,
    });
  };

  const handleOpenSuperZoom = () => {
    const liveProj = projectRef.current;
    if (liveProj.loopEndSec <= liveProj.loopStartSec + MIN_LOOP_SEC) {
      const start = Math.max(0, liveProj.playheadSec);
      onUpdateProject({
        loopStartSec: start,
        loopEndSec: Math.min(timelineTotalSec, start + getDefaultLoopSpanSec(start)),
        loopEnabled: true,
      });
    } else if (!liveProj.loopEnabled) {
      onUpdateProject({ loopEnabled: true });
    }
    setShowSuperZoom(true);
  };

  const startLoopBarDrag = (
    e: React.PointerEvent,
    mode: 'start' | 'end' | 'move'
  ) => {
    e.stopPropagation();
    e.preventDefault();
    const startClientX = e.clientX;
    const origStart = projectRef.current.loopStartSec;
    const origEnd = projectRef.current.loopEndSec;
    const origLen = Math.max(MIN_LOOP_SEC, origEnd - origStart);

    setLoopDragInfo({ mode, startSec: origStart, endSec: origEnd });

    const onMove = (ev: PointerEvent) => {
      const liveProj = projectRef.current;
      const dt = (ev.clientX - startClientX) / liveProj.zoomPxPerSec;
      let nextStart = origStart;
      let nextEnd = origEnd;

      if (mode === 'start') {
        const snapped = snapLoopSec(origStart + dt, ev.altKey);
        nextStart = Math.max(0, Math.min(origEnd - MIN_LOOP_SEC, snapped));
      } else if (mode === 'end') {
        const snapped = snapLoopSec(origEnd + dt, ev.altKey);
        nextEnd = Math.min(timelineTotalSec, Math.max(origStart + MIN_LOOP_SEC, snapped));
      } else {
        const rawStart = Math.max(0, Math.min(timelineTotalSec - origLen, origStart + dt));
        nextStart = snapLoopSec(rawStart, ev.altKey);
        nextStart = Math.max(0, Math.min(timelineTotalSec - origLen, nextStart));
        nextEnd = nextStart + origLen;
      }

      setLoopDragInfo({ mode, startSec: nextStart, endSec: nextEnd });
      onUpdateProjectRef.current({
        loopStartSec: nextStart,
        loopEndSec: nextEnd,
        loopEnabled: true,
      });
    };

    const onUp = () => {
      setLoopDragInfo(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleLoopStripPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const toSec = (clientX: number, altKey: boolean) => {
      const x = Math.max(0, clientX - rect.left);
      return snapLoopSec(x / projectRef.current.zoomPxPerSec, altKey);
    };

    const anchorSec = toSec(e.clientX, e.altKey);
    let hasDragged = false;

    const onMove = (ev: PointerEvent) => {
      const curSec = toSec(ev.clientX, ev.altKey);
      const lo = Math.min(anchorSec, curSec);
      const hi = Math.max(anchorSec, curSec);
      if (hi - lo >= MIN_LOOP_SEC) {
        hasDragged = true;
        setLoopDragInfo({ mode: 'draw', startSec: lo, endSec: hi });
        onUpdateProjectRef.current({
          loopStartSec: lo,
          loopEndSec: hi,
          loopEnabled: true,
        });
      }
    };

    const onUp = () => {
      setLoopDragInfo(null);
      if (!hasDragged) {
        onSeek(anchorSec);
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const loopDurationBars = useMemo(() => {
    if (project.loopEndSec <= project.loopStartSec) return 0;
    const startBeats = getBeatsAtTime(project, project.loopStartSec);
    const endBeats = getBeatsAtTime(project, project.loopEndSec);
    return Math.max(0, (endBeats - startBeats) / 4);
  }, [project.masterBpm, project.tempoPoints, project.loopStartSec, project.loopEndSec]);

  const allTimelineClips = useMemo(() => {
    const items: Array<{
      trackId: string;
      trackIndex: number;
      clip: NleClip;
      startSec: number;
      endSec: number;
    }> = [];
    project.tracks.forEach((track, trackIndex) => {
      for (const clip of track.clips) {
        items.push({
          trackId: track.id,
          trackIndex,
          clip,
          startSec: clip.startSec,
          endSec: clip.startSec + clip.durationSec,
        });
      }
    });
    items.sort((a, b) =>
      Math.abs(a.startSec - b.startSec) > 1e-4
        ? a.startSec - b.startSec
        : a.trackIndex - b.trackIndex
    );
    return items;
  }, [project.tracks]);

  const currentClipForJump = useMemo(() => {
    if (allTimelineClips.length === 0) return null;
    const t = project.playheadSec;
    const eps = 0.02;
    const covering = allTimelineClips.filter(
      (item) => item.startSec - eps <= t && t <= item.endSec + eps
    );

    if (covering.length > 0) {
      if (selectedClipRef) {
        const selectedMatch = covering.find(
          (item) =>
            item.trackId === selectedClipRef.trackId &&
            item.clip.id === selectedClipRef.clipId
        );
        if (selectedMatch) return selectedMatch;
      }
      const ongoing = covering.filter((item) => item.endSec > t + eps);
      const pool = ongoing.length > 0 ? ongoing : covering;
      return pool[pool.length - 1];
    }

    if (selectedClipRef) {
      const selectedAny = allTimelineClips.find(
        (item) =>
          item.trackId === selectedClipRef.trackId &&
          item.clip.id === selectedClipRef.clipId
      );
      if (selectedAny) return selectedAny;
    }

    let prevItem = null as (typeof allTimelineClips)[number] | null;
    for (const item of allTimelineClips) {
      if (item.startSec <= t) prevItem = item;
      else break;
    }
    return prevItem ?? allTimelineClips[0];
  }, [allTimelineClips, project.playheadSec, selectedClipRef]);

  const seekAndScrollPlayhead = (targetSec: number) => {
    const safeSec = Math.max(0, Math.min(timelineTotalSec, targetSec));
    onSeek(safeSec);
    const container = scrollContainerRef.current;
    if (!container) return;
    if (safeSec <= 0.001) {
      container.scrollLeft = 0;
      return;
    }
    const targetX = safeSec * project.zoomPxPerSec;
    const visibleLaneWidth = Math.max(100, container.clientWidth - TRACK_HEADER_WIDTH);
    if (
      targetX < container.scrollLeft + 24 ||
      targetX > container.scrollLeft + visibleLaneWidth - 24
    ) {
      container.scrollLeft = Math.max(0, targetX - visibleLaneWidth * 0.25);
    }
  };

  const handleJumpToTimelineStart = () => {
    seekAndScrollPlayhead(0);
  };

  const handleJumpToClipStart = () => {
    if (!currentClipForJump) return;
    seekAndScrollPlayhead(currentClipForJump.startSec);
  };

  const handleJumpToClipEnd = () => {
    if (!currentClipForJump) return;
    seekAndScrollPlayhead(currentClipForJump.endSec);
  };

  // Ruler Scrubbing
  const handleRulerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const updateFromEvent = (clientX: number) => {
      const x = Math.max(0, clientX - rect.left);
      const sec = Math.max(0, Math.min(timelineTotalSec, x / project.zoomPxPerSec));
      onSeek(sec);
    };
    updateFromEvent(e.clientX);
    const onMove = (ev: PointerEvent) => updateFromEvent(ev.clientX);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="flex-1 min-w-0 h-full flex flex-col bg-om-base overflow-hidden select-none">
      {/* NLE Transport & Editing Toolbar */}
      <div className="px-4 py-2.5 bg-om-panel border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onTogglePlay}
            className={`h-8 px-3.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              project.isPlaying
                ? 'bg-om-accent text-om-accent-ink'
                : 'bg-om-control-alt hover:bg-om-control-hover text-om-text border border-white/[0.08]'
            }`}
          >
            {project.isPlaying ? (
              <>
                <Pause className="w-3.5 h-3.5 fill-current" />
                Pause
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 fill-current" />
                Play Mix
              </>
            )}
          </button>

          <button
            type="button"
            onClick={onStop}
            title="Stop and Return to Cue Point (press again for 0:00)"
            className="h-8 w-8 rounded-md bg-om-control hover:bg-om-control-hover border border-white/[0.08] flex items-center justify-center text-om-text-secondary cursor-pointer"
          >
            <Square className="w-3.5 h-3.5 fill-current" />
          </button>

          <button
            type="button"
            onClick={handleJumpToTimelineStart}
            disabled={project.playheadSec <= 0.005}
            aria-label="Jump to start of timeline"
            title="Jump to Start of Timeline (0:00)"
            className="h-8 w-8 rounded-md bg-om-control hover:bg-om-control-hover border border-white/[0.08] flex items-center justify-center text-om-text-secondary hover:text-om-text disabled:opacity-35 disabled:cursor-not-allowed transition-colors cursor-pointer shrink-0"
          >
            <SkipBack className="w-3.5 h-3.5" />
          </button>

          <div className="inline-flex items-center rounded-md border border-white/[0.08] bg-om-control overflow-hidden shrink-0">
            <button
              type="button"
              onClick={handleJumpToClipStart}
              disabled={!currentClipForJump}
              aria-label="Jump to start of current clip"
              title={
                currentClipForJump
                  ? `Jump to Start of Current Clip (${assetsMap.get(currentClipForJump.clip.trackAssetId)?.name ?? 'Clip'} · ${formatTimecode(currentClipForJump.startSec, true)})`
                  : 'Jump to Start of Current Clip (no clips on timeline)'
              }
              className="h-8 w-7 flex items-center justify-center text-om-text-secondary hover:text-om-text hover:bg-white/[0.06] disabled:opacity-35 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              <ArrowLeftToLine className="w-3.5 h-3.5" />
            </button>
            <span className="px-1.5 text-[10px] font-medium uppercase tracking-wider text-om-text-muted border-x border-white/[0.08] h-8 inline-flex items-center">
              Clip
            </span>
            <button
              type="button"
              onClick={handleJumpToClipEnd}
              disabled={!currentClipForJump}
              aria-label="Jump to end of current clip"
              title={
                currentClipForJump
                  ? `Jump to End of Current Clip (${assetsMap.get(currentClipForJump.clip.trackAssetId)?.name ?? 'Clip'} · ${formatTimecode(currentClipForJump.endSec, true)})`
                  : 'Jump to End of Current Clip (no clips on timeline)'
              }
              className="h-8 w-7 flex items-center justify-center text-om-text-secondary hover:text-om-text hover:bg-white/[0.06] disabled:opacity-35 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              <ArrowRightToLine className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="inline-flex items-center rounded-md border border-white/[0.08] bg-om-control overflow-hidden shrink-0">
            <button
              type="button"
              onClick={() => {
                if (!project.loopEnabled && project.loopEndSec <= project.loopStartSec + MIN_LOOP_SEC) {
                  const start = Math.max(0, project.playheadSec);
                  onUpdateProject({
                    loopStartSec: start,
                    loopEndSec: Math.min(timelineTotalSec, start + getDefaultLoopSpanSec(start)),
                    loopEnabled: true,
                  });
                } else {
                  onUpdateProject({ loopEnabled: !project.loopEnabled });
                }
              }}
              title="Toggle Loop Region (L)"
              className={`h-8 px-2.5 text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap cursor-pointer ${
                project.loopEnabled
                  ? 'bg-om-secondary/25 text-om-secondary'
                  : 'text-om-text-dim hover:text-om-text hover:bg-white/[0.04]'
              }`}
            >
              <Repeat className="w-3.5 h-3.5" />
              Loop
            </button>
            <button
              type="button"
              onClick={handleSetLoopInAtPlayhead}
              title="Set Loop In Point at Playhead ([)"
              className="h-8 px-2 text-[11px] font-mono text-om-text-muted hover:text-om-secondary hover:bg-white/[0.05] border-l border-white/[0.08] transition-colors cursor-pointer"
            >
              In
            </button>
            <button
              type="button"
              onClick={handleSetLoopOutAtPlayhead}
              title="Set Loop Out Point at Playhead (])"
              className="h-8 px-2 text-[11px] font-mono text-om-text-muted hover:text-om-secondary hover:bg-white/[0.05] border-l border-white/[0.08] transition-colors cursor-pointer"
            >
              Out
            </button>
            {project.loopEndSec > project.loopStartSec + MIN_LOOP_SEC && (
              <button
                type="button"
                onClick={() => onSeek(project.loopStartSec)}
                title={`Jump to Loop In (${formatTimecode(project.loopStartSec, true)} – ${formatTimecode(project.loopEndSec, true)})`}
                className={`h-8 px-2 text-[11px] font-mono tabular-nums border-l border-white/[0.08] transition-colors whitespace-nowrap cursor-pointer ${
                  project.loopEnabled
                    ? 'text-om-secondary bg-om-secondary/10 hover:bg-om-secondary/20'
                    : 'text-om-text-faint hover:text-om-text-secondary'
                }`}
              >
                {loopDurationBars >= 0.25
                  ? `${Number(loopDurationBars.toFixed(1))}b`
                  : `${(project.loopEndSec - project.loopStartSec).toFixed(1)}s`}
              </button>
            )}
            <button
              type="button"
              onClick={handleOpenSuperZoom}
              title="Open Beat Edit window for the looped section with beat markers and ultra-precise positioning"
              className={`h-8 px-2.5 text-xs font-medium inline-flex items-center gap-1.5 border-l border-white/[0.08] transition-colors whitespace-nowrap cursor-pointer ${
                showSuperZoom
                  ? 'bg-om-secondary text-om-accent-ink'
                  : 'text-om-secondary bg-om-secondary/10 hover:bg-om-secondary/25'
              }`}
            >
              <Crosshair className="w-3.5 h-3.5" />
              Beat Edit
            </button>
          </div>

          <div className="ml-2 px-3 py-1 rounded bg-om-base border border-white/[0.08] font-mono tabular-nums text-xs flex items-center gap-2.5 whitespace-nowrap">
            <span className="inline-flex items-center gap-1.5">
              <span className="text-om-text font-semibold" title="Current playhead position">
                {formatTimecode(project.playheadSec, true)}
              </span>
              <span className="text-om-text-icon" aria-hidden="true">
                /
              </span>
              <span className="text-om-text-muted" title="Total mix duration">
                {formatTimecode(mixEnd, true)}
              </span>
            </span>
            <span className="text-om-text-icon" aria-hidden="true">
              ·
            </span>
            <span className="text-om-accent" title="Instantaneous BPM at playhead">
              {livePlayheadBpm.toFixed(1)} BPM
            </span>
          </div>
        </div>

        {/* Center/Right: Options Menu, Snap, Split, Zoom, Add Track */}
        <div className="flex items-center gap-2.5 flex-wrap">
          <div ref={optionsMenuRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => setShowOptionsMenu((prev) => !prev)}
              aria-expanded={showOptionsMenu}
              aria-haspopup="menu"
              title="Timeline options: Tempo Map, Key Lock, Beats, Auto-Mix, and Ripple"
              className={`h-8 px-2.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                showOptionsMenu
                  ? 'bg-om-control-hover text-om-text border-white/[0.16]'
                  : 'bg-om-control hover:bg-om-control-hover text-om-text border-white/[0.08]'
              }`}
            >
              <Sliders className="w-3.5 h-3.5 text-om-accent shrink-0" />
              <span>Options</span>
              <ChevronDown
                className={`w-3.5 h-3.5 text-om-text-dim transition-transform ${
                  showOptionsMenu ? 'rotate-180' : ''
                }`}
              />
            </button>

            {showOptionsMenu && (
              <div
                role="menu"
                aria-label="Timeline options"
                className="absolute left-0 mt-1.5 w-60 rounded-lg bg-om-panel border border-white/[0.12] shadow-2xl py-1 z-50"
              >
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={Boolean(project.showTempoLane)}
                  onClick={() => onUpdateProject({ showTempoLane: !project.showTempoLane })}
                  title="Toggle Master Tempo (BPM) Automation Lane"
                  className="w-full px-3 py-2 text-left text-xs font-medium text-om-text hover:bg-om-control flex items-center justify-between gap-2 transition-colors cursor-pointer"
                >
                  <span className="inline-flex items-center gap-2.5 min-w-0">
                    <TrendingUp
                      className={`w-3.5 h-3.5 shrink-0 ${
                        project.showTempoLane || sortedTempoPoints.length > 0
                          ? 'text-om-secondary'
                          : 'text-om-text-muted'
                      }`}
                    />
                    <span>Tempo Map</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5 shrink-0">
                    {sortedTempoPoints.length > 0 && (
                      <span className="px-1.5 py-0.5 rounded bg-om-base text-[10px] font-mono tabular-nums text-om-text">
                        {sortedTempoPoints.length}
                      </span>
                    )}
                    <span
                      className={`text-[10px] font-mono uppercase ${
                        project.showTempoLane ? 'text-om-secondary' : 'text-om-text-subtle'
                      }`}
                    >
                      {project.showTempoLane ? 'On' : 'Off'}
                    </span>
                  </span>
                </button>

                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={project.keyLock ?? true}
                  onClick={() => {
                    onUpdateProject({ keyLock: !(project.keyLock ?? true) });
                    onCommitTempoChange?.();
                  }}
                  title={
                    (project.keyLock ?? true)
                      ? 'Key Lock ON: preserves pitch during tempo changes (click for zero-artifact Vinyl/Repitch mode)'
                      : 'Repitch / Vinyl mode: pitch follows speed with zero time-stretch artifacts (click to enable Key Lock)'
                  }
                  className="w-full px-3 py-2 text-left text-xs font-medium text-om-text hover:bg-om-control flex items-center justify-between gap-2 transition-colors cursor-pointer"
                >
                  <span className="inline-flex items-center gap-2.5 min-w-0">
                    {(project.keyLock ?? true) ? (
                      <Lock className="w-3.5 h-3.5 text-om-secondary shrink-0" />
                    ) : (
                      <Unlock className="w-3.5 h-3.5 text-om-text-muted shrink-0" />
                    )}
                    <span>Key Lock</span>
                  </span>
                  <span
                    className={`text-[10px] font-mono uppercase shrink-0 ${
                      (project.keyLock ?? true) ? 'text-om-secondary' : 'text-om-text-subtle'
                    }`}
                  >
                    {(project.keyLock ?? true) ? 'On' : 'Repitch'}
                  </span>
                </button>

                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={project.showBeatMarkers ?? true}
                  onClick={() =>
                    onUpdateProject({ showBeatMarkers: !(project.showBeatMarkers ?? true) })
                  }
                  title="Toggle per-clip beat & downbeat markers on waveforms"
                  className="w-full px-3 py-2 text-left text-xs font-medium text-om-text hover:bg-om-control flex items-center justify-between gap-2 transition-colors cursor-pointer"
                >
                  <span className="inline-flex items-center gap-2.5 min-w-0">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 14 14"
                      fill="none"
                      aria-hidden="true"
                      className={`shrink-0 ${
                        (project.showBeatMarkers ?? true)
                          ? 'text-om-accent'
                          : 'text-om-text-muted'
                      }`}
                    >
                      <line x1="2.5" y1="2" x2="2.5" y2="12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                      <line x1="6.5" y1="4" x2="6.5" y2="10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.7" />
                      <line x1="10.5" y1="4" x2="10.5" y2="10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity="0.7" />
                    </svg>
                    <span>Beats</span>
                  </span>
                  <span
                    className={`text-[10px] font-mono uppercase shrink-0 ${
                      (project.showBeatMarkers ?? true) ? 'text-om-accent' : 'text-om-text-subtle'
                    }`}
                  >
                    {(project.showBeatMarkers ?? true) ? 'On' : 'Off'}
                  </span>
                </button>

                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={project.rippleMove !== false}
                  onClick={() =>
                    onUpdateProject({ rippleMove: !(project.rippleMove !== false) })
                  }
                  title={
                    project.rippleMove !== false
                      ? 'Ripple Move ON: moving a clip shifts all subsequent clips across all tracks to stay in sync (click to move clips independently)'
                      : 'Ripple Move OFF: clips move independently without shifting subsequent clips (click to enable Ripple Move)'
                  }
                  className="w-full px-3 py-2 text-left text-xs font-medium text-om-text hover:bg-om-control flex items-center justify-between gap-2 transition-colors cursor-pointer"
                >
                  <span className="inline-flex items-center gap-2.5 min-w-0">
                    <Link2
                      className={`w-3.5 h-3.5 shrink-0 ${
                        project.rippleMove !== false ? 'text-om-accent' : 'text-om-text-muted'
                      }`}
                    />
                    <span>Ripple</span>
                  </span>
                  <span
                    className={`text-[10px] font-mono uppercase shrink-0 ${
                      project.rippleMove !== false ? 'text-om-accent' : 'text-om-text-subtle'
                    }`}
                  >
                    {project.rippleMove !== false ? 'On' : 'Off'}
                  </span>
                </button>

                <div className="my-1 border-t border-white/[0.08]" />

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setShowOptionsMenu(false);
                    setShowMixDefaultsModal(true);
                  }}
                  title="Configure default overlap & crossfade behavior when dropping tracks onto the timeline"
                  className="w-full px-3 py-2 text-left text-xs font-medium text-om-text hover:bg-om-control flex items-center justify-between gap-2 transition-colors cursor-pointer"
                >
                  <span className="inline-flex items-center gap-2.5 min-w-0">
                    <ArrowLeftRight
                      className={`w-3.5 h-3.5 shrink-0 ${
                        mixDefaults.enabled ? 'text-om-positive' : 'text-om-text-muted'
                      }`}
                    />
                    <span>Auto-Mix</span>
                  </span>
                  <span
                    className={`text-[10px] font-mono uppercase shrink-0 ${
                      mixDefaults.enabled ? 'text-om-positive' : 'text-om-text-subtle'
                    }`}
                  >
                    {mixDefaults.enabled ? `${mixDefaults.overlapBars}B` : 'Off'}
                  </span>
                </button>
              </div>
            )}
          </div>

          {showMixDefaultsModal && (
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Auto-Mix Default Drop Transition"
              onClick={() => setShowMixDefaultsModal(false)}
              className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
            >
              <div
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-[860px] max-h-[90vh] flex flex-col rounded-lg bg-om-panel border border-white/[0.12] shadow-2xl overflow-hidden text-xs"
              >
                <div className="px-5 py-3.5 border-b border-white/[0.08] flex items-center justify-between gap-3 shrink-0">
                  <div>
                    <div className="font-display text-sm font-semibold text-om-text">
                      Auto-Mix Defaults
                    </div>
                    <div className="text-[11px] text-om-text-subtle mt-0.5">
                      Hold Alt while dropping to place at exact cursor
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={mixDefaults.enabled}
                        onChange={(e) =>
                          updateMixDefaults({ enabled: e.target.checked }, false)
                        }
                        className="accent-om-positive"
                      />
                      <span className="text-[11px] font-medium text-om-text">
                        {mixDefaults.enabled ? 'On' : 'Off'}
                      </span>
                    </label>
                    <button
                      type="button"
                      onClick={() => setShowMixDefaultsModal(false)}
                      aria-label="Close Auto-Mix popup"
                      className="p-1 text-om-text-subtle hover:text-white cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="p-5 overflow-y-auto">
                  <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1.25fr)_minmax(310px,1fr)] gap-5 items-stretch">
                    {/* Left: Live Demo Mix Preview */}
                    <div className="min-w-0">
                      <AutoMixPreview defaults={mixDefaults} />
                    </div>

                    {/* Right: Auto-Mix Controls */}
                    <div className="space-y-3.5 min-w-0">
                  {/* Preset Chips */}
                  <div className="space-y-1.5">
                    <div className="text-[10px] font-mono uppercase tracking-wider text-om-text-subtle">
                      Mix Style Preset
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {MIX_PRESETS.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() =>
                            onUpdateProject({
                              defaultMixOptions: applyMixPreset(preset.id, mixDefaults),
                            })
                          }
                          title={preset.description}
                          className={`px-2.5 py-1.5 rounded border text-left transition-colors cursor-pointer ${
                            mixDefaults.preset === preset.id
                              ? 'bg-om-positive/15 border-om-positive/60 text-om-text'
                              : 'bg-om-base border-white/[0.08] text-om-text-muted hover:text-white'
                          }`}
                        >
                          <div className="text-[11px] font-medium">{preset.label}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Overlap Bars */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-om-text-secondary">Overlap Length (Bars)</span>
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          min={0}
                          max={64}
                          step={1}
                          value={mixDefaults.overlapBars}
                          onChange={(e) =>
                            updateMixDefaults(
                              { overlapBars: clampOverlapBars(parseFloat(e.target.value)) },
                              false
                            )
                          }
                          className="w-14 bg-om-base border border-white/[0.1] rounded px-1.5 py-0.5 text-right font-mono tabular-nums text-om-text"
                        />
                        <span className="text-[10px] text-om-text-subtle">bars</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {[2, 4, 8, 16, 32].map((b) => (
                        <button
                          key={b}
                          type="button"
                          onClick={() => updateMixDefaults({ overlapBars: b }, false)}
                          className={`flex-1 py-1 rounded text-[10px] font-mono tabular-nums border cursor-pointer ${
                            mixDefaults.overlapBars === b
                              ? 'bg-om-accent/20 border-om-accent/60 text-om-accent'
                              : 'bg-om-base border-white/[0.08] text-om-text-dim hover:text-white'
                          }`}
                        >
                          {b}B
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Volume & Curve */}
                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex items-center gap-1.5 text-[11px] text-om-text-secondary cursor-pointer">
                      <input
                        type="checkbox"
                        checked={mixDefaults.volumeCrossfade}
                        onChange={(e) =>
                          updateMixDefaults({ volumeCrossfade: e.target.checked })
                        }
                        className="accent-om-accent"
                      />
                      <span>Volume Crossfade</span>
                    </label>
                    <select
                      value={mixDefaults.fadeCurve}
                      disabled={!mixDefaults.volumeCrossfade}
                      onChange={(e) =>
                        updateMixDefaults({ fadeCurve: e.target.value as FadeCurve })
                      }
                      className="bg-om-base border border-white/[0.08] rounded px-1.5 py-1 text-[11px] text-om-text disabled:opacity-45"
                    >
                      <option value="scurve">S-Curve Fade</option>
                      <option value="linear">Linear Fade</option>
                      <option value="exponential">Exp Fade</option>
                    </select>
                  </div>

                  {/* Bass EQ Mode & Depth */}
                  <div className="grid grid-cols-2 gap-2">
                    <label className="space-y-1">
                      <span className="block text-[10px] text-om-text-subtle">Bass (Low EQ)</span>
                      <select
                        value={mixDefaults.bassMode}
                        onChange={(e) =>
                          updateMixDefaults({ bassMode: e.target.value as BassMixMode })
                        }
                        className="w-full bg-om-base border border-white/[0.08] rounded px-1.5 py-1 text-[11px] text-om-text"
                      >
                        <option value="none">None</option>
                        <option value="swap">Bass Swap (Mid)</option>
                        <option value="crossfade">Bass Crossfade</option>
                      </select>
                    </label>
                    <label className="space-y-1">
                      <span className="block text-[10px] text-om-text-subtle">Bass Cut Depth</span>
                      <select
                        value={mixDefaults.bassCutDb}
                        disabled={mixDefaults.bassMode === 'none'}
                        onChange={(e) =>
                          updateMixDefaults({
                            bassCutDb: clampBassCutDb(parseFloat(e.target.value)),
                          })
                        }
                        className="w-full bg-om-base border border-white/[0.08] rounded px-1.5 py-1 text-[11px] font-mono text-om-text disabled:opacity-45"
                      >
                        <option value={-12}>-12 dB</option>
                        <option value={-18}>-18 dB</option>
                        <option value={-24}>-24 dB</option>
                        <option value={-36}>-36 dB</option>
                      </select>
                    </label>
                  </div>

                  {/* Mid / High / Filter */}
                  <div className="grid grid-cols-3 gap-2">
                    <label className="space-y-1">
                      <span className="block text-[10px] text-om-text-subtle">Mid EQ</span>
                      <select
                        value={mixDefaults.midMode}
                        onChange={(e) =>
                          updateMixDefaults({ midMode: e.target.value as EqBandMixMode })
                        }
                        className="w-full bg-om-base border border-white/[0.08] rounded px-1.5 py-1 text-[11px] text-om-text"
                      >
                        <option value="none">Flat</option>
                        <option value="crossfade">Crossfade</option>
                      </select>
                    </label>
                    <label className="space-y-1">
                      <span className="block text-[10px] text-om-text-subtle">High EQ</span>
                      <select
                        value={mixDefaults.highMode}
                        onChange={(e) =>
                          updateMixDefaults({ highMode: e.target.value as EqBandMixMode })
                        }
                        className="w-full bg-om-base border border-white/[0.08] rounded px-1.5 py-1 text-[11px] text-om-text"
                      >
                        <option value="none">Flat</option>
                        <option value="crossfade">Crossfade</option>
                      </select>
                    </label>
                    <label className="space-y-1">
                      <span className="block text-[10px] text-om-text-subtle">Filter</span>
                      <select
                        value={mixDefaults.filterMode}
                        onChange={(e) =>
                          updateMixDefaults({ filterMode: e.target.value as FilterMixMode })
                        }
                        className="w-full bg-om-base border border-white/[0.08] rounded px-1.5 py-1 text-[11px] text-om-text"
                      >
                        <option value="none">Off</option>
                        <option value="dual">Dual Sweep</option>
                        <option value="lpf-in">LPF In</option>
                        <option value="hpf-out">HPF Out</option>
                      </select>
                    </label>
                  </div>

                    </div>
                  </div>
                </div>

                <div className="px-5 py-3 border-t border-white/[0.08] flex justify-end shrink-0">
                  <button
                    type="button"
                    onClick={() => setShowMixDefaultsModal(false)}
                    className="px-3.5 py-1.5 rounded bg-om-control-alt hover:bg-om-control-hover text-xs font-medium text-om-text cursor-pointer"
                  >
                    Done
                  </button>
                </div>
              </div>
            </div>
          )}


          <label className="flex items-center gap-1.5 text-xs text-om-text-muted">
            <span>Snap</span>
            <select
              value={project.snapMode}
              onChange={(e) => onUpdateProject({ snapMode: e.target.value as SnapMode })}
              className="bg-om-base border border-white/[0.08] rounded px-2 py-1 text-xs text-om-text"
            >
              <option value="bar">Bar</option>
              <option value="half-beat">1/2 Beat</option>
              <option value="quarter-beat">1/4 Beat</option>
              <option value="off">Off</option>
            </select>
          </label>

          <button
            type="button"
            onClick={() => onSplitAtPlayhead(selectedClipRef?.clipId ?? null)}
            title="Split clip(s) at playhead"
            className="h-8 px-2.5 rounded-md bg-om-control hover:bg-om-control-hover border border-white/[0.08] text-xs font-medium text-om-text inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Scissors className="w-3.5 h-3.5" />
            Split
          </button>

          <div className="flex items-center gap-1 bg-om-base border border-white/[0.08] rounded-md px-1.5 py-0.5">
            <button
              type="button"
              onClick={() => handleStepZoom('out')}
              disabled={project.zoomPxPerSec <= MIN_ZOOM_PX_PER_SEC}
              className="p-1 text-om-text-dim hover:text-white disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
              title="Zoom Out (Ctrl+Scroll)"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="text-[11px] font-mono tabular-nums text-om-text-dim w-11 text-center">
              {project.zoomPxPerSec < 10
                ? `${Number(project.zoomPxPerSec.toFixed(2))}px`
                : `${Math.round(project.zoomPxPerSec)}px`}
            </span>
            <button
              type="button"
              onClick={() => handleStepZoom('in')}
              disabled={project.zoomPxPerSec >= MAX_ZOOM_PX_PER_SEC}
              className="p-1 text-om-text-dim hover:text-white disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
              title="Zoom In (Ctrl+Scroll)"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleFitTimeline}
              className="ml-0.5 px-1.5 py-0.5 rounded bg-om-control hover:bg-om-control-hover text-[10px] font-medium text-om-text-secondary hover:text-white cursor-pointer"
              title="Fit entire mix in timeline view"
            >
              Fit
            </button>
          </div>

          <button
            type="button"
            onClick={onAddTrack}
            className="h-8 px-3 rounded-md bg-om-control-alt hover:bg-om-control-hover border border-white/[0.08] text-xs font-medium text-om-text inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Track
          </button>
        </div>
      </div>

      {/* Main Scrollable Timeline Area + Right-Hand Master Meter & Volume */}
      <div className="flex-1 min-h-0 flex flex-row overflow-hidden">
        <div ref={scrollContainerRef} className="flex-1 min-w-0 overflow-auto relative">
        <div
          style={{ minWidth: TRACK_HEADER_WIDTH + timelineWidthPx }}
          className="flex flex-col min-h-full"
        >
          {/* Sticky Ruler Row */}
          <div className="sticky top-0 z-30 flex bg-om-panel border-b border-white/[0.08]">
            <div
              style={{ width: TRACK_HEADER_WIDTH }}
              className="shrink-0 px-3 py-2 border-r border-white/[0.08] text-[11px] font-mono text-om-text-dim flex items-center justify-between bg-om-panel sticky left-0 z-30"
            >
              <span>TRACKS ({project.tracks.length})</span>
              <span className="text-om-secondary">
                {livePlayheadBpm.toFixed(1)} BPM{sortedTempoPoints.length > 0 ? ' VAR' : ''}
              </span>
            </div>

            <div
              onPointerDown={handleRulerPointerDown}
              style={{ width: timelineWidthPx }}
              className="relative h-10 bg-om-well cursor-pointer"
            >
              {/* Top Interactive Loop Strip (drag anywhere to draw a loop region; Alt = free snap) */}
              <div
                onPointerDown={handleLoopStripPointerDown}
                title="Drag to set loop range (hold Alt to disable snap)"
                className="absolute top-0 left-0 right-0 h-3.5 bg-om-deepest/80 border-b border-white/[0.06] cursor-crosshair z-10"
              >
                {project.loopEndSec > project.loopStartSec + MIN_LOOP_SEC && (() => {
                  const loopLeftPx = project.loopStartSec * project.zoomPxPerSec;
                  const loopWidthPx = Math.max(
                    6,
                    (project.loopEndSec - project.loopStartSec) * project.zoomPxPerSec
                  );
                  const active = project.loopEnabled;
                  return (
                    <div
                      onPointerDown={(e) => startLoopBarDrag(e, 'move')}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        onUpdateProject({ loopEnabled: !project.loopEnabled });
                      }}
                      style={{ left: loopLeftPx, width: loopWidthPx }}
                      title={
                        active
                          ? 'Drag to slide loop · Drag edges to resize · Double-click to disable'
                          : 'Loop disabled · Drag to move/enable · Double-click to enable'
                      }
                      className={`group absolute top-0 bottom-0 cursor-grab active:cursor-grabbing transition-colors ${
                        active
                          ? 'bg-om-secondary/45 hover:bg-om-secondary/60 border-y border-om-secondary-bright/80'
                          : 'bg-om-text-faint/30 hover:bg-om-secondary/30 border-y border-white/20'
                      }`}
                    >
                      {/* Left (In) Loop Bracket Handle */}
                      <div
                        onPointerDown={(e) => startLoopBarDrag(e, 'start')}
                        title="Drag Loop In point (Alt = free snap)"
                        className="absolute -left-1.5 top-0 bottom-0 w-3 flex items-center justify-center cursor-ew-resize z-20"
                      >
                        <div
                          className={`w-1.5 h-full rounded-l-sm ${
                            active ? 'bg-om-secondary-bright' : 'bg-om-text-muted'
                          }`}
                        />
                      </div>

                      {/* Right (Out) Loop Bracket Handle */}
                      <div
                        onPointerDown={(e) => startLoopBarDrag(e, 'end')}
                        title="Drag Loop Out point (Alt = free snap)"
                        className="absolute -right-1.5 top-0 bottom-0 w-3 flex items-center justify-center cursor-ew-resize z-20"
                      >
                        <div
                          className={`w-1.5 h-full rounded-r-sm ${
                            active ? 'bg-om-secondary-bright' : 'bg-om-text-muted'
                          }`}
                        />
                      </div>

                      {/* Live Drag Readout Badge */}
                      {loopDragInfo && (
                        <div className="absolute left-1/2 -translate-x-1/2 top-4 px-1.5 py-0.5 rounded bg-om-base/95 border border-om-secondary/60 text-[10px] font-mono tabular-nums text-om-secondary-bright whitespace-nowrap pointer-events-none shadow-lg z-30">
                          {formatTimecode(loopDragInfo.startSec, true)} →{' '}
                          {formatTimecode(loopDragInfo.endSec, true)} (
                          {Number(loopDurationBars.toFixed(1))} bars)
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* Variable-Tempo Bar Ticks */}
              {barTicks.map((bar) => {
                if (bar.barIndex % rulerLabelStep !== 0) return null;
                const barLeft = bar.timeSec * project.zoomPxPerSec;
                return (
                  <div
                    key={bar.barIndex}
                    style={{ left: barLeft }}
                    className="absolute top-3.5 bottom-0 border-l border-white/[0.12] pl-1.5 pt-1 text-[10px] font-mono tabular-nums text-om-text-subtle pointer-events-none whitespace-nowrap"
                  >
                    {bar.barIndex + 1}
                  </div>
                );
              })}

              {/* Playhead Cap */}
              <div
                style={{ left: project.playheadSec * project.zoomPxPerSec - 5 }}
                className="absolute top-3.5 w-0 h-0 border-l-[5px] border-r-[5px] border-t-[8px] border-l-transparent border-r-transparent border-t-om-accent pointer-events-none z-20"
              />
            </div>
          </div>

          {/* Master Tempo (BPM) Automation Lane */}
          {project.showTempoLane && (
            <div className="flex h-[92px] bg-om-base border-b border-om-secondary/30 relative">
              {/* Sticky Tempo Header */}
              <div
                style={{ width: TRACK_HEADER_WIDTH }}
                className="shrink-0 bg-om-sub border-r border-white/[0.08] p-2.5 flex flex-col justify-between sticky left-0 z-20"
              >
                <div className="flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1.5">
                    <TrendingUp className="w-3.5 h-3.5 text-om-secondary" />
                    <span className="text-[11px] font-semibold tracking-wide text-om-text">
                      MASTER TEMPO
                    </span>
                  </div>
                  <span className="text-[11px] font-mono tabular-nums text-om-secondary font-semibold">
                    {livePlayheadBpm.toFixed(1)} BPM
                  </span>
                </div>

                <div className="flex items-center justify-between gap-1.5">
                  <select
                    value={
                      sortedTempoPoints.find((p) => p.id === selectedTempoPointId)?.curve ??
                      tempoCurveType
                    }
                    onChange={(e) => {
                      const nextCurve = e.target.value as AutomationCurveType;
                      setTempoCurveType(nextCurve);
                      if (selectedTempoPointId) {
                        const updated = sortedTempoPoints.map((p) =>
                          p.id === selectedTempoPointId ? { ...p, curve: nextCurve } : p
                        );
                        onUpdateProject({ tempoPoints: updated });
                        onCommitTempoChange?.();
                      }
                    }}
                    className="bg-om-base border border-white/[0.08] rounded px-1.5 py-0.5 text-[10px] text-om-text-secondary flex-1"
                    title="Tempo Segment Curve Shape"
                  >
                    <option value="linear">Ramp: Linear</option>
                    <option value="smooth">Ramp: Smooth</option>
                    <option value="step">Ramp: Step</option>
                  </select>

                  <button
                    type="button"
                    onClick={() => {
                      const t = Math.max(0, project.playheadSec);
                      const bpm = Math.round(evaluateBpmAt(project, t) * 2) / 2;
                      const nextPts = [...sortedTempoPoints];
                      if (nextPts.length === 0 && t > 0.05) {
                        nextPts.push({
                          id: `tempo_anchor_${Date.now()}`,
                          timeSec: 0,
                          bpm: clampBpm(project.masterBpm),
                          curve: tempoCurveType,
                        });
                      }
                      const newPt: TempoPoint = {
                        id: `tempo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                        timeSec: t,
                        bpm,
                        curve: tempoCurveType,
                      };
                      nextPts.push(newPt);
                      nextPts.sort((a, b) => a.timeSec - b.timeSec);
                      setSelectedTempoPointId(newPt.id);
                      onUpdateProject({ tempoPoints: nextPts });
                      onCommitTempoChange?.();
                    }}
                    className="px-1.5 py-0.5 rounded bg-om-control hover:bg-om-control-hover text-[10px] text-om-secondary font-medium cursor-pointer whitespace-nowrap"
                    title="Add Tempo Node at Playhead"
                  >
                    + Node
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setSelectedTempoPointId(null);
                      onUpdateProject({ tempoPoints: [] });
                      onCommitTempoChange?.();
                    }}
                    disabled={sortedTempoPoints.length === 0}
                    className="px-1.5 py-0.5 rounded bg-om-control text-[10px] text-om-text-dim hover:text-om-danger disabled:opacity-40 cursor-pointer"
                    title="Clear all tempo nodes (revert to constant Project BPM)"
                  >
                    Reset
                  </button>
                </div>

                <div className="flex items-center justify-between gap-1.5">
                  <span
                    className="text-[10px] font-mono tabular-nums text-om-text-subtle truncate"
                    title={
                      tempoTrackSummary.distinctChain.length > 0
                        ? `${tempoTrackSummary.distinctChain.map((b) => `${b} BPM`).join(' → ')} · Click curve to add, 2x click node to delete`
                        : 'Click curve to add · 2x click node to delete'
                    }
                  >
                    {tempoTrackSummary.distinctChain.length > 1
                      ? `${tempoTrackSummary.distinctChain.slice(0, 4).join(' → ')}${
                          tempoTrackSummary.distinctChain.length > 4 ? ' …' : ''
                        } BPM`
                      : `${tempoTrackSummary.distinctChain[0] ?? project.masterBpm} BPM Const`}
                  </span>

                  {tempoTrackSummary.hasTrackBpmChanges ? (
                    <button
                      type="button"
                      onClick={() => {
                        const nextPoints = buildTempoPointsFromEntries(timelineTempoEntries);
                        if (nextPoints.length > 0) {
                          onUpdateProject({
                            masterBpm: nextPoints[0].bpm,
                            tempoPoints: nextPoints,
                          });
                          onCommitTempoChange?.();
                        }
                      }}
                      title="Tempo map auto-syncs across track transitions; click to re-sync after manual tempo edits"
                      className="px-1.5 py-0.5 rounded bg-om-control hover:bg-om-control-hover border border-om-secondary/30 text-[9px] font-medium text-om-secondary whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {sortedTempoPoints.length > 0 ? 'Auto-Sync' : 'Sync Map'}
                    </button>
                  ) : (
                    <span className="text-[9.5px] text-om-text-faint whitespace-nowrap shrink-0">
                      Click · 2x del
                    </span>
                  )}
                </div>
              </div>

              {/* Interactive Tempo Curve SVG Surface */}
              <div
                style={{ width: timelineWidthPx }}
                onClick={(e) => {
                  const tag = (e.target as HTMLElement).tagName.toLowerCase();
                  if (tag === 'circle') return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const x = Math.max(0, e.clientX - rect.left);
                  const y = Math.max(0, Math.min(TEMPO_LANE_HEIGHT, e.clientY - rect.top));
                  const rawSec = x / project.zoomPxPerSec;
                  const timeSec = e.altKey
                    ? rawSec
                    : snapSecondsWithTempoMap(project, rawSec, project.snapMode);
                  const bpm = laneYToBpm(y);

                  const nextPts = [...sortedTempoPoints];
                  if (nextPts.length === 0 && timeSec > 0.05) {
                    nextPts.push({
                      id: `tempo_anchor_${Date.now()}`,
                      timeSec: 0,
                      bpm: clampBpm(project.masterBpm),
                      curve: tempoCurveType,
                    });
                  }
                  const newPt: TempoPoint = {
                    id: `tempo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                    timeSec,
                    bpm,
                    curve: tempoCurveType,
                  };
                  nextPts.push(newPt);
                  nextPts.sort((a, b) => a.timeSec - b.timeSec);
                  setSelectedTempoPointId(newPt.id);
                  onUpdateProject({ tempoPoints: nextPts });
                  onCommitTempoChange?.();
                }}
                className="relative flex-1 cursor-crosshair"
              >
                <svg width={timelineWidthPx} height={TEMPO_LANE_HEIGHT} className="block">
                  {/* Vertical Bar Gridlines */}
                  <path
                    d={barGridSvgPath}
                    stroke="rgba(255,255,255,0.06)"
                    strokeWidth={1}
                    fill="none"
                  />

                  {/* Horizontal BPM Guide Lines */}
                  {[60, 90, 120, 150, 180].map((refBpm) => {
                    const gy = bpmToLaneY(refBpm);
                    return (
                      <g key={refBpm}>
                        <line
                          x1={0}
                          y1={gy}
                          x2={timelineWidthPx}
                          y2={gy}
                          stroke="rgba(255,255,255,0.06)"
                          strokeDasharray="3 3"
                        />
                        <text
                          x={6}
                          y={gy - 2}
                          fill="rgba(148,163,184,0.45)"
                          fontSize={9}
                          fontFamily="monospace"
                        >
                          {refBpm}
                        </text>
                      </g>
                    );
                  })}

                  {/* Shaded Track Transition Windows Between Consecutive Tracks */}
                  {timelineTempoEntries.map((entry, idx) => {
                    if (idx === 0) return null;
                    const fromSec = entry.transitionFromSec ?? entry.timeSec;
                    const toSec = entry.transitionToSec ?? entry.timeSec;
                    const xFrom = fromSec * project.zoomPxPerSec;
                    const xTo = toSec * project.zoomPxPerSec;
                    const spanPx = xTo - xFrom;
                    if (spanPx < 1) return null;

                    const prevLabel =
                      entry.prevBpm !== undefined
                        ? Number.isInteger(entry.prevBpm)
                          ? entry.prevBpm.toFixed(0)
                          : entry.prevBpm.toFixed(1)
                        : null;
                    const nextLabel = Number.isInteger(entry.bpm)
                      ? entry.bpm.toFixed(0)
                      : entry.bpm.toFixed(1);

                    return (
                      <g key={`span_${entry.id}`} className="pointer-events-none">
                        <rect
                          x={xFrom}
                          y={0}
                          width={spanPx}
                          height={TEMPO_LANE_HEIGHT}
                          fill={theme.canvas.accentFillRgba}
                        />
                        <line
                          x1={xFrom}
                          y1={0}
                          x2={xFrom}
                          y2={TEMPO_LANE_HEIGHT}
                          stroke={theme.canvas.accentLineRgba}
                          strokeOpacity={0.5}
                          strokeWidth={1}
                          strokeDasharray="3 2"
                        />
                        <line
                          x1={xTo}
                          y1={0}
                          x2={xTo}
                          y2={TEMPO_LANE_HEIGHT}
                          stroke={theme.canvas.positiveLineRgba}
                          strokeWidth={1}
                          strokeDasharray="3 2"
                        />
                        {spanPx >= 56 && prevLabel && (
                          <text
                            x={xFrom + spanPx / 2}
                            y={TEMPO_LANE_HEIGHT - 5}
                            textAnchor="middle"
                            fill={theme.canvas.accentBright}
                            fontSize={9}
                            fontFamily="monospace"
                            className="select-none"
                          >
                            {prevLabel}→{nextLabel}
                          </text>
                        )}
                      </g>
                    );
                  })}

                  {/* Constant Master BPM Reference Line when no tempo points exist */}
                  {sortedTempoPoints.length === 0 && (
                    <line
                      x1={0}
                      y1={bpmToLaneY(project.masterBpm)}
                      x2={timelineWidthPx}
                      y2={bpmToLaneY(project.masterBpm)}
                      stroke={theme.canvas.secondary}
                      strokeWidth={1.75}
                      strokeDasharray="5 4"
                      opacity={0.75}
                    />
                  )}

                  {/* Variable Tempo Curve Polyline + Subtle Area Fill */}
                  {sortedTempoPoints.length > 0 &&
                    (() => {
                      const coords: string[] = [];
                      const firstY = bpmToLaneY(sortedTempoPoints[0].bpm);
                      coords.push(`0,${firstY}`);

                      for (let i = 0; i < sortedTempoPoints.length; i++) {
                        const p = sortedTempoPoints[i];
                        if (i > 0 && sortedTempoPoints[i - 1].curve === 'smooth') {
                          const prev = sortedTempoPoints[i - 1];
                          const steps = 16;
                          for (let s = 1; s <= steps; s++) {
                            const t =
                              prev.timeSec + ((p.timeSec - prev.timeSec) * s) / steps;
                            const b = evaluateBpmAt(project, t);
                            coords.push(`${t * project.zoomPxPerSec},${bpmToLaneY(b)}`);
                          }
                        } else if (i > 0 && sortedTempoPoints[i - 1].curve === 'step') {
                          coords.push(
                            `${p.timeSec * project.zoomPxPerSec},${bpmToLaneY(sortedTempoPoints[i - 1].bpm)}`
                          );
                          coords.push(
                            `${p.timeSec * project.zoomPxPerSec},${bpmToLaneY(p.bpm)}`
                          );
                        } else {
                          coords.push(
                            `${p.timeSec * project.zoomPxPerSec},${bpmToLaneY(p.bpm)}`
                          );
                        }
                      }

                      const lastY = bpmToLaneY(
                        sortedTempoPoints[sortedTempoPoints.length - 1].bpm
                      );
                      coords.push(`${timelineWidthPx},${lastY}`);
                      const polyStr = coords.join(' ');
                      const fillStr = `0,${TEMPO_LANE_HEIGHT} ${polyStr} ${timelineWidthPx},${TEMPO_LANE_HEIGHT}`;

                      return (
                        <>
                          <polygon points={fillStr} fill={theme.canvas.secondaryFillSoftRgba} />
                          <polyline
                            fill="none"
                            stroke={theme.canvas.secondary}
                            strokeWidth={2}
                            points={polyStr}
                          />
                        </>
                      );
                    })()}

                  {/* Tempo Breakpoint Nodes */}
                  {sortedTempoPoints.map((pt) => {
                    const cx = pt.timeSec * project.zoomPxPerSec;
                    const cy = bpmToLaneY(pt.bpm);
                    const isSelected =
                      selectedTempoPointId === pt.id || draggingTempoPointId === pt.id;
                    return (
                      <g key={pt.id}>
                        <circle
                          cx={cx}
                          cy={cy}
                          r={isSelected ? 6 : 5}
                          fill={theme.canvas.bgBase}
                          stroke={isSelected ? theme.canvas.accent : theme.canvas.secondary}
                          strokeWidth={2.2}
                          className="cursor-grab active:cursor-grabbing"
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            const filtered = sortedTempoPoints.filter((p) => p.id !== pt.id);
                            if (selectedTempoPointId === pt.id) setSelectedTempoPointId(null);
                            onUpdateProject({ tempoPoints: filtered });
                            onCommitTempoChange?.();
                          }}
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            setSelectedTempoPointId(pt.id);
                            setDraggingTempoPointId(pt.id);
                            const svgRect = (
                              e.currentTarget.ownerSVGElement as SVGSVGElement
                            ).getBoundingClientRect();

                            const onMove = (ev: PointerEvent) => {
                              const x = Math.max(0, ev.clientX - svgRect.left);
                              const y = Math.max(
                                0,
                                Math.min(TEMPO_LANE_HEIGHT, ev.clientY - svgRect.top)
                              );
                              const rawSec = Math.max(0, x / project.zoomPxPerSec);
                              const timeSec = ev.altKey
                                ? rawSec
                                : snapSecondsWithTempoMap(project, rawSec, project.snapMode);
                              const bpm = laneYToBpm(y);
                              const nextPts = sortedTempoPoints
                                .map((p) =>
                                  p.id === pt.id ? { ...p, timeSec, bpm } : p
                                )
                                .sort((a, b) => a.timeSec - b.timeSec);
                              onUpdateProject({ tempoPoints: nextPts });
                            };

                            const onUp = () => {
                              setDraggingTempoPointId(null);
                              window.removeEventListener('pointermove', onMove);
                              window.removeEventListener('pointerup', onUp);
                              onCommitTempoChange?.();
                            };

                            window.addEventListener('pointermove', onMove);
                            window.addEventListener('pointerup', onUp);
                          }}
                        />
                        <text
                          x={cx + 8}
                          y={Math.max(12, cy - 5)}
                          fill={isSelected ? theme.canvas.accent : theme.canvas.textMuted}
                          fontSize={10}
                          fontFamily="monospace"
                          className="pointer-events-none select-none"
                        >
                          {pt.bpm.toFixed(1)}
                        </text>
                      </g>
                    );
                  })}

                  {/* Playhead Cursor in Tempo Lane */}
                  <line
                    x1={project.playheadSec * project.zoomPxPerSec}
                    y1={0}
                    x2={project.playheadSec * project.zoomPxPerSec}
                    y2={TEMPO_LANE_HEIGHT}
                    stroke={theme.canvas.accent}
                    strokeWidth={1.5}
                    className="pointer-events-none"
                  />
                </svg>
              </div>
            </div>
          )}

          {/* Track Lanes */}
          <div className="relative flex-1">
            {/* Active Loop Region Highlight & Vertical Guides across Track Lanes */}
            {(project.loopEnabled || loopDragInfo) &&
              project.loopEndSec > project.loopStartSec + MIN_LOOP_SEC && (
                <div
                  style={{
                    left: TRACK_HEADER_WIDTH + project.loopStartSec * project.zoomPxPerSec,
                    width:
                      (project.loopEndSec - project.loopStartSec) * project.zoomPxPerSec,
                  }}
                  className="absolute top-0 bottom-0 bg-om-secondary/[0.05] border-x border-om-secondary/45 z-[5] pointer-events-none"
                />
              )}

            {/* Global Playhead Line */}
            <div
              style={{ left: TRACK_HEADER_WIDTH + project.playheadSec * project.zoomPxPerSec }}
              className="absolute top-0 bottom-0 w-[1.5px] bg-om-accent z-10 pointer-events-none"
            />

            {project.tracks.map((track, trackIdx) => {
              const isDropTarget = dragOverTrackId === track.id;
              const isFxOpen = activeFxTrackId === track.id;
              const trackAccent = resolveTrackAccentColor(track.accentColor, trackIdx, themeId);
              const autoParamMeta =
                automationParams.find((p) => p.id === track.activeAutomationParam) ??
                automationParams[0];
              const autoLane = track.automationLanes[track.activeAutomationParam];

              return (
                <div key={track.id} className="border-b border-white/[0.08]">
                  {/* Primary Track Row */}
                  <div className="flex min-h-[96px]">
                    {/* Sticky Track Header */}
                    <div
                      style={{ width: TRACK_HEADER_WIDTH }}
                      className="shrink-0 bg-om-panel border-r border-white/[0.08] px-2.5 py-2 flex flex-col justify-center gap-2.5 sticky left-0 z-20 overflow-hidden"
                    >
                      <div className="flex items-center justify-between gap-1.5 min-w-0">
                        <div className="flex items-center gap-1.5 flex-1 min-w-0">
                          <span
                            className="w-2 h-2 rounded-sm shrink-0"
                            style={{ backgroundColor: trackAccent }}
                          />
                          <input
                            type="text"
                            value={track.name}
                            onChange={(e) =>
                              onUpdateTrack(track.id, { name: e.target.value })
                            }
                            className="bg-transparent text-xs font-semibold text-om-text truncate flex-1 min-w-0 w-full focus:outline-none focus:bg-om-base rounded px-1"
                          />
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => onUpdateTrack(track.id, { muted: !track.muted })}
                            className={`w-6 h-6 rounded text-[10px] font-mono font-bold cursor-pointer ${
                              track.muted
                                ? 'bg-om-danger text-white'
                                : 'bg-om-control-alt text-om-text-dim hover:text-white'
                            }`}
                            title="Mute Track"
                          >
                            M
                          </button>
                          <button
                            type="button"
                            onClick={() => onUpdateTrack(track.id, { soloed: !track.soloed })}
                            className={`w-6 h-6 rounded text-[10px] font-mono font-bold cursor-pointer ${
                              track.soloed
                                ? 'bg-om-accent text-om-accent-ink'
                                : 'bg-om-control-alt text-om-text-dim hover:text-white'
                            }`}
                            title="Solo Track"
                          >
                            S
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setActiveFxTrackId(isFxOpen ? null : track.id)
                            }
                            className={`px-1.5 h-6 rounded text-[10px] font-mono font-medium inline-flex items-center gap-0.5 cursor-pointer ${
                              isFxOpen
                                ? 'bg-om-secondary text-om-accent-ink font-semibold'
                                : 'bg-om-control-alt text-om-text-dim hover:text-white'
                            }`}
                            title="Track Real-Time Effects Rack"
                          >
                            <Sliders className="w-3 h-3" />
                            FX
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              onUpdateTrack(track.id, {
                                showAutomation: !track.showAutomation,
                              })
                            }
                            className={`px-1.5 h-6 rounded text-[10px] font-mono font-medium inline-flex items-center gap-0.5 cursor-pointer ${
                              track.showAutomation
                                ? 'bg-om-positive text-om-accent-ink font-semibold'
                                : 'bg-om-control-alt text-om-text-dim hover:text-white'
                            }`}
                            title="Toggle Segment Automation Curves"
                          >
                            <Activity className="w-3 h-3" />
                          </button>
                        </div>
                      </div>

                      {/* Volume + Pan + Remove (min-w-0 allows range input to shrink inside fixed header width) */}
                      <div className="flex items-center gap-1.5 min-w-0 w-full">
                        <div className="flex items-center gap-1 flex-1 min-w-0">
                          <span className="text-[10px] font-mono text-om-text-faint shrink-0">VOL</span>
                          <input
                            type="range"
                            min={0}
                            max={1.25}
                            step={0.01}
                            value={track.volume}
                            onChange={(e) =>
                              onUpdateTrack(track.id, { volume: parseFloat(e.target.value) })
                            }
                            className="studio-slider flex-1 min-w-0 w-full"
                          />
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <span className="text-[10px] font-mono text-om-text-faint shrink-0">PAN</span>
                          <input
                            type="range"
                            min={-1}
                            max={1}
                            step={0.05}
                            value={track.pan}
                            onDoubleClick={() => onUpdateTrack(track.id, { pan: 0 })}
                            onChange={(e) =>
                              onUpdateTrack(track.id, { pan: parseFloat(e.target.value) })
                            }
                            className="studio-slider w-10 shrink-0"
                          />
                        </div>
                        {project.tracks.length > 1 && (
                          <button
                            type="button"
                            onClick={() => onRemoveTrack(track.id)}
                            className="p-0.5 text-om-text-icon hover:text-om-danger shrink-0 cursor-pointer transition-colors"
                            title="Delete Track"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Track Clip Lane Canvas */}
                    <div
                      ref={(el) => {
                        if (el) {
                          trackLaneRefs.current.set(track.id, el);
                        } else {
                          trackLaneRefs.current.delete(track.id);
                        }
                      }}
                      style={{ width: timelineWidthPx }}
                      onDragOver={(e) => {
                        if (e.dataTransfer.types.includes('application/x-obsidian-track')) {
                          e.preventDefault();
                          setDragOverTrackId(track.id);
                        }
                      }}
                      onDragLeave={() => {
                        if (dragOverTrackId === track.id) setDragOverTrackId(null);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragOverTrackId(null);
                        const assetId = e.dataTransfer.getData('application/x-obsidian-track');
                        if (!assetId) return;
                        const asset = assetsMap.get(assetId);
                        const rect = e.currentTarget.getBoundingClientRect();
                        const rawSec = Math.max(0, (e.clientX - rect.left) / project.zoomPxPerSec);
                        const snapped = e.altKey
                          ? rawSec
                          : snapClipStartToBeatGrid({
                              project,
                              rawStartSec: rawSec,
                              snapMode: project.snapMode,
                              offsetSec: 0,
                              durationSec: asset?.duration,
                              stretchToMasterBpm: true,
                              asset,
                              assetsMap,
                            });
                        onAddClipAt(track.id, assetId, snapped, {
                          bypassAutoMix: e.altKey,
                        });
                      }}
                      onClick={(e) => {
                        if (e.target === e.currentTarget) {
                          setSelectedClipRef(null);
                        }
                      }}
                      className={`relative z-0 flex-1 bg-om-base transition-colors ${
                        isDropTarget ? 'bg-om-panel-alt ring-1 ring-inset ring-om-accent/50' : ''
                      }`}
                    >
                      {/* Variable-Tempo Beat Grid Vertical Lines */}
                      <svg
                        width={timelineWidthPx}
                        height="100%"
                        preserveAspectRatio="none"
                        className="absolute inset-0 pointer-events-none opacity-30"
                      >
                        <path
                          d={barGridSvgPath}
                          stroke="rgba(255,255,255,0.08)"
                          strokeWidth={1}
                          fill="none"
                        />
                      </svg>

                      {track.clips.length === 0 && (
                        <div className="absolute inset-0 flex items-center pl-6 pointer-events-none">
                          <span className="text-xs text-om-text-icon">
                            Drag tracks from Crate onto this lane to arrange
                          </span>
                        </div>
                      )}

                      {/* Audio Clips */}
                      {track.clips.map((clip) => {
                        const asset = assetsMap.get(clip.trackAssetId);
                        const clipLeft = clip.startSec * project.zoomPxPerSec;
                        const clipWidth = Math.max(8, clip.durationSec * project.zoomPxPerSec);
                        const isSelected = selectedClipRef?.clipId === clip.id;
                        const clipBpmRange = getBpmRangeForClip(
                          project,
                          clip.startSec,
                          clip.durationSec
                        );
                        const volInCfg = getConfiguredClipVolumeFade(clip, 'in');
                        const volOutCfg = getConfiguredClipVolumeFade(clip, 'out');
                        const fadeInStartSec = volInCfg.offsetSec;
                        const fadeOutEndSec = volOutCfg.offsetSec;
                        const fadeInStartW = Math.min(
                          clipWidth * 0.9,
                          fadeInStartSec * project.zoomPxPerSec
                        );
                        const fadeInW = Math.min(
                          Math.max(0, clipWidth - fadeInStartW),
                          volInCfg.durationSec * project.zoomPxPerSec
                        );
                        const fadeInEndX = fadeInStartW + fadeInW;

                        const fadeOutEndW = Math.min(
                          clipWidth * 0.9,
                          fadeOutEndSec * project.zoomPxPerSec
                        );
                        const fadeOutW = Math.min(
                          Math.max(0, clipWidth - fadeOutEndW - fadeInEndX),
                          volOutCfg.durationSec * project.zoomPxPerSec
                        );
                        const fadeOutEndX = Math.max(fadeInEndX, clipWidth - fadeOutEndW);
                        const fadeOutStartX = Math.max(fadeInEndX, fadeOutEndX - fadeOutW);

                        const bassInCfg = getConfiguredClipBassFade(clip, 'in');
                        const bassOutCfg = getConfiguredClipBassFade(clip, 'out');
                        const bassIn = getEffectiveClipBassFade(clip, 'in');
                        const bassOut = getEffectiveClipBassFade(clip, 'out');
                        const hasBassInConfigured =
                          bassInCfg.durationSec > 0.01 || bassInCfg.offsetSec > 0.01;
                        const hasBassOutConfigured =
                          bassOutCfg.durationSec > 0.01 || bassOutCfg.offsetSec > 0.01;
                        const bassInActive = bassInCfg.enabled && hasBassInConfigured;
                        const bassOutActive = bassOutCfg.enabled && hasBassOutConfigured;
                        const bassInStartW = Math.min(
                          clipWidth * 0.9,
                          bassInCfg.offsetSec * project.zoomPxPerSec
                        );
                        const bassInW = Math.min(
                          Math.max(0, clipWidth - bassInStartW),
                          bassInCfg.durationSec * project.zoomPxPerSec
                        );
                        const bassInEndX = bassInStartW + bassInW;

                        const bassOutEndW = Math.min(
                          clipWidth * 0.9,
                          bassOutCfg.offsetSec * project.zoomPxPerSec
                        );
                        const bassOutW = Math.min(
                          Math.max(0, clipWidth - bassOutEndW - bassInEndX),
                          bassOutCfg.durationSec * project.zoomPxPerSec
                        );
                        const bassOutEndX = Math.max(bassInEndX, clipWidth - bassOutEndW);
                        const bassOutStartX = Math.max(bassInEndX, bassOutEndX - bassOutW);
                        const mixInW = clip.mixIn
                          ? Math.min(clipWidth * 0.85, clip.mixIn.durationSec * project.zoomPxPerSec)
                          : 0;
                        const mixOutW = clip.mixOut
                          ? Math.min(clipWidth * 0.85, clip.mixOut.durationSec * project.zoomPxPerSec)
                          : 0;
                        const hasEqIn = hasActiveEqOrFilterTransition(clip.mixIn);
                        const hasEqOut = hasActiveEqOrFilterTransition(clip.mixOut);
                        const inBadges = formatMixSummaryBadges(clip.mixIn, {
                          bassEnabled: bassInCfg.enabled,
                        });
                        const outBadges = formatMixSummaryBadges(clip.mixOut, {
                          bassEnabled: bassOutCfg.enabled,
                        });

                        return (
                          <div
                            key={clip.id}
                            onPointerDown={(e) => {
                              if (e.button !== 0) return;
                              startClipDrag(e, track, clip, 'move');
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setSelectedClipRef({ trackId: track.id, clipId: clip.id });
                              openClipFloatingMenu(track.id, clip.id, e.clientX, e.clientY, false);
                            }}
                            style={{
                              left: clipLeft,
                              width: clipWidth,
                              borderColor: isSelected ? theme.canvas.accent : 'rgba(255,255,255,0.16)',
                            }}
                            className={`absolute top-1.5 bottom-1.5 rounded bg-om-elevated border overflow-clip cursor-grab active:cursor-grabbing group ${
                              isSelected ? 'ring-1 ring-om-accent' : ''
                            }`}
                          >
                            {/* Clip Header Bar */}
                            <div
                              className="h-5 px-2 flex items-center justify-between gap-2 text-[11px] font-medium text-om-accent-ink"
                              style={{ backgroundColor: trackAccent }}
                            >
                              <div
                                style={{
                                  left: TRACK_HEADER_WIDTH + 8,
                                  backgroundColor: trackAccent,
                                }}
                                className="sticky z-[1] min-w-0 flex items-center gap-1.5 pr-1"
                              >
                                <span className="min-w-0 truncate font-semibold">
                                  {asset?.name ?? 'Audio Clip'}
                                </span>
                                {clipWidth >= 72 && (() => {
                                  const isMenuOpen =
                                    !isDynamicMixViewActive &&
                                    clipMenuState?.trackId === track.id &&
                                    clipMenuState?.clipId === clip.id;
                                  const anyBassActive = bassInActive || bassOutActive;
                                  const anyBassConfigured =
                                    hasBassInConfigured || hasBassOutConfigured;
                                  return (
                                    <button
                                      type="button"
                                      onPointerDown={(e) => e.stopPropagation()}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setSelectedClipRef({ trackId: track.id, clipId: clip.id });
                                        const rect = e.currentTarget.getBoundingClientRect();
                                        openClipFloatingMenu(
                                          track.id,
                                          clip.id,
                                          rect.left,
                                          rect.bottom,
                                          true
                                        );
                                      }}
                                      title="Clip options (Gain, Fades, Stretch, Beat Grid & Mix Transition)"
                                      className={`inline-flex items-center gap-1 px-1 h-3.5 rounded font-mono text-[9px] font-bold transition-colors cursor-pointer shrink-0 ${
                                        isMenuOpen || anyBassActive
                                          ? 'bg-om-base text-om-secondary-bright ring-1 ring-om-secondary-bright/70'
                                          : anyBassConfigured
                                            ? 'bg-om-base/35 text-om-accent-ink/80 hover:bg-om-base hover:text-white'
                                            : 'bg-om-base/15 text-om-accent-ink/70 opacity-0 group-hover:opacity-100 hover:bg-om-base hover:text-om-secondary-bright'
                                      }`}
                                    >
                                      <Sliders className="w-2.5 h-2.5 shrink-0" />
                                      <span className="flex items-center gap-0.5">
                                        <span
                                          className={`w-1 h-1 rounded-full ${
                                            bassInActive
                                              ? 'bg-om-secondary-bright'
                                              : hasBassInConfigured
                                                ? 'bg-current opacity-40'
                                                : 'bg-current opacity-20'
                                          }`}
                                        />
                                        <span
                                          className={`w-1 h-1 rounded-full ${
                                            bassOutActive
                                              ? 'bg-om-secondary-bright'
                                              : hasBassOutConfigured
                                                ? 'bg-current opacity-40'
                                                : 'bg-current opacity-20'
                                          }`}
                                        />
                                      </span>
                                      <ChevronDown className="w-2.5 h-2.5 shrink-0" />
                                    </button>
                                  );
                                })()}
                              </div>
                              {clipWidth >= 130 && (
                                <div className="flex items-center gap-1.5 shrink-0">
                                  {inBadges.length > 0 ? (
                                    <span className="px-1 rounded bg-om-base/20 font-mono text-[9px] font-bold">
                                      IN:{inBadges.slice(0, 2).join(' ')}
                                    </span>
                                  ) : bassIn.durationSec > 0.05 ? (
                                    <span className="px-1 rounded bg-om-base/20 font-mono text-[9px] font-bold">
                                      BASS IN:{bassIn.durationSec.toFixed(1)}s
                                    </span>
                                  ) : null}
                                  {outBadges.length > 0 ? (
                                    <span className="px-1 rounded bg-om-base/20 font-mono text-[9px] font-bold">
                                      OUT:{outBadges.slice(0, 2).join(' ')}
                                    </span>
                                  ) : bassOut.durationSec > 0.05 ? (
                                    <span className="px-1 rounded bg-om-base/20 font-mono text-[9px] font-bold">
                                      BASS OUT:{bassOut.durationSec.toFixed(1)}s
                                    </span>
                                  ) : null}
                                  {clip.stretchToMasterBpm && asset && (
                                    <span className="font-mono text-[9px] opacity-80">
                                      {clipBpmRange.isVariable
                                        ? `SYNC ${Math.round(clipBpmRange.minBpm)}→${Math.round(clipBpmRange.maxBpm)}`
                                        : `SYNC ${Math.round(clipBpmRange.minBpm)}`}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>

                            {/* Waveform & Fade/Transition Overlays */}
                            <div className="relative h-[calc(100%-20px)] bg-om-well">
                              <ClipWaveformCanvas
                                asset={asset}
                                clipStartSec={clip.startSec}
                                offsetSec={clip.offsetSec}
                                durationSec={clip.durationSec}
                                stretchToMasterBpm={clip.stretchToMasterBpm}
                                masterBpm={project.masterBpm}
                                tempoPoints={project.tempoPoints}
                                showBeatMarkers={project.showBeatMarkers ?? true}
                                widthPx={clipWidth}
                                heightPx={62}
                                accentColor={trackAccent}
                              />

                              {/* Fade In / Out + EQ/Filter Transition Shading */}
                              <svg
                                width={clipWidth}
                                height={62}
                                className="absolute inset-0 pointer-events-none"
                                preserveAspectRatio="none"
                              >
                                {hasEqIn && mixInW > 2 && (
                                  <rect
                                    x={0}
                                    y={0}
                                    width={mixInW}
                                    height={62}
                                    fill={theme.canvas.positiveFillRgba}
                                  />
                                )}
                                {hasEqOut && mixOutW > 2 && (
                                  <rect
                                    x={clipWidth - mixOutW}
                                    y={0}
                                    width={mixOutW}
                                    height={62}
                                    fill={theme.canvas.secondaryFillSoftRgba}
                                  />
                                )}
                                {fadeInStartW > 1 && (
                                  <>
                                    {volInCfg.enabled && (
                                      <rect
                                        x={0}
                                        y={0}
                                        width={fadeInStartW}
                                        height={62}
                                        fill="rgba(11,13,16,0.72)"
                                      />
                                    )}
                                    <line
                                      x1={0}
                                      y1={61}
                                      x2={fadeInStartW}
                                      y2={61}
                                      stroke={volInCfg.enabled ? theme.canvas.accent : 'rgba(148, 163, 184, 0.35)'}
                                      strokeWidth={volInCfg.enabled ? 1.5 : 1.25}
                                      strokeDasharray={volInCfg.enabled ? undefined : '3 3'}
                                    />
                                    {fadeInW <= 1 && (
                                      <line
                                        x1={fadeInStartW}
                                        y1={0}
                                        x2={fadeInStartW}
                                        y2={62}
                                        stroke={volInCfg.enabled ? theme.canvas.accent : 'rgba(148, 163, 184, 0.35)'}
                                        strokeWidth={volInCfg.enabled ? 1.5 : 1.25}
                                        strokeDasharray={volInCfg.enabled ? undefined : '3 3'}
                                      />
                                    )}
                                  </>
                                )}
                                {fadeInW > 1 && (() => {
                                  const { linePath, shadePath } = buildFadeSvgPaths(
                                    'in',
                                    volInCfg.curve,
                                    fadeInStartW,
                                    fadeInW,
                                    62,
                                    volInCfg.curveTension
                                  );
                                  const isOn = volInCfg.enabled;
                                  return (
                                    <>
                                      {isOn && <path d={shadePath} fill="rgba(11,13,16,0.68)" />}
                                      <path
                                        d={linePath}
                                        fill="none"
                                        stroke={isOn ? theme.canvas.accent : 'rgba(148, 163, 184, 0.35)'}
                                        strokeWidth={isOn ? 1.5 : 1.25}
                                        strokeDasharray={isOn ? undefined : '3 3'}
                                      />
                                      {!isOn && fadeInW >= 46 && (
                                        <text
                                          x={fadeInStartW + 4}
                                          y={12}
                                          fill={theme.canvas.textMuted}
                                          fontSize={8.5}
                                          fontFamily="monospace"
                                          fontWeight={700}
                                          opacity={0.55}
                                        >
                                          VOL OFF
                                        </text>
                                      )}
                                    </>
                                  );
                                })()}
                                {fadeOutW > 1 && (() => {
                                  const { linePath, shadePath } = buildFadeSvgPaths(
                                    'out',
                                    volOutCfg.curve,
                                    fadeOutStartX,
                                    fadeOutEndX - fadeOutStartX,
                                    62,
                                    volOutCfg.curveTension
                                  );
                                  const isOn = volOutCfg.enabled;
                                  return (
                                    <>
                                      {isOn && <path d={shadePath} fill="rgba(11,13,16,0.68)" />}
                                      <path
                                        d={linePath}
                                        fill="none"
                                        stroke={isOn ? theme.canvas.accent : 'rgba(148, 163, 184, 0.35)'}
                                        strokeWidth={isOn ? 1.5 : 1.25}
                                        strokeDasharray={isOn ? undefined : '3 3'}
                                      />
                                      {!isOn && fadeOutW >= 48 && (
                                        <text
                                          x={fadeOutEndX - 4}
                                          y={12}
                                          textAnchor="end"
                                          fill={theme.canvas.textMuted}
                                          fontSize={8.5}
                                          fontFamily="monospace"
                                          fontWeight={700}
                                          opacity={0.55}
                                        >
                                          VOL OFF
                                        </text>
                                      )}
                                    </>
                                  );
                                })()}
                                {clipWidth - fadeOutEndX > 1 && (
                                  <>
                                    {volOutCfg.enabled && (
                                      <rect
                                        x={fadeOutEndX}
                                        y={0}
                                        width={clipWidth - fadeOutEndX}
                                        height={62}
                                        fill="rgba(11,13,16,0.72)"
                                      />
                                    )}
                                    <line
                                      x1={fadeOutEndX}
                                      y1={61}
                                      x2={clipWidth}
                                      y2={61}
                                      stroke={volOutCfg.enabled ? theme.canvas.accent : 'rgba(148, 163, 184, 0.35)'}
                                      strokeWidth={volOutCfg.enabled ? 1.5 : 1.25}
                                      strokeDasharray={volOutCfg.enabled ? undefined : '3 3'}
                                    />
                                    {fadeOutW <= 1 && (
                                      <line
                                        x1={fadeOutEndX}
                                        y1={0}
                                        x2={fadeOutEndX}
                                        y2={62}
                                        stroke={volOutCfg.enabled ? theme.canvas.accent : 'rgba(148, 163, 184, 0.35)'}
                                        strokeWidth={volOutCfg.enabled ? 1.5 : 1.25}
                                        strokeDasharray={volOutCfg.enabled ? undefined : '3 3'}
                                      />
                                    )}
                                  </>
                                )}
                                {bassInStartW > 1 && (
                                  <>
                                    {bassInCfg.enabled && (
                                      <rect
                                        x={0}
                                        y={3}
                                        width={bassInStartW}
                                        height={59}
                                        fill={theme.canvas.secondaryFillRgba}
                                      />
                                    )}
                                    <line
                                      x1={0}
                                      y1={59}
                                      x2={bassInStartW}
                                      y2={59}
                                      stroke={bassInCfg.enabled ? theme.canvas.secondaryBright : 'rgba(148, 163, 184, 0.35)'}
                                      strokeWidth={bassInCfg.enabled ? 1.75 : 1.25}
                                      strokeDasharray="4 2"
                                    />
                                  </>
                                )}
                                {bassInW > 1 && (() => {
                                  const { linePath, shadePath, swapMidX } = buildBassFadeSvgPaths(
                                    'in',
                                    bassInCfg.mode,
                                    bassInStartW,
                                    bassInW,
                                    62,
                                    bassInCfg.curveTension
                                  );
                                  const isOn = bassInCfg.enabled;
                                  return (
                                    <>
                                      {isOn && (
                                        <path d={shadePath} fill={theme.canvas.secondaryFillRgba} />
                                      )}
                                      <path
                                        d={linePath}
                                        fill="none"
                                        stroke={isOn ? theme.canvas.secondaryBright : 'rgba(148, 163, 184, 0.35)'}
                                        strokeWidth={isOn ? 1.75 : 1.25}
                                        strokeDasharray={
                                          !isOn
                                            ? '3 3'
                                            : bassInCfg.mode === 'swap'
                                              ? undefined
                                              : '4 2'
                                        }
                                      />
                                      {isOn && bassInCfg.mode === 'swap' && bassInW >= 18 && bassInW < 22 && (
                                        <circle
                                          cx={swapMidX}
                                          cy={31}
                                          r={2.8}
                                          fill={theme.canvas.bgBase}
                                          stroke={theme.canvas.secondaryBright}
                                          strokeWidth={1.5}
                                        />
                                      )}
                                      {bassInW >= 46 && (
                                        <text
                                          x={bassInStartW + 4}
                                          y={58}
                                          fill={isOn ? theme.canvas.secondaryBright : theme.canvas.textMuted}
                                          fontSize={8.5}
                                          fontFamily="monospace"
                                          fontWeight={700}
                                          opacity={isOn ? 0.9 : 0.55}
                                        >
                                          {!isOn
                                            ? 'BASS OFF'
                                            : bassInCfg.mode === 'swap'
                                              ? 'BASS SWAP'
                                              : 'BASS IN'}
                                        </text>
                                      )}
                                    </>
                                  );
                                })()}
                                {bassOutW > 1 && (() => {
                                  const { linePath, shadePath, swapMidX } = buildBassFadeSvgPaths(
                                    'out',
                                    bassOutCfg.mode,
                                    bassOutStartX,
                                    bassOutEndX - bassOutStartX,
                                    62,
                                    bassOutCfg.curveTension
                                  );
                                  const isOn = bassOutCfg.enabled;
                                  return (
                                    <>
                                      {isOn && (
                                        <path d={shadePath} fill={theme.canvas.secondaryFillRgba} />
                                      )}
                                      <path
                                        d={linePath}
                                        fill="none"
                                        stroke={isOn ? theme.canvas.secondaryBright : 'rgba(148, 163, 184, 0.35)'}
                                        strokeWidth={isOn ? 1.75 : 1.25}
                                        strokeDasharray={
                                          !isOn
                                            ? '3 3'
                                            : bassOutCfg.mode === 'swap'
                                              ? undefined
                                              : '4 2'
                                        }
                                      />
                                      {isOn && bassOutCfg.mode === 'swap' && bassOutW >= 18 && bassOutW < 22 && (
                                        <circle
                                          cx={swapMidX}
                                          cy={31}
                                          r={2.8}
                                          fill={theme.canvas.bgBase}
                                          stroke={theme.canvas.secondaryBright}
                                          strokeWidth={1.5}
                                        />
                                      )}
                                      {bassOutW >= 48 && (
                                        <text
                                          x={bassOutEndX - 4}
                                          y={58}
                                          textAnchor="end"
                                          fill={isOn ? theme.canvas.secondaryBright : theme.canvas.textMuted}
                                          fontSize={8.5}
                                          fontFamily="monospace"
                                          fontWeight={700}
                                          opacity={isOn ? 0.9 : 0.55}
                                        >
                                          {!isOn
                                            ? 'BASS OFF'
                                            : bassOutCfg.mode === 'swap'
                                              ? 'BASS SWAP'
                                              : 'BASS OUT'}
                                        </text>
                                      )}
                                    </>
                                  );
                                })()}
                                {clipWidth - bassOutEndX > 1 && (
                                  <>
                                    {bassOutCfg.enabled && (
                                      <rect
                                        x={bassOutEndX}
                                        y={3}
                                        width={clipWidth - bassOutEndX}
                                        height={59}
                                        fill={theme.canvas.secondaryFillRgba}
                                      />
                                    )}
                                    <line
                                      x1={bassOutEndX}
                                      y1={59}
                                      x2={clipWidth}
                                      y2={59}
                                      stroke={bassOutCfg.enabled ? theme.canvas.secondaryBright : 'rgba(148, 163, 184, 0.35)'}
                                      strokeWidth={bassOutCfg.enabled ? 1.75 : 1.25}
                                      strokeDasharray="4 2"
                                    />
                                  </>
                                )}
                                {hasEqIn && mixInW > 2 && (
                                  <line
                                    x1={mixInW}
                                    y1={0}
                                    x2={mixInW}
                                    y2={62}
                                    stroke={theme.canvas.positive}
                                    strokeDasharray="3 2"
                                    strokeWidth={1}
                                  />
                                )}
                                {hasEqOut && mixOutW > 2 && (
                                  <line
                                    x1={clipWidth - mixOutW}
                                    y1={0}
                                    x2={clipWidth - mixOutW}
                                    y2={62}
                                    stroke={theme.canvas.secondary}
                                    strokeDasharray="3 2"
                                    strokeWidth={1}
                                  />
                                )}
                              </svg>
                            </div>

                            {/* Left & Right Trim Handles (header & edge zones underneath corner fade handles) */}
                            <div
                              onPointerDown={(e) => startClipDrag(e, track, clip, 'trim-left')}
                              title="Drag to trim clip start"
                              className="absolute top-0 bottom-0 left-0 w-2 z-10 cursor-ew-resize hover:bg-white/25"
                            />
                            <div
                              onPointerDown={(e) => startClipDrag(e, track, clip, 'trim-right')}
                              title="Drag to trim clip end"
                              className="absolute top-0 bottom-0 right-0 w-2 z-10 cursor-ew-resize hover:bg-white/25"
                            />

                            {/* Active Fade Guide & Live Readout Pill while dragging */}
                            {activeFadeDrag && activeFadeDrag.clipId === clip.id && (() => {
                              const isIn =
                                activeFadeDrag.mode === 'fade-in-start' ||
                                activeFadeDrag.mode === 'fade-in' ||
                                activeFadeDrag.mode === 'fade-in-curve' ||
                                activeFadeDrag.mode === 'bass-fade-in-start' ||
                                activeFadeDrag.mode === 'bass-fade-in' ||
                                activeFadeDrag.mode === 'bass-fade-in-curve';
                              const isBass =
                                activeFadeDrag.mode === 'bass-fade-in-start' ||
                                activeFadeDrag.mode === 'bass-fade-in' ||
                                activeFadeDrag.mode === 'bass-fade-in-curve' ||
                                activeFadeDrag.mode === 'bass-fade-out' ||
                                activeFadeDrag.mode === 'bass-fade-out-end' ||
                                activeFadeDrag.mode === 'bass-fade-out-curve';
                              const isCurveDrag =
                                activeFadeDrag.mode === 'fade-in-curve' ||
                                activeFadeDrag.mode === 'fade-out-curve' ||
                                activeFadeDrag.mode === 'bass-fade-in-curve' ||
                                activeFadeDrag.mode === 'bass-fade-out-curve';
                              const guideX =
                                activeFadeDrag.mode === 'fade-in-start'
                                  ? fadeInStartW
                                  : activeFadeDrag.mode === 'fade-in'
                                    ? fadeInEndX
                                    : activeFadeDrag.mode === 'fade-in-curve'
                                      ? fadeInStartW + fadeInW * 0.5
                                      : activeFadeDrag.mode === 'fade-out'
                                        ? fadeOutStartX
                                        : activeFadeDrag.mode === 'fade-out-end'
                                          ? fadeOutEndX
                                          : activeFadeDrag.mode === 'fade-out-curve'
                                            ? fadeOutStartX + (fadeOutEndX - fadeOutStartX) * 0.5
                                            : activeFadeDrag.mode === 'bass-fade-in-start'
                                              ? bassInStartW
                                              : activeFadeDrag.mode === 'bass-fade-in'
                                                ? bassInEndX
                                                : activeFadeDrag.mode === 'bass-fade-in-curve'
                                                  ? bassInStartW +
                                                    bassInW *
                                                      (bassInCfg.mode === 'swap'
                                                        ? getBassSwapCenterFraction(
                                                            'in',
                                                            bassInCfg.curveTension
                                                          )
                                                        : 0.5)
                                                  : activeFadeDrag.mode === 'bass-fade-out'
                                                    ? bassOutStartX
                                                    : activeFadeDrag.mode === 'bass-fade-out-curve'
                                                      ? bassOutStartX +
                                                        (bassOutEndX - bassOutStartX) *
                                                          (bassOutCfg.mode === 'swap'
                                                            ? getBassSwapCenterFraction(
                                                                'out',
                                                                bassOutCfg.curveTension
                                                              )
                                                            : 0.5)
                                                      : bassOutEndX;
                              const isBottomPill =
                                activeFadeDrag.mode === 'fade-in-start' ||
                                activeFadeDrag.mode === 'fade-out-end' ||
                                activeFadeDrag.mode === 'bass-fade-in-start' ||
                                activeFadeDrag.mode === 'bass-fade-out-end';
                              return (
                                <>
                                  {!isCurveDrag && (
                                    <div
                                      style={{ left: Math.max(0, Math.min(clipWidth - 1, guideX)) }}
                                      className={`pointer-events-none absolute top-5 bottom-0 w-px z-20 ${
                                        isBass ? 'bg-om-secondary-bright' : 'bg-om-accent'
                                      }`}
                                    />
                                  )}
                                  <div
                                    style={
                                      isIn
                                        ? {
                                            left: Math.min(
                                              Math.max(4, guideX + 10),
                                              Math.max(4, clipWidth - 130)
                                            ),
                                          }
                                        : {
                                            right: Math.min(
                                              Math.max(4, clipWidth - guideX + 10),
                                              Math.max(4, clipWidth - 130)
                                            ),
                                          }
                                    }
                                    className={`pointer-events-none absolute ${
                                      isBottomPill ? 'bottom-4' : 'top-6'
                                    } z-30 px-1.5 py-0.5 rounded bg-om-base/95 border text-[9px] font-mono font-semibold whitespace-nowrap shadow-md ${
                                      isBass
                                        ? 'border-om-secondary-bright/70 text-om-secondary-bright'
                                        : 'border-om-accent/70 text-om-accent'
                                    }`}
                                  >
                                    {activeFadeDrag.label}
                                  </div>
                                </>
                              );
                            })()}

                            {/* Volume Fade In (Both Ends: Top = 100% End, Bottom = 0% Start) & Fade Out (Both Ends: Top = 100% Start, Bottom = 0% End) */}
                            {(() => {
                              const clampX = (px: number) =>
                                Math.min(Math.max(0, px), Math.max(0, clipWidth - 14));
                              const volInEndLeft = fadeInEndX > 0 ? clampX(fadeInEndX - 7) : 0;
                              const volInStartLeft = fadeInStartW > 0 ? clampX(fadeInStartW - 7) : 0;
                              const volOutStartLeft =
                                clipWidth - fadeOutStartX > 0
                                  ? clampX(fadeOutStartX - 7)
                                  : Math.max(0, clipWidth - 14);
                              const volOutEndLeft =
                                clipWidth - fadeOutEndX > 0
                                  ? clampX(fadeOutEndX - 7)
                                  : Math.max(0, clipWidth - 14);

                              const isActive = (m: NonNullable<typeof activeFadeDrag>['mode']) =>
                                activeFadeDrag?.clipId === clip.id && activeFadeDrag.mode === m;

                              return (
                                <>
                                  {/* Volume Fade In — End Handle (Top, 100% full volume) */}
                                  <div
                                    onPointerDown={(e) => startClipDrag(e, track, clip, 'fade-in')}
                                    onDoubleClick={(e) =>
                                      resetClipFadeHandle(e, track, clip, 'fade-in')
                                    }
                                    title={`Volume Fade In End (${clip.fadeInSec.toFixed(2)}s${volInCfg.enabled ? '' : ' · Bypassed'}) · Drag to set where Fade In reaches 100% · Double-click to reset`}
                                    style={{ left: volInEndLeft }}
                                    className={`absolute top-5 z-20 w-3.5 h-3.5 rounded-br flex items-center justify-center cursor-ew-resize border transition-all ${
                                      !volInCfg.enabled && clip.fadeInSec > 0.01
                                        ? 'bg-om-control/90 border-white/25 text-om-text-faint hover:border-om-accent hover:text-om-accent'
                                        : isActive('fade-in') || (volInCfg.enabled && clip.fadeInSec > 0.01)
                                          ? 'bg-om-accent border-om-base text-om-accent-ink shadow-sm shadow-black/60'
                                          : 'bg-om-control/95 border-om-accent/80 text-om-accent hover:bg-om-accent hover:text-om-accent-ink'
                                    }`}
                                  >
                                    <svg
                                      width="9"
                                      height="9"
                                      viewBox="0 0 10 10"
                                      className="pointer-events-none"
                                    >
                                      <path
                                        d="M1.5 8.5 Q4.5 2 8.5 1.5"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="1.75"
                                        strokeLinecap="round"
                                      />
                                    </svg>
                                  </div>

                                  {/* Volume Fade In — Start Handle (Bottom, 0% mute floor) */}
                                  <div
                                    onPointerDown={(e) =>
                                      startClipDrag(e, track, clip, 'fade-in-start')
                                    }
                                    onDoubleClick={(e) =>
                                      resetClipFadeHandle(e, track, clip, 'fade-in-start')
                                    }
                                    title={`Volume Fade In Start (+${fadeInStartSec.toFixed(2)}s${volInCfg.enabled ? '' : ' · Bypassed'}) · Drag to set where Fade In begins · Double-click to reset`}
                                    style={{ left: volInStartLeft }}
                                    className={`absolute bottom-0 z-20 w-3.5 h-3.5 rounded-tr flex items-center justify-center cursor-ew-resize border transition-all ${
                                      !volInCfg.enabled && fadeInStartSec > 0.01
                                        ? 'bg-om-control/90 border-white/25 text-om-text-faint hover:border-om-accent hover:text-om-accent'
                                        : isActive('fade-in-start') || (volInCfg.enabled && fadeInStartSec > 0.01)
                                          ? 'bg-om-accent border-om-base text-om-accent-ink shadow-sm shadow-black/60'
                                          : 'bg-om-control/95 border-om-accent/80 text-om-accent hover:bg-om-accent hover:text-om-accent-ink'
                                    }`}
                                  >
                                    <span className="w-1.5 h-1.5 rounded-full bg-current pointer-events-none" />
                                  </div>

                                  {/* Volume Fade Out — Start Handle (Top, 100% drop start) */}
                                  <div
                                    onPointerDown={(e) => startClipDrag(e, track, clip, 'fade-out')}
                                    onDoubleClick={(e) =>
                                      resetClipFadeHandle(e, track, clip, 'fade-out')
                                    }
                                    title={`Volume Fade Out Start (${clip.fadeOutSec.toFixed(2)}s${volOutCfg.enabled ? '' : ' · Bypassed'}) · Drag to set where Fade Out begins · Double-click to reset`}
                                    style={{ left: volOutStartLeft }}
                                    className={`absolute top-5 z-20 w-3.5 h-3.5 rounded-bl flex items-center justify-center cursor-ew-resize border transition-all ${
                                      !volOutCfg.enabled && clip.fadeOutSec > 0.01
                                        ? 'bg-om-control/90 border-white/25 text-om-text-faint hover:border-om-accent hover:text-om-accent'
                                        : isActive('fade-out') || (volOutCfg.enabled && clip.fadeOutSec > 0.01)
                                          ? 'bg-om-accent border-om-base text-om-accent-ink shadow-sm shadow-black/60'
                                          : 'bg-om-control/95 border-om-accent/80 text-om-accent hover:bg-om-accent hover:text-om-accent-ink'
                                    }`}
                                  >
                                    <svg
                                      width="9"
                                      height="9"
                                      viewBox="0 0 10 10"
                                      className="pointer-events-none"
                                    >
                                      <path
                                        d="M1.5 1.5 Q5.5 2 8.5 8.5"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="1.75"
                                        strokeLinecap="round"
                                      />
                                    </svg>
                                  </div>

                                  {/* Volume Fade Out — End Handle (Bottom, 0% mute floor) */}
                                  <div
                                    onPointerDown={(e) =>
                                      startClipDrag(e, track, clip, 'fade-out-end')
                                    }
                                    onDoubleClick={(e) =>
                                      resetClipFadeHandle(e, track, clip, 'fade-out-end')
                                    }
                                    title={`Volume Fade Out End (-${fadeOutEndSec.toFixed(2)}s${volOutCfg.enabled ? '' : ' · Bypassed'}) · Drag to set where Fade Out reaches 0% · Double-click to reset`}
                                    style={{ left: volOutEndLeft }}
                                    className={`absolute bottom-0 z-20 w-3.5 h-3.5 rounded-tl flex items-center justify-center cursor-ew-resize border transition-all ${
                                      !volOutCfg.enabled && fadeOutEndSec > 0.01
                                        ? 'bg-om-control/90 border-white/25 text-om-text-faint hover:border-om-accent hover:text-om-accent'
                                        : isActive('fade-out-end') || (volOutCfg.enabled && fadeOutEndSec > 0.01)
                                          ? 'bg-om-accent border-om-base text-om-accent-ink shadow-sm shadow-black/60'
                                          : 'bg-om-control/95 border-om-accent/80 text-om-accent hover:bg-om-accent hover:text-om-accent-ink'
                                    }`}
                                  >
                                    <span className="w-1.5 h-1.5 rounded-full bg-current pointer-events-none" />
                                  </div>
                                </>
                              );
                            })()}

                            {/* Bass Fade In (Both Ends: Upper-Mid = 0dB End, Lower-Mid = Cut Start) & Bass Fade Out (Both Ends) */}
                            {(() => {
                              const clampX = (px: number) =>
                                Math.min(Math.max(0, px), Math.max(0, clipWidth - 14));
                              const bassInEndLeft = bassInEndX > 0 ? clampX(bassInEndX - 7) : 0;
                              const bassInStartLeft =
                                bassInStartW > 0 ? clampX(bassInStartW - 7) : 0;
                              const bassOutStartLeft =
                                clipWidth - bassOutStartX > 0
                                  ? clampX(bassOutStartX - 7)
                                  : Math.max(0, clipWidth - 14);
                              const bassOutEndLeft =
                                clipWidth - bassOutEndX > 0
                                  ? clampX(bassOutEndX - 7)
                                  : Math.max(0, clipWidth - 14);

                              const isActive = (m: NonNullable<typeof activeFadeDrag>['mode']) =>
                                activeFadeDrag?.clipId === clip.id && activeFadeDrag.mode === m;

                              return (
                                <>
                                  {/* Bass Fade In — End Handle (Upper-Mid, 0 dB) */}
                                  <div
                                    onPointerDown={(e) =>
                                      startClipDrag(e, track, clip, 'bass-fade-in')
                                    }
                                    onDoubleClick={(e) =>
                                      resetClipFadeHandle(e, track, clip, 'bass-fade-in')
                                    }
                                    title={`Bass Fade In End (${bassInCfg.durationSec.toFixed(2)}s · ${bassInCfg.enabled ? (bassInCfg.mode === 'swap' ? 'Swap' : 'Crossfade') : 'Bypassed'}) · Drag to set where Bass reaches 0 dB · Double-click to reset`}
                                    style={{ left: bassInEndLeft }}
                                    className={`absolute top-[35px] z-20 w-3.5 h-3.5 rounded-r flex items-center justify-center cursor-ew-resize border transition-all ${
                                      !bassInCfg.enabled && bassInCfg.durationSec > 0.01
                                        ? 'bg-om-control/90 border-white/25 text-om-text-faint hover:border-om-secondary-bright hover:text-om-secondary-bright'
                                        : isActive('bass-fade-in') || bassIn.durationSec > 0.01
                                          ? 'bg-om-secondary-bright border-om-base text-om-accent-ink shadow-sm shadow-black/60'
                                          : 'bg-om-control/95 border-om-secondary-bright/75 text-om-secondary-bright hover:bg-om-secondary-bright hover:text-om-accent-ink'
                                    }`}
                                  >
                                    <svg
                                      width="9"
                                      height="9"
                                      viewBox="0 0 10 10"
                                      className="pointer-events-none"
                                    >
                                      <path
                                        d="M1.5 8.5 Q4.5 2 8.5 1.5"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="1.75"
                                        strokeLinecap="round"
                                      />
                                    </svg>
                                  </div>

                                  {/* Bass Fade In — Start Handle (Lower-Mid, Cut floor) */}
                                  <div
                                    onPointerDown={(e) =>
                                      startClipDrag(e, track, clip, 'bass-fade-in-start')
                                    }
                                    onDoubleClick={(e) =>
                                      resetClipFadeHandle(e, track, clip, 'bass-fade-in-start')
                                    }
                                    title={`Bass Fade In Start (+${bassInCfg.offsetSec.toFixed(2)}s${bassInCfg.enabled ? '' : ' · Bypassed'}) · Drag to set where Bass Fade In begins · Double-click to reset`}
                                    style={{ left: bassInStartLeft }}
                                    className={`absolute bottom-[15px] z-20 w-3.5 h-3.5 rounded-r flex items-center justify-center cursor-ew-resize border transition-all ${
                                      !bassInCfg.enabled && bassInCfg.offsetSec > 0.01
                                        ? 'bg-om-control/90 border-white/25 text-om-text-faint hover:border-om-secondary-bright hover:text-om-secondary-bright'
                                        : isActive('bass-fade-in-start') || bassIn.offsetSec > 0.01
                                          ? 'bg-om-secondary-bright border-om-base text-om-accent-ink shadow-sm shadow-black/60'
                                          : 'bg-om-control/95 border-om-secondary-bright/75 text-om-secondary-bright hover:bg-om-secondary-bright hover:text-om-accent-ink'
                                    }`}
                                  >
                                    <span className="w-1.5 h-1.5 rounded-full bg-current pointer-events-none" />
                                  </div>

                                  {/* Bass Fade Out — Start Handle (Upper-Mid, 0 dB drop start) */}
                                  <div
                                    onPointerDown={(e) =>
                                      startClipDrag(e, track, clip, 'bass-fade-out')
                                    }
                                    onDoubleClick={(e) =>
                                      resetClipFadeHandle(e, track, clip, 'bass-fade-out')
                                    }
                                    title={`Bass Fade Out Start (${bassOutCfg.durationSec.toFixed(2)}s · ${bassOutCfg.enabled ? (bassOutCfg.mode === 'swap' ? 'Swap' : 'Crossfade') : 'Bypassed'}) · Drag to set where Bass Fade Out begins · Double-click to reset`}
                                    style={{ left: bassOutStartLeft }}
                                    className={`absolute top-[35px] z-20 w-3.5 h-3.5 rounded-l flex items-center justify-center cursor-ew-resize border transition-all ${
                                      !bassOutCfg.enabled && bassOutCfg.durationSec > 0.01
                                        ? 'bg-om-control/90 border-white/25 text-om-text-faint hover:border-om-secondary-bright hover:text-om-secondary-bright'
                                        : isActive('bass-fade-out') || bassOut.durationSec > 0.01
                                          ? 'bg-om-secondary-bright border-om-base text-om-accent-ink shadow-sm shadow-black/60'
                                          : 'bg-om-control/95 border-om-secondary-bright/75 text-om-secondary-bright hover:bg-om-secondary-bright hover:text-om-accent-ink'
                                    }`}
                                  >
                                    <svg
                                      width="9"
                                      height="9"
                                      viewBox="0 0 10 10"
                                      className="pointer-events-none"
                                    >
                                      <path
                                        d="M1.5 1.5 Q5.5 2 8.5 8.5"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="1.75"
                                        strokeLinecap="round"
                                      />
                                    </svg>
                                  </div>

                                  {/* Bass Fade Out — End Handle (Lower-Mid, Cut floor) */}
                                  <div
                                    onPointerDown={(e) =>
                                      startClipDrag(e, track, clip, 'bass-fade-out-end')
                                    }
                                    onDoubleClick={(e) =>
                                      resetClipFadeHandle(e, track, clip, 'bass-fade-out-end')
                                    }
                                    title={`Bass Fade Out End (-${bassOutCfg.offsetSec.toFixed(2)}s${bassOutCfg.enabled ? '' : ' · Bypassed'}) · Drag to set where Bass Fade Out reaches full cut · Double-click to reset`}
                                    style={{ left: bassOutEndLeft }}
                                    className={`absolute bottom-[15px] z-20 w-3.5 h-3.5 rounded-l flex items-center justify-center cursor-ew-resize border transition-all ${
                                      !bassOutCfg.enabled && bassOutCfg.offsetSec > 0.01
                                        ? 'bg-om-control/90 border-white/25 text-om-text-faint hover:border-om-secondary-bright hover:text-om-secondary-bright'
                                        : isActive('bass-fade-out-end') || bassOut.offsetSec > 0.01
                                          ? 'bg-om-secondary-bright border-om-base text-om-accent-ink shadow-sm shadow-black/60'
                                          : 'bg-om-control/95 border-om-secondary-bright/75 text-om-secondary-bright hover:bg-om-secondary-bright hover:text-om-accent-ink'
                                    }`}
                                  >
                                    <span className="w-1.5 h-1.5 rounded-full bg-current pointer-events-none" />
                                  </div>
                                </>
                              );
                            })()}

                            {/* Manual Curve Bend Handles (on-curve nodes for Volume & Bass Fade In/Out) */}
                            {(() => {
                              const isActive = (m: NonNullable<typeof activeFadeDrag>['mode']) =>
                                activeFadeDrag?.clipId === clip.id && activeFadeDrag.mode === m;
                              const clampNodeX = (px: number) =>
                                Math.min(Math.max(6, px), Math.max(6, clipWidth - 6));
                              const clampNodeY = (py: number) =>
                                Math.min(Math.max(24, py), 78);

                              const volInTension = clampCurveTension(clip.fadeInCurveTension);
                              const volOutTension = clampCurveTension(clip.fadeOutCurveTension);
                              const volInMidX = fadeInStartW + fadeInW * 0.5;
                              const volInMidY =
                                20 +
                                62 *
                                  (1 -
                                    evaluateVolumeFadeGain(
                                      0.5,
                                      clip.fadeInCurve ?? clip.fadeCurve,
                                      volInTension
                                    ));
                              const volOutSpanW = Math.max(0, fadeOutEndX - fadeOutStartX);
                              const volOutMidX = fadeOutStartX + volOutSpanW * 0.5;
                              const volOutMidY =
                                20 +
                                62 *
                                  (1 -
                                    evaluateVolumeFadeGain(
                                      0.5,
                                      clip.fadeOutCurve ?? clip.fadeCurve,
                                      volOutTension
                                    ));

                              const bassInIsSwap = bassInCfg.mode === 'swap';
                              const bassOutIsSwap = bassOutCfg.mode === 'swap';
                              const bassInDefaultT = bassInIsSwap
                                ? getBassSwapCenterFraction('in', bassInCfg.curveTension)
                                : 0.5;
                              let bassInNodeX = bassInStartW + bassInW * bassInDefaultT;
                              let bassInNodeY = bassInIsSwap
                                ? 20 + 31
                                : 20 +
                                  3 +
                                  56 *
                                    (1 -
                                      evaluateBassTransitionFraction(
                                        bassInDefaultT,
                                        'in',
                                        'crossfade',
                                        bassInCfg.curveTension
                                      ));
                              // Offset Bass Crossfade handle slightly along its own curve when overlapping the Volume handle so both stay clickable
                              if (
                                !bassInIsSwap &&
                                fadeInW >= 22 &&
                                Math.hypot(bassInNodeX - volInMidX, bassInNodeY - volInMidY) < 13
                              ) {
                                const shiftedT = 0.62;
                                bassInNodeX = bassInStartW + bassInW * shiftedT;
                                bassInNodeY =
                                  20 +
                                  3 +
                                  56 *
                                    (1 -
                                      evaluateBassTransitionFraction(
                                        shiftedT,
                                        'in',
                                        'crossfade',
                                        bassInCfg.curveTension
                                      ));
                              }

                              const bassOutSpanW = Math.max(0, bassOutEndX - bassOutStartX);
                              const bassOutDefaultT = bassOutIsSwap
                                ? getBassSwapCenterFraction('out', bassOutCfg.curveTension)
                                : 0.5;
                              let bassOutNodeX = bassOutStartX + bassOutSpanW * bassOutDefaultT;
                              let bassOutNodeY = bassOutIsSwap
                                ? 20 + 31
                                : 20 +
                                  3 +
                                  56 *
                                    (1 -
                                      evaluateBassTransitionFraction(
                                        bassOutDefaultT,
                                        'out',
                                        'crossfade',
                                        bassOutCfg.curveTension
                                      ));
                              if (
                                !bassOutIsSwap &&
                                volOutSpanW >= 22 &&
                                Math.hypot(bassOutNodeX - volOutMidX, bassOutNodeY - volOutMidY) < 13
                              ) {
                                const shiftedT = 0.38;
                                bassOutNodeX = bassOutStartX + bassOutSpanW * shiftedT;
                                bassOutNodeY =
                                  20 +
                                  3 +
                                  56 *
                                    (1 -
                                      evaluateBassTransitionFraction(
                                        shiftedT,
                                        'out',
                                        'crossfade',
                                        bassOutCfg.curveTension
                                      ));
                              }

                              return (
                                <>
                                  {volInCfg.enabled && fadeInW >= 22 && (
                                    <div
                                      onPointerDown={(e) =>
                                        startClipDrag(e, track, clip, 'fade-in-curve')
                                      }
                                      onDoubleClick={(e) =>
                                        resetClipFadeHandle(e, track, clip, 'fade-in-curve')
                                      }
                                      title={`Volume Fade In Curve (${formatCurveTensionReadout(volInTension)}) · Drag up/down to bend curve · Double-click to reset`}
                                      style={{
                                        left: clampNodeX(volInMidX) - 5,
                                        top: clampNodeY(volInMidY) - 5,
                                      }}
                                      className={`absolute z-20 w-2.5 h-2.5 rounded-full cursor-ns-resize border transition-transform hover:scale-125 ${
                                        isActive('fade-in-curve')
                                          ? 'bg-om-accent border-white scale-125 shadow-sm shadow-om-accent/80'
                                          : Math.abs(volInTension) > 0.01
                                            ? 'bg-om-accent border-om-base shadow-sm shadow-black/70'
                                            : 'bg-om-base/90 border-om-accent opacity-75 group-hover:opacity-100 hover:bg-om-accent'
                                      }`}
                                    />
                                  )}

                                  {volOutCfg.enabled && volOutSpanW >= 22 && (
                                    <div
                                      onPointerDown={(e) =>
                                        startClipDrag(e, track, clip, 'fade-out-curve')
                                      }
                                      onDoubleClick={(e) =>
                                        resetClipFadeHandle(e, track, clip, 'fade-out-curve')
                                      }
                                      title={`Volume Fade Out Curve (${formatCurveTensionReadout(volOutTension)}) · Drag up/down to bend curve · Double-click to reset`}
                                      style={{
                                        left: clampNodeX(volOutMidX) - 5,
                                        top: clampNodeY(volOutMidY) - 5,
                                      }}
                                      className={`absolute z-20 w-2.5 h-2.5 rounded-full cursor-ns-resize border transition-transform hover:scale-125 ${
                                        isActive('fade-out-curve')
                                          ? 'bg-om-accent border-white scale-125 shadow-sm shadow-om-accent/80'
                                          : Math.abs(volOutTension) > 0.01
                                            ? 'bg-om-accent border-om-base shadow-sm shadow-black/70'
                                            : 'bg-om-base/90 border-om-accent opacity-75 group-hover:opacity-100 hover:bg-om-accent'
                                      }`}
                                    />
                                  )}

                                  {bassInCfg.enabled && bassInW >= 22 && (
                                    <div
                                      onPointerDown={(e) =>
                                        startClipDrag(e, track, clip, 'bass-fade-in-curve')
                                      }
                                      onDoubleClick={(e) =>
                                        resetClipFadeHandle(e, track, clip, 'bass-fade-in-curve')
                                      }
                                      title={
                                        bassInIsSwap
                                          ? `Bass Swap In Point (${formatCurveTensionReadout(bassInCfg.curveTension, { isSwap: true, direction: 'in' })}) · Drag left/right to move swap point · Double-click to reset`
                                          : `Bass Fade In Curve (${formatCurveTensionReadout(bassInCfg.curveTension)}) · Drag up/down to bend curve · Double-click to reset`
                                      }
                                      style={{
                                        left: clampNodeX(bassInNodeX) - 5,
                                        top: clampNodeY(bassInNodeY) - 5,
                                      }}
                                      className={`absolute z-20 w-2.5 h-2.5 ${
                                        bassInIsSwap ? 'rotate-45 rounded-[2px] cursor-ew-resize' : 'rounded-full cursor-ns-resize'
                                      } border transition-transform hover:scale-125 ${
                                        isActive('bass-fade-in-curve')
                                          ? 'bg-om-secondary-bright border-white scale-125 shadow-sm shadow-om-secondary-bright/80'
                                          : Math.abs(bassInCfg.curveTension) > 0.01
                                            ? 'bg-om-secondary-bright border-om-base shadow-sm shadow-black/70'
                                            : 'bg-om-base/90 border-om-secondary-bright opacity-80 group-hover:opacity-100 hover:bg-om-secondary-bright'
                                      }`}
                                    />
                                  )}

                                  {bassOutCfg.enabled && bassOutSpanW >= 22 && (
                                    <div
                                      onPointerDown={(e) =>
                                        startClipDrag(e, track, clip, 'bass-fade-out-curve')
                                      }
                                      onDoubleClick={(e) =>
                                        resetClipFadeHandle(e, track, clip, 'bass-fade-out-curve')
                                      }
                                      title={
                                        bassOutIsSwap
                                          ? `Bass Swap Out Point (${formatCurveTensionReadout(bassOutCfg.curveTension, { isSwap: true, direction: 'out' })}) · Drag left/right to move swap point · Double-click to reset`
                                          : `Bass Fade Out Curve (${formatCurveTensionReadout(bassOutCfg.curveTension)}) · Drag up/down to bend curve · Double-click to reset`
                                      }
                                      style={{
                                        left: clampNodeX(bassOutNodeX) - 5,
                                        top: clampNodeY(bassOutNodeY) - 5,
                                      }}
                                      className={`absolute z-20 w-2.5 h-2.5 ${
                                        bassOutIsSwap ? 'rotate-45 rounded-[2px] cursor-ew-resize' : 'rounded-full cursor-ns-resize'
                                      } border transition-transform hover:scale-125 ${
                                        isActive('bass-fade-out-curve')
                                          ? 'bg-om-secondary-bright border-white scale-125 shadow-sm shadow-om-secondary-bright/80'
                                          : Math.abs(bassOutCfg.curveTension) > 0.01
                                            ? 'bg-om-secondary-bright border-om-base shadow-sm shadow-black/70'
                                            : 'bg-om-base/90 border-om-secondary-bright opacity-80 group-hover:opacity-100 hover:bg-om-secondary-bright'
                                      }`}
                                    />
                                  )}
                                </>
                              );
                            })()}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Expandable Automation Curve Lane */}
                  {track.showAutomation && (
                    <div className="flex h-[84px] bg-om-well border-t border-white/[0.06]">
                      <div
                        style={{ width: TRACK_HEADER_WIDTH }}
                        className="shrink-0 bg-om-sub border-r border-white/[0.08] p-2 flex flex-col justify-between sticky left-0 z-20"
                      >
                        <div className="flex items-center justify-between gap-1">
                          <select
                            value={track.activeAutomationParam}
                            onChange={(e) =>
                              onUpdateTrack(track.id, {
                                activeAutomationParam: e.target.value as AutomationParam,
                              })
                            }
                            className="bg-om-base border border-white/[0.08] rounded px-1.5 py-0.5 text-[11px] text-om-text flex-1"
                          >
                            {automationParams.map((p) => (
                              <option key={p.id} value={p.id}>
                                Auto: {p.label}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() =>
                              onUpdateTrack(track.id, {
                                automationLanes: {
                                  ...track.automationLanes,
                                  [track.activeAutomationParam]: {
                                    ...autoLane,
                                    points: [],
                                  },
                                },
                              })
                            }
                            className="px-1.5 py-0.5 rounded bg-om-control text-[10px] text-om-text-dim hover:text-om-danger cursor-pointer"
                            title="Clear automation breakpoints"
                          >
                            Clear
                          </button>
                        </div>

                        <div className="flex items-center justify-between text-[10px] text-om-text-faint">
                          <span>Click lane to add nodes</span>
                          <select
                            value={autoCurveType}
                            onChange={(e) =>
                              setAutoCurveType(e.target.value as AutomationCurveType)
                            }
                            className="bg-om-base border border-white/[0.06] rounded px-1 py-0.5 text-[10px] text-om-text-muted"
                          >
                            <option value="linear">Linear</option>
                            <option value="smooth">Smooth</option>
                            <option value="step">Step</option>
                          </select>
                        </div>
                      </div>

                      {/* Interactive SVG Automation Curve Surface */}
                      <div
                        style={{ width: timelineWidthPx }}
                        onClick={(e) => {
                          // Only add point if clicking empty background (not dragging existing circle)
                          if ((e.target as HTMLElement).tagName.toLowerCase() === 'circle') return;
                          const rect = e.currentTarget.getBoundingClientRect();
                          const x = Math.max(0, e.clientX - rect.left);
                          const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
                          const timeSec = x / project.zoomPxPerSec;
                          const value = Math.max(0, Math.min(1, 1 - y / rect.height));
                          const newPoint = {
                            id: `pt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                            timeSec,
                            value,
                            curve: autoCurveType,
                          };
                          const updatedPts = [...autoLane.points, newPoint].sort(
                            (a, b) => a.timeSec - b.timeSec
                          );
                          onUpdateTrack(track.id, {
                            automationLanes: {
                              ...track.automationLanes,
                              [track.activeAutomationParam]: {
                                ...autoLane,
                                points: updatedPts,
                              },
                            },
                          });
                        }}
                        className="relative flex-1 cursor-crosshair"
                      >
                        <svg width={timelineWidthPx} height={84} className="block">
                          {/* Midline */}
                          <line
                            x1={0}
                            y1={42}
                            x2={timelineWidthPx}
                            y2={42}
                            stroke="rgba(255,255,255,0.06)"
                            strokeDasharray="3 3"
                          />

                          {/* Sampled Curve Polyline */}
                          {autoLane.points.length > 0 && (
                            <polyline
                              fill="none"
                              stroke={autoParamMeta.color}
                              strokeWidth={2}
                              points={(() => {
                                const pts = [...autoLane.points].sort(
                                  (a, b) => a.timeSec - b.timeSec
                                );
                                const coords: string[] = [];
                                const firstY = (1 - pts[0].value) * 84;
                                coords.push(`0,${firstY}`);
                                for (let i = 0; i < pts.length; i++) {
                                  const p = pts[i];
                                  if (i > 0 && pts[i - 1].curve === 'smooth') {
                                    const prev = pts[i - 1];
                                    for (let s = 1; s <= 12; s++) {
                                      const t =
                                        prev.timeSec + ((p.timeSec - prev.timeSec) * s) / 12;
                                      const v = evaluateAutomationAt(autoLane, t) ?? p.value;
                                      coords.push(`${t * project.zoomPxPerSec},${(1 - v) * 84}`);
                                    }
                                  } else if (i > 0 && pts[i - 1].curve === 'step') {
                                    coords.push(
                                      `${p.timeSec * project.zoomPxPerSec},${(1 - pts[i - 1].value) * 84}`
                                    );
                                    coords.push(
                                      `${p.timeSec * project.zoomPxPerSec},${(1 - p.value) * 84}`
                                    );
                                  } else {
                                    coords.push(
                                      `${p.timeSec * project.zoomPxPerSec},${(1 - p.value) * 84}`
                                    );
                                  }
                                }
                                const lastY = (1 - pts[pts.length - 1].value) * 84;
                                coords.push(`${timelineWidthPx},${lastY}`);
                                return coords.join(' ');
                              })()}
                            />
                          )}

                          {/* Breakpoint Nodes */}
                          {autoLane.points.map((pt) => (
                            <circle
                              key={pt.id}
                              cx={pt.timeSec * project.zoomPxPerSec}
                              cy={(1 - pt.value) * 84}
                              r={5}
                              fill={theme.canvas.bgBase}
                              stroke={autoParamMeta.color}
                              strokeWidth={2}
                              className="cursor-grab active:cursor-grabbing"
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                onUpdateTrack(track.id, {
                                  automationLanes: {
                                    ...track.automationLanes,
                                    [track.activeAutomationParam]: {
                                      ...autoLane,
                                      points: autoLane.points.filter((p) => p.id !== pt.id),
                                    },
                                  },
                                });
                              }}
                              onPointerDown={(e) => {
                                e.stopPropagation();
                                const svgRect = (
                                  e.currentTarget.ownerSVGElement as SVGSVGElement
                                ).getBoundingClientRect();
                                const onMove = (ev: PointerEvent) => {
                                  const x = Math.max(0, ev.clientX - svgRect.left);
                                  const y = Math.max(0, Math.min(84, ev.clientY - svgRect.top));
                                  const timeSec = Math.max(0, x / project.zoomPxPerSec);
                                  const value = Math.max(0, Math.min(1, 1 - y / 84));
                                  const nextPts = autoLane.points
                                    .map((p) =>
                                      p.id === pt.id ? { ...p, timeSec, value } : p
                                    )
                                    .sort((a, b) => a.timeSec - b.timeSec);
                                  onUpdateTrack(track.id, {
                                    automationLanes: {
                                      ...track.automationLanes,
                                      [track.activeAutomationParam]: {
                                        ...autoLane,
                                        points: nextPts,
                                      },
                                    },
                                  });
                                };
                                const onUp = () => {
                                  window.removeEventListener('pointermove', onMove);
                                  window.removeEventListener('pointerup', onUp);
                                };
                                window.addEventListener('pointermove', onMove);
                                window.addEventListener('pointerup', onUp);
                              }}
                            />
                          ))}
                        </svg>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        </div>

        <MasterMeterPanel
          isPlaying={project.isPlaying}
          masterVolume={project.masterVolume ?? DEFAULT_MASTER_VOLUME}
          onChangeMasterVolume={(masterVolume) => onUpdateProject({ masterVolume })}
        />
      </div>

      {/* Bottom Real-Time Track Effects Rack Drawer */}
      {activeFxTrack && (
        <div className="bg-om-panel border-t border-white/[0.08] px-4 py-3 flex items-center justify-between gap-4 overflow-x-auto">
          <div className="flex items-center gap-2 shrink-0">
            <span
              className="w-2.5 h-2.5 rounded-sm"
              style={{
                backgroundColor: resolveTrackAccentColor(
                  activeFxTrack.accentColor,
                  Math.max(
                    0,
                    project.tracks.findIndex((t) => t.id === activeFxTrack.id)
                  ),
                  themeId
                ),
              }}
            />
            <div>
              <h4 className="text-xs font-semibold text-om-text">
                {activeFxTrack.name} Effects Rack
              </h4>
              <p className="text-[11px] text-om-text-faint">
                Real-time filter, EQ, delay, reverb & saturation
              </p>
            </div>
          </div>

          <div className="flex items-center gap-5 shrink-0">
            {/* Filter Module */}
            <div className="flex items-center gap-3 px-3 py-1.5 rounded bg-om-well border border-white/[0.06]">
              <label className="flex items-center gap-1.5 text-[11px] font-medium text-om-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={activeFxTrack.effects.filterEnabled}
                  onChange={(e) =>
                    onUpdateTrack(activeFxTrack.id, {
                      effects: { ...activeFxTrack.effects, filterEnabled: e.target.checked },
                    })
                  }
                  className="accent-om-secondary"
                />
                Filter
              </label>
              <Knob
                label="Cutoff"
                value={activeFxTrack.effects.filterValue}
                min={-1}
                max={1}
                defaultValue={0}
                step={0.01}
                size={34}
                accent="cyan"
                bipolar
                formatValue={(v) =>
                  Math.abs(v) < 0.03 ? 'Flat' : v < 0 ? `LP ${Math.round((1 + v) * 100)}%` : `HP ${Math.round(v * 100)}%`
                }
                onChange={(filterValue) =>
                  onUpdateTrack(activeFxTrack.id, {
                    effects: { ...activeFxTrack.effects, filterValue, filterEnabled: true },
                  })
                }
              />
              <Knob
                label="Res"
                value={activeFxTrack.effects.filterResonance}
                min={0.7}
                max={12}
                defaultValue={1.2}
                step={0.1}
                size={32}
                accent="cyan"
                onChange={(filterResonance) =>
                  onUpdateTrack(activeFxTrack.id, {
                    effects: { ...activeFxTrack.effects, filterResonance },
                  })
                }
              />
            </div>

            {/* 3-Band EQ */}
            <div className="flex items-center gap-2.5 px-3 py-1.5 rounded bg-om-well border border-white/[0.06]">
              <span className="text-[11px] font-medium text-om-text-muted">EQ</span>
              <Knob
                label="Low"
                value={activeFxTrack.effects.eqLow}
                min={-18}
                max={12}
                defaultValue={0}
                step={0.5}
                size={32}
                accent="amber"
                bipolar
                formatValue={(v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}dB`}
                onChange={(eqLow) =>
                  onUpdateTrack(activeFxTrack.id, {
                    effects: { ...activeFxTrack.effects, eqLow },
                  })
                }
              />
              <Knob
                label="Mid"
                value={activeFxTrack.effects.eqMid}
                min={-18}
                max={12}
                defaultValue={0}
                step={0.5}
                size={32}
                accent="amber"
                bipolar
                formatValue={(v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}dB`}
                onChange={(eqMid) =>
                  onUpdateTrack(activeFxTrack.id, {
                    effects: { ...activeFxTrack.effects, eqMid },
                  })
                }
              />
              <Knob
                label="High"
                value={activeFxTrack.effects.eqHigh}
                min={-18}
                max={12}
                defaultValue={0}
                step={0.5}
                size={32}
                accent="amber"
                bipolar
                formatValue={(v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}dB`}
                onChange={(eqHigh) =>
                  onUpdateTrack(activeFxTrack.id, {
                    effects: { ...activeFxTrack.effects, eqHigh },
                  })
                }
              />
            </div>

            {/* Delay */}
            <div className="flex items-center gap-2.5 px-3 py-1.5 rounded bg-om-well border border-white/[0.06]">
              <label className="flex items-center gap-1.5 text-[11px] font-medium text-om-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={activeFxTrack.effects.delayEnabled}
                  onChange={(e) =>
                    onUpdateTrack(activeFxTrack.id, {
                      effects: { ...activeFxTrack.effects, delayEnabled: e.target.checked },
                    })
                  }
                  className="accent-om-accent"
                />
                Delay
              </label>
              <Knob
                label="Time"
                value={activeFxTrack.effects.delayTimeSec}
                min={0.05}
                max={1.2}
                defaultValue={0.375}
                step={0.01}
                size={32}
                accent="amber"
                formatValue={(v) => `${Math.round(v * 1000)}ms`}
                onChange={(delayTimeSec) =>
                  onUpdateTrack(activeFxTrack.id, {
                    effects: { ...activeFxTrack.effects, delayTimeSec, delayEnabled: true },
                  })
                }
              />
              <Knob
                label="Fdbk"
                value={activeFxTrack.effects.delayFeedback}
                min={0}
                max={0.85}
                defaultValue={0.35}
                step={0.01}
                size={32}
                accent="amber"
                formatValue={(v) => `${Math.round(v * 100)}%`}
                onChange={(delayFeedback) =>
                  onUpdateTrack(activeFxTrack.id, {
                    effects: { ...activeFxTrack.effects, delayFeedback },
                  })
                }
              />
              <Knob
                label="Wet"
                value={activeFxTrack.effects.delayWet}
                min={0}
                max={1}
                defaultValue={0.25}
                step={0.01}
                size={32}
                accent="amber"
                formatValue={(v) => `${Math.round(v * 100)}%`}
                onChange={(delayWet) =>
                  onUpdateTrack(activeFxTrack.id, {
                    effects: { ...activeFxTrack.effects, delayWet, delayEnabled: true },
                  })
                }
              />
            </div>

            {/* Reverb & Drive */}
            <div className="flex items-center gap-2.5 px-3 py-1.5 rounded bg-om-well border border-white/[0.06]">
              <label className="flex items-center gap-1.5 text-[11px] font-medium text-om-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={activeFxTrack.effects.reverbEnabled}
                  onChange={(e) =>
                    onUpdateTrack(activeFxTrack.id, {
                      effects: { ...activeFxTrack.effects, reverbEnabled: e.target.checked },
                    })
                  }
                  className="accent-om-secondary"
                />
                Reverb
              </label>
              <Knob
                label="Mix"
                value={activeFxTrack.effects.reverbWet}
                min={0}
                max={1}
                defaultValue={0.22}
                step={0.01}
                size={32}
                accent="cyan"
                formatValue={(v) => `${Math.round(v * 100)}%`}
                onChange={(reverbWet) =>
                  onUpdateTrack(activeFxTrack.id, {
                    effects: { ...activeFxTrack.effects, reverbWet, reverbEnabled: true },
                  })
                }
              />
              <label className="flex items-center gap-1.5 text-[11px] font-medium text-om-text-secondary cursor-pointer ml-1">
                <input
                  type="checkbox"
                  checked={activeFxTrack.effects.driveEnabled}
                  onChange={(e) =>
                    onUpdateTrack(activeFxTrack.id, {
                      effects: { ...activeFxTrack.effects, driveEnabled: e.target.checked },
                    })
                  }
                  className="accent-om-accent"
                />
                Drive
              </label>
              <Knob
                label="Amount"
                value={activeFxTrack.effects.driveAmount}
                min={0}
                max={1}
                defaultValue={0.2}
                step={0.01}
                size={32}
                accent="amber"
                formatValue={(v) => `${Math.round(v * 100)}%`}
                onChange={(driveAmount) =>
                  onUpdateTrack(activeFxTrack.id, {
                    effects: { ...activeFxTrack.effects, driveAmount, driveEnabled: true },
                  })
                }
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => setActiveFxTrackId(null)}
            className="px-2.5 py-1 rounded bg-om-control-alt text-xs text-om-text-muted hover:text-white shrink-0 cursor-pointer"
          >
            Close
          </button>
        </div>
      )}

      {/* Unified Floating Clip & Dynamic Mix Menu */}
      {isFloatingMenuOpen && (() => {
        const panelW = Math.min(620, Math.max(320, window.innerWidth - 24));
        const clampedDraggedPos = floatingMenuPos
          ? {
              left: Math.max(8, Math.min(window.innerWidth - panelW - 8, floatingMenuPos.x)),
              top: Math.max(8, Math.min(window.innerHeight - 120, floatingMenuPos.y)),
            }
          : null;

        let initialAnchoredPos: { left: number; top: number } | null = null;
        if (!clampedDraggedPos && clipMenuState) {
          const menuHeightEst = 260;
          const left = Math.max(8, Math.min(clipMenuState.x, window.innerWidth - panelW - 8));
          const baseTop =
            clipMenuState.y + menuHeightEst > window.innerHeight - 8
              ? Math.max(8, clipMenuState.y - menuHeightEst - 22)
              : clipMenuState.y + 4;
          const top = Math.max(8, baseTop + clipMenuTopOffset);
          initialAnchoredPos = { left, top };
        }

        const resolvedPos = clampedDraggedPos ?? initialAnchoredPos;

        if (isDynamicMixViewActive && activePlayheadMixPair) {
          const pair = activePlayheadMixPair;
          const progress = Math.max(
            0,
            Math.min(
              1,
              (project.playheadSec - pair.overlapStartSec) / Math.max(0.01, pair.overlapDurationSec)
            )
          );
          const progressPct = Math.round(progress * 100);
          return (
            <div
              ref={floatingMenuRef}
              onPointerDown={(e) => e.stopPropagation()}
              style={
                resolvedPos
                  ? { width: panelW, left: resolvedPos.left, top: resolvedPos.top }
                  : { width: panelW }
              }
              className={`fixed z-50 max-h-[calc(100vh-16px)] overflow-y-auto rounded-md bg-om-panel-alt/95 backdrop-blur-sm border shadow-2xl shadow-black/80 p-2.5 text-xs text-om-text space-y-2 ${
                resolvedPos ? '' : 'bottom-4 left-1/2 -translate-x-1/2'
              } ${isDraggingFloatingMenu ? 'border-om-positive/75 select-none' : 'border-om-positive/35'}`}
            >
              <div
                onPointerDown={handleFloatingMenuDragStart}
                onDoubleClick={(e) => {
                  if ((e.target as HTMLElement).closest('button')) return;
                  resetFloatingMenuPos();
                }}
                title="Drag to move · Double-click to reset position"
                className={`flex items-center justify-between gap-2 pb-1.5 border-b border-white/[0.08] select-none ${
                  isDraggingFloatingMenu ? 'cursor-grabbing' : 'cursor-grab'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <GripHorizontal className="w-3.5 h-3.5 text-om-text-dim shrink-0" />
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-om-positive/15 border border-om-positive/40 text-[10px] font-semibold uppercase tracking-wider text-om-positive shrink-0">
                    <ArrowLeftRight className="w-3 h-3" />
                    Mix Point
                  </span>
                  <span className="font-mono tabular-nums text-[10px] text-om-text-dim truncate">
                    Overlap {formatTimecode(pair.overlapDurationSec, true)} · {progressPct}%
                  </span>
                  <div className="hidden sm:block w-24 h-1 rounded-full bg-om-base overflow-hidden border border-white/[0.06] shrink-0">
                    <div
                      className="h-full bg-om-positive transition-[width] duration-75"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={toggleDynamicMixMenu}
                    aria-pressed={dynamicMixMenuEnabled}
                    title="Dynamic mode ON (click to switch this menu back to single-clip options)"
                    className="px-1.5 py-0.5 rounded border text-[10px] font-medium inline-flex items-center gap-1 transition-colors cursor-pointer bg-om-positive/15 border-om-positive/50 text-om-positive"
                  >
                    <ArrowLeftRight className="w-3 h-3" />
                    <span>Dynamic</span>
                  </button>
                  <button
                    type="button"
                    onClick={closeFloatingMenu}
                    className="p-1 rounded text-om-text-dim hover:bg-white/[0.06] hover:text-white cursor-pointer"
                    title="Close menu (reappears on next mix point while Dynamic is ON)"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <ClipFadeCard
                  direction="out"
                  trackId={pair.outTrack.id}
                  clip={pair.outClip}
                  trackLabel={pair.outAsset?.name ?? pair.outTrack.name}
                  trackAccentColor={resolveTrackAccentColor(
                    pair.outTrack.accentColor,
                    pair.outTrackIdx,
                    themeId
                  )}
                  roleTag="OUT"
                  onUpdateClip={onUpdateClip}
                  onToggleVolumeFade={toggleClipVolumeFadeDirection}
                  onToggleBassFade={toggleClipBassFadeDirection}
                />
                <ClipFadeCard
                  direction="in"
                  trackId={pair.inTrack.id}
                  clip={pair.inClip}
                  trackLabel={pair.inAsset?.name ?? pair.inTrack.name}
                  trackAccentColor={resolveTrackAccentColor(
                    pair.inTrack.accentColor,
                    pair.inTrackIdx,
                    themeId
                  )}
                  roleTag="IN"
                  onUpdateClip={onUpdateClip}
                  onToggleVolumeFade={toggleClipVolumeFadeDirection}
                  onToggleBassFade={toggleClipBassFadeDirection}
                />
              </div>
            </div>
          );
        }

        if (!clipMenuState) return null;
        const menuTrack = project.tracks.find((t) => t.id === clipMenuState.trackId);
        const menuClip = menuTrack?.clips.find((c) => c.id === clipMenuState.clipId);
        if (!menuTrack || !menuClip) return null;
        const menuAsset = assetsMap.get(menuClip.trackAssetId);
        const menuClipBpmRange = getBpmRangeForClip(
          project,
          menuClip.startSec,
          menuClip.durationSec
        );
        const volInCfg = getConfiguredClipVolumeFade(menuClip, 'in');
        const volOutCfg = getConfiguredClipVolumeFade(menuClip, 'out');
        const hasVolIn = volInCfg.durationSec > 0.01 || volInCfg.offsetSec > 0.01;
        const hasVolOut = volOutCfg.durationSec > 0.01 || volOutCfg.offsetSec > 0.01;
        const volInActive = volInCfg.enabled && hasVolIn;
        const volOutActive = volOutCfg.enabled && hasVolOut;

        const activeEnv = clipMixDirection === 'in' ? menuClip.mixIn : menuClip.mixOut;
        const inBadges = formatMixSummaryBadges(menuClip.mixIn);
        const outBadges = formatMixSummaryBadges(menuClip.mixOut);
        const hasPrevCandidate = Boolean(
          findClipById(project.tracks, menuClip.mixIn?.pairedClipId) ??
            findPreviousClip(
              project.tracks,
              menuClip.id,
              menuClip.startSec + (menuClip.mixIn?.durationSec ?? 0) + 1
            )
        );

        const buildSeededEnvelope = (dir: 'in' | 'out'): ClipMixEnvelope => {
          const existing = dir === 'in' ? menuClip.mixIn : menuClip.mixOut;
          if (existing) return existing;
          const prevLookup =
            dir === 'in'
              ? findPreviousClip(project.tracks, menuClip.id, menuClip.startSec + 1)
              : null;
          const dur =
            dir === 'in' && prevLookup
              ? getOverlapDurationBeforeTime(project, prevLookup.endSec, mixDefaults.overlapBars)
              : dir === 'in'
                ? getOverlapDurationFromStart(project, menuClip.startSec, mixDefaults.overlapBars)
                : getOverlapDurationBeforeTime(
                    project,
                    menuClip.startSec + menuClip.durationSec,
                    mixDefaults.overlapBars
                  );
          return buildMixEnvelopeFromDefaults(
            mixDefaults,
            Math.min(menuClip.durationSec * 0.75, dur),
            prevLookup?.clip.id
          );
        };

        const applyEnvPatch = (
          patch: Partial<ClipMixEnvelope>,
          realignToPrev = false
        ) => {
          const base = buildSeededEnvelope(clipMixDirection);
          const nextEnv: ClipMixEnvelope = { ...base, ...patch };
          onUpdateClipTransition(menuTrack.id, menuClip.id, clipMixDirection, nextEnv, {
            realignToPrev,
            syncPair: syncPairedClip,
          });
        };

        const hasBpm = Boolean(menuAsset && menuAsset.bpm > 0);
        const barPeriodSec = hasBpm && menuAsset ? (60 / Math.max(40, menuAsset.bpm)) * 4 : 2;
        const currentOffset =
          menuAsset && Number.isFinite(menuAsset.beatOffsetSec) ? menuAsset.beatOffsetSec : 0;
        const nudgeBeatOffset = (deltaSec: number) => {
          if (!menuAsset) return;
          const next = (((currentOffset + deltaSec) % barPeriodSec) + barPeriodSec) % barPeriodSec;
          onUpdateTrackBeatOffset?.(menuAsset.id, Math.round(next * 10000) / 10000);
        };
        const nudgeClipStart = (deltaSec: number) => {
          const nextStart = Math.max(
            0,
            Math.round((menuClip.startSec + deltaSec) * 10000) / 10000
          );
          if (nextStart === menuClip.startSec) return;
          onMoveClip(menuTrack.id, menuTrack.id, menuClip.id, nextStart);
          onCommitTempoChange?.();
        };
        const playheadInsideClip =
          project.playheadSec >= menuClip.startSec &&
          project.playheadSec <= menuClip.startSec + menuClip.durationSec;

        let bestOverlap = 0;
        let bestEarlierOverlap = 0;
        let overlapRef: { clip: NleClip; asset: TrackAsset } | null = null;
        let earlierOverlapRef: { clip: NleClip; asset: TrackAsset } | null = null;
        if (menuAsset) {
          const clipEnd = menuClip.startSec + menuClip.durationSec;
          for (const tr of project.tracks) {
            for (const c of tr.clips) {
              if (c.id === menuClip.id) continue;
              const a = assetsMap.get(c.trackAssetId);
              if (!a) continue;
              const ov =
                Math.min(clipEnd, c.startSec + c.durationSec) -
                Math.max(menuClip.startSec, c.startSec);
              if (ov > 0.8) {
                if (c.startSec <= menuClip.startSec + 1e-4 && ov > bestEarlierOverlap) {
                  bestEarlierOverlap = ov;
                  earlierOverlapRef = { clip: c, asset: a };
                }
                if (ov > bestOverlap) {
                  bestOverlap = ov;
                  overlapRef = { clip: c, asset: a };
                }
              }
            }
          }
          if (project.rippleMove !== false && earlierOverlapRef) {
            overlapRef = earlierOverlapRef;
          }
        }
        const activeFeedback =
          autoLockStatus && autoLockStatus.clipId === menuClip.id ? autoLockStatus.label : null;

        return (
          <div
            ref={floatingMenuRef}
            onPointerDown={(e) => e.stopPropagation()}
            style={
              resolvedPos
                ? { width: panelW, left: resolvedPos.left, top: resolvedPos.top }
                : { width: panelW }
            }
            className={`fixed z-50 max-h-[calc(100vh-16px)] overflow-y-auto rounded-md bg-om-panel-alt/95 backdrop-blur-sm border shadow-2xl shadow-black/80 p-2.5 text-xs text-om-text space-y-2 ${
              resolvedPos ? '' : 'bottom-4 left-1/2 -translate-x-1/2'
            } ${isDraggingFloatingMenu ? 'border-om-accent/70 select-none' : 'border-white/[0.14]'}`}
          >
            {/* Draggable Menu Header */}
            <div
              onPointerDown={handleFloatingMenuDragStart}
              onDoubleClick={(e) => {
                if ((e.target as HTMLElement).closest('button')) return;
                resetFloatingMenuPos();
              }}
              title="Drag to move · Double-click to reset position"
              className={`flex items-start justify-between gap-2 pb-1.5 border-b border-white/[0.08] select-none ${
                isDraggingFloatingMenu ? 'cursor-grabbing' : 'cursor-grab'
              }`}
            >
              <div className="flex items-start gap-2 min-w-0">
                <GripHorizontal className="w-3.5 h-3.5 mt-0.5 text-om-text-dim shrink-0" />
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold text-om-accent truncate">
                    {menuAsset?.name ?? 'Clip Options'}
                  </div>
                  <div className="font-mono tabular-nums text-[10px] text-om-text-dim">
                    Start {formatTimecode(menuClip.startSec, true)} · Dur{' '}
                    {formatTimecode(menuClip.durationSec, true)}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={toggleDynamicMixMenu}
                  aria-pressed={dynamicMixMenuEnabled}
                  title={
                    dynamicMixMenuEnabled
                      ? 'Dynamic mode ON (switches to dual-track Mix Point view whenever playhead is over an overlap)'
                      : 'Enable Dynamic mode (switches this floating menu to dual-track Mix Point view at playhead overlaps)'
                  }
                  className={`px-1.5 py-0.5 rounded border text-[10px] font-medium inline-flex items-center gap-1 transition-colors cursor-pointer ${
                    dynamicMixMenuEnabled
                      ? 'bg-om-positive/15 border-om-positive/50 text-om-positive'
                      : 'bg-om-base border-white/[0.08] text-om-text-dim hover:text-white'
                  }`}
                >
                  <ArrowLeftRight className="w-3 h-3" />
                  <span>Dynamic</span>
                </button>
                <button
                  type="button"
                  onClick={() => onDuplicateClip(menuTrack.id, menuClip.id)}
                  className="p-1 rounded text-om-text-muted hover:bg-white/[0.06] hover:text-white cursor-pointer"
                  title="Duplicate Clip"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onDeleteClip(menuTrack.id, menuClip.id);
                    setSelectedClipRef(null);
                    setClipMenuState(null);
                  }}
                  className="p-1 rounded text-om-text-muted hover:bg-white/[0.06] hover:text-om-danger cursor-pointer"
                  title="Delete Clip"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={closeFloatingMenu}
                  className="p-1 rounded text-om-text-dim hover:bg-white/[0.06] hover:text-white cursor-pointer"
                  title="Close menu"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Quick Fixes: Beat Alignment */}
            {menuAsset && (
              <div className="flex items-center gap-1.5 text-[11px]">
                <button
                  type="button"
                  disabled={!overlapRef}
                  onClick={() => {
                    if (!overlapRef) return;
                    const res = autoAlignOverlapShiftSec({
                      project,
                      targetClip: menuClip,
                      targetAsset: menuAsset,
                      referenceClip: overlapRef.clip,
                      referenceAsset: overlapRef.asset,
                    });
                    if (autoLockTimerRef.current !== null) {
                      window.clearTimeout(autoLockTimerRef.current);
                    }
                    if (!res) {
                      setAutoLockStatus({ clipId: menuClip.id, label: 'No kicks found' });
                    } else {
                      const nextStart = Math.max(
                        0,
                        Math.round((menuClip.startSec + res.deltaSec) * 10000) / 10000
                      );
                      onMoveClip(menuTrack.id, menuTrack.id, menuClip.id, nextStart);
                      onCommitTempoChange?.();
                      const ms = Math.round(res.deltaSec * 1000);
                      setAutoLockStatus({
                        clipId: menuClip.id,
                        label:
                          ms === 0 ? 'Locked (0ms)' : `Locked ${ms > 0 ? `+${ms}` : ms}ms`,
                      });
                    }
                    autoLockTimerRef.current = window.setTimeout(() => {
                      setAutoLockStatus(null);
                      autoLockTimerRef.current = null;
                    }, 2800);
                  }}
                  className="flex-1 px-2 py-1 rounded bg-om-positive/15 hover:bg-om-positive/25 disabled:opacity-40 disabled:cursor-not-allowed border border-om-positive/45 font-medium text-om-positive cursor-pointer text-center"
                  title={
                    overlapRef
                      ? `Auto-align this clip's kick transients directly to overlapping track "${overlapRef.asset.name}"`
                      : 'Overlap this clip with another track by at least 1 second to auto-lock beats'
                  }
                >
                  {activeFeedback ?? 'Auto-Lock Beats'}
                </button>

                {hasBpm && (
                  <button
                    type="button"
                    onClick={() => {
                      const subsequentIds =
                        project.rippleMove !== false
                          ? new Set(
                              project.tracks.flatMap((t) =>
                                t.clips
                                  .filter(
                                    (c) =>
                                      c.id !== menuClip.id && c.startSec > menuClip.startSec + 1e-4
                                  )
                                  .map((c) => c.id)
                              )
                            )
                          : undefined;
                      const alignedStart = snapClipStartToBeatGrid({
                        project,
                        rawStartSec: menuClip.startSec,
                        snapMode: 'bar',
                        offsetSec: menuClip.offsetSec,
                        durationSec: menuClip.durationSec,
                        stretchToMasterBpm: menuClip.stretchToMasterBpm,
                        asset: menuAsset,
                        assetsMap,
                        excludeClipId: menuClip.id,
                        excludeClipIds: subsequentIds,
                      });
                      onMoveClip(menuTrack.id, menuTrack.id, menuClip.id, alignedStart);
                      onCommitTempoChange?.();
                    }}
                    className="flex-1 px-2 py-1 rounded bg-om-secondary/15 hover:bg-om-secondary/25 border border-om-secondary/45 font-medium text-om-secondary cursor-pointer text-center"
                    title="Snap this clip's Beat 1 downbeat directly onto the overlapping track's beat grid"
                  >
                    Align to Mix Grid
                  </button>
                )}
              </div>
            )}

            {/* Gain, Pitch & Beat-Match Stretch */}
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-[11px] text-om-text-muted">
                  <span>Gain</span>
                  <input
                    type="number"
                    min={-24}
                    max={12}
                    step={0.5}
                    value={menuClip.gainDb}
                    onChange={(e) =>
                      onUpdateClip(menuTrack.id, menuClip.id, {
                        gainDb: Math.max(-24, Math.min(12, parseFloat(e.target.value) || 0)),
                      })
                    }
                    className="w-14 bg-om-base border border-white/[0.08] rounded px-1.5 py-0.5 font-mono tabular-nums text-[11px] text-om-text"
                  />
                  <span>dB</span>
                </label>

                <label className="flex items-center gap-1.5 text-[11px] text-om-text-muted">
                  <span>Pitch</span>
                  <input
                    type="number"
                    min={-12}
                    max={12}
                    step={0.5}
                    value={menuClip.pitchSemitones}
                    onChange={(e) => {
                      onUpdateClip(menuTrack.id, menuClip.id, {
                        pitchSemitones: Math.max(-12, Math.min(12, parseFloat(e.target.value) || 0)),
                      });
                      onCommitTempoChange?.();
                    }}
                    className="w-14 bg-om-base border border-white/[0.08] rounded px-1.5 py-0.5 font-mono tabular-nums text-[11px] text-om-text"
                  />
                  <span>st</span>
                </label>
              </div>

              <label className="inline-flex items-center gap-1.5 cursor-pointer text-[11px] text-om-text-secondary">
                <input
                  type="checkbox"
                  checked={menuClip.stretchToMasterBpm}
                  onChange={(e) => {
                    onUpdateClip(menuTrack.id, menuClip.id, {
                      stretchToMasterBpm: e.target.checked,
                    });
                    onCommitTempoChange?.();
                  }}
                  className="accent-om-secondary"
                />
                <span>
                  Beat-Match Stretch (
                  {menuClipBpmRange.isVariable
                    ? `${Math.round(menuClipBpmRange.minBpm)}→${Math.round(menuClipBpmRange.maxBpm)} BPM`
                    : `${Math.round(menuClipBpmRange.minBpm)} BPM`}
                  )
                </span>
              </label>
            </div>

            {/* Volume & Bass Fades + Curves */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <ClipFadeCard
                direction="in"
                trackId={menuTrack.id}
                clip={menuClip}
                onUpdateClip={onUpdateClip}
                onToggleVolumeFade={toggleClipVolumeFadeDirection}
                onToggleBassFade={toggleClipBassFadeDirection}
              />
              <ClipFadeCard
                direction="out"
                trackId={menuTrack.id}
                clip={menuClip}
                onUpdateClip={onUpdateClip}
                onToggleVolumeFade={toggleClipVolumeFadeDirection}
                onToggleBassFade={toggleClipBassFadeDirection}
              />
            </div>

            {/* Collapsible Sections Side-by-Side */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 items-start">
              {/* Collapsible: Beat Grid & Clip Nudge */}
              <div className="rounded border border-white/[0.08] bg-om-well overflow-hidden">
              <button
                type="button"
                onClick={() => setShowBeatGridEditor((v) => !v)}
                className="w-full px-2 py-1.5 flex items-center justify-between gap-2 hover:bg-white/[0.04] cursor-pointer text-left"
              >
                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-om-text-secondary">
                  <ChevronDown
                    className={`w-3 h-3 text-om-text-dim transition-transform ${
                      showBeatGridEditor ? '' : '-rotate-90'
                    }`}
                  />
                  <span>Beat Grid & Nudge</span>
                </span>
                {hasBpm && (
                  <span className="font-mono tabular-nums text-[10px] text-om-text-subtle">
                    Phase {Math.round(currentOffset * 1000)}ms
                  </span>
                )}
              </button>

              {showBeatGridEditor && (
                <div className="px-2 pb-2 pt-1 border-t border-white/[0.06] space-y-2 text-[10px]">
                  {hasBpm && menuAsset && onUpdateTrackBeatOffset && (
                    <div className="space-y-1">
                      <div className="text-om-text-subtle font-mono uppercase tracking-wider text-[9px]">
                        Beat Grid Phase
                      </div>
                      <div className="flex flex-wrap items-center gap-1">
                        {[
                          { label: '-10ms', delta: -0.01 },
                          { label: '-1ms', delta: -0.001 },
                          { label: '+1ms', delta: 0.001 },
                          { label: '+10ms', delta: 0.01 },
                        ].map((btn) => (
                          <button
                            key={btn.label}
                            type="button"
                            onClick={() => nudgeBeatOffset(btn.delta)}
                            className="px-1.5 py-0.5 rounded bg-om-hover hover:bg-om-control-hover border border-white/[0.08] font-mono text-om-text-secondary cursor-pointer"
                            title="Nudge this track's beat grid phase"
                          >
                            {btn.label}
                          </button>
                        ))}
                      </div>
                      <div className="flex flex-wrap items-center gap-1">
                        <button
                          type="button"
                          disabled={!playheadInsideClip}
                          onClick={() => {
                            const localOutSec = Math.max(0, project.playheadSec - menuClip.startSec);
                            const srcDelta = menuClip.stretchToMasterBpm
                              ? integrateClipSourceOffsetSec(
                                  project,
                                  menuClip.startSec,
                                  localOutSec,
                                  menuAsset.bpm
                                )
                              : localOutSec;
                            const srcTimeSec = menuClip.offsetSec + srcDelta;
                            const next =
                              (((srcTimeSec % barPeriodSec) + barPeriodSec) % barPeriodSec);
                            onUpdateTrackBeatOffset(menuAsset.id, Math.round(next * 10000) / 10000);
                          }}
                          className="px-2 py-0.5 rounded bg-om-control hover:bg-om-control-hover disabled:opacity-40 disabled:cursor-not-allowed border border-om-accent/35 font-medium text-om-accent cursor-pointer"
                          title={
                            playheadInsideClip
                              ? 'Mark the audio at the current playhead as Beat 1 (downbeat) of this track'
                              : 'Place playhead inside this clip on a downbeat kick to calibrate Beat 1'
                          }
                        >
                          Beat 1 = Playhead
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const detected = detectBeatOffsetForBuffer(
                              menuAsset.audioBuffer,
                              menuAsset.bpm
                            );
                            onUpdateTrackBeatOffset(
                              menuAsset.id,
                              Math.round(detected * 10000) / 10000
                            );
                          }}
                          className="px-2 py-0.5 rounded bg-om-hover hover:bg-om-control-hover border border-white/[0.08] text-om-text-muted hover:text-white cursor-pointer"
                          title="Re-detect downbeat transient phase from kick onset energy"
                        >
                          Auto Grid
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="space-y-1">
                    <div className="text-om-text-subtle font-mono uppercase tracking-wider text-[9px]">
                      Clip Nudge
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      {[
                        { label: '-100ms', delta: -0.1 },
                        { label: '-10ms', delta: -0.01 },
                        { label: '-1ms', delta: -0.001 },
                        { label: '+1ms', delta: 0.001 },
                        { label: '+10ms', delta: 0.01 },
                        { label: '+100ms', delta: 0.1 },
                      ].map((btn) => (
                        <button
                          key={btn.label}
                          type="button"
                          disabled={btn.delta < 0 && menuClip.startSec <= 0}
                          onClick={() => nudgeClipStart(btn.delta)}
                          className="px-1.5 py-0.5 rounded bg-om-hover hover:bg-om-control-hover disabled:opacity-40 disabled:cursor-not-allowed border border-om-secondary/25 font-mono text-om-text-secondary hover:text-white cursor-pointer"
                          title={`Move clip ${btn.delta < 0 ? 'earlier' : 'later'} on the timeline by ${Math.abs(Math.round(btn.delta * 1000))}ms`}
                        >
                          {btn.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Collapsible: Mix Transition */}
            <div className="rounded border border-white/[0.08] bg-om-well overflow-hidden">
              <button
                type="button"
                onClick={() => setShowClipMixEditor((v) => !v)}
                className="w-full px-2 py-1.5 flex items-center justify-between gap-2 hover:bg-white/[0.04] cursor-pointer text-left"
              >
                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-om-text-secondary">
                  <ChevronDown
                    className={`w-3 h-3 text-om-text-dim transition-transform ${
                      showClipMixEditor ? '' : '-rotate-90'
                    }`}
                  />
                  <ArrowLeftRight
                    className={`w-3 h-3 ${
                      inBadges.length > 0 || outBadges.length > 0
                        ? 'text-om-positive'
                        : 'text-om-text-dim'
                    }`}
                  />
                  <span
                    className={
                      inBadges.length > 0 || outBadges.length > 0 ? 'text-om-positive' : undefined
                    }
                  >
                    Mix Transition
                  </span>
                </span>
                {(inBadges.length > 0 || outBadges.length > 0) && (
                  <span className="font-mono text-[9px] text-om-positive truncate max-w-[130px]">
                    {(inBadges.length > 0 ? inBadges : outBadges).slice(0, 2).join(' · ')}
                  </span>
                )}
              </button>

              {showClipMixEditor && (
                <div className="px-2 pb-2 pt-1.5 border-t border-white/[0.06] space-y-2 text-[11px]">
                  <div className="flex items-center justify-between gap-2">
                    <div className="inline-flex rounded bg-om-base border border-white/[0.08] p-0.5">
                      <button
                        type="button"
                        onClick={() => setClipMixDirection('in')}
                        className={`px-2 py-0.5 rounded text-[10px] font-medium cursor-pointer ${
                          clipMixDirection === 'in'
                            ? 'bg-om-positive text-om-accent-ink font-semibold'
                            : 'text-om-text-dim hover:text-white'
                        }`}
                      >
                        Mix In
                      </button>
                      <button
                        type="button"
                        onClick={() => setClipMixDirection('out')}
                        className={`px-2 py-0.5 rounded text-[10px] font-medium cursor-pointer ${
                          clipMixDirection === 'out'
                            ? 'bg-om-secondary text-om-accent-ink font-semibold'
                            : 'text-om-text-dim hover:text-white'
                        }`}
                      >
                        Mix Out
                      </button>
                    </div>

                    <label
                      className="inline-flex items-center gap-1 text-[10px] text-om-text-muted cursor-pointer"
                      title="Keep paired outgoing/incoming clip synchronized when editing this transition"
                    >
                      <input
                        type="checkbox"
                        checked={syncPairedClip}
                        onChange={(e) => setSyncPairedClip(e.target.checked)}
                        className="accent-om-positive"
                      />
                      <span>Sync Pair</span>
                    </label>
                  </div>

                  {/* Overlap Bars + Re-align */}
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-[10px] text-om-text-dim">Overlap:</span>
                    {[2, 4, 8, 16].map((b) => (
                      <button
                        key={b}
                        type="button"
                        onClick={() => {
                          if (clipMixDirection === 'in' && hasPrevCandidate) {
                            applyEnvPatch({ overlapBars: b }, true);
                          } else {
                            const dur =
                              clipMixDirection === 'in'
                                ? getOverlapDurationFromStart(project, menuClip.startSec, b)
                                : getOverlapDurationBeforeTime(
                                    project,
                                    menuClip.startSec + menuClip.durationSec,
                                    b
                                  );
                            applyEnvPatch({ overlapBars: b, durationSec: dur }, false);
                          }
                        }}
                        className={`px-1.5 py-0.5 rounded text-[10px] font-mono border cursor-pointer ${
                          activeEnv?.overlapBars === b
                            ? 'bg-om-accent/20 border-om-accent/60 text-om-accent'
                            : 'bg-om-base border-white/[0.08] text-om-text-dim hover:text-white'
                        }`}
                      >
                        {b}B
                      </button>
                    ))}
                    <input
                      type="number"
                      min={0}
                      max={64}
                      step={1}
                      value={activeEnv?.overlapBars ?? mixDefaults.overlapBars}
                      onChange={(e) => {
                        const bars = clampOverlapBars(parseFloat(e.target.value));
                        if (clipMixDirection === 'in' && hasPrevCandidate) {
                          applyEnvPatch({ overlapBars: bars }, true);
                        } else {
                          const dur =
                            clipMixDirection === 'in'
                              ? getOverlapDurationFromStart(project, menuClip.startSec, bars)
                              : getOverlapDurationBeforeTime(
                                  project,
                                  menuClip.startSec + menuClip.durationSec,
                                  bars
                                );
                          applyEnvPatch({ overlapBars: bars, durationSec: dur }, false);
                        }
                      }}
                      className="w-11 bg-om-base border border-white/[0.08] rounded px-1 py-0.5 font-mono tabular-nums text-[10px] text-om-text"
                    />
                    {clipMixDirection === 'in' && hasPrevCandidate && (
                      <button
                        type="button"
                        onClick={() =>
                          applyEnvPatch(
                            { overlapBars: activeEnv?.overlapBars ?? mixDefaults.overlapBars },
                            true
                          )
                        }
                        className="px-1.5 py-0.5 rounded bg-om-control hover:bg-om-control-hover text-[10px] text-om-secondary cursor-pointer"
                        title="Snap clip start to overlap previous clip by selected bars"
                      >
                        Re-align
                      </button>
                    )}
                  </div>

                  {/* Vol XF + Bass Mode & Cut */}
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="inline-flex items-center gap-1 text-[10px] text-om-text-secondary cursor-pointer">
                      <input
                        type="checkbox"
                        checked={
                          activeEnv?.volumeCrossfade ??
                          (clipMixDirection === 'in' ? volInActive : volOutActive)
                        }
                        onChange={(e) => applyEnvPatch({ volumeCrossfade: e.target.checked })}
                        className="accent-om-accent"
                      />
                      <span>Vol XF</span>
                    </label>

                    <label className="flex items-center gap-1 text-[10px] text-om-text-muted">
                      <span>Bass</span>
                      <select
                        value={activeEnv?.bassMode ?? 'none'}
                        onChange={(e) =>
                          applyEnvPatch({ bassMode: e.target.value as BassMixMode })
                        }
                        className="bg-om-base border border-white/[0.08] rounded px-1 py-0.5 text-[10px] text-om-text"
                      >
                        <option value="none">None</option>
                        <option value="swap">Swap (Mid)</option>
                        <option value="crossfade">Crossfade</option>
                      </select>
                    </label>

                    {activeEnv && activeEnv.bassMode !== 'none' && (
                      <select
                        value={activeEnv.bassCutDb}
                        onChange={(e) =>
                          applyEnvPatch({ bassCutDb: clampBassCutDb(parseFloat(e.target.value)) })
                        }
                        className="bg-om-base border border-white/[0.08] rounded px-1 py-0.5 font-mono text-[10px] text-om-text"
                        title="Bass Cut Depth"
                      >
                        <option value={-12}>-12dB</option>
                        <option value={-18}>-18dB</option>
                        <option value={-24}>-24dB</option>
                        <option value={-36}>-36dB</option>
                      </select>
                    )}
                  </div>

                  {/* Mid, High & Filter */}
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1 text-[10px] text-om-text-muted">
                      <span>Mid</span>
                      <select
                        value={activeEnv?.midMode ?? 'none'}
                        onChange={(e) =>
                          applyEnvPatch({ midMode: e.target.value as EqBandMixMode })
                        }
                        className="bg-om-base border border-white/[0.08] rounded px-1 py-0.5 text-[10px] text-om-text"
                      >
                        <option value="none">Flat</option>
                        <option value="crossfade">XF</option>
                      </select>
                    </label>

                    <label className="flex items-center gap-1 text-[10px] text-om-text-muted">
                      <span>High</span>
                      <select
                        value={activeEnv?.highMode ?? 'none'}
                        onChange={(e) =>
                          applyEnvPatch({ highMode: e.target.value as EqBandMixMode })
                        }
                        className="bg-om-base border border-white/[0.08] rounded px-1 py-0.5 text-[10px] text-om-text"
                      >
                        <option value="none">Flat</option>
                        <option value="crossfade">XF</option>
                      </select>
                    </label>

                    <label className="flex items-center gap-1 text-[10px] text-om-text-muted">
                      <span>Filter</span>
                      <select
                        value={activeEnv?.filterMode ?? 'none'}
                        onChange={(e) =>
                          applyEnvPatch({ filterMode: e.target.value as FilterMixMode })
                        }
                        className="bg-om-base border border-white/[0.08] rounded px-1 py-0.5 text-[10px] text-om-text"
                      >
                        <option value="none">Off</option>
                        <option value="dual">Dual Sweep</option>
                        <option value="lpf-in">LPF In</option>
                        <option value="hpf-out">HPF Out</option>
                      </select>
                    </label>
                  </div>

                  {/* Apply Defaults / Clear */}
                  <div className="flex items-center justify-end gap-1.5 pt-0.5">
                    <button
                      type="button"
                      onClick={() => {
                        const seeded = buildSeededEnvelope(clipMixDirection);
                        const fresh = buildMixEnvelopeFromDefaults(
                          mixDefaults,
                          seeded.durationSec,
                          seeded.pairedClipId
                        );
                        onUpdateClipTransition(menuTrack.id, menuClip.id, clipMixDirection, fresh, {
                          realignToPrev: clipMixDirection === 'in' && hasPrevCandidate,
                          syncPair: syncPairedClip,
                        });
                      }}
                      className="px-2 py-0.5 rounded bg-om-control hover:bg-om-control-hover text-[10px] text-om-positive cursor-pointer"
                      title="Apply current Auto-Mix Defaults to this transition"
                    >
                      Apply Defaults
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        onUpdateClipTransition(
                          menuTrack.id,
                          menuClip.id,
                          clipMixDirection,
                          undefined,
                          { syncPair: syncPairedClip }
                        )
                      }
                      className="px-2 py-0.5 rounded bg-om-control hover:text-om-danger text-[10px] text-om-text-dim cursor-pointer"
                      title="Clear this transition"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              )}
            </div>
            </div>
          </div>
        );
      })()}

      <SuperZoomModal
        isOpen={showSuperZoom}
        onClose={() => setShowSuperZoom(false)}
        project={project}
        assetsMap={assetsMap}
        initialSelectedClipRef={selectedClipRef}
        onSelectClipRef={setSelectedClipRef}
        onUpdateProject={onUpdateProject}
        onTogglePlay={onTogglePlay}
        onStop={onStop}
        onSeek={onSeek}
        onUpdateTrack={onUpdateTrack}
        onMoveClip={onMoveClip}
        onCommitTempoChange={onCommitTempoChange}
        onUpdateTrackBeatOffset={onUpdateTrackBeatOffset}
      />
    </div>
  );
};
