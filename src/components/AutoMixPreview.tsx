import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import {
  buildFilterSweepCurve,
  evaluateBassTransitionFraction,
  evaluateVolumeFadeGain,
  getBassSwapCenterFraction,
} from '../audio/mixTransitions';
import type { AutoMixDefaults, BassMixMode, FadeCurve } from '../types/audio';
import { useTheme } from '../theme/themes';

interface AutoMixPreviewProps {
  defaults: AutoMixDefaults;
}

const VIEW_W = 460;
const VIEW_H = 156;
const PAD_X = 8;
const USABLE_W = VIEW_W - PAD_X * 2;
const RULER_H = 20;
const LANE_A_Y = 24;
const LANE_B_Y = 88;
const LANE_H = 58;
const CLIP_HEADER_H = 14;
const BODY_H = LANE_H - CLIP_HEADER_H;
const PLAY_LOOP_MS = 4200;

function formatHz(hz: number): string {
  if (hz >= 1000) {
    return `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)} kHz`;
  }
  return `${Math.round(hz)} Hz`;
}

function formatDb(db: number): string {
  const rounded = Math.round(db);
  return rounded === 0 ? '0 dB' : `${rounded} dB`;
}

function generateMockWaveform(seedOffset: number, count: number): number[] {
  const bars: number[] = [];
  for (let i = 0; i < count; i++) {
    const phase = i + seedOffset;
    const isBeat = i % 4 === 0;
    const isOffBeat = i % 4 === 2;
    const harmonic =
      0.42 +
      0.22 * Math.sin(phase * 0.73) +
      0.14 * Math.cos(phase * 1.91) +
      0.08 * Math.sin(phase * 3.17);
    const punch = isBeat ? 0.24 : isOffBeat ? 0.1 : -0.04;
    bars.push(Math.max(0.18, Math.min(0.96, harmonic + punch)));
  }
  return bars;
}

function buildVolumePath(
  direction: 'in' | 'out',
  curve: FadeCurve,
  startX: number,
  width: number,
  bodyY: number,
  bodyH: number
): { linePath: string; shadePath: string } {
  const steps = curve === 'linear' ? 1 : 28;
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const xNorm = direction === 'in' ? t : 1 - t;
    const gain = evaluateVolumeFadeGain(xNorm, curve, 0);
    const px = startX + t * width;
    const py = bodyY + bodyH * (1 - gain);
    pts.push(`${px.toFixed(2)},${py.toFixed(2)}`);
  }
  const linePath = `M ${pts.join(' L ')}`;
  const shadePath =
    direction === 'in'
      ? `M ${startX.toFixed(2)},${bodyY} L ${pts.join(' L ')} Z`
      : `M ${pts.join(' L ')} L ${(startX + width).toFixed(2)},${bodyY} Z`;
  return { linePath, shadePath };
}

function buildBassPath(
  direction: 'in' | 'out',
  mode: Exclude<BassMixMode, 'none'>,
  cutDb: number,
  startX: number,
  width: number,
  bodyY: number,
  bodyH: number
): { linePath: string; shadePath: string; swapMidX: number; swapMidY: number } {
  const steps = mode === 'swap' ? 36 : 24;
  const depthRatio = Math.max(0.38, Math.min(0.95, Math.abs(cutDb) / 38));
  const maxDrop = (bodyH - 6) * depthRatio;
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const level = evaluateBassTransitionFraction(t, direction, mode, 0);
    const px = startX + t * width;
    const py = bodyY + 3 + maxDrop * (1 - level);
    pts.push(`${px.toFixed(2)},${py.toFixed(2)}`);
  }
  const bottomY = bodyY + bodyH;
  const linePath = `M ${pts.join(' L ')}`;
  const shadePath = `M ${startX.toFixed(2)},${bottomY} L ${pts.join(' L ')} L ${(startX + width).toFixed(2)},${bottomY} Z`;
  const centerFrac = getBassSwapCenterFraction(direction, 0);
  return {
    linePath,
    shadePath,
    swapMidX: startX + width * centerFrac,
    swapMidY: bodyY + 3 + maxDrop * 0.5,
  };
}

