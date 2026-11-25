import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Crosshair,
  LocateFixed,
  Maximize2,
  Pause,
  Play,
  RotateCcw,
  SlidersHorizontal,
  Square,
  Volume2,
  VolumeX,
  Wand2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  ALL_MUSICAL_KEYS,
  detectBeatOffsetForBuffer,
  detectBpmAndOffset,
  detectBpmAndOffsetAroundTime,
  formatTimecode,
  getCamelotForKey,
} from '../audio/analysis';
import { nleEngine } from '../audio/nleEngine';
import { useTheme } from '../theme/themes';
import type { TrackAsset } from '../types/audio';

interface BeatgridEditorModalProps {
  track: TrackAsset | null;
  initialBpm?: number;
  initialKey?: string;
  onClose: () => void;
  onSave: (trackId: string, bpm: number, musicalKey: string, beatOffsetSec: number) => void;
}

const MIN_BPM = 40;
const MAX_BPM = 240;
const MIN_ZOOM = 8;
const MAX_ZOOM = 2400;
const RULER_HEIGHT = 28;
const WAVEFORM_HEIGHT = 236;
const OVERVIEW_HEIGHT = 48;
const BEAT_HIT_TOLERANCE_PX = 9;

function formatTimecodeMs(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const ms = Math.floor((safe - Math.floor(safe)) * 1000);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function clampBpm(v: number): number {
  if (!Number.isFinite(v)) return 120;
  return Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(v * 100) / 100));
}

function clampZoom(v: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(v * 10) / 10));
}

function normalizeBeatOffset(offsetSec: number, bpm: number): number {
  const safeBpm = clampBpm(bpm);
  const barSec = (60 / safeBpm) * 4;
  if (!Number.isFinite(offsetSec) || barSec <= 0) return 0;
  const mod = ((offsetSec % barSec) + barSec) % barSec;
  return Math.round(mod * 10000) / 10000;
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return `rgba(245, 158, 11, ${alpha})`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Synthesizes a crisp, short metronome click directly on the Web Audio graph. */
function playMetronomeClick(isDownbeat: boolean): void {
  try {
    const ctx = nleEngine.getContext();
    if (ctx.state === 'suspended') return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(isDownbeat ? 1560 : 980, now);
    osc.frequency.exponentialRampToValueAtTime(isDownbeat ? 780 : 490, now + 0.025);
    gain.gain.setValueAtTime(isDownbeat ? 0.24 : 0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.032);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.036);
  } catch {
    // Ignore transient audio context errors
  }
}

