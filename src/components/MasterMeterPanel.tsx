import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { DEFAULT_MASTER_VOLUME, nleEngine } from '../audio/nleEngine';
import { useTheme } from '../theme/themes';

interface MasterMeterPanelProps {
  isPlaying: boolean;
  masterVolume: number;
  onChangeMasterVolume: (volume: number) => void;
}

const MIN_DB = -60;
const MAX_DB = 0;
const DB_TICKS = [0, -6, -12, -24, -48];
const PEAK_HOLD_MS = 1200;
const MAX_MASTER_VOL = 1.25;

/** Maps a dBFS value [-60..0] to normalized vertical height [0..1] using perceptual scaling. */
function dbToNorm(db: number): number {
  if (!Number.isFinite(db) || db <= MIN_DB) return 0;
  if (db >= MAX_DB) return 1;
  // Slightly expand the top -24..0 dB range for finer DJ/mastering resolution
  const linearNorm = (db - MIN_DB) / (MAX_DB - MIN_DB);
  return Math.pow(linearNorm, 1.35);
}

function formatVolumeDb(volume: number): string {
  if (volume <= 0.001) return '-∞ dB';
  const db = 20 * Math.log10(volume);
  const rounded = Math.abs(db) < 0.05 ? 0 : db;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} dB`;
}

export const MasterMeterPanel: React.FC<MasterMeterPanelProps> = ({
  isPlaying,
  masterVolume,
  onChangeMasterVolume,
}) => {
  const { theme } = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;

  const meterWrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const peakReadoutRef = useRef<HTMLButtonElement | null>(null);
  const faderTrackRef = useRef<HTMLDivElement | null>(null);

  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  // Remember last non-zero volume for mute toggle
  const preMuteVolRef = useRef<number>(
    masterVolume > 0.005 ? masterVolume : DEFAULT_MASTER_VOLUME
  );
  if (masterVolume > 0.005) {
    preMuteVolRef.current = masterVolume;
  }

  const [meterSize, setMeterSize] = useState<{ w: number; h: number }>({ w: 46, h: 160 });

  // Mutable animation state kept outside React to sustain smooth 60fps ballistics
  const meterStateRef = useRef({
    rmsNormL: 0,
    rmsNormR: 0,
    peakNormL: 0,
    peakNormR: 0,
    holdNormL: 0,
    holdNormR: 0,
    holdUntilL: 0,
    holdUntilR: 0,
    latchedPeakDb: MIN_DB,
    clipped: false,
    lastFrameTime: 0,
  });

  // Track container dimensions so the stereo canvas stays crisp at any timeline height
  useEffect(() => {
    const el = meterWrapperRef.current;
    if (!el) return;
    let rafId = 0;
    const updateSize = () => {
      rafId = 0;
      const rect = el.getBoundingClientRect();
      const nextW = Math.floor(rect.width);
      const nextH = Math.floor(rect.height);
      if (nextW > 0 && nextH > 0) {
        setMeterSize((prev) =>
          Math.abs(prev.w - nextW) <= 1 && Math.abs(prev.h - nextH) <= 1
            ? prev
            : { w: nextW, h: nextH }
        );
      }
    };
    const scheduleUpdate = () => {
      if (rafId !== 0) return;
      rafId = requestAnimationFrame(updateSize);
    };
    scheduleUpdate();
    const ro = new ResizeObserver(scheduleUpdate);
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (rafId !== 0) cancelAnimationFrame(rafId);
    };
  }, []);

  const resetPeakLatch = useCallback(() => {
    const st = meterStateRef.current;
    st.latchedPeakDb = MIN_DB;
    st.clipped = false;
    st.holdNormL = 0;
    st.holdNormR = 0;
    if (peakReadoutRef.current) {
      peakReadoutRef.current.textContent = '-∞';
      peakReadoutRef.current.dataset.clipped = 'false';
      peakReadoutRef.current.className =
        'w-full py-0.5 px-1 rounded text-[10px] font-mono tabular-nums text-center border transition-colors cursor-pointer bg-om-base border-white/[0.08] text-om-text-dim hover:text-om-text';
    }
  }, []);

  // 60fps Canvas Stereo Meter + Peak-Hold Animation Loop
  useEffect(() => {
    let rafId = 0;

    const drawFrame = (now: number) => {
      const canvas = canvasRef.current;
      const st = meterStateRef.current;
      const dtSec =
        st.lastFrameTime > 0 ? Math.min(0.1, (now - st.lastFrameTime) / 1000) : 1 / 60;
      st.lastFrameTime = now;

      const levels = nleEngine.getMasterLevels();
      const targetRmsL = isPlayingRef.current ? dbToNorm(levels.leftDb) : 0;
      const targetRmsR = isPlayingRef.current ? dbToNorm(levels.rightDb) : 0;
      const targetPeakL = isPlayingRef.current ? dbToNorm(levels.leftPeakDb) : 0;
      const targetPeakR = isPlayingRef.current ? dbToNorm(levels.rightPeakDb) : 0;

      // Fast attack, smooth exponential release ballistics
      const attackAlpha = 1 - Math.exp(-dtSec * 36);
      const releaseAlpha = 1 - Math.exp(-dtSec * 9);

      st.rmsNormL +=
        (targetRmsL - st.rmsNormL) * (targetRmsL > st.rmsNormL ? attackAlpha : releaseAlpha);
      st.rmsNormR +=
        (targetRmsR - st.rmsNormR) * (targetRmsR > st.rmsNormR ? attackAlpha : releaseAlpha);

      st.peakNormL =
        targetPeakL >= st.peakNormL
          ? targetPeakL
          : Math.max(0, st.peakNormL - dtSec * 1.45);
      st.peakNormR =
        targetPeakR >= st.peakNormR
          ? targetPeakR
          : Math.max(0, st.peakNormR - dtSec * 1.45);

      if (targetPeakL >= st.holdNormL) {
        st.holdNormL = targetPeakL;
        st.holdUntilL = now + PEAK_HOLD_MS;
      } else if (now > st.holdUntilL) {
        st.holdNormL = Math.max(0, st.holdNormL - dtSec * 0.55);
      }

      if (targetPeakR >= st.holdNormR) {
        st.holdNormR = targetPeakR;
        st.holdUntilR = now + PEAK_HOLD_MS;
      } else if (now > st.holdUntilR) {
        st.holdNormR = Math.max(0, st.holdNormR - dtSec * 0.55);
      }

      // Latch max peak dB & clip flag
      if (isPlayingRef.current) {
        const frameMaxPeakDb = Math.max(levels.leftPeakDb, levels.rightPeakDb);
        if (frameMaxPeakDb > st.latchedPeakDb) {
          st.latchedPeakDb = frameMaxPeakDb;
        }
        if (levels.leftPeak >= 0.99 || levels.rightPeak >= 0.99) {
          st.clipped = true;
        }
      }

      // Update peak readout DOM directly without triggering React renders
      const readoutEl = peakReadoutRef.current;
      if (readoutEl) {
        if (st.clipped) {
          readoutEl.textContent = 'CLIP';
          if (readoutEl.dataset.clipped !== 'true') {
            readoutEl.dataset.clipped = 'true';
            readoutEl.className =
              'w-full py-0.5 px-1 rounded text-[10px] font-mono font-bold tabular-nums text-center border transition-colors cursor-pointer bg-om-danger/25 border-om-danger text-om-danger-soft';
          }
        } else {
          readoutEl.textContent =
            st.latchedPeakDb <= MIN_DB + 0.2 ? '-∞' : st.latchedPeakDb.toFixed(1);
          if (readoutEl.dataset.clipped !== 'false') {
            readoutEl.dataset.clipped = 'false';
            readoutEl.className =
              'w-full py-0.5 px-1 rounded text-[10px] font-mono tabular-nums text-center border transition-colors cursor-pointer bg-om-base border-white/[0.08] text-om-text-dim hover:text-om-text';
          }
        }
      }

      // Draw L / R meter bars on canvas
      if (canvas && meterSize.w > 0 && meterSize.h > 0) {
        const dpr = window.devicePixelRatio || 1;
        const targetW = Math.round(meterSize.w * dpr);
        const targetH = Math.round(meterSize.h * dpr);
        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
        }
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          const w = meterSize.w;
          const h = meterSize.h;
          ctx.clearRect(0, 0, w, h);

          const scaleWidth = 18;
          const padTop = 4;
          const padBottom = 4;
          const barAreaH = Math.max(20, h - padTop - padBottom);
          const barsLeft = scaleWidth + 2;
          const gap = 3;
          const barW = Math.max(6, Math.floor((w - barsLeft - gap - 2) / 2));
          const leftX = barsLeft;
          const rightX = barsLeft + barW + gap;

          const palette = themeRef.current.canvas;

          // dB scale tick lines and numeric labels
          ctx.font = '8.5px "JetBrains Mono", monospace';
          ctx.textBaseline = 'middle';
          ctx.textAlign = 'right';
          for (const tickDb of DB_TICKS) {
            const norm = dbToNorm(tickDb);
            const y = padTop + (1 - norm) * barAreaH;
            ctx.fillStyle = tickDb === 0 ? palette.danger : palette.textSubtle;
            ctx.fillText(String(tickDb), scaleWidth - 2, y);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
            ctx.fillRect(barsLeft, Math.round(y), barW * 2 + gap, 1);
          }

          // Channel slot backgrounds
          ctx.fillStyle = palette.bgDeepest;
          ctx.fillRect(leftX, padTop, barW, barAreaH);
          ctx.fillRect(rightX, padTop, barW, barAreaH);

          // Shared vertical gradient driven by active theme
          const grad = ctx.createLinearGradient(0, padTop + barAreaH, 0, padTop);
          grad.addColorStop(0, palette.meterLow);
          grad.addColorStop(dbToNorm(-12), palette.meterMid);
          grad.addColorStop(dbToNorm(-3), palette.meterHigh);
          grad.addColorStop(1, palette.meterClip);

          const drawChannel = (x: number, rmsNorm: number, peakNorm: number, holdNorm: number) => {
            const rmsH = Math.max(0, Math.min(barAreaH, rmsNorm * barAreaH));
            if (rmsH > 0.5) {
              ctx.fillStyle = grad;
              ctx.fillRect(x, padTop + barAreaH - rmsH, barW, rmsH);
            }

            // Subtle translucent instantaneous peak fill above RMS
            const peakH = Math.max(0, Math.min(barAreaH, peakNorm * barAreaH));
            if (peakH > rmsH + 0.5) {
              ctx.save();
              ctx.globalAlpha = 0.42;
              ctx.fillStyle = grad;
              ctx.fillRect(x, padTop + barAreaH - peakH, barW, peakH - rmsH);
              ctx.restore();
            }

            // Crisp segmented LED mask for studio meter legibility
            ctx.fillStyle = palette.meterMaskRgba;
            for (let sy = padTop + 3; sy < padTop + barAreaH; sy += 4) {
              ctx.fillRect(x, sy, barW, 1);
            }

            // Floating Peak Hold line
            if (holdNorm > 0.01) {
              const holdY = Math.max(
                padTop,
                Math.min(padTop + barAreaH - 2, padTop + barAreaH - holdNorm * barAreaH)
              );
              ctx.fillStyle =
                holdNorm >= dbToNorm(-1)
                  ? palette.meterHoldHigh
                  : holdNorm >= dbToNorm(-9)
                    ? palette.meterHoldMid
                    : palette.meterHoldLow;
              ctx.fillRect(x, Math.round(holdY), barW, 2);
            }
          };

          drawChannel(leftX, st.rmsNormL, st.peakNormL, st.holdNormL);
          drawChannel(rightX, st.rmsNormR, st.peakNormR, st.holdNormR);
        }
      }

      const activeDecay =
        isPlayingRef.current ||
        st.rmsNormL > 0.002 ||
        st.rmsNormR > 0.002 ||
        st.holdNormL > 0.002 ||
        st.holdNormR > 0.002;

      if (activeDecay) {
        rafId = requestAnimationFrame(drawFrame);
      } else {
        st.lastFrameTime = 0;
      }
    };

    rafId = requestAnimationFrame(drawFrame);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, meterSize, theme]);

  // Vertical Master Fader Pointer Interaction
  const updateVolumeFromClientY = useCallback(
    (clientY: number) => {
      const trackEl = faderTrackRef.current;
      if (!trackEl) return;
      const rect = trackEl.getBoundingClientRect();
      const clampedY = Math.max(rect.top, Math.min(rect.bottom, clientY));
      const norm = 1 - (clampedY - rect.top) / Math.max(1, rect.height);
      const nextVol = Math.round(norm * MAX_MASTER_VOL * 100) / 100;
      onChangeMasterVolume(Math.max(0, Math.min(MAX_MASTER_VOL, nextVol)));
    },
    [onChangeMasterVolume]
  );

  const handleFaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    updateVolumeFromClientY(e.clientY);
  };

  const handleFaderPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons === 0) return;
    updateVolumeFromClientY(e.clientY);
  };

  const handleFaderPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const handleFaderWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const step = e.shiftKey ? 0.01 : 0.03;
    const dir = e.deltaY < 0 ? 1 : -1;
    const next = Math.round((masterVolume + dir * step) * 100) / 100;
    onChangeMasterVolume(Math.max(0, Math.min(MAX_MASTER_VOL, next)));
  };

  const faderNorm = Math.max(0, Math.min(1, masterVolume / MAX_MASTER_VOL));
  const unityNorm = 1.0 / MAX_MASTER_VOL;
  const isMuted = masterVolume <= 0.001;

  return (
    <aside
      aria-label="Master Output Meter and Volume"
      className="w-[104px] shrink-0 bg-om-panel border-l border-white/[0.08] flex flex-col select-none z-20"
    >
      {/* Top Header aligned with Timeline Ruler height (h-8) */}
      <div className="h-8 shrink-0 px-2 border-b border-white/[0.08] flex items-center justify-between bg-om-panel">
        <span className="text-[10px] font-mono font-semibold tracking-wider text-om-text-secondary">
          MASTER
        </span>
        <button
          type="button"
          onClick={() => {
            if (isMuted) {
              onChangeMasterVolume(preMuteVolRef.current || DEFAULT_MASTER_VOLUME);
            } else {
              preMuteVolRef.current = masterVolume;
              onChangeMasterVolume(0);
            }
          }}
          title={isMuted ? 'Unmute Master Output' : 'Mute Master Output'}
          className={`w-5 h-5 rounded flex items-center justify-center transition-colors cursor-pointer ${
            isMuted
              ? 'bg-om-danger/25 text-om-danger-soft'
              : 'text-om-text-dim hover:text-om-text hover:bg-white/[0.06]'
          }`}
        >
          {isMuted ? <VolumeX className="w-3 h-3" /> : <Volume2 className="w-3 h-3" />}
        </button>
      </div>

      {/* Latched Peak / Clip Readout Badge */}
      <div className="px-2 pt-2 shrink-0">
        <button
          ref={peakReadoutRef}
          type="button"
          onClick={resetPeakLatch}
          title="Peak hold readout (dBFS). Click to clear peak / clip indicator."
          className="w-full py-0.5 px-1 rounded text-[10px] font-mono tabular-nums text-center border transition-colors cursor-pointer bg-om-base border-white/[0.08] text-om-text-dim hover:text-om-text"
        >
          -∞
        </button>
      </div>

      {/* Stereo L/R Meter + Master Volume Fader */}
      <div className="flex-1 min-h-0 flex items-stretch gap-2 px-2 py-2">
        {/* Left Half: Stereo L/R Level Meters */}
        <div className="flex-1 min-w-0 flex flex-col items-center">
          <div ref={meterWrapperRef} className="flex-1 w-full min-h-[72px] relative overflow-hidden">
            <canvas
              ref={canvasRef}
              className="absolute inset-0 block w-full h-full"
            />
          </div>
          <div className="w-full pl-[20px] pr-[2px] flex items-center justify-around text-[9px] font-mono text-om-text-faint pt-1 shrink-0">
            <span>L</span>
            <span>R</span>
          </div>
        </div>

        {/* Right Half: Vertical Master Volume Fader */}
        <div className="w-8 shrink-0 flex flex-col items-center">
          <div
            role="slider"
            tabIndex={0}
            aria-label="Master Volume"
            aria-valuemin={0}
            aria-valuemax={MAX_MASTER_VOL}
            aria-valuenow={masterVolume}
            aria-valuetext={formatVolumeDb(masterVolume)}
            onPointerDown={handleFaderPointerDown}
            onPointerMove={handleFaderPointerMove}
            onPointerUp={handleFaderPointerUp}
            onDoubleClick={() => onChangeMasterVolume(DEFAULT_MASTER_VOLUME)}
            onWheel={handleFaderWheel}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
                e.preventDefault();
                const step = e.shiftKey ? 0.01 : 0.05;
                onChangeMasterVolume(Math.min(MAX_MASTER_VOL, Math.round((masterVolume + step) * 100) / 100));
              } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
                e.preventDefault();
                const step = e.shiftKey ? 0.01 : 0.05;
                onChangeMasterVolume(Math.max(0, Math.round((masterVolume - step) * 100) / 100));
              }
            }}
            title={`Master Volume: ${formatVolumeDb(masterVolume)} (drag or double-click to reset)`}
            className="relative flex-1 w-full min-h-[72px] flex justify-center cursor-ns-resize py-1.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-om-accent rounded"
          >
            {/* Fader Slot */}
            <div
              ref={faderTrackRef}
              className="relative w-1.5 h-full rounded-full bg-om-deepest border border-white/[0.08]"
            >
              {/* Unity 0 dB Tick Mark */}
              <div
                style={{ bottom: `${unityNorm * 100}%` }}
                className="absolute -left-1.5 -right-1.5 h-[1px] bg-om-text-dim/50 pointer-events-none"
              />
              {/* Active Level Fill */}
              <div
                style={{ height: `${faderNorm * 100}%` }}
                className={`absolute bottom-0 left-0 right-0 rounded-full ${
                  isMuted
                    ? 'bg-om-text-icon'
                    : masterVolume > 1.0
                      ? 'bg-om-accent'
                      : 'bg-om-positive'
                }`}
              />
              {/* Hardware Fader Thumb */}
              <div
                style={{ bottom: `calc(${faderNorm * 100}% - 5px)` }}
                className="absolute left-1/2 -translate-x-1/2 w-5 h-2.5 rounded-[2px] bg-om-text border border-om-base shadow-md flex items-center justify-center pointer-events-none"
              >
                <span className="w-3 h-[1px] bg-om-base/70" />
              </div>
            </div>
          </div>
          <span className="text-[9px] font-mono text-om-text-faint pt-1 shrink-0">VOL</span>
        </div>
      </div>

      {/* Footer: Live Master Gain Readout */}
      <div className="px-2 py-1.5 border-t border-white/[0.08] bg-om-footer flex items-center justify-center shrink-0">
        <span
          className={`text-[10px] font-mono tabular-nums font-medium ${
            isMuted
              ? 'text-om-danger-soft'
              : masterVolume > 1.0
                ? 'text-om-accent'
                : 'text-om-text'
          }`}
        >
          {formatVolumeDb(masterVolume)}
        </span>
      </div>
    </aside>
  );
};