function buildFilterPath(
  direction: 'in' | 'out',
  values: Float32Array,
  startX: number,
  width: number,
  bodyY: number,
  bodyH: number
): { linePath: string; shadePath: string } {
  const logMin = Math.log(24);
  const logSpan = Math.log(20000) - logMin;
  const pts: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const t = i / (values.length - 1);
    const hz = Math.max(24, Math.min(20000, values[i]));
    const norm = Math.max(0, Math.min(1, (Math.log(hz) - logMin) / logSpan));
    const px = startX + t * width;
    // HPF sweeps up from bottom (cutting lows); LPF opens up from bottom to top (revealing highs)
    const py = bodyY + 4 + (bodyH - 8) * (1 - norm);
    pts.push(`${px.toFixed(2)},${py.toFixed(2)}`);
  }
  const linePath = `M ${pts.join(' L ')}`;
  const edgeY = direction === 'out' ? bodyY + bodyH : bodyY;
  const shadePath = `M ${startX.toFixed(2)},${edgeY} L ${pts.join(' L ')} L ${(startX + width).toFixed(2)},${edgeY} Z`;
  return { linePath, shadePath };
}

function buildEqContourPath(
  direction: 'in' | 'out',
  startX: number,
  width: number,
  bodyY: number,
  bodyH: number,
  cutRatio: number
): string {
  const steps = 20;
  const maxDrop = (bodyH - 8) * cutRatio;
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const smooth = 0.5 - 0.5 * Math.cos(Math.PI * t);
    const level = direction === 'in' ? smooth : 1 - smooth;
    const px = startX + t * width;
    const py = bodyY + 4 + maxDrop * (1 - level);
    pts.push(`${px.toFixed(2)},${py.toFixed(2)}`);
  }
  return `M ${pts.join(' L ')}`;
}