export const BeatgridEditorModal: React.FC<BeatgridEditorModalProps> = ({
  track,
  initialBpm,
  initialKey,
  onClose,
  onSave,
}) => {
  const { theme } = useTheme();
  const isOpen = track !== null;

  const [draftBpm, setDraftBpm] = useState<number>(120);
  const [bpmInputStr, setBpmInputStr] = useState<string>('120');
  const [draftKey, setDraftKey] = useState<string>('Am');
  const [draftOffsetSec, setDraftOffsetSec] = useState<number>(0);

  const [zoomPxPerSec, setZoomPxPerSec] = useState<number>(120);
  const [scrollLeft, setScrollLeft] = useState<number>(0);
  const [viewportWidth, setViewportWidth] = useState<number>(860);
  const [verticalGain, setVerticalGain] = useState<1 | 2 | 3>(1);
  const [showHalfBeats, setShowHalfBeats] = useState<boolean>(true);
  const [metronomeEnabled, setMetronomeEnabled] = useState<boolean>(true);
  const [followPlayhead, setFollowPlayhead] = useState<boolean>(true);

  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playheadSec, setPlayheadSec] = useState<number>(0);
  const [hoverSec, setHoverSec] = useState<number | null>(null);
  const [hoverBeatIdx, setHoverBeatIdx] = useState<number | null>(null);
  const [dragHud, setDragHud] = useState<{
    mode: 'shift' | 'stretch';
    deltaMs: number;
    bpm: number;
    offsetSec: number;
    fineMode: boolean;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overviewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pendingZoomScrollRef = useRef<{ anchorSec: number; viewportOffsetPx: number } | null>(null);
  const suppressScrollEventRef = useRef(false);
  const tapTimesRef = useRef<number[]>([]);
  const lastClickedBeatRef = useRef<number | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  const draftBpmRef = useRef(draftBpm);
  const draftOffsetRef = useRef(draftOffsetSec);
  const zoomRef = useRef(zoomPxPerSec);
  const isPlayingRef = useRef(isPlaying);
  const playheadRef = useRef(playheadSec);
  const metronomeRef = useRef(metronomeEnabled);
  const followPlayheadRef = useRef(followPlayhead);
  const trackRef = useRef(track);
  const onCloseRef = useRef(onClose);

  draftBpmRef.current = draftBpm;
  draftOffsetRef.current = draftOffsetSec;
  zoomRef.current = zoomPxPerSec;
  isPlayingRef.current = isPlaying;
  playheadRef.current = playheadSec;
  metronomeRef.current = metronomeEnabled;
  followPlayheadRef.current = followPlayhead;
  trackRef.current = track;
  onCloseRef.current = onClose;

  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
    }
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null);
      noticeTimerRef.current = null;
    }, 2400);
  }, []);

  const stopPreviewPlayback = useCallback(() => {
    nleEngine.stopPreview();
    setIsPlaying(false);
    lastClickedBeatRef.current = null;
  }, []);

  const startPreviewFrom = useCallback((sec: number) => {
    const activeTrack = trackRef.current;
    if (!activeTrack) return;
    const clamped = Math.max(0, Math.min(sec, Math.max(0, activeTrack.duration - 0.05)));
    const beatPeriod = 60 / Math.max(MIN_BPM, draftBpmRef.current);
    lastClickedBeatRef.current = Math.floor(
      (clamped - draftOffsetRef.current) / beatPeriod
    );
    setPlayheadSec(clamped);
    setIsPlaying(true);
    nleEngine.playPreview(activeTrack, clamped, () => {
      setIsPlaying(false);
      lastClickedBeatRef.current = null;
    });
  }, []);

  const togglePlayback = useCallback(() => {
    if (isPlayingRef.current) {
      stopPreviewPlayback();
    } else {
      startPreviewFrom(playheadRef.current);
    }
  }, [startPreviewFrom, stopPreviewPlayback]);

  const activeTrackId = track?.id ?? null;

  // Initialize state whenever a track is opened in the editor
  useEffect(() => {
    const activeTrack = trackRef.current;
    if (!activeTrackId || !activeTrack) {
      if (isPlayingRef.current) {
        stopPreviewPlayback();
      }
      return;
    }
    nleEngine.stop();
    nleEngine.stopPreview();

    const startBpm = clampBpm(initialBpm ?? activeTrack.bpm);
    const startKey = initialKey ?? activeTrack.musicalKey;
    const startOffset = normalizeBeatOffset(
      Number.isFinite(activeTrack.beatOffsetSec) ? activeTrack.beatOffsetSec : 0,
      startBpm
    );

    setDraftBpm(startBpm);
    setBpmInputStr(String(startBpm));
    setDraftKey(startKey);
    setDraftOffsetSec(startOffset);
    setIsPlaying(false);
    setPlayheadSec(startOffset);
    setHoverSec(null);
    setHoverBeatIdx(null);
    setDragHud(null);
    setNotice(null);
    tapTimesRef.current = [];
    lastClickedBeatRef.current = null;

    const raf = requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      if (!scroller) return;
      const w = Math.max(320, scroller.clientWidth);
      setViewportWidth((prev) => (prev === w ? prev : w));
      // Show ~8 bars (32 beats) initially so individual kicks & beat markers are immediately crisp
      const eightBarsSec = Math.max(4, Math.min(activeTrack.duration, (60 / startBpm) * 32));
      const initialZoom = clampZoom(w / eightBarsSec);
      setZoomPxPerSec(initialZoom);
      suppressScrollEventRef.current = true;
      scroller.scrollLeft = 0;
      setScrollLeft((prev) => (prev === 0 ? prev : 0));
      requestAnimationFrame(() => {
        suppressScrollEventRef.current = false;
      });
    });

    return () => {
      cancelAnimationFrame(raf);
      nleEngine.stopPreview();
      if (noticeTimerRef.current !== null) {
        window.clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = null;
      }
    };
  }, [activeTrackId, initialBpm, initialKey, stopPreviewPlayback]);

  // Measure waveform viewport width responsively
  useEffect(() => {
    if (!isOpen) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    let rafId = 0;
    const updateSize = () => {
      rafId = 0;
      if (scroller.clientWidth <= 0) return;
      const next = Math.max(320, scroller.clientWidth);
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

  // Playhead animation loop + audible metronome clicks while previewing
  useEffect(() => {
    if (!isPlaying || !track) return;
    let rafId = 0;

    const tick = () => {
      const pos = nleEngine.getPreviewPositionSec();
      setPlayheadSec(pos);

      // Fire audible metronome click on each beat boundary crossing
      if (metronomeRef.current) {
        const beatPeriod = 60 / Math.max(MIN_BPM, draftBpmRef.current);
        const curBeatIdx = Math.floor((pos - draftOffsetRef.current + 0.004) / beatPeriod);
        if (lastClickedBeatRef.current === null) {
          lastClickedBeatRef.current = curBeatIdx;
        } else if (curBeatIdx > lastClickedBeatRef.current) {
          const isDownbeat = ((curBeatIdx % 4) + 4) % 4 === 0;
          playMetronomeClick(isDownbeat);
          lastClickedBeatRef.current = curBeatIdx;
        }
      }

      // Smoothly page-turn scroll when playhead leaves visible window
      if (followPlayheadRef.current && scrollRef.current) {
        const scroller = scrollRef.current;
        const z = zoomRef.current;
        const px = pos * z;
        const leftEdge = scroller.scrollLeft;
        const rightEdge = leftEdge + scroller.clientWidth;
        const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
        if (px > rightEdge - 48 || px < leftEdge) {
          const nextLeft = Math.max(0, Math.min(maxScroll, px - scroller.clientWidth * 0.2));
          if (Math.abs(nextLeft - leftEdge) > 1) {
            scroller.scrollLeft = nextLeft;
            const actual = scroller.scrollLeft;
            setScrollLeft((prev) => (Math.abs(prev - actual) < 0.5 ? prev : actual));
          }
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, activeTrackId]);

  // Restore anchor scroll position after zoom change
  useLayoutEffect(() => {
    const pending = pendingZoomScrollRef.current;
    const scroller = scrollRef.current;
    if (!pending || !scroller) return;
    pendingZoomScrollRef.current = null;
    const targetLeft = Math.max(0, pending.anchorSec * zoomPxPerSec - pending.viewportOffsetPx);
    suppressScrollEventRef.current = true;
    scroller.scrollLeft = targetLeft;
    const actualLeft = scroller.scrollLeft;
    setScrollLeft((prev) => (Math.abs(prev - actualLeft) < 0.5 ? prev : actualLeft));
    requestAnimationFrame(() => {
      suppressScrollEventRef.current = false;
    });
  }, [zoomPxPerSec]);

  // Mouse wheel zoom on waveform scroller (Ctrl/Cmd+wheel or vertical wheel without Shift)
  useEffect(() => {
    if (!isOpen) return;
    const scroller = scrollRef.current;
    if (!scroller) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      if (e.deltaY === 0) return;
      e.preventDefault();
      e.stopPropagation();

      const curZoom = zoomRef.current;
      const clampedDelta = Math.max(-180, Math.min(180, e.deltaY));
      const factor = Math.exp(-clampedDelta * 0.003);
      const nextZoom = clampZoom(curZoom * factor);
      if (nextZoom === curZoom) return;

      const rect = scroller.getBoundingClientRect();
      const offsetX = Math.max(0, Math.min(scroller.clientWidth, e.clientX - rect.left));
      const anchorSec = (scroller.scrollLeft + offsetX) / curZoom;
      pendingZoomScrollRef.current = { anchorSec, viewportOffsetPx: offsetX };
      setZoomPxPerSec(nextZoom);
    };

    scroller.addEventListener('wheel', handleWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', handleWheel);
  }, [isOpen]);

  const applyBpm = useCallback((nextBpm: number) => {
    const valid = clampBpm(nextBpm);
    setDraftBpm(valid);
    setBpmInputStr(String(valid));
  }, []);

  const nudgeOffsetMs = useCallback((deltaMs: number) => {
    setDraftOffsetSec((prev) =>
      normalizeBeatOffset(prev + deltaMs / 1000, draftBpmRef.current)
    );
  }, []);

  const shiftDownbeatByBeats = useCallback(
    (deltaBeats: number) => {
      const beatSec = 60 / Math.max(MIN_BPM, draftBpmRef.current);
      setDraftOffsetSec((prev) =>
        normalizeBeatOffset(prev + deltaBeats * beatSec, draftBpmRef.current)
      );
      showNotice(
        deltaBeats > 0 ? 'Shifted downbeat +1 beat' : 'Shifted downbeat -1 beat'
      );
    },
    [showNotice]
  );

  const handleSetDownbeatAtPlayhead = useCallback(() => {
    const nextOffset = normalizeBeatOffset(playheadRef.current, draftBpmRef.current);
    setDraftOffsetSec(nextOffset);
    showNotice(`Beat 1 locked at ${formatTimecodeMs(playheadRef.current)}`);
  }, [showNotice]);

  const handleAutoDetectGrid = useCallback(() => {
    const activeTrack = trackRef.current;
    if (!activeTrack) return;
    const detected = detectBeatOffsetForBuffer(activeTrack.audioBuffer, draftBpmRef.current);
    const normalized = normalizeBeatOffset(detected, draftBpmRef.current);
    setDraftOffsetSec(normalized);
    showNotice(`Mixxx phase-locked grid (${(normalized * 1000).toFixed(1)} ms)`);
  }, [showNotice]);

  const handleDetectFullTrack = useCallback(() => {
    const activeTrack = trackRef.current;
    if (!activeTrack) return;
    const result = detectBpmAndOffset(activeTrack.audioBuffer);
    const nextBpm = clampBpm(result.bpm);
    const normalizedOffset = normalizeBeatOffset(result.beatOffsetSec, nextBpm);
    applyBpm(nextBpm);
    setDraftOffsetSec(normalizedOffset);
    showNotice(
      `Mixxx QM detected ${nextBpm} BPM · ${(normalizedOffset * 1000).toFixed(1)} ms Beat 1`
    );
  }, [applyBpm, showNotice]);

  const handleDetectFromPlayhead = useCallback(() => {
    const activeTrack = trackRef.current;
    if (!activeTrack) return;
    const result = detectBpmAndOffsetAroundTime(activeTrack.audioBuffer, playheadRef.current);
    const nextBpm = clampBpm(result.bpm);
    const normalizedOffset = normalizeBeatOffset(result.beatOffsetSec, nextBpm);
    applyBpm(nextBpm);
    setDraftOffsetSec(normalizedOffset);
    showNotice(
      `Detected ${nextBpm} BPM from ${formatTimecode(result.windowStartSec)}–${formatTimecode(result.windowEndSec)} → 0:00`
    );
  }, [applyBpm, showNotice]);

  const handleTapTempo = useCallback(() => {
    const now = performance.now();
    const taps = tapTimesRef.current;
    if (taps.length > 0 && now - taps[taps.length - 1] > 2200) {
      taps.length = 0;
    }
    taps.push(now);
    if (taps.length > 8) taps.shift();

    if (taps.length >= 2) {
      let sumDiff = 0;
      for (let i = 1; i < taps.length; i++) {
        sumDiff += taps[i] - taps[i - 1];
      }
      const avgMs = sumDiff / (taps.length - 1);
      if (avgMs > 180 && avgMs < 1800) {
        const tappedBpm = clampBpm(Math.round((60000 / avgMs) * 10) / 10);
        applyBpm(tappedBpm);
        showNotice(`Tap Tempo: ${tappedBpm.toFixed(1)} BPM (${taps.length} taps)`);
      }
    } else {
      showNotice('Tap again in rhythm...');
    }
  }, [applyBpm, showNotice]);

  const stepZoom = useCallback((direction: 'in' | 'out') => {
    const scroller = scrollRef.current;
    const curZoom = zoomRef.current;
    const nextZoom = clampZoom(direction === 'in' ? curZoom * 1.5 : curZoom / 1.5);
    if (nextZoom === curZoom) return;
    if (scroller) {
      const phX = playheadRef.current * curZoom - scroller.scrollLeft;
      const phVisible = phX >= 0 && phX <= scroller.clientWidth;
      pendingZoomScrollRef.current = {
        anchorSec: phVisible
          ? playheadRef.current
          : (scroller.scrollLeft + scroller.clientWidth / 2) / curZoom,
        viewportOffsetPx: phVisible ? phX : scroller.clientWidth / 2,
      };
    }
    setZoomPxPerSec(nextZoom);
  }, []);

  const handleFitFullTrack = useCallback(() => {
    const activeTrack = trackRef.current;
    const scroller = scrollRef.current;
    if (!activeTrack || !scroller) return;
    pendingZoomScrollRef.current = null;
    const w = Math.max(320, scroller.clientWidth);
    const fitZoom = clampZoom(w / Math.max(1, activeTrack.duration));
    setZoomPxPerSec(fitZoom);
    scroller.scrollLeft = 0;
    setScrollLeft(0);
  }, []);

  const handleZoomToBars = useCallback((bars: number) => {
    const activeTrack = trackRef.current;
    const scroller = scrollRef.current;
    if (!activeTrack || !scroller) return;
    const w = Math.max(320, scroller.clientWidth);
    const spanSec = Math.max(1, (60 / Math.max(MIN_BPM, draftBpmRef.current)) * 4 * bars);
    const targetZoom = clampZoom(w / spanSec);
    pendingZoomScrollRef.current = {
      anchorSec: playheadRef.current,
      viewportOffsetPx: w * 0.25,
    };
    setZoomPxPerSec(targetZoom);
  }, []);

  const jumpToBeatOne = useCallback(() => {
    const scroller = scrollRef.current;
    const target = draftOffsetRef.current;
    setPlayheadSec(target);
    if (isPlayingRef.current) {
      startPreviewFrom(target);
    }
    if (scroller) {
      const nextLeft = Math.max(0, target * zoomRef.current - scroller.clientWidth * 0.15);
      scroller.scrollLeft = nextLeft;
      setScrollLeft(nextLeft);
    }
  }, [startPreviewFrom]);

  const handleResetDraft = useCallback(() => {
    if (!track) return;
    const origBpm = clampBpm(track.bpm);
    const origOffset = normalizeBeatOffset(track.beatOffsetSec, origBpm);
    setDraftBpm(origBpm);
    setBpmInputStr(String(origBpm));
    setDraftKey(track.musicalKey);
    setDraftOffsetSec(origOffset);
    showNotice('Reverted to saved BPM, Key & beatgrid');
  }, [track, showNotice]);

  const handleCommitSave = useCallback(() => {
    if (!track) return;
    stopPreviewPlayback();
    const finalBpm = clampBpm(draftBpmRef.current);
    const finalOffset = normalizeBeatOffset(draftOffsetRef.current, finalBpm);
    onSave(track.id, finalBpm, draftKey, finalOffset);
    onClose();
  }, [track, draftKey, onSave, onClose, stopPreviewPlayback]);

  // Keyboard shortcuts while Beatgrid modal is open
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        stopPreviewPlayback();
        onCloseRef.current();
        return;
      }

      if (isInput) return;

      if (e.code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
        togglePlayback();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        const stepMs = e.shiftKey ? 0.5 : e.altKey ? 10 : 1;
        nudgeOffsetMs(-stepMs);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        const stepMs = e.shiftKey ? 0.5 : e.altKey ? 10 : 1;
        nudgeOffsetMs(stepMs);
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        stepZoom('in');
      } else if (e.key === '-') {
        e.preventDefault();
        stepZoom('out');
      } else if (e.key.toLowerCase() === 'b') {
        e.preventDefault();
        handleSetDownbeatAtPlayhead();
      } else if (e.key.toLowerCase() === 't') {
        e.preventDefault();
        handleTapTempo();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [
    isOpen,
    stopPreviewPlayback,
    togglePlayback,
    nudgeOffsetMs,
    stepZoom,
    handleSetDownbeatAtPlayhead,
    handleTapTempo,
  ]);

  const duration = track?.duration ?? 0;
  const totalContentWidthPx = Math.max(viewportWidth, Math.ceil(duration * zoomPxPerSec));
  const visibleStartSec = scrollLeft / zoomPxPerSec;
  const visibleEndSec = visibleStartSec + viewportWidth / zoomPxPerSec;

  const beatPeriodSec = 60 / Math.max(MIN_BPM, draftBpm);

  // Render full-track overview minimap canvas
  useEffect(() => {
    const canvas = overviewCanvasRef.current;
    if (!canvas || !track || viewportWidth <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(100, Math.round(viewportWidth));
    const h = OVERVIEW_HEIGHT;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Background well
    ctx.fillStyle = theme.canvas.bgDeepest;
    ctx.fillRect(0, 0, w, h);

    const peaks = track.waveformPeaks;
    const { low, mid, high } = track.waveformBands;
    const count = peaks.length;
    const midY = h * 0.5;
    const halfH = h * 0.44;

    if (count > 0) {
      for (let x = 0; x < w; x++) {
        const bStart = Math.floor((x / w) * count);
        const bEnd = Math.max(bStart + 1, Math.floor(((x + 1) / w) * count));
        let maxP = 0;
        let maxL = 0;
        let maxM = 0;
        let maxHi = 0;
        for (let b = bStart; b < bEnd && b < count; b++) {
          if (peaks[b] > maxP) maxP = peaks[b];
          if (low[b] > maxL) maxL = low[b];
          if (mid[b] > maxM) maxM = mid[b];
          if (high[b] > maxHi) maxHi = high[b];
        }
        const total = maxL + maxM + maxHi + 1e-5;
        const lowRatio = maxL / total;
        const highRatio = maxHi / total;
        ctx.fillStyle =
          lowRatio > 0.46
            ? hexToRgba(theme.canvas.accent, 0.78)
            : highRatio > 0.34
              ? hexToRgba(theme.canvas.secondaryBright, 0.72)
              : hexToRgba(theme.canvas.secondary, 0.6);

        const barH = Math.max(1.2, maxP * halfH * 2);
        ctx.fillRect(x, midY - barH * 0.5, 1, barH);
      }
    }

    // Current viewport highlight window
    if (duration > 0) {
      const vx0 = Math.max(0, (visibleStartSec / duration) * w);
      const vx1 = Math.min(w, (visibleEndSec / duration) * w);
      const vw = Math.max(8, vx1 - vx0);

      // Dim regions outside current view
      ctx.fillStyle = 'rgba(0, 0, 0, 0.48)';
      if (vx0 > 0) ctx.fillRect(0, 0, vx0, h);
      if (vx0 + vw < w) ctx.fillRect(vx0 + vw, 0, w - (vx0 + vw), h);

      ctx.fillStyle = theme.canvas.accentFillSoftRgba;
      ctx.fillRect(vx0, 0, vw, h);
      ctx.strokeStyle = theme.canvas.accentLineRgba;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(vx0 + 0.75, 0.75, Math.max(1, vw - 1.5), h - 1.5);

      // Playhead line in overview
      const phX = Math.max(0, Math.min(w, (playheadSec / duration) * w));
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(Math.round(phX) - 0.5, 0, 1.5, h);
    }
  }, [track, viewportWidth, duration, visibleStartSec, visibleEndSec, playheadSec, theme]);

  // Render high-resolution PCM waveform + interactive beat markers canvas
  useEffect(() => {
    const canvas = waveCanvasRef.current;
    if (!canvas || !track || viewportWidth <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(100, Math.round(viewportWidth));
    const totalH = RULER_HEIGHT + WAVEFORM_HEIGHT;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(totalH * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(totalH * dpr);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, totalH);

    const timeToX = (sec: number) => (sec - visibleStartSec) * zoomPxPerSec;

    // 1. Ruler background
    ctx.fillStyle = theme.canvas.bgPanel;
    ctx.fillRect(0, 0, w, RULER_HEIGHT);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.fillRect(0, RULER_HEIGHT - 1, w, 1);

    // 2. Waveform lane background + center line
    ctx.fillStyle = theme.canvas.bgDeepest;
    ctx.fillRect(0, RULER_HEIGHT, w, WAVEFORM_HEIGHT);
    const waveTop = RULER_HEIGHT;
    const midY = waveTop + WAVEFORM_HEIGHT * 0.5;
    const waveHalfH = (WAVEFORM_HEIGHT - 28) * 0.48;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.fillRect(0, Math.round(midY) + 0.5, w, 1);

    // 3. Ruler time ticks
    const minLabelPx = 88;
    const candidateSteps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
    const secStep =
      candidateSteps.find((s) => s * zoomPxPerSec >= minLabelPx) ?? 60;
    const firstTickSec = Math.floor(Math.max(0, visibleStartSec) / secStep) * secStep;
    ctx.font = '500 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    for (let t = firstTickSec; t <= Math.min(duration, visibleEndSec + secStep); t += secStep) {
      const x = Math.round(timeToX(t)) + 0.5;
      if (x < -20 || x > w + 20) continue;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.fillRect(x, RULER_HEIGHT - 7, 1, 7);
      ctx.fillStyle = theme.canvas.textMuted;
      ctx.fillText(secStep < 1 ? formatTimecodeMs(t) : formatTimecode(t), x + 4, RULER_HEIGHT - 10);
    }

    // 4. High-resolution PCM waveform directly from AudioBuffer
    const buf = track.audioBuffer;
    const sampleRate = buf.sampleRate;
    const totalSamples = buf.length;
    const ch0 = buf.getChannelData(0);
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;

    const drawStartSec = Math.max(0, visibleStartSec);
    const drawEndSec = Math.min(duration, visibleEndSec);
    const xStart = Math.max(0, Math.floor(timeToX(drawStartSec)));
    const xEnd = Math.min(w, Math.ceil(timeToX(drawEndSec)));

    if (xEnd > xStart) {
      const samplesPerPx =
        ((drawEndSec - drawStartSec) * sampleRate) / Math.max(1, xEnd - xStart);
      const waveCoreColor = hexToRgba(theme.canvas.secondaryBright, 0.82);
      const waveOuterColor = hexToRgba(theme.canvas.secondary, 0.28);

      if (samplesPerPx <= 2) {
        ctx.beginPath();
        ctx.strokeStyle = waveCoreColor;
        ctx.lineWidth = 1.5;
        let started = false;
        for (let px = xStart; px <= xEnd; px++) {
          const sec = visibleStartSec + px / zoomPxPerSec;
          if (sec < 0 || sec >= duration) continue;
          const idx = Math.min(totalSamples - 1, Math.max(0, Math.round(sec * sampleRate)));
          const val = ch1 ? (ch0[idx] + ch1[idx]) * 0.5 : ch0[idx];
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
        const maxScanSamples = 320;
        for (let px = xStart; px < xEnd; px++) {
          const t0 = visibleStartSec + px / zoomPxPerSec;
          const t1 = visibleStartSec + (px + 1) / zoomPxPerSec;
          if (t1 <= 0 || t0 >= duration) continue;

          const idx0 = Math.max(0, Math.floor(t0 * sampleRate));
          const idx1 = Math.min(totalSamples - 1, Math.max(idx0, Math.ceil(t1 * sampleRate)));
          const span = idx1 - idx0 + 1;
          const stride = span > maxScanSamples ? Math.ceil(span / maxScanSamples) : 1;

          let minV = 0;
          let maxV = 0;
          let sumSq = 0;
          let read = 0;
          for (let i = idx0; i <= idx1; i += stride) {
            const v = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
            if (v < minV) minV = v;
            if (v > maxV) maxV = v;
            sumSq += v * v;
            read++;
          }

          const gMin = Math.max(-1, Math.min(1, minV * verticalGain));
          const gMax = Math.max(-1, Math.min(1, maxV * verticalGain));
          const rms = read > 0 ? Math.min(1, Math.sqrt(sumSq / read) * verticalGain) : 0;

          const yTop = midY - gMax * waveHalfH;
          const yBot = midY - gMin * waveHalfH;
          const barH = Math.max(1.2, yBot - yTop);

          ctx.fillStyle = waveOuterColor;
          ctx.fillRect(px, yTop, 1, barH);

          ctx.fillStyle = waveCoreColor;
          const rmsH = Math.max(1, rms * waveHalfH * 2);
          ctx.fillRect(px, midY - rmsH * 0.5, 1, rmsH);
          ctx.fillRect(px, yTop, 1, 1.3);
          ctx.fillRect(px, yBot - 1.3, 1, 1.3);
        }
      }
    }

    // 5. Beat & Downbeat Markers overlaid on waveform
    const pxPerBeat = beatPeriodSec * zoomPxPerSec;
    const firstBeatIdx = Math.ceil((drawStartSec - draftOffsetSec - beatPeriodSec) / beatPeriodSec);
    const lastBeatIdx = Math.floor((drawEndSec - draftOffsetSec + beatPeriodSec) / beatPeriodSec);

    const drawHalf = showHalfBeats && pxPerBeat >= 80;
    const drawBeats = pxPerBeat >= 10;
    const step = drawHalf ? 0.5 : drawBeats ? 1 : 4;
    const maxMarkers = 1600;
    let count = 0;

    for (let beatVal = firstBeatIdx; beatVal <= lastBeatIdx && count < maxMarkers; beatVal += step) {
      count++;
      const beatSec = draftOffsetSec + beatVal * beatPeriodSec;
      if (beatSec < -0.001 || beatSec > duration + 0.001) continue;
      if (beatSec < visibleStartSec - 0.01 || beatSec > visibleEndSec + 0.01) continue;

      const isWhole = Math.abs(beatVal - Math.round(beatVal)) < 1e-4;
      const intIdx = Math.round(beatVal);
      const isDownbeat = isWhole && ((intIdx % 4) + 4) % 4 === 0;
      const isHovered = isWhole && hoverBeatIdx === intIdx;
      const isAnchorBeat = intIdx === 0;

      const mx = Math.round(timeToX(beatSec)) + 0.5;

      if (isDownbeat) {
        // Strong downbeat line
        ctx.fillStyle = isHovered ? '#FFFFFF' : theme.canvas.accentLineRgba;
        ctx.fillRect(mx - (isHovered ? 1 : 0.5), waveTop, isHovered ? 2.5 : 1.5, WAVEFORM_HEIGHT);

        // Top & bottom interactive diamond/triangle caps
        ctx.fillStyle = isHovered ? '#FFFFFF' : theme.canvas.accent;
        ctx.beginPath();
        ctx.moveTo(mx, waveTop + 10);
        ctx.lineTo(mx - 5.5, waveTop);
        ctx.lineTo(mx + 5.5, waveTop);
        ctx.closePath();
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(mx, totalH - 8);
        ctx.lineTo(mx - 4.5, totalH);
        ctx.lineTo(mx + 4.5, totalH);
        ctx.closePath();
        ctx.fill();

        // Bar label badge
        if (pxPerBeat * 4 >= 36) {
          const barNum = Math.floor(intIdx / 4) + 1;
          const label = isAnchorBeat ? `B${barNum} ★` : `B${barNum}`;
          ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace';
          const tw = ctx.measureText(label).width;
          ctx.fillStyle = isAnchorBeat
            ? theme.canvas.accent
            : 'rgba(11, 13, 16, 0.85)';
          ctx.fillRect(mx + 5, waveTop + 4, tw + 6, 14);
          ctx.fillStyle = isAnchorBeat ? '#090B0E' : theme.canvas.accentBright;
          ctx.fillText(label, mx + 8, waveTop + 14);
        }
      } else if (isWhole) {
        ctx.fillStyle = isHovered ? theme.canvas.accentBright : 'rgba(255, 255, 255, 0.55)';
        ctx.fillRect(mx, waveTop, isHovered ? 2 : 1, WAVEFORM_HEIGHT);

        // Top & bottom tick handles
        ctx.fillStyle = isHovered ? theme.canvas.accentBright : 'rgba(255, 255, 255, 0.85)';
        ctx.fillRect(mx - 2, waveTop, 5, 5);
        ctx.fillRect(mx - 2, totalH - 5, 5, 5);

        if (pxPerBeat >= 44) {
          const beatInBar = (((intIdx % 4) + 4) % 4) + 1;
          ctx.font = '500 9px ui-monospace, SFMono-Regular, Menlo, monospace';
          ctx.fillStyle = isHovered ? theme.canvas.accentBright : 'rgba(226, 232, 240, 0.78)';
          ctx.fillText(`.${beatInBar}`, mx + 4, waveTop + 13);
        }
      } else {
        // Half-beat dashed guide
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(mx, waveTop + 8);
        ctx.lineTo(mx, totalH - 8);
        ctx.stroke();
        ctx.restore();
      }
    }

    // 6. Hover guide line
    if (hoverSec !== null && hoverSec >= visibleStartSec && hoverSec <= visibleEndSec) {
      const hx = Math.round(timeToX(hoverSec)) + 0.5;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
      ctx.fillRect(hx, waveTop, 1, WAVEFORM_HEIGHT);
    }

    // 7. Playhead line & ruler cap
    if (playheadSec >= visibleStartSec - 0.02 && playheadSec <= visibleEndSec + 0.02) {
      const phX = Math.round(timeToX(playheadSec)) + 0.5;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(phX - 0.5, 0, 1.5, totalH);

      ctx.beginPath();
      ctx.moveTo(phX, RULER_HEIGHT + 2);
      ctx.lineTo(phX - 5, RULER_HEIGHT - 8);
      ctx.lineTo(phX + 5, RULER_HEIGHT - 8);
      ctx.closePath();
      ctx.fill();
    }
  }, [
    track,
    viewportWidth,
    duration,
    visibleStartSec,
    visibleEndSec,
    zoomPxPerSec,
    verticalGain,
    draftOffsetSec,
    beatPeriodSec,
    showHalfBeats,
    hoverBeatIdx,
    hoverSec,
    playheadSec,
    theme,
  ]);

  // Helper to locate nearest whole beat marker under a given client X in the waveform
  const findHitBeatAtSec = useCallback(
    (sec: number): { beatIdx: number; beatSec: number } | null => {
      const period = 60 / Math.max(MIN_BPM, draftBpmRef.current);
      const nearestIdx = Math.round((sec - draftOffsetRef.current) / period);
      const beatSec = draftOffsetRef.current + nearestIdx * period;
      if (beatSec < 0 || beatSec > duration) return null;
      const distPx = Math.abs(beatSec - sec) * zoomRef.current;
      if (distPx <= BEAT_HIT_TOLERANCE_PX) {
        return { beatIdx: nearestIdx, beatSec };
      }
      return null;
    },
    [duration]
  );

  // Pointer interaction on the waveform + ruler canvas
  const handleWavePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const localX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const localY = e.clientY - rect.top;
    const sec = Math.max(0, Math.min(duration, visibleStartSec + localX / zoomPxPerSec));
    setHoverSec(sec);

    if (localY >= RULER_HEIGHT) {
      const hit = findHitBeatAtSec(sec);
      setHoverBeatIdx(hit ? hit.beatIdx : null);
    } else {
      setHoverBeatIdx(null);
    }
  };

  const handleWavePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!track) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const localX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const localY = e.clientY - rect.top;
    const clickSec = Math.max(0, Math.min(duration, visibleStartSec + localX / zoomPxPerSec));

    // Clicking in the ruler always scrubs playhead
    if (localY < RULER_HEIGHT) {
      const seekAt = (clientX: number) => {
        const lx = Math.max(0, Math.min(rect.width, clientX - rect.left));
        const nextSec = Math.max(0, Math.min(duration, visibleStartSec + lx / zoomRef.current));
        setPlayheadSec(nextSec);
        if (isPlayingRef.current) {
          startPreviewFrom(nextSec);
        }
      };
      seekAt(e.clientX);
      const onMove = (ev: PointerEvent) => seekAt(ev.clientX);
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      return;
    }

    // Check if user grabbed a beat marker to drag it
    const hit = findHitBeatAtSec(clickSec);
    if (hit) {
      const startClientX = e.clientX;
      const origOffset = draftOffsetRef.current;
      const origBpm = draftBpmRef.current;
      const stretchMode = e.altKey && hit.beatIdx !== 0;

      const onMove = (ev: PointerEvent) => {
        const fine = ev.shiftKey;
        const sensitivity = fine ? 0.12 : 1;
        const deltaPx = (ev.clientX - startClientX) * sensitivity;
        const deltaSec = deltaPx / zoomRef.current;

        if (stretchMode) {
          // Keep anchor Beat 0 locked and stretch/compress BPM so dragged beat follows pointer
          const targetBeatSec = hit.beatSec + deltaSec;
          const spanFromAnchor = targetBeatSec - origOffset;
          const newBeatPeriod = spanFromAnchor / hit.beatIdx;
          if (newBeatPeriod > 0.22 && newBeatPeriod < 1.6) {
            const nextBpm = clampBpm(60 / newBeatPeriod);
            setDraftBpm(nextBpm);
            setBpmInputStr(String(nextBpm));
            setDragHud({
              mode: 'stretch',
              deltaMs: deltaSec * 1000,
              bpm: nextBpm,
              offsetSec: origOffset,
              fineMode: fine,
            });
          }
        } else {
          const nextOffset = normalizeBeatOffset(origOffset + deltaSec, origBpm);
          setDraftOffsetSec(nextOffset);
          setDragHud({
            mode: 'shift',
            deltaMs: deltaSec * 1000,
            bpm: origBpm,
            offsetSec: nextOffset,
            fineMode: fine,
          });
        }
      };

      const onUp = () => {
        setDragHud(null);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      return;
    }

    // Otherwise clicking empty waveform seeks playhead
    setPlayheadSec(clickSec);
    if (isPlayingRef.current) {
      startPreviewFrom(clickSec);
    }
  };

  // Click or drag on the overview minimap to jump/pan the zoomed window
  const handleOverviewPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!track || duration <= 0) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const scroller = scrollRef.current;

    const panToClientX = (clientX: number, alsoSeek: boolean) => {
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      const sec = ratio * duration;
      if (scroller) {
        const nextLeft = Math.max(0, sec * zoomRef.current - scroller.clientWidth * 0.5);
        scroller.scrollLeft = nextLeft;
        setScrollLeft(nextLeft);
      }
      if (alsoSeek) {
        setPlayheadSec(sec);
        if (isPlayingRef.current) {
          startPreviewFrom(sec);
        }
      }
    };

    panToClientX(e.clientX, true);
    const onMove = (ev: PointerEvent) => panToClientX(ev.clientX, false);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const hasChanges = useMemo(() => {
    if (!track) return false;
    return (
      Math.abs(draftBpm - track.bpm) > 0.001 ||
      draftKey !== track.musicalKey ||
      Math.abs(draftOffsetSec - normalizeBeatOffset(track.beatOffsetSec, track.bpm)) > 0.0005
    );
  }, [track, draftBpm, draftKey, draftOffsetSec]);

  if (!isOpen || !track) return null;

  const camelotCode = getCamelotForKey(draftKey);
  const currentBarBeat = (() => {
    const relBeats = (playheadSec - draftOffsetSec) / beatPeriodSec;
    const floored = Math.floor(relBeats + 1e-6);
    const bar = Math.floor(floored / 4) + 1;
    const beat = (((floored % 4) + 4) % 4) + 1;
    return `${bar}.${beat}`;
  })();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Beatgrid & BPM Editor — ${track.name}`}
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          stopPreviewPlayback();
          onClose();
        }
      }}
    >
      <div className="w-full max-w-5xl rounded-xl bg-om-panel border border-white/[0.12] shadow-2xl flex flex-col overflow-hidden select-none">
        {/* Header */}
        <div className="px-5 py-3.5 bg-om-elevated border-b border-white/[0.08] flex items-center justify-between gap-4">
          <div className="min-w-0 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-om-accent/15 border border-om-accent/35 flex items-center justify-center text-om-accent shrink-0">
              <SlidersHorizontal className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="font-display text-sm font-semibold text-om-text truncate">
                  {track.name}
                </h2>
                {hasChanges && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-om-accent/15 text-om-accent-bright border border-om-accent/30 shrink-0">
                    Modified
                  </span>
                )}
              </div>
              <p className="text-[11px] font-mono tabular-nums text-om-text-dim truncate">
                {formatTimecode(track.duration)} · {(track.sampleRate / 1000).toFixed(1)} kHz · Beat 1 Offset:{' '}
                <span className="text-om-accent-soft">{(draftOffsetSec * 1000).toFixed(1)} ms</span>
                {' · '}Pos: <span className="text-om-text-secondary">{formatTimecodeMs(playheadSec)}</span> (Bar {currentBarBeat})
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              stopPreviewPlayback();
              onClose();
            }}
            aria-label="Close Beatgrid Editor"
            className="p-1.5 rounded-md bg-om-control hover:bg-om-control-hover text-om-text-muted hover:text-om-text border border-white/[0.08] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Transport, Zoom & Beatgrid Toolbar */}
        <div className="px-5 py-2.5 bg-om-well border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
          {/* Left: Playback + Metronome */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={togglePlayback}
              title="Play / Pause Preview (Space)"
              className={`px-3 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer ${
                isPlaying
                  ? 'bg-om-accent text-om-accent-ink'
                  : 'bg-om-control hover:bg-om-control-hover text-om-text border border-white/[0.08]'
              }`}
            >
              {isPlaying ? <Pause className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current" />}
              <span>{isPlaying ? 'Pause' : 'Play'}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                stopPreviewPlayback();
                setPlayheadSec(draftOffsetSec);
              }}
              title="Stop & return to Beat 1"
              className="p-1.5 rounded-md bg-om-control hover:bg-om-control-hover text-om-text-muted hover:text-om-text border border-white/[0.08] cursor-pointer"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
            </button>
            <button
              type="button"
              onClick={jumpToBeatOne}
              title="Jump view & playhead to Beat 1"
              className="px-2 py-1.5 rounded-md bg-om-control hover:bg-om-control-hover text-[11px] font-mono text-om-text-secondary hover:text-om-text border border-white/[0.08] inline-flex items-center gap-1 cursor-pointer"
            >
              <LocateFixed className="w-3.5 h-3.5 text-om-accent" />
              <span>Beat 1</span>
            </button>
            <button
              type="button"
              aria-pressed={metronomeEnabled}
              onClick={() => setMetronomeEnabled((v) => !v)}
              title="Toggle audible beatgrid metronome click during playback"
              className={`px-2.5 py-1.5 rounded-md text-[11px] font-mono inline-flex items-center gap-1.5 border transition-colors cursor-pointer ${
                metronomeEnabled
                  ? 'bg-om-accent/15 border-om-accent/40 text-om-accent-bright'
                  : 'bg-om-control border-white/[0.08] text-om-text-muted hover:text-om-text'
              }`}
            >
              {metronomeEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
              <span>Click</span>
            </button>
          </div>

          {/* Right: Zoom, Gain, Follow & Sub-beat toggles */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => stepZoom('out')}
              title="Zoom Out (-)"
              className="p-1.5 rounded-md bg-om-control hover:bg-om-control-hover text-om-text-muted hover:text-om-text border border-white/[0.08] cursor-pointer"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => handleZoomToBars(4)}
              title="Zoom to 4 bars"
              className="px-2 py-1 rounded-md bg-om-control hover:bg-om-control-hover text-[11px] font-mono text-om-text-secondary hover:text-om-text border border-white/[0.08] cursor-pointer"
            >
              4 Bars
            </button>
            <button
              type="button"
              onClick={handleFitFullTrack}
              title="Fit entire track"
              className="px-2 py-1 rounded-md bg-om-control hover:bg-om-control-hover text-[11px] font-mono text-om-text-secondary hover:text-om-text border border-white/[0.08] inline-flex items-center gap-1 cursor-pointer"
            >
              <Maximize2 className="w-3 h-3" />
              <span>Fit</span>
            </button>
            <button
              type="button"
              onClick={() => stepZoom('in')}
              title="Zoom In (+)"
              className="p-1.5 rounded-md bg-om-control hover:bg-om-control-hover text-om-text-muted hover:text-om-text border border-white/[0.08] cursor-pointer"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>

            <div className="w-px h-4 bg-white/[0.1] mx-1" />

            <button
              type="button"
              onClick={() => setVerticalGain((g) => (g === 1 ? 2 : g === 2 ? 3 : 1))}
              title="Cycle waveform amplitude gain"
              className="px-2 py-1 rounded-md bg-om-control hover:bg-om-control-hover text-[11px] font-mono text-om-text-secondary hover:text-om-text border border-white/[0.08] cursor-pointer"
            >
              {verticalGain}× Gain
            </button>
            <button
              type="button"
              aria-pressed={showHalfBeats}
              onClick={() => setShowHalfBeats((v) => !v)}
              title="Show dashed half-beat guides when zoomed in"
              className={`px-2 py-1 rounded-md text-[11px] font-mono border cursor-pointer ${
                showHalfBeats
                  ? 'bg-om-control-hover border-white/[0.18] text-om-text'
                  : 'bg-om-control border-white/[0.08] text-om-text-muted'
              }`}
            >
              ½ Beats
            </button>
            <button
              type="button"
              aria-pressed={followPlayhead}
              onClick={() => setFollowPlayhead((v) => !v)}
              title="Auto-scroll waveform to follow playhead"
              className={`px-2 py-1 rounded-md text-[11px] font-mono border cursor-pointer ${
                followPlayhead
                  ? 'bg-om-control-hover border-white/[0.18] text-om-text'
                  : 'bg-om-control border-white/[0.08] text-om-text-muted'
              }`}
            >
              Follow
            </button>
          </div>
        </div>

        {/* Waveform Stage: Overview Minimap + Main Zoomed Interactive Waveform */}
        <div className="px-5 py-3.5 space-y-2.5 bg-om-base">
          {/* Full-track overview minimap */}
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[10px] font-mono text-om-text-faint">
              <span>TRACK OVERVIEW (Click or drag to navigate)</span>
              <span>
                {hoverSec !== null ? `Cursor: ${formatTimecodeMs(hoverSec)}` : `${Math.round(zoomPxPerSec)} px/s`}
              </span>
            </div>
            <div
              onPointerDown={handleOverviewPointerDown}
              className="relative w-full rounded-md overflow-hidden border border-white/[0.1] cursor-pointer"
              style={{ height: OVERVIEW_HEIGHT }}
            >
              <canvas
                ref={overviewCanvasRef}
                className="absolute inset-0 block w-full h-full pointer-events-none"
              />
            </div>
          </div>

          {/* Main scrollable high-res waveform + beatgrid */}
          <div className="relative rounded-md border border-white/[0.12] overflow-hidden bg-om-base">
            <div
              ref={scrollRef}
              onScroll={(e) => {
                if (suppressScrollEventRef.current) return;
                const next = e.currentTarget.scrollLeft;
                setScrollLeft((prev) => (Math.abs(prev - next) < 0.5 ? prev : next));
              }}
              className="w-full overflow-x-auto overflow-y-hidden"
            >
              <div
                style={{ width: totalContentWidthPx, height: RULER_HEIGHT + WAVEFORM_HEIGHT }}
                className="relative"
              >
                {/* Sticky viewport-sized canvas for crisp 60fps rendering at any zoom */}
                <div
                  onPointerMove={handleWavePointerMove}
                  onPointerLeave={() => {
                    setHoverSec(null);
                    setHoverBeatIdx(null);
                  }}
                  onPointerDown={handleWavePointerDown}
                  style={{
                    width: viewportWidth,
                    height: RULER_HEIGHT + WAVEFORM_HEIGHT,
                    cursor: hoverBeatIdx !== null ? 'ew-resize' : 'crosshair',
                  }}
                  className="sticky left-0 top-0"
                >
                  <canvas
                    ref={waveCanvasRef}
                    style={{ width: viewportWidth, height: RULER_HEIGHT + WAVEFORM_HEIGHT }}
                    className="block pointer-events-none"
                  />
                </div>
              </div>
            </div>

            {/* Live Drag / Stretch HUD */}
            {dragHud && (
              <div className="pointer-events-none absolute top-9 right-3 px-2.5 py-1.5 rounded-md bg-om-panel/95 border border-om-accent/50 shadow-lg text-[11px] font-mono tabular-nums text-om-text flex items-center gap-2">
                <span className="text-om-accent-bright font-semibold">
                  {dragHud.mode === 'stretch' ? 'Stretch BPM' : 'Shift Grid'}
                </span>
                <span>
                  {dragHud.mode === 'stretch'
                    ? `${dragHud.bpm.toFixed(2)} BPM`
                    : `${dragHud.deltaMs >= 0 ? '+' : ''}${dragHud.deltaMs.toFixed(1)} ms`}
                </span>
                {dragHud.fineMode && (
                  <span className="text-[10px] text-om-secondary-bright">FINE</span>
                )}
              </div>
            )}

            {/* Status toast inside waveform stage */}
            {notice && !dragHud && (
              <div className="pointer-events-none absolute top-9 right-3 px-2.5 py-1 rounded-md bg-om-elevated/95 border border-white/[0.15] shadow-lg text-[11px] font-mono text-om-accent-bright">
                {notice}
              </div>
            )}
          </div>
        </div>

        {/* Controls Deck: BPM, Beatgrid Adjustments, Key */}
        <div className="px-5 py-3.5 bg-om-panel border-t border-white/[0.08] grid grid-cols-1 lg:grid-cols-[1.15fr_1.45fr_0.75fr] gap-3">
          {/* BPM Section */}
          <div className="p-3 rounded-lg bg-om-well border border-white/[0.08] space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono uppercase tracking-wider text-om-text-dim">
                Tempo (BPM)
              </span>
              <span className="text-[10px] font-mono tabular-nums text-om-text-faint">
                {(beatPeriodSec * 1000).toFixed(1)} ms / beat
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => applyBpm(draftBpm - 0.1)}
                title="Decrease BPM by 0.1"
                className="px-2 py-1.5 rounded bg-om-control hover:bg-om-control-hover border border-white/[0.08] text-[11px] font-mono text-om-text cursor-pointer"
              >
                -0.1
              </button>
              <input
                type="number"
                step="0.01"
                min={MIN_BPM}
                max={MAX_BPM}
                value={bpmInputStr}
                onChange={(e) => {
                  const raw = e.target.value;
                  setBpmInputStr(raw);
                  const parsed = parseFloat(raw);
                  if (Number.isFinite(parsed) && parsed >= MIN_BPM && parsed <= MAX_BPM) {
                    setDraftBpm(Math.round(parsed * 100) / 100);
                  }
                }}
                onBlur={() => setBpmInputStr(String(draftBpm))}
                className="w-20 bg-om-elevated border border-white/[0.12] focus:border-om-accent/70 rounded px-2 py-1.5 text-xs font-mono tabular-nums text-om-text text-center focus:outline-none"
              />
              <button
                type="button"
                onClick={() => applyBpm(draftBpm + 0.1)}
                title="Increase BPM by 0.1"
                className="px-2 py-1.5 rounded bg-om-control hover:bg-om-control-hover border border-white/[0.08] text-[11px] font-mono text-om-text cursor-pointer"
              >
                +0.1
              </button>
              <button
                type="button"
                onClick={() => applyBpm(draftBpm / 2)}
                title="Halve BPM"
                className="px-2 py-1.5 rounded bg-om-control-alt hover:bg-om-control-hover text-[11px] font-mono text-om-text-secondary hover:text-om-text cursor-pointer"
              >
                ÷2
              </button>
              <button
                type="button"
                onClick={() => applyBpm(draftBpm * 2)}
                title="Double BPM"
                className="px-2 py-1.5 rounded bg-om-control-alt hover:bg-om-control-hover text-[11px] font-mono text-om-text-secondary hover:text-om-text cursor-pointer"
              >
                ×2
              </button>
              <button
                type="button"
                onClick={handleTapTempo}
                title="Tap repeatedly to set BPM (Shortcut: T)"
                className="px-2.5 py-1.5 rounded bg-om-accent/15 hover:bg-om-accent/25 border border-om-accent/35 text-[11px] font-mono font-semibold text-om-accent-bright cursor-pointer"
              >
                Tap
              </button>
              <button
                type="button"
                onClick={handleDetectFullTrack}
                title="Run full-track Mixxx Queen Mary Complex Spectral Difference + constant-region BPM & Beat 1 detection"
                className="px-2 py-1.5 rounded bg-om-secondary/15 hover:bg-om-secondary/25 border border-om-secondary/35 text-[11px] font-medium text-om-secondary-bright inline-flex items-center gap-1 cursor-pointer"
              >
                <Wand2 className="w-3 h-3" />
                <span>Detect Track</span>
              </button>
              <button
                type="button"
                onClick={handleDetectFromPlayhead}
                title="Detect BPM & Beat 1 from a clean window around the current playhead and project backwards to 0:00"
                className="px-2 py-1.5 rounded bg-om-control hover:bg-om-control-hover border border-white/[0.08] text-[11px] font-medium text-om-secondary-bright inline-flex items-center gap-1 cursor-pointer"
              >
                <Wand2 className="w-3 h-3" />
                <span>Detect Here</span>
              </button>
            </div>
          </div>

          {/* Beatgrid Nudge & Downbeat Phase Section */}
          <div className="p-3 rounded-lg bg-om-well border border-white/[0.08] space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono uppercase tracking-wider text-om-text-dim">
                Beat Markers &amp; Downbeat Phase
              </span>
              <span className="text-[10px] font-mono tabular-nums text-om-accent-soft">
                Offset: {(draftOffsetSec * 1000).toFixed(1)} ms
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={handleSetDownbeatAtPlayhead}
                title="Lock Beat 1 (Downbeat) to current playhead position (Shortcut: B)"
                className="px-2.5 py-1.5 rounded bg-om-accent/15 hover:bg-om-accent/25 border border-om-accent/40 text-[11px] font-medium text-om-accent-bright inline-flex items-center gap-1 cursor-pointer"
              >
                <Crosshair className="w-3.5 h-3.5" />
                <span>Set Beat 1 Here</span>
              </button>

              <button
                type="button"
                onClick={() => shiftDownbeatByBeats(-1)}
                title="Shift Downbeat (B1) 1 beat left"
                className="px-2 py-1.5 rounded bg-om-control hover:bg-om-control-hover border border-white/[0.08] text-[11px] font-mono text-om-text-secondary hover:text-om-text inline-flex items-center gap-0.5 cursor-pointer"
              >
                <ArrowLeft className="w-3 h-3" />
                <span>1 Beat</span>
              </button>
              <button
                type="button"
                onClick={() => shiftDownbeatByBeats(1)}
                title="Shift Downbeat (B1) 1 beat right"
                className="px-2 py-1.5 rounded bg-om-control hover:bg-om-control-hover border border-white/[0.08] text-[11px] font-mono text-om-text-secondary hover:text-om-text inline-flex items-center gap-0.5 cursor-pointer"
              >
                <span>1 Beat</span>
                <ArrowRight className="w-3 h-3" />
              </button>

              <div className="w-px h-4 bg-white/[0.1] mx-0.5" />

              {([-10, -1, 1, 10] as const).map((ms) => (
                <button
                  key={ms}
                  type="button"
                  onClick={() => nudgeOffsetMs(ms)}
                  title={`Nudge beatgrid ${ms > 0 ? `+${ms}` : ms} ms`}
                  className="px-1.5 py-1.5 rounded bg-om-control hover:bg-om-control-hover border border-white/[0.08] text-[11px] font-mono tabular-nums text-om-text-secondary hover:text-om-text cursor-pointer"
                >
                  {ms > 0 ? `+${ms}` : ms}ms
                </button>
              ))}

              <button
                type="button"
                onClick={handleAutoDetectGrid}
                title="Mixxx-style Complex Spectral Difference phase lock for the current BPM"
                className="px-2 py-1.5 rounded bg-om-control hover:bg-om-control-hover border border-white/[0.08] text-[11px] font-medium text-om-secondary-bright inline-flex items-center gap-1 cursor-pointer"
              >
                <Wand2 className="w-3 h-3" />
                <span>Auto Phase</span>
              </button>
            </div>
          </div>

          {/* Musical Key Section */}
          <div className="p-3 rounded-lg bg-om-well border border-white/[0.08] space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono uppercase tracking-wider text-om-text-dim">
                Musical Key
              </span>
              <span className="text-[10px] font-mono text-om-secondary-bright">
                Camelot {camelotCode}
              </span>
            </div>
            <select
              value={draftKey}
              onChange={(e) => setDraftKey(e.target.value)}
              className="w-full bg-om-elevated border border-white/[0.12] focus:border-om-accent/70 rounded px-2.5 py-1.5 text-xs font-mono text-om-text focus:outline-none"
            >
              {ALL_MUSICAL_KEYS.map((k) => (
                <option key={k} value={k}>
                  {k} ({getCamelotForKey(k)})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Footer Actions & Quick Help */}
        <div className="px-5 py-3 bg-om-footer border-t border-white/[0.08] flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] text-om-text-faint">
            Drag any beat marker to align grid · <span className="text-om-text-dim">Alt+Drag</span> a beat to stretch BPM ·{' '}
            <span className="text-om-text-dim">Shift+Drag</span> for fine control · <span className="text-om-text-dim">←/→</span> nudge 1ms
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!hasChanges}
              onClick={handleResetDraft}
              className="px-2.5 py-1.5 rounded-md bg-om-control hover:bg-om-control-hover disabled:opacity-40 disabled:cursor-not-allowed border border-white/[0.08] text-xs text-om-text-secondary inline-flex items-center gap-1.5 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset</span>
            </button>
            <button
              type="button"
              onClick={() => {
                stopPreviewPlayback();
                onClose();
              }}
              className="px-3 py-1.5 rounded-md text-xs text-om-text-dim hover:text-om-text cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleCommitSave}
              className="px-4 py-1.5 rounded-md bg-om-accent hover:bg-om-accent-bright text-om-accent-ink text-xs font-semibold cursor-pointer transition-colors"
            >
              Save Beatgrid
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
