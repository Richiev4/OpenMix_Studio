import React from 'react';
import {
  clampCurveTension,
  getBassSwapCenterFraction,
  getConfiguredClipBassFade,
  getConfiguredClipVolumeFade,
} from '../audio/mixTransitions';
import type { FadeCurve, NleClip } from '../types/audio';

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

export interface ClipFadeCardProps {
  direction: 'in' | 'out';
  trackId: string;
  clip: NleClip;
  trackLabel?: string;
  trackAccentColor?: string;
  roleTag?: string;
  onUpdateClip: (trackId: string, clipId: string, patch: Partial<NleClip>) => void;
  onToggleVolumeFade: (trackId: string, clip: NleClip, direction: 'in' | 'out') => void;
  onToggleBassFade: (trackId: string, clip: NleClip, direction: 'in' | 'out') => void;
}

export const ClipFadeCard: React.FC<ClipFadeCardProps> = ({
  direction,
  trackId,
  clip,
  trackLabel,
  trackAccentColor,
  roleTag,
  onUpdateClip,
  onToggleVolumeFade,
  onToggleBassFade,
}) => {
  const isIn = direction === 'in';

  const volCfg = getConfiguredClipVolumeFade(clip, direction);
  const hasVol = volCfg.durationSec > 0.01 || volCfg.offsetSec > 0.01;
  const volActive = volCfg.enabled && hasVol;

  const bassCfg = getConfiguredClipBassFade(clip, direction);
  const hasBass = bassCfg.durationSec > 0.01 || bassCfg.offsetSec > 0.01;
  const bassActive = bassCfg.enabled && hasBass;

  const curveValue = isIn ? (clip.fadeInCurve ?? clip.fadeCurve) : (clip.fadeOutCurve ?? clip.fadeCurve);
  const volSec = isIn ? clip.fadeInSec : clip.fadeOutSec;
  const volTension = isIn ? clip.fadeInCurveTension : clip.fadeOutCurveTension;

  return (
    <div className="p-2 rounded bg-om-base/85 border border-white/[0.08] space-y-1.5 min-w-0">
      {trackLabel && (
        <div className="flex items-center justify-between gap-1.5 pb-1 border-b border-white/[0.06]">
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: trackAccentColor ?? (isIn ? '#22d3ee' : '#f59e0b') }}
            />
            <span className="text-[11px] font-medium text-om-text truncate" title={trackLabel}>
              {trackLabel}
            </span>
          </div>
          {roleTag && (
            <span className="text-[9px] font-mono uppercase tracking-wider text-om-text-dim shrink-0">
              {roleTag}
            </span>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <span
          className={`text-[10px] font-semibold uppercase tracking-wider ${
            isIn ? 'text-om-accent' : 'text-om-secondary'
          }`}
        >
          {isIn ? 'Fade In' : 'Fade Out'}
        </span>
        <select
          value={curveValue}
          onChange={(e) =>
            onUpdateClip(
              trackId,
              clip.id,
              isIn
                ? { fadeInCurve: e.target.value as FadeCurve }
                : { fadeOutCurve: e.target.value as FadeCurve }
            )
          }
          className="bg-om-panel-alt border border-white/[0.08] rounded px-1.5 py-0.5 text-[10px] text-om-text"
          title={isIn ? 'Start Fade In Curve Shape' : 'End Fade Out Curve Shape'}
        >
          <option value="scurve">S-Curve</option>
          <option value="linear">Linear</option>
          <option value="exponential">Exp</option>
        </select>
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 text-[11px] text-om-text-muted">
          <button
            type="button"
            onClick={() => onToggleVolumeFade(trackId, clip, direction)}
            title={
              volActive
                ? `Bypass Volume Fade ${isIn ? 'In' : 'Out'} (keeps duration)`
                : hasVol
                  ? `Re-enable Volume Fade ${isIn ? 'In' : 'Out'}`
                  : `Enable Volume Fade ${isIn ? 'In' : 'Out'}`
            }
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold transition-colors cursor-pointer ${
              volActive
                ? 'bg-om-accent/20 border-om-accent/70 text-om-accent'
                : !volCfg.enabled && hasVol
                  ? 'bg-om-elevated border-white/[0.1] text-om-text-faint line-through hover:text-om-text-muted'
                  : 'bg-om-elevated border-white/[0.08] text-om-text-dim hover:border-om-accent/50 hover:text-om-accent'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                volActive ? 'bg-om-accent' : 'bg-om-text-faint'
              }`}
            />
            <span>Vol</span>
          </button>
          <input
            type="number"
            min={0}
            max={60}
            step={0.1}
            value={volSec}
            onChange={(e) => {
              const nextFade = Math.max(0, parseFloat(e.target.value) || 0);
              const preservedBass = getConfiguredClipBassFade(clip, direction).durationSec;
              if (isIn) {
                onUpdateClip(trackId, clip.id, {
                  fadeInSec: nextFade,
                  fadeInEnabled: true,
                  bassFadeInSec: preservedBass,
                  mixIn: clip.mixIn
                    ? { ...clip.mixIn, volumeCrossfade: nextFade > 0 }
                    : undefined,
                });
              } else {
                onUpdateClip(trackId, clip.id, {
                  fadeOutSec: nextFade,
                  fadeOutEnabled: true,
                  bassFadeOutSec: preservedBass,
                  mixOut: clip.mixOut
                    ? { ...clip.mixOut, volumeCrossfade: nextFade > 0 }
                    : undefined,
                });
              }
            }}
            title={
              isIn
                ? 'Start Volume Fade In duration (amber curve)'
                : 'End Volume Fade Out duration (amber curve)'
            }
            className={`w-14 bg-om-panel-alt border rounded px-1.5 py-0.5 font-mono tabular-nums text-[11px] focus:border-om-accent ${
              volActive
                ? 'border-om-accent/40 text-om-text'
                : 'border-white/[0.08] text-om-text-faint'
            }`}
          />
          <span>s</span>
        </div>

        <div className="flex items-center gap-1 text-[11px] text-om-text-muted">
          <button
            type="button"
            onClick={() => onToggleBassFade(trackId, clip, direction)}
            title={
              bassActive
                ? `Bypass Bass Fade ${isIn ? 'In' : 'Out'} (keeps duration)`
                : hasBass
                  ? `Re-enable Bass Fade ${isIn ? 'In' : 'Out'}`
                  : `Enable Bass Fade ${isIn ? 'In' : 'Out'}`
            }
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold transition-colors cursor-pointer ${
              bassActive
                ? 'bg-om-secondary-bright/20 border-om-secondary-bright/70 text-om-secondary-bright'
                : !bassCfg.enabled && hasBass
                  ? 'bg-om-elevated border-white/[0.1] text-om-text-faint line-through hover:text-om-text-muted'
                  : 'bg-om-elevated border-white/[0.08] text-om-text-dim hover:border-om-secondary-bright/50 hover:text-om-secondary-bright'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                bassActive ? 'bg-om-secondary-bright' : 'bg-om-text-faint'
              }`}
            />
            <span>Bass</span>
          </button>
          <input
            type="number"
            min={0}
            max={60}
            step={0.1}
            value={Math.round(bassCfg.durationSec * 100) / 100}
            onChange={(e) => {
              const nextBass = Math.max(
                0,
                Math.min(clip.durationSec * 0.85, parseFloat(e.target.value) || 0)
              );
              const rounded = Math.round(nextBass * 100) / 100;
              if (isIn) {
                onUpdateClip(trackId, clip.id, {
                  bassFadeInSec: rounded,
                  bassFadeInEnabled: true,
                  mixIn: clip.mixIn
                    ? {
                        ...clip.mixIn,
                        bassMode:
                          nextBass > 0
                            ? clip.mixIn.bassMode === 'none'
                              ? 'crossfade'
                              : clip.mixIn.bassMode
                            : 'none',
                      }
                    : undefined,
                });
              } else {
                onUpdateClip(trackId, clip.id, {
                  bassFadeOutSec: rounded,
                  bassFadeOutEnabled: true,
                  mixOut: clip.mixOut
                    ? {
                        ...clip.mixOut,
                        bassMode:
                          nextBass > 0
                            ? clip.mixOut.bassMode === 'none'
                              ? 'crossfade'
                              : clip.mixOut.bassMode
                            : 'none',
                      }
                    : undefined,
                });
              }
            }}
            title={
              isIn
                ? 'Start Bass (Low EQ) Fade In duration (cyan curve)'
                : 'End Bass (Low EQ) Fade Out duration (cyan curve)'
            }
            className={`w-14 bg-om-panel-alt border rounded px-1.5 py-0.5 font-mono tabular-nums text-[11px] focus:border-om-secondary-bright ${
              bassActive
                ? 'border-om-secondary-bright/40 text-om-text'
                : 'border-white/[0.08] text-om-text-faint'
            }`}
          />
          <span>s</span>
        </div>
      </div>

      {/* Manual Volume & Bass Curve Shaping */}
      <div className="pt-1 border-t border-white/[0.06] space-y-1">
        <div className="flex items-center gap-1.5 text-[10px]">
          <span className="w-14 shrink-0 text-om-accent/90">Vol Bend</span>
          <input
            type="range"
            min={-1}
            max={1}
            step={0.05}
            value={clampCurveTension(volTension)}
            onChange={(e) =>
              onUpdateClip(
                trackId,
                clip.id,
                isIn
                  ? { fadeInCurveTension: parseFloat(e.target.value) }
                  : { fadeOutCurveTension: parseFloat(e.target.value) }
              )
            }
            title={
              isIn
                ? 'Bend Volume Fade In curve (-100% late/concave to +100% early/convex)'
                : 'Bend Volume Fade Out curve (-100% fast drop to +100% hold longer)'
            }
            className="flex-1 h-1 accent-om-accent cursor-pointer"
          />
          <button
            type="button"
            onClick={() =>
              onUpdateClip(
                trackId,
                clip.id,
                isIn ? { fadeInCurveTension: 0 } : { fadeOutCurveTension: 0 }
              )
            }
            title={`Click to reset Volume Fade ${isIn ? 'In' : 'Out'} bend to 0%`}
            className="w-10 text-right font-mono tabular-nums text-om-text hover:text-om-accent cursor-pointer"
          >
            {formatCurveTensionReadout(volTension ?? 0)}
          </button>
        </div>
        <div className="flex items-center gap-1.5 text-[10px]">
          <span className="w-14 shrink-0 text-om-secondary-bright/90">
            {bassCfg.mode === 'swap' ? 'Bass Swap' : 'Bass Bend'}
          </span>
          <input
            type="range"
            min={-1}
            max={1}
            step={0.05}
            value={bassCfg.curveTension}
            onChange={(e) =>
              onUpdateClip(
                trackId,
                clip.id,
                isIn
                  ? { bassFadeInCurveTension: parseFloat(e.target.value) }
                  : { bassFadeOutCurveTension: parseFloat(e.target.value) }
              )
            }
            title={
              bassCfg.mode === 'swap'
                ? `Shift Bass Swap ${isIn ? 'In' : 'Out'} point along the transition`
                : isIn
                  ? 'Bend Bass Fade In curve (-100% late to +100% early)'
                  : 'Bend Bass Fade Out curve (-100% fast cut to +100% hold longer)'
            }
            className="flex-1 h-1 accent-om-secondary-bright cursor-pointer"
          />
          <button
            type="button"
            onClick={() =>
              onUpdateClip(
                trackId,
                clip.id,
                isIn ? { bassFadeInCurveTension: 0 } : { bassFadeOutCurveTension: 0 }
              )
            }
            title={`Click to reset Bass Fade ${isIn ? 'In' : 'Out'} curve to default`}
            className="w-10 text-right font-mono tabular-nums text-om-text hover:text-om-secondary-bright cursor-pointer"
          >
            {formatCurveTensionReadout(bassCfg.curveTension, {
              isSwap: bassCfg.mode === 'swap',
              direction,
            })}
          </button>
        </div>
      </div>
    </div>
  );
};