export const AutoMixPreview: React.FC<AutoMixPreviewProps> = ({ defaults }) => {
  const { theme } = useTheme();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [playheadNorm, setPlayheadNorm] = useState(0.5);
  const [isPlaying, setIsPlaying] = useState(false);
  const isScrubbingRef = useRef(false);

  const isOverlapActive = defaults.enabled && defaults.overlapBars > 0;

  const geometry = useMemo(() => {
    if (!isOverlapActive) {
      const midX = PAD_X + USABLE_W * 0.5;
      return {
        overlapStartX: midX,
        overlapEndX: midX,
        overlapW: 0,
        trackAStartX: PAD_X,
        trackAEndX: midX,
        trackBStartX: midX,
        trackBEndX: PAD_X + USABLE_W,
      };
    }
    const barScale = Math.log2(Math.max(1, defaults.overlapBars)) / Math.log2(64);
    const overlapFrac = Math.max(0.22, Math.min(0.66, 0.22 + barScale * 0.44));
    const overlapW = USABLE_W * overlapFrac;
    const sideW = (USABLE_W - overlapW) * 0.5;
    const overlapStartX = PAD_X + sideW;
    const overlapEndX = overlapStartX + overlapW;
    return {
      overlapStartX,
      overlapEndX,
      overlapW,
      trackAStartX: PAD_X,
      trackAEndX: overlapEndX,
      trackBStartX: overlapStartX,
      trackBEndX: PAD_X + USABLE_W,
    };
  }, [defaults.overlapBars, isOverlapActive]);

  const waveA = useMemo(() => generateMockWaveform(0, 76), []);
  const waveB = useMemo(() => generateMockWaveform(19, 76), []);

  // Playhead animation loop
  useEffect(() => {
    if (!isPlaying) return;
    let rafId = 0;
    let lastTs = performance.now();
    const tick = (now: number) => {
      const dt = now - lastTs;
      lastTs = now;
      setPlayheadNorm((prev) => {
        const next = prev + dt / PLAY_LOOP_MS;
        return next > 1 ? next - 1 : next;
      });
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying]);

  const updatePlayheadFromClientX = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const viewX = ((clientX - rect.left) / rect.width) * VIEW_W;
    const norm = Math.max(0, Math.min(1, (viewX - PAD_X) / USABLE_W));
    setPlayheadNorm(norm);
  };

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    isScrubbingRef.current = true;
    setIsPlaying(false);
    e.currentTarget.setPointerCapture(e.pointerId);
    updatePlayheadFromClientX(e.clientX);
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!isScrubbingRef.current) return;
    updatePlayheadFromClientX(e.clientX);
  };

  const handlePointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!isScrubbingRef.current) return;
    isScrubbingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const playheadX = PAD_X + playheadNorm * USABLE_W;

  // Evaluate exact filter curves
  const filterOut = useMemo(
    () => (isOverlapActive ? buildFilterSweepCurve('out', defaults.filterMode, 32) : null),
    [defaults.filterMode, isOverlapActive]
  );
  const filterIn = useMemo(
    () => (isOverlapActive ? buildFilterSweepCurve('in', defaults.filterMode, 32) : null),
    [defaults.filterMode, isOverlapActive]
  );

  // Build SVG paths for active overlap curves
  const curves = useMemo(() => {
    if (!isOverlapActive || geometry.overlapW <= 2) return null;
    const { overlapStartX, overlapW } = geometry;
    const bodyAY = LANE_A_Y + CLIP_HEADER_H;
    const bodyBY = LANE_B_Y + CLIP_HEADER_H;

    const volA = defaults.volumeCrossfade
      ? buildVolumePath('out', defaults.fadeCurve, overlapStartX, overlapW, bodyAY, BODY_H)
      : null;
    const volB = defaults.volumeCrossfade
      ? buildVolumePath('in', defaults.fadeCurve, overlapStartX, overlapW, bodyBY, BODY_H)
      : null;

    const bassA =
      defaults.bassMode !== 'none'
        ? buildBassPath('out', defaults.bassMode, defaults.bassCutDb, overlapStartX, overlapW, bodyAY, BODY_H)
        : null;
    const bassB =
      defaults.bassMode !== 'none'
        ? buildBassPath('in', defaults.bassMode, defaults.bassCutDb, overlapStartX, overlapW, bodyBY, BODY_H)
        : null;

    const midCutRatio = defaults.volumeCrossfade ? 0.34 : 0.62;
    const eqContourA =
      defaults.midMode === 'crossfade' || defaults.highMode === 'crossfade'
        ? buildEqContourPath('out', overlapStartX, overlapW, bodyAY, BODY_H, midCutRatio)
        : null;
    const eqContourB =
      defaults.midMode === 'crossfade' || defaults.highMode === 'crossfade'
        ? buildEqContourPath('in', overlapStartX, overlapW, bodyBY, BODY_H, midCutRatio)
        : null;

    const fltA = filterOut
      ? buildFilterPath('out', filterOut.values, overlapStartX, overlapW, bodyAY, BODY_H)
      : null;
    const fltB = filterIn
      ? buildFilterPath('in', filterIn.values, overlapStartX, overlapW, bodyBY, BODY_H)
      : null;

    return { volA, volB, bassA, bassB, eqContourA, eqContourB, fltA, fltB };
  }, [defaults, filterIn, filterOut, geometry, isOverlapActive]);

  // Ruler beat/bar ticks
  const rulerTicks = useMemo(() => {
    const ticks: { x: number; major: boolean; label?: string }[] = [];
    if (!isOverlapActive) {
      const step = USABLE_W / 8;
      for (let i = 0; i <= 8; i++) {
        ticks.push({
          x: PAD_X + i * step,
          major: i % 2 === 0,
          label: i === 4 ? 'Cut' : i % 2 === 0 ? `B${i + 1}` : undefined,
        });
      }
      return ticks;
    }

    const { overlapStartX, overlapEndX, overlapW } = geometry;
    const divs =
      defaults.overlapBars <= 4
        ? Math.max(1, Math.round(defaults.overlapBars))
        : defaults.overlapBars <= 16
          ? 4
          : 8;
    const step = overlapW / divs;

    // Ticks inside overlap
    for (let i = 0; i <= divs; i++) {
      const x = overlapStartX + i * step;
      const barNum = Math.round((i / divs) * defaults.overlapBars);
      const label =
        i === 0
          ? 'In'
          : i === divs
            ? 'Out'
            : i * 2 === divs
              ? `${barNum}B`
              : undefined;
      ticks.push({ x, major: i === 0 || i === divs || i * 2 === divs, label });
    }

    // Lead-in and tail rhythm ticks
    let leftX = overlapStartX - step;
    while (leftX >= PAD_X + 2) {
      ticks.push({ x: leftX, major: false });
      leftX -= step;
    }
    let rightX = overlapEndX + step;
    while (rightX <= PAD_X + USABLE_W - 2) {
      ticks.push({ x: rightX, major: false });
      rightX += step;
    }
    return ticks;
  }, [defaults.overlapBars, geometry, isOverlapActive]);

  // Live readout at playhead position
  const readout = useMemo(() => {
    const { overlapStartX, overlapEndX, overlapW, trackAEndX, trackBStartX } = geometry;
    const inOverlap = isOverlapActive && playheadX >= overlapStartX && playheadX <= overlapEndX;
    const t = inOverlap && overlapW > 0 ? Math.max(0, Math.min(1, (playheadX - overlapStartX) / overlapW)) : 0;

    const aActive = playheadX <= trackAEndX + 0.5;
    const bActive = playheadX >= trackBStartX - 0.5;

    const aVol = !aActive
      ? 0
      : inOverlap && defaults.volumeCrossfade
        ? evaluateVolumeFadeGain(1 - t, defaults.fadeCurve, 0)
        : 1;
    const bVol = !bActive
      ? 0
      : inOverlap && defaults.volumeCrossfade
        ? evaluateVolumeFadeGain(t, defaults.fadeCurve, 0)
        : 1;

    const aBassDb =
      !aActive || defaults.bassMode === 'none' || !inOverlap
        ? 0
        : defaults.bassCutDb * (1 - evaluateBassTransitionFraction(t, 'out', defaults.bassMode, 0));
    const bBassDb =
      !bActive || defaults.bassMode === 'none' || !inOverlap
        ? 0
        : defaults.bassCutDb * (1 - evaluateBassTransitionFraction(t, 'in', defaults.bassMode, 0));

    const midCut = defaults.volumeCrossfade ? -8 : -18;
    const highCut = defaults.volumeCrossfade ? -5 : -18;
    const smoothT = 0.5 - 0.5 * Math.cos(Math.PI * t);
    const aMidDb = !aActive || defaults.midMode === 'none' || !inOverlap ? 0 : midCut * smoothT;
    const bMidDb = !bActive || defaults.midMode === 'none' || !inOverlap ? 0 : midCut * (1 - smoothT);
    const aHighDb = !aActive || defaults.highMode === 'none' || !inOverlap ? 0 : highCut * smoothT;
    const bHighDb = !bActive || defaults.highMode === 'none' || !inOverlap ? 0 : highCut * (1 - smoothT);

    const aFilterHz =
      inOverlap && filterOut
        ? filterOut.values[Math.min(filterOut.values.length - 1, Math.round(t * (filterOut.values.length - 1)))]
        : null;
    const bFilterHz =
      inOverlap && filterIn
        ? filterIn.values[Math.min(filterIn.values.length - 1, Math.round(t * (filterIn.values.length - 1)))]
        : null;

    return {
      aActive,
      bActive,
      inOverlap,
      t,
      aVolPct: Math.round(aVol * 100),
      bVolPct: Math.round(bVol * 100),
      aBassDb,
      bBassDb,
      aMidDb,
      bMidDb,
      aHighDb,
      bHighDb,
      aFilterHz,
      bFilterHz,
    };
  }, [defaults, filterIn, filterOut, geometry, isOverlapActive, playheadX]);

  const summaryParts = useMemo(() => {
    if (!defaults.enabled) return ['Auto-Mix Off', 'End-to-end drop'];
    if (defaults.overlapBars <= 0) return ['0 Bars', 'Direct cut'];
    const parts: string[] = [`${defaults.overlapBars}B overlap`];
    if (defaults.volumeCrossfade) {
      parts.push(
        defaults.fadeCurve === 'scurve'
          ? 'S-Curve'
          : defaults.fadeCurve === 'linear'
            ? 'Linear'
            : 'Exp'
      );
    } else {
      parts.push('Vol flat');
    }
    if (defaults.bassMode === 'swap') parts.push(`Bass swap ${defaults.bassCutDb} dB`);
    else if (defaults.bassMode === 'crossfade') parts.push(`Bass XF ${defaults.bassCutDb} dB`);
    if (defaults.filterMode === 'dual') parts.push('Dual filter');
    else if (defaults.filterMode === 'lpf-in') parts.push('LPF in');
    else if (defaults.filterMode === 'hpf-out') parts.push('HPF out');
    return parts;
  }, [defaults]);

  const trackAColor = theme.trackAccents[0];
  const trackBColor = theme.trackAccents[1];
  const bodyAY = LANE_A_Y + CLIP_HEADER_H;
  const bodyBY = LANE_B_Y + CLIP_HEADER_H;
  const trackAW = geometry.trackAEndX - geometry.trackAStartX;
  const trackBW = geometry.trackBEndX - geometry.trackBStartX;

  return (
    <div className="h-full flex flex-col rounded-md bg-om-deepest border border-white/[0.08] overflow-hidden">
      {/* Header row */}
      <div className="px-3 py-2 border-b border-white/[0.06] flex items-center justify-between gap-2 shrink-0">
        <div className="min-w-0 flex items-center gap-1.5 text-[11px] truncate">
          <span className="font-medium text-om-text shrink-0">Mix Preview</span>
          <span className="text-om-text-icon" aria-hidden="true">·</span>
          <span className="text-om-text-muted font-mono text-[10px] truncate tabular-nums">
            {summaryParts.join(' · ')}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setIsPlaying((prev) => !prev)}
          aria-label={isPlaying ? 'Pause mix preview' : 'Play mix preview'}
          className="px-2 py-0.5 rounded bg-om-control hover:bg-om-control-hover border border-white/[0.08] text-[10px] font-medium text-om-text inline-flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
        >
          {isPlaying ? <Pause className="w-2.5 h-2.5" /> : <Play className="w-2.5 h-2.5" />}
          <span>{isPlaying ? 'Pause' : 'Play'}</span>
        </button>
      </div>

      {/* Interactive Mini-Timeline SVG */}
      <div className="flex-1 min-h-0 flex items-center px-1.5 py-2 select-none">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="w-full h-auto block cursor-ew-resize touch-none"
          role="img"
          aria-label="Interactive Auto-Mix timeline preview showing Track A transitioning into Track B"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          {/* Ruler background */}
          <rect x={0} y={0} width={VIEW_W} height={RULER_H} fill={theme.canvas.bgPanel} />
          <line
            x1={0}
            y1={RULER_H}
            x2={VIEW_W}
            y2={RULER_H}
            stroke="rgba(255,255,255,0.08)"
            strokeWidth={1}
          />

          {/* Vertical Beat/Bar Grid Lines */}
          {rulerTicks.map((tick, idx) => (
            <g key={idx}>
              <line
                x1={tick.x}
                y1={tick.major ? 4 : 11}
                x2={tick.x}
                y2={RULER_H}
                stroke={tick.major ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.12)'}
                strokeWidth={1}
              />
              <line
                x1={tick.x}
                y1={RULER_H}
                x2={tick.x}
                y2={VIEW_H - 6}
                stroke={tick.major ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.035)'}
                strokeWidth={1}
              />
              {tick.label && (
                <text
                  x={tick.x + (tick.label === 'Out' ? -3 : 3)}
                  y={13}
                  textAnchor={tick.label === 'Out' ? 'end' : 'start'}
                  fill={theme.canvas.textMuted}
                  fontSize={8.5}
                  fontFamily="monospace"
                >
                  {tick.label}
                </text>
              )}
            </g>
          ))}

          {/* Overlap Highlight Band or Direct Cut Seam */}
          {isOverlapActive ? (
            <g>
              <rect
                x={geometry.overlapStartX}
                y={RULER_H}
                width={geometry.overlapW}
                height={VIEW_H - RULER_H - 6}
                fill={theme.canvas.accentFillSoftRgba}
              />
              <line
                x1={geometry.overlapStartX}
                y1={RULER_H}
                x2={geometry.overlapStartX}
                y2={VIEW_H - 6}
                stroke={theme.canvas.accentLineRgba}
                strokeWidth={1}
                strokeDasharray="3 3"
                opacity={0.55}
              />
              <line
                x1={geometry.overlapEndX}
                y1={RULER_H}
                x2={geometry.overlapEndX}
                y2={VIEW_H - 6}
                stroke={theme.canvas.accentLineRgba}
                strokeWidth={1}
                strokeDasharray="3 3"
                opacity={0.55}
              />
            </g>
          ) : (
            <line
              x1={geometry.overlapStartX}
              y1={RULER_H}
              x2={geometry.overlapStartX}
              y2={VIEW_H - 6}
              stroke="rgba(255,255,255,0.28)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
          )}

          {/* Lane 1: Track A (Outgoing) */}
          <g>
            <rect
              x={geometry.trackAStartX}
              y={LANE_A_Y}
              width={trackAW}
              height={LANE_H}
              rx={4}
              fill={theme.canvas.bgCard}
              stroke="rgba(255,255,255,0.12)"
              strokeWidth={1}
            />
            <rect
              x={geometry.trackAStartX + 0.5}
              y={LANE_A_Y + 0.5}
              width={Math.max(0, trackAW - 1)}
              height={CLIP_HEADER_H}
              rx={3}
              fill={trackAColor}
              fillOpacity={0.18}
            />
            <text
              x={geometry.trackAStartX + 6}
              y={LANE_A_Y + 10.5}
              fill={theme.canvas.textPrimary}
              fontSize={8.5}
              fontWeight={600}
              fontFamily="sans-serif"
            >
              Track A · Outgoing
            </text>

            {/* Track A Mock Waveform */}
            {waveA.map((amp, i) => {
              const frac = (i + 0.5) / waveA.length;
              const bx = geometry.trackAStartX + 4 + frac * Math.max(0, trackAW - 8);
              let gainAtten = 1;
              if (isOverlapActive && defaults.volumeCrossfade && bx >= geometry.overlapStartX) {
                const t = Math.max(0, Math.min(1, (bx - geometry.overlapStartX) / geometry.overlapW));
                gainAtten = 0.22 + 0.78 * evaluateVolumeFadeGain(1 - t, defaults.fadeCurve, 0);
              }
              const halfH = Math.max(1.5, amp * gainAtten * (BODY_H * 0.42));
              const cy = bodyAY + BODY_H * 0.5;
              return (
                <line
                  key={i}
                  x1={bx}
                  y1={cy - halfH}
                  x2={bx}
                  y2={cy + halfH}
                  stroke={trackAColor}
                  strokeWidth={2}
                  strokeLinecap="round"
                  opacity={0.72}
                />
              );
            })}

            {/* Track A Overlap Envelopes */}
            {curves && (
              <g>
                {curves.volA ? (
                  <>
                    <path d={curves.volA.shadePath} fill="rgba(11,13,16,0.66)" />
                    <path
                      d={curves.volA.linePath}
                      fill="none"
                      stroke={theme.canvas.accent}
                      strokeWidth={1.75}
                    />
                  </>
                ) : (
                  <line
                    x1={geometry.overlapStartX}
                    y1={bodyAY + 2}
                    x2={geometry.overlapEndX}
                    y2={bodyAY + 2}
                    stroke="rgba(148,163,184,0.4)"
                    strokeWidth={1.25}
                    strokeDasharray="3 3"
                  />
                )}

                {curves.eqContourA && (
                  <path
                    d={curves.eqContourA}
                    fill="none"
                    stroke="rgba(226,232,240,0.62)"
                    strokeWidth={1.15}
                    strokeDasharray="2 3"
                  />
                )}

                {curves.fltA && (
                  <>
                    <path d={curves.fltA.shadePath} fill={theme.canvas.positiveFillRgba} />
                    <path
                      d={curves.fltA.linePath}
                      fill="none"
                      stroke={theme.canvas.positiveBright}
                      strokeWidth={1.5}
                    />
                    {geometry.overlapW >= 68 && (
                      <text
                        x={geometry.overlapEndX - 4}
                        y={bodyAY + 10}
                        textAnchor="end"
                        fill={theme.canvas.positiveBright}
                        fontSize={7.5}
                        fontFamily="monospace"
                        fontWeight={700}
                      >
                        HPF OUT
                      </text>
                    )}
                  </>
                )}

                {curves.bassA && (
                  <>
                    <path d={curves.bassA.shadePath} fill={theme.canvas.secondaryFillRgba} />
                    <path
                      d={curves.bassA.linePath}
                      fill="none"
                      stroke={theme.canvas.secondaryBright}
                      strokeWidth={1.75}
                      strokeDasharray={defaults.bassMode === 'swap' ? undefined : '4 2'}
                    />
                    {defaults.bassMode === 'swap' && (
                      <circle
                        cx={curves.bassA.swapMidX}
                        cy={curves.bassA.swapMidY}
                        r={3}
                        fill={theme.canvas.bgBase}
                        stroke={theme.canvas.secondaryBright}
                        strokeWidth={1.5}
                      />
                    )}
                  </>
                )}
              </g>
            )}
          </g>

          {/* Lane 2: Track B (Incoming) */}
          <g>
            <rect
              x={geometry.trackBStartX}
              y={LANE_B_Y}
              width={trackBW}
              height={LANE_H}
              rx={4}
              fill={theme.canvas.bgCard}
              stroke="rgba(255,255,255,0.12)"
              strokeWidth={1}
            />
            <rect
              x={geometry.trackBStartX + 0.5}
              y={LANE_B_Y + 0.5}
              width={Math.max(0, trackBW - 1)}
              height={CLIP_HEADER_H}
              rx={3}
              fill={trackBColor}
              fillOpacity={0.18}
            />
            <text
              x={geometry.trackBStartX + 6}
              y={LANE_B_Y + 10.5}
              fill={theme.canvas.textPrimary}
              fontSize={8.5}
              fontWeight={600}
              fontFamily="sans-serif"
            >
              Track B · Incoming
            </text>

            {/* Track B Mock Waveform */}
            {waveB.map((amp, i) => {
              const frac = (i + 0.5) / waveB.length;
              const bx = geometry.trackBStartX + 4 + frac * Math.max(0, trackBW - 8);
              let gainAtten = 1;
              if (isOverlapActive && defaults.volumeCrossfade && bx <= geometry.overlapEndX) {
                const t = Math.max(0, Math.min(1, (bx - geometry.overlapStartX) / geometry.overlapW));
                gainAtten = 0.22 + 0.78 * evaluateVolumeFadeGain(t, defaults.fadeCurve, 0);
              }
              const halfH = Math.max(1.5, amp * gainAtten * (BODY_H * 0.42));
              const cy = bodyBY + BODY_H * 0.5;
              return (
                <line
                  key={i}
                  x1={bx}
                  y1={cy - halfH}
                  x2={bx}
                  y2={cy + halfH}
                  stroke={trackBColor}
                  strokeWidth={2}
                  strokeLinecap="round"
                  opacity={0.72}
                />
              );
            })}

            {/* Track B Overlap Envelopes */}
            {curves && (
              <g>
                {curves.volB ? (
                  <>
                    <path d={curves.volB.shadePath} fill="rgba(11,13,16,0.66)" />
                    <path
                      d={curves.volB.linePath}
                      fill="none"
                      stroke={theme.canvas.accent}
                      strokeWidth={1.75}
                    />
                  </>
                ) : (
                  <line
                    x1={geometry.overlapStartX}
                    y1={bodyBY + 2}
                    x2={geometry.overlapEndX}
                    y2={bodyBY + 2}
                    stroke="rgba(148,163,184,0.4)"
                    strokeWidth={1.25}
                    strokeDasharray="3 3"
                  />
                )}

                {curves.eqContourB && (
                  <path
                    d={curves.eqContourB}
                    fill="none"
                    stroke="rgba(226,232,240,0.62)"
                    strokeWidth={1.15}
                    strokeDasharray="2 3"
                  />
                )}

                {curves.fltB && (
                  <>
                    <path d={curves.fltB.shadePath} fill={theme.canvas.positiveFillRgba} />
                    <path
                      d={curves.fltB.linePath}
                      fill="none"
                      stroke={theme.canvas.positiveBright}
                      strokeWidth={1.5}
                    />
                    {geometry.overlapW >= 68 && (
                      <text
                        x={geometry.overlapStartX + 4}
                        y={bodyBY + 10}
                        textAnchor="start"
                        fill={theme.canvas.positiveBright}
                        fontSize={7.5}
                        fontFamily="monospace"
                        fontWeight={700}
                      >
                        LPF IN
                      </text>
                    )}
                  </>
                )}

                {curves.bassB && (
                  <>
                    <path d={curves.bassB.shadePath} fill={theme.canvas.secondaryFillRgba} />
                    <path
                      d={curves.bassB.linePath}
                      fill="none"
                      stroke={theme.canvas.secondaryBright}
                      strokeWidth={1.75}
                      strokeDasharray={defaults.bassMode === 'swap' ? undefined : '4 2'}
                    />
                    {defaults.bassMode === 'swap' && (
                      <circle
                        cx={curves.bassB.swapMidX}
                        cy={curves.bassB.swapMidY}
                        r={3}
                        fill={theme.canvas.bgBase}
                        stroke={theme.canvas.secondaryBright}
                        strokeWidth={1.5}
                      />
                    )}
                  </>
                )}
              </g>
            )}
          </g>

          {/* Interactive Playhead */}
          <g pointerEvents="none">
            <line
              x1={playheadX}
              y1={0}
              x2={playheadX}
              y2={VIEW_H - 4}
              stroke={theme.canvas.accentBright}
              strokeWidth={1.5}
            />
            <polygon
              points={`${playheadX - 4.5},0 ${playheadX + 4.5},0 ${playheadX},6`}
              fill={theme.canvas.accentBright}
            />
          </g>
        </svg>
      </div>

      {/* Live Scrub Readout & Curve Legend */}
      <div className="px-3 py-2 border-t border-white/[0.06] bg-om-base/60 space-y-1.5 text-[10px]">
        <div className="grid grid-cols-2 gap-3 font-mono tabular-nums">
          <div className="min-w-0 truncate text-om-text-muted">
            <span className="font-sans font-semibold text-om-text mr-1.5">A</span>
            <span>Vol {readout.aVolPct}%</span>
            {isOverlapActive && defaults.bassMode !== 'none' && (
              <span> · Low {formatDb(readout.aBassDb)}</span>
            )}
            {isOverlapActive && defaults.midMode === 'crossfade' && (
              <span> · Mid {formatDb(readout.aMidDb)}</span>
            )}
            {isOverlapActive && defaults.highMode === 'crossfade' && (
              <span> · Hi {formatDb(readout.aHighDb)}</span>
            )}
            {readout.aFilterHz !== null && <span> · HPF {formatHz(readout.aFilterHz)}</span>}
          </div>
          <div className="min-w-0 truncate text-right text-om-text-muted">
            <span className="font-sans font-semibold text-om-text mr-1.5">B</span>
            <span>Vol {readout.bVolPct}%</span>
            {isOverlapActive && defaults.bassMode !== 'none' && (
              <span> · Low {formatDb(readout.bBassDb)}</span>
            )}
            {isOverlapActive && defaults.midMode === 'crossfade' && (
              <span> · Mid {formatDb(readout.bMidDb)}</span>
            )}
            {isOverlapActive && defaults.highMode === 'crossfade' && (
              <span> · Hi {formatDb(readout.bHighDb)}</span>
            )}
            {readout.bFilterHz !== null && <span> · LPF {formatHz(readout.bFilterHz)}</span>}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 text-[10px] text-om-text-subtle">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block w-3 h-[2px]"
                style={{ backgroundColor: theme.canvas.accent }}
              />
              <span>Volume</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block w-3 h-[2px]"
                style={{ backgroundColor: theme.canvas.secondaryBright }}
              />
              <span>Bass EQ</span>
            </span>
            {(defaults.midMode === 'crossfade' || defaults.highMode === 'crossfade') && (
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block w-3 border-t border-dashed border-slate-300/70" />
                <span>Mid/High</span>
              </span>
            )}
            {defaults.filterMode !== 'none' && (
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block w-3 h-[2px]"
                  style={{ backgroundColor: theme.canvas.positiveBright }}
                />
                <span>Filter</span>
              </span>
            )}
          </div>
          <span className="text-om-text-faint whitespace-nowrap shrink-0">Drag to scrub</span>
        </div>
      </div>
    </div>
  );
};
