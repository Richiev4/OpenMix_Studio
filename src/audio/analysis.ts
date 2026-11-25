import type {
  NleClip,
  TrackAnalysisMeta,
  TrackAsset,
  TrackCompatibility,
} from '../types/audio';
import {
  evaluateBpmAt,
  integrateClipSourceOffsetSec,
  type TempoMapSource,
} from './tempoMap';
import {
  computeTimelineComplexOnsetCurve,
  detectMixxxPhaseForKnownBpm,
  runMixxxBeatTracker,
  type MixxxAnalysisRange,
  type MixxxOnsetData,
} from './mixxxBeatTracker';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Krumhansl-Schmuckler major & minor tonal profiles
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const CAMELOT_MAJOR: Record<string, string> = {
  C: '8B',
  'C#': '3B',
  D: '10B',
  'D#': '5B',
  E: '12B',
  F: '7B',
  'F#': '2B',
  G: '9B',
  'G#': '4B',
  A: '11B',
  'A#': '6B',
  B: '1B',
};

const CAMELOT_MINOR: Record<string, string> = {
  Cm: '5A',
  'C#m': '12A',
  Dm: '7A',
  'D#m': '2A',
  Em: '9A',
  Fm: '4A',
  'F#m': '11A',
  Gm: '6A',
  'G#m': '1A',
  Am: '8A',
  'A#m': '3A',
  Bm: '10A',
};

export function getCamelotForKey(musicalKey: string): string {
  return CAMELOT_MINOR[musicalKey] ?? CAMELOT_MAJOR[musicalKey] ?? '1A';
}

export const ALL_MUSICAL_KEYS = [
  'Cm', 'C#m', 'Dm', 'D#m', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'A#m', 'Bm',
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
];

/**
 * Computes multi-band waveform peaks so both overview and zoomed waveforms
 * render crisp low/mid/high energy coloration at 60fps.
 */
function extractWaveformPeaks(buffer: AudioBuffer, bucketCount = 1800) {
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
  const totalSamples = ch0.length;
  const samplesPerBucket = Math.max(1, Math.floor(totalSamples / bucketCount));

  const peaks = new Float32Array(bucketCount);
  const low = new Float32Array(bucketCount);
  const mid = new Float32Array(bucketCount);
  const high = new Float32Array(bucketCount);

  // Simple 1-pole crossover state for low (<250Hz) and high (>2.5kHz) bands
  const sr = buffer.sampleRate;
  const lpAlpha = Math.min(1, (2 * Math.PI * 250) / sr);
  const hpAlpha = Math.min(1, (2 * Math.PI * 2500) / sr);
  let lpState = 0;
  let hpState = 0;
  let prevSample = 0;

  for (let b = 0; b < bucketCount; b++) {
    const start = b * samplesPerBucket;
    const end = Math.min(totalSamples, start + samplesPerBucket);
    let maxAmp = 0;
    let maxLow = 0;
    let maxMid = 0;
    let maxHigh = 0;

    // Step slightly on very long tracks for instant decoding performance
    const step = samplesPerBucket > 4096 ? 4 : samplesPerBucket > 1024 ? 2 : 1;

    for (let i = start; i < end; i += step) {
      const sample = (ch0[i] + ch1[i]) * 0.5;
      const abs = Math.abs(sample);
      if (abs > maxAmp) maxAmp = abs;

      lpState += lpAlpha * (sample - lpState);
      hpState = (1 - hpAlpha) * (hpState + sample - prevSample);
      prevSample = sample;
      const midSample = sample - lpState - hpState;

      const absLow = Math.abs(lpState);
      const absMid = Math.abs(midSample);
      const absHigh = Math.abs(hpState);

      if (absLow > maxLow) maxLow = absLow;
      if (absMid > maxMid) maxMid = absMid;
      if (absHigh > maxHigh) maxHigh = absHigh;
    }

    peaks[b] = Math.min(1, maxAmp);
    low[b] = Math.min(1, maxLow);
    mid[b] = Math.min(1, maxMid);
    high[b] = Math.min(1, maxHigh);
  }

  return { peaks, low, mid, high };
}

interface AnalysisWindowOptions {
  /** Explicit window start in seconds */
  startSec?: number;
  /** Explicit window end in seconds */
  endSec?: number;
  /** Optional anchor time (seconds) to center the analysis window around */
  centerSec?: number;
  /** Optional window width (seconds) when centerSec is provided */
  spanSec?: number;
}

/**
 * Resolves an optional explicit or playhead-anchored range for Mixxx beat analysis.
 * When no range/center is specified, returns undefined so the Mixxx Queen Mary tracker
 * analyzes the full track end-to-end and isolates steady constant-tempo regions via BeatUtils.
 */
function resolveMixxxRange(
  duration: number,
  options?: AnalysisWindowOptions
): { range?: MixxxAnalysisRange; isAnchored: boolean } {
  if (!Number.isFinite(duration) || duration <= 0) {
    return { isAnchored: false };
  }

  if (
    typeof options?.startSec === 'number' &&
    typeof options?.endSec === 'number' &&
    options.endSec > options.startSec
  ) {
    const startSec = Math.max(0, Math.min(duration, options.startSec));
    const endSec = Math.max(startSec, Math.min(duration, options.endSec));
    return { range: { startSec, endSec }, isAnchored: true };
  }

  if (typeof options?.centerSec === 'number' && Number.isFinite(options.centerSec)) {
    const clampedCenter = Math.max(0, Math.min(duration, options.centerSec));
    const desiredSpan =
      typeof options.spanSec === 'number' && options.spanSec > 0
        ? options.spanSec
        : Math.min(duration, Math.max(40, Math.min(96, duration * 0.45)));
    const actualSpan = Math.min(duration, Math.min(180, desiredSpan));
    let startSec = clampedCenter - actualSpan * 0.5;
    let endSec = clampedCenter + actualSpan * 0.5;
    if (startSec < 0) {
      endSec = Math.min(duration, endSec - startSec);
      startSec = 0;
    }
    if (endSec > duration) {
      startSec = Math.max(0, startSec - (endSec - duration));
      endSec = duration;
    }
    return { range: { startSec, endSec }, isAnchored: true };
  }

  return { isAnchored: false };
}

/**
 * Refines a comb-detected beat phase (which typically locks onto the peak slope/body of kicks)
 * backward onto the leading edge (attack onset) using a beat-averaged PCM amplitude envelope
 * sampled strictly inside the clean analysis window, then projects that phase backwards to 0:00.
 */
function refineBeatPhaseToLeadingEdge(
  buffer: AudioBuffer,
  beatPhaseSec: number,
  beatPeriodSec: number,
  windowStartSec = 0.05,
  windowEndSec = buffer.duration - 0.05
): number {
  const sr = buffer.sampleRate;
  const totalSamples = buffer.length;
  const duration = buffer.duration;
  if (duration < beatPeriodSec * 4 || totalSamples < 2048) return beatPhaseSec;

  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;

  // Candidate beat indices strictly inside the clean middle/anchored window
  const scanStart = Math.max(0.05, Math.min(duration - 0.1, windowStartSec));
  const scanEnd = Math.min(duration - 0.05, Math.max(scanStart + beatPeriodSec * 4, windowEndSec));
  const firstK = Math.max(0, Math.ceil((scanStart - beatPhaseSec) / beatPeriodSec));
  const lastK = Math.floor((scanEnd - beatPhaseSec) / beatPeriodSec);
  const totalBeats = lastK - firstK + 1;
  if (totalBeats < 4) return beatPhaseSec;

  // Quick energy pass over up to 96 evenly spaced beats in the clean window to select active rhythmic beats
  const probeCount = Math.min(totalBeats, 96);
  const probeStep = Math.max(1, Math.floor(totalBeats / probeCount));
  const probeHalfWin = Math.max(1, Math.round(0.025 * sr));
  const candidates: Array<{ timeSec: number; energy: number }> = [];

  for (let i = 0; i < totalBeats && candidates.length < probeCount; i += probeStep) {
    const t = beatPhaseSec + (firstK + i) * beatPeriodSec;
    const center = Math.round(t * sr);
    const s0 = Math.max(0, center - probeHalfWin);
    const s1 = Math.min(totalSamples, center + probeHalfWin);
    let sumSq = 0;
    for (let s = s0; s < s1; s += 4) {
      const v = (ch0[s] + ch1[s]) * 0.5;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, (s1 - s0) / 4));
    candidates.push({ timeSec: t, energy: rms });
  }

  candidates.sort((a, b) => b.energy - a.energy);
  const topCount = Math.min(64, Math.max(8, Math.floor(candidates.length * 0.65)));
  const activeBeats = candidates.slice(0, topCount);
  if (activeBeats.length === 0 || activeBeats[0].energy < 1e-4) {
    return beatPhaseSec;
  }

  // Build beat-averaged PCM amplitude envelope over [-36ms, +24ms] at 0.5ms resolution
  const preMs = 36;
  const postMs = 24;
  const stepMs = 0.5;
  const binCount = Math.round((preMs + postMs) / stepMs) + 1;
  const zeroBin = Math.round(preMs / stepMs); // 0ms
  // ±1.5ms (3ms RMS) bridges mid/high zero-crossings while preserving sub-ms leading-edge sharpness
  const winHalfSamples = Math.max(1, Math.round(0.0015 * sr));

  const avgEnv = new Float64Array(binCount);
  const beatEnv = new Float64Array(binCount);
  let validBeats = 0;

  for (let b = 0; b < activeBeats.length; b++) {
    const t = activeBeats[b].timeSec;
    let beatPeak = 0;
    for (let idx = 0; idx < binCount; idx++) {
      const offsetSec = (idx - zeroBin) * (stepMs / 1000);
      const center = Math.round((t + offsetSec) * sr);
      const s0 = Math.max(0, center - winHalfSamples);
      const s1 = Math.min(totalSamples, center + winHalfSamples);
      let sumSq = 0;
      for (let s = s0; s < s1; s++) {
        const v = (ch0[s] + ch1[s]) * 0.5;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / Math.max(1, s1 - s0));
      beatEnv[idx] = rms;
      if (rms > beatPeak) beatPeak = rms;
    }

    if (beatPeak > 1e-4) {
      const inv = 1 / beatPeak;
      for (let idx = 0; idx < binCount; idx++) {
        avgEnv[idx] += beatEnv[idx] * inv;
      }
      validBeats++;
    }
  }

  if (validBeats < 4) return beatPhaseSec;
  for (let idx = 0; idx < binCount; idx++) {
    avgEnv[idx] /= validBeats;
  }

  // Light 5-tap Gaussian smoothing to prevent single-cycle zero-crossing dips on sub kicks
  const smooth = new Float64Array(binCount);
  for (let idx = 0; idx < binCount; idx++) {
    const vM2 = avgEnv[Math.max(0, idx - 2)];
    const vM1 = avgEnv[Math.max(0, idx - 1)];
    const v0 = avgEnv[idx];
    const vP1 = avgEnv[Math.min(binCount - 1, idx + 1)];
    const vP2 = avgEnv[Math.min(binCount - 1, idx + 2)];
    smooth[idx] = vM2 * 0.1 + vM1 * 0.22 + v0 * 0.36 + vP1 * 0.22 + vP2 * 0.1;
  }

  // Locate main transient peak in [-16ms, +20ms] around the Mixxx DF phase
  const peakSearchStart = Math.max(6, zeroBin - Math.round(16 / stepMs));
  const peakSearchEnd = Math.min(binCount - 1, zeroBin + Math.round(20 / stepMs));
  let peakIdx = zeroBin;
  let peakVal = -1;
  for (let idx = peakSearchStart; idx <= peakSearchEnd; idx++) {
    if (smooth[idx] > peakVal) {
      peakVal = smooth[idx];
      peakIdx = idx;
    }
  }

  // Measure pre-attack baseline floor in [-36ms, -14ms] (or before peakIdx - 10ms)
  const floorEnd = Math.max(6, Math.min(zeroBin - Math.round(14 / stepMs), peakIdx - Math.round(10 / stepMs)));
  const floorSamples: number[] = [];
  for (let idx = 0; idx < floorEnd; idx++) {
    floorSamples.push(smooth[idx]);
  }
  floorSamples.sort((a, b) => a - b);
  const floorVal = floorSamples[Math.floor(floorSamples.length * 0.35)] ?? 0;

  const contrast = (peakVal - floorVal) / Math.max(1e-6, peakVal);
  if (contrast < 0.16) {
    return beatPhaseSec;
  }

  // Walk FORWARD from the pre-attack floor to find the FIRST sustained crossing of the 22%
  // attack threshold (avoids getting trapped on mid-kick waveform zero-crossing dips!)
  const threshold = floorVal + (peakVal - floorVal) * 0.22;
  const searchFrom = Math.max(1, peakIdx - Math.round(26 / stepMs));
  let onsetBin = peakIdx;
  for (let idx = searchFrom; idx < peakIdx; idx++) {
    if (
      smooth[idx] <= threshold &&
      smooth[idx + 1] > threshold &&
      smooth[Math.min(peakIdx, idx + 3)] > threshold
    ) {
      const denom = Math.max(1e-8, smooth[idx + 1] - smooth[idx]);
      const frac = Math.max(0, Math.min(1, (threshold - smooth[idx]) / denom));
      onsetBin = idx + frac;
      break;
    }
  }

  // Compensate ~1.0ms for the half-width of the symmetric 3ms RMS window leading into a sharp step
  const rawDeltaSec = (onsetBin - zeroBin) * (stepMs / 1000) + 0.001;
  const clampedDeltaSec = Math.max(-0.028, Math.min(0.016, rawDeltaSec));
  return ((beatPhaseSec + clampedDeltaSec) % beatPeriodSec + beatPeriodSec) % beatPeriodSec;
}

/**
 * Detects whether the audio file appears to start mid-mix / mid-phrase (e.g., cut from a DJ mix)
 * rather than beginning cleanly on Bar 1 Beat 1 from silence.
 */
function looksLikeMidMixStart(
  buffer: AudioBuffer,
  lowEnv: Float32Array,
  highEnv: Float32Array,
  beatPhaseSec: number,
  beatPeriodSec: number
): boolean {
  const sr = buffer.sampleRate;
  const totalSamples = buffer.length;
  if (totalSamples < sr * 2 || lowEnv.length < 20) return false;

  // Estimate typical full-body RMS from the analyzed middle core (80th percentile)
  const bodySamples: number[] = [];
  const step = Math.max(1, Math.floor(lowEnv.length / 200));
  for (let i = 0; i < lowEnv.length; i += step) {
    bodySamples.push(Math.hypot(lowEnv[i], highEnv[i]));
  }
  bodySamples.sort((a, b) => a - b);
  const bodyRefRms = bodySamples[Math.floor(bodySamples.length * 0.8)] ?? 0;
  if (bodyRefRms < 1e-4) return false;

  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;

  const measureRms = (t0Sec: number, t1Sec: number): number => {
    const s0 = Math.max(0, Math.floor(t0Sec * sr));
    const s1 = Math.min(totalSamples, Math.floor(t1Sec * sr));
    if (s1 <= s0) return 0;
    let sumSq = 0;
    for (let s = s0; s < s1; s++) {
      const v = (ch0[s] + ch1[s]) * 0.5;
      sumSq += v * v;
    }
    return Math.sqrt(sumSq / (s1 - s0));
  };

  // Signal A: Substantial audio is ALREADY playing before the first projected grid beat at 0:00
  // (classic signature of slicing out of a continuous mix between beats or mid-bar).
  if (beatPhaseSec >= 0.045) {
    const preBeatRms = measureRms(0.005, beatPhaseSec - 0.015);
    if (preBeatRms >= bodyRefRms * 0.18) {
      return true;
    }
  }

  // Signal B: The track begins at full club loudness immediately at t = 0 while not aligned near a beat boundary
  const headRms = measureRms(0.005, Math.min(0.25, beatPeriodSec * 0.5));
  const distToBeatZero = Math.min(beatPhaseSec, beatPeriodSec - beatPhaseSec);
  if (headRms >= bodyRefRms * 0.35 && distToBeatZero > 0.03) {
    return true;
  }

  return false;
}

/**
 * Selects which of the 4 beat positions (0..3) is Bar Beat 1 primarily from the clean middle body
 * and projects that downbeat backwards to [0, barPeriodSec) at 0:00:
 * 1) Snare/clap backbeat alignment (high-band onsets on Beats 2 & 4) in the middle body
 * 2) Multi-band 1-bar & 2-bar phrase/energy novelty across the middle body
 * 3) Kick-only (<150Hz) low-end downbeat weight in the middle body
 * 4) Early Bar 1 -> Bar 2 confirmation from t = 0 ONLY when the track starts cleanly (suppressed
 *    for mid-mix cuts or playhead-anchored detections)
 */
function selectDownbeatBarOffsetFromOnset(
  buffer: AudioBuffer,
  onsetData: MixxxOnsetData,
  beatPhaseSec: number,
  beatPeriodSec: number,
  ignoreTrackStart = false
): number {
  const {
    lowEnergy: lowEnv,
    highEnergy: highEnv,
    sr,
    startSample,
    hopSize,
    frameSize,
    frameCount,
    windowStartSec: startTimeSec,
    windowEndSec: endTimeSec,
  } = onsetData;
  const barPeriodSec = beatPeriodSec * 4;
  const halfFrameSamples = frameSize * 0.5;

  const sampleArrayAtTime = (arr: Float32Array, tSec: number): number => {
    const fFloat = (tSec * sr - startSample - halfFrameSamples) / hopSize;
    if (fFloat < 0 || fFloat >= frameCount - 1) return 0;
    const f0 = Math.floor(fFloat);
    const frac = fFloat - f0;
    return arr[f0] * (1 - frac) + arr[f0 + 1] * frac;
  };

  // Detect whether t = 0 starts mid-mix/mid-phrase so we don't let a cut edge hijack Beat 1
  const midMixStart =
    ignoreTrackStart ||
    looksLikeMidMixStart(buffer, lowEnv, highEnv, beatPhaseSec, beatPeriodSec);

  // --- Signal 1: Early track scan from t = 0 (only used as a modest tie-breaker on clean starts) ---
  const barEntryBonus = [0, 0, 0, 0];
  if (!midMixStart) {
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
    const totalSamples = buffer.length;
    const scanSec = Math.min(buffer.duration, 64);
    const numEarlyBeats = Math.floor((scanSec - beatPhaseSec) / beatPeriodSec);

    if (numEarlyBeats >= 8) {
      const fullRms = new Float32Array(numEarlyBeats);
      const lowRms = new Float32Array(numEarlyBeats);
      const attackSec = Math.min(0.09, beatPeriodSec * 0.28);
      const attackSamples = Math.max(16, Math.round(attackSec * sr));
      const lpAlpha = Math.min(1, (2 * Math.PI * 150) / sr);

      for (let n = 0; n < numEarlyBeats; n++) {
        const t = beatPhaseSec + n * beatPeriodSec;
        const s0 = Math.max(0, Math.round(t * sr));
        const s1 = Math.min(totalSamples, s0 + attackSamples);
        if (s1 <= s0) continue;

        let lp1 = 0;
        let lp2 = 0;
        let sumFull = 0;
        let sumLow = 0;
        for (let s = s0; s < s1; s++) {
          const v = (ch0[s] + ch1[s]) * 0.5;
          lp1 += lpAlpha * (v - lp1);
          lp2 += lpAlpha * (lp1 - lp2);
          sumFull += v * v;
          sumLow += lp2 * lp2;
        }
        const len = s1 - s0;
        fullRms[n] = Math.sqrt(sumFull / len);
        lowRms[n] = Math.sqrt(sumLow / len);
      }

      const sortedFull = Array.from(fullRms).sort((a, b) => a - b);
      const sortedLow = Array.from(lowRms).sort((a, b) => a - b);
      const refFull = sortedFull[Math.floor(sortedFull.length * 0.85)] ?? 0;
      const refLow = sortedLow[Math.floor(sortedLow.length * 0.85)] ?? 0;

      if (refLow > 1e-4) {
        let firstKickIdx = -1;
        for (let n = 0; n < numEarlyBeats - 4; n++) {
          if (lowRms[n] >= refLow * 0.42 && lowRms[n + 4] >= refLow * 0.42) {
            firstKickIdx = n;
            break;
          }
        }

        if (firstKickIdx > 0 && firstKickIdx < 4) {
          for (let k = 0; k < firstKickIdx; k++) {
            const isRealEntry =
              fullRms[k] >= refFull * 0.16 &&
              (k === 0 || fullRms[k] > fullRms[k - 1] * 1.6);
            if (isRealEntry && lowRms[k + 4] >= refLow * 0.5) {
              firstKickIdx = k;
              break;
            }
          }
        }

        if (firstKickIdx >= 0) {
          const phaseM = ((firstKickIdx % 4) + 4) % 4;
          const bar2Strength = Math.min(1, lowRms[firstKickIdx + 4] / Math.max(1e-6, refLow));
          barEntryBonus[phaseM] += 0.65 * (0.5 + 0.5 * bar2Strength);
        }
      }

      if (refFull > 1e-4) {
        let firstAudibleIdx = -1;
        for (let n = 0; n < numEarlyBeats - 5; n++) {
          if (fullRms[n] >= refFull * 0.18 && fullRms[n + 4] >= refFull * 0.28) {
            const isSingleBeatPickup =
              refLow > 1e-4 &&
              lowRms[n] < refLow * 0.25 &&
              lowRms[n + 1] >= refLow * 0.55 &&
              lowRms[n + 5] >= refLow * 0.55;
            firstAudibleIdx = isSingleBeatPickup ? n + 1 : n;
            break;
          }
        }

        if (firstAudibleIdx >= 0) {
          const phaseM = ((firstAudibleIdx % 4) + 4) % 4;
          barEntryBonus[phaseM] += 0.45;
        }
      }
    }
  }

  // --- Signals 2, 3, 4: Middle-body Kick Weight, Backbeat (2 & 4) Claps/Snares, and Band-Split Phrase Novelty ---
  const lowKickMeans = [0, 0, 0, 0];
  const highOnsetMeans = [0, 0, 0, 0];
  const phraseNovelty = [0, 0, 0, 0];

  for (let m = 0; m < 4; m++) {
    const candBar = (beatPhaseSec + m * beatPeriodSec) % barPeriodSec;
    const firstB = Math.ceil((startTimeSec + barPeriodSec - candBar) / barPeriodSec);
    const lastB = Math.floor((endTimeSec - barPeriodSec - candBar) / barPeriodSec);
    const count = lastB - firstB + 1;
    if (count <= 0) continue;

    let lowSum = 0;
    let highOnsetSum = 0;
    let noveltySum = 0;

    for (let b = firstB; b <= lastB; b++) {
      const t = candBar + b * barPeriodSec;

      // Strictly low-end (<150Hz) kick body energy (no high-frequency snare contamination)
      lowSum +=
        sampleArrayAtTime(lowEnv, t + 0.01) * 0.55 +
        sampleArrayAtTime(lowEnv, t + 0.025) * 0.45;

      // High-band (>150Hz) transient step for detecting snare/clap backbeats on Beats 2 & 4
      const hiAfter =
        sampleArrayAtTime(highEnv, t + 0.008) * 0.6 +
        sampleArrayAtTime(highEnv, t + 0.02) * 0.4;
      const hiBefore = sampleArrayAtTime(highEnv, t - 0.02);
      highOnsetSum += Math.max(0, hiAfter - hiBefore);

      // Band-separated bar-level energy novelty (bass drops, chord changes, & percussive entries on Beat 1)
      let prevLowE = 0;
      let nextLowE = 0;
      let prevHighE = 0;
      let nextHighE = 0;
      for (let step = 0; step < 4; step++) {
        const tPrev = t - (step + 0.5) * beatPeriodSec;
        const tNext = t + (step + 0.5) * beatPeriodSec;
        prevLowE += sampleArrayAtTime(lowEnv, tPrev);
        nextLowE += sampleArrayAtTime(lowEnv, tNext);
        prevHighE += sampleArrayAtTime(highEnv, tPrev);
        nextHighE += sampleArrayAtTime(highEnv, tNext);
      }
      noveltySum += Math.abs(nextLowE - prevLowE) + Math.abs(nextHighE - prevHighE);
    }

    lowKickMeans[m] = lowSum / count;
    highOnsetMeans[m] = highOnsetSum / count;
    phraseNovelty[m] = noveltySum / count;
  }

  const normalizeScores = (arr: number[]): number[] => {
    let minV = Infinity;
    let maxV = -Infinity;
    for (const v of arr) {
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const span = maxV - minV;
    if (span < 1e-7) return [0, 0, 0, 0];
    return arr.map((v) => (v - minV) / span);
  };

  // Backbeat score: if m is Beat 1, Beats 2 ((m+1)%4) & 4 ((m+3)%4) carry stronger snares/claps
  const avgHigh =
    (highOnsetMeans[0] + highOnsetMeans[1] + highOnsetMeans[2] + highOnsetMeans[3]) * 0.25;
  const backbeatRaw = [0, 1, 2, 3].map((m) => {
    const back = highOnsetMeans[(m + 1) % 4] + highOnsetMeans[(m + 3) % 4];
    const on = highOnsetMeans[m] + highOnsetMeans[(m + 2) % 4];
    return avgHigh > 1e-6 ? (back - on) / (2 * avgHigh) : 0;
  });

  const lowNorm = normalizeScores(lowKickMeans);
  const noveltyNorm = normalizeScores(phraseNovelty);
  const backbeatNorm = normalizeScores(backbeatRaw);

  // Give strong weight to backbeat alignment when a genuine 2&4 snare/clap pattern exists
  const backbeatSpread = Math.max(...backbeatRaw) - Math.min(...backbeatRaw);
  const backbeatWeight = backbeatSpread > 0.07 ? 0.65 : 0.18;
  // Suppress t=0 entry bias entirely on mid-mix starts or playhead-anchored runs; keep modest on clean starts
  const barEntryWeight = midMixStart ? 0 : 0.45;

  let bestM = 0;
  let bestScore = -Infinity;
  for (let m = 0; m < 4; m++) {
    const score =
      barEntryBonus[m] * barEntryWeight +
      backbeatNorm[m] * backbeatWeight +
      noveltyNorm[m] * 0.55 +
      lowNorm[m] * 0.4;
    if (score > bestScore) {
      bestScore = score;
      bestM = m;
    }
  }

  // Project the winning middle-body Beat 1 backwards to [0, barPeriodSec) at 0:00
  const bestBarOffsetSec = (beatPhaseSec + bestM * beatPeriodSec) % barPeriodSec;
  return Math.round((((bestBarOffsetSec % barPeriodSec) + barPeriodSec) % barPeriodSec) * 10000) / 10000;
}

/**
 * Finalizes a Mixxx-detected beat phase by snapping backward to the exact 0.5ms PCM kick
 * leading edge across the track's steady rhythmic regions, then selecting Beat 1 (downbeat).
 */
function finalizeMixxxBeatOffset(
  buffer: AudioBuffer,
  onsetData: MixxxOnsetData,
  bpm: number,
  rawBeatPhaseSec: number,
  activeStartSec: number,
  activeEndSec: number,
  ignoreTrackStart = false
): number {
  const beatPeriodSec = 60 / Math.max(40, bpm);
  const leadingBeatPhaseSec = refineBeatPhaseToLeadingEdge(
    buffer,
    rawBeatPhaseSec,
    beatPeriodSec,
    activeStartSec,
    activeEndSec
  );

  return selectDownbeatBarOffsetFromOnset(
    buffer,
    onsetData,
    leadingBeatPhaseSec,
    beatPeriodSec,
    ignoreTrackStart
  );
}

/**
 * Re-estimates the downbeat phase offset (in seconds) for a known BPM using Mixxx's
 * Complex Spectral Difference (`DF_COMPLEXSD`) phase adjustment + PCM leading-edge lock.
 */
export function detectBeatOffsetForBuffer(
  buffer: AudioBuffer,
  bpm: number,
  options?: { centerSec?: number; ignoreTrackStart?: boolean }
): number {
  const { range, isAnchored } = resolveMixxxRange(
    buffer.duration,
    typeof options?.centerSec === 'number' ? { centerSec: options.centerSec } : undefined
  );
  const phaseRes = detectMixxxPhaseForKnownBpm(buffer, bpm, range);
  if (!phaseRes) return 0;

  return finalizeMixxxBeatOffset(
    buffer,
    phaseRes.onsetData,
    bpm,
    phaseRes.beatPhaseSec,
    phaseRes.onsetData.windowStartSec,
    phaseRes.onsetData.windowEndSec,
    Boolean(options?.ignoreTrackStart || isAnchored)
  );
}

/**
 * Core Mixxx Queen Mary (`qm-dsp` `DF_COMPLEXSD` + `TempoTrackV2` + `BeatUtils`) BPM & Beat 1 detector.
 */
function detectBpmAndOffsetInWindow(
  buffer: AudioBuffer,
  options?: AnalysisWindowOptions
): { bpm: number; beatOffsetSec: number; windowStartSec: number; windowEndSec: number } {
  const { range, isAnchored } = resolveMixxxRange(buffer.duration, options);
  const res = runMixxxBeatTracker(buffer, range);
  if (!res) {
    return { bpm: 120, beatOffsetSec: 0, windowStartSec: 0, windowEndSec: buffer.duration };
  }

  const activeStartSec =
    res.regions.length > 0 ? res.regions[0].firstBeatSec : res.onsetData.windowStartSec;
  const activeEndSec =
    res.regions.length > 0
      ? res.regions[res.regions.length - 1].lastBeatSec
      : res.onsetData.windowEndSec;

  const beatOffsetSec = finalizeMixxxBeatOffset(
    buffer,
    res.onsetData,
    res.bpm,
    res.beatPhaseSec,
    activeStartSec,
    activeEndSec,
    isAnchored
  );

  return {
    bpm: res.bpm,
    beatOffsetSec,
    windowStartSec: res.onsetData.windowStartSec,
    windowEndSec: res.onsetData.windowEndSec,
  };
}

/**
 * Estimates BPM and first-downbeat phase offset across the full track using Mixxx's
 * Queen Mary Complex Spectral Difference + TempoTrackV2 + BeatUtils pipeline.
 */
export function detectBpmAndOffset(buffer: AudioBuffer): { bpm: number; beatOffsetSec: number } {
  const { bpm, beatOffsetSec } = detectBpmAndOffsetInWindow(buffer);
  return { bpm, beatOffsetSec };
}

/**
 * Detects both BPM and Beat 1 offset from a rhythmic window centered around `centerSec`
 * (or the full track when omitted) and projects the resulting beatgrid backwards to 0:00.
 */
export function detectBpmAndOffsetAroundTime(
  buffer: AudioBuffer,
  centerSec?: number
): { bpm: number; beatOffsetSec: number; windowStartSec: number; windowEndSec: number } {
  return detectBpmAndOffsetInWindow(
    buffer,
    typeof centerSec === 'number' ? { centerSec } : undefined
  );
}

/**
 * Builds a timeline-aligned STFT Complex Spectral Difference + Low-Band Kick onset curve
 * for a clip over [sampleStartSec, sampleStartSec + sampleDurSec].
 */
function buildTimelineComplexOnset(
  project: TempoMapSource,
  clip: Pick<NleClip, 'startSec' | 'offsetSec' | 'stretchToMasterBpm'>,
  asset: Pick<TrackAsset, 'audioBuffer' | 'bpm'>,
  sampleStartSec: number,
  sampleDurSec: number,
  dtSec: number
): Float32Array {
  const buffer = asset.audioBuffer;
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const canStretch = clip.stretchToMasterBpm && asset.bpm > 0;

  return computeTimelineComplexOnsetCurve(
    ch0,
    ch1,
    buffer.sampleRate,
    (tSec) => {
      const local = Math.max(0, tSec - clip.startSec);
      const srcDelta = canStretch
        ? integrateClipSourceOffsetSec(project, clip.startSec, local, asset.bpm)
        : local;
      return clip.offsetSec + srcDelta;
    },
    sampleStartSec,
    sampleDurSec,
    dtSec
  );
}

/**
 * Cross-correlates the STFT Complex Spectral Difference + Low-Band Kick onset transients of
 * `targetClip` against `referenceClip` across their actual timeline overlap window, returning
 * the exact sub-millisecond shift `deltaSec` to add to `targetClip.startSec` so beats lock cleanly.
 */
export function autoAlignOverlapShiftSec(params: {
  project: TempoMapSource;
  targetClip: Pick<NleClip, 'startSec' | 'durationSec' | 'offsetSec' | 'stretchToMasterBpm'>;
  targetAsset: Pick<TrackAsset, 'audioBuffer' | 'bpm'>;
  referenceClip: Pick<NleClip, 'startSec' | 'durationSec' | 'offsetSec' | 'stretchToMasterBpm'>;
  referenceAsset: Pick<TrackAsset, 'audioBuffer' | 'bpm'>;
}): { deltaSec: number; confidence: number } | null {
  const { project, targetClip, targetAsset, referenceClip, referenceAsset } = params;

  const ovStart = Math.max(targetClip.startSec, referenceClip.startSec);
  const ovEnd = Math.min(
    targetClip.startSec + targetClip.durationSec,
    referenceClip.startSec + referenceClip.durationSec
  );
  const ovDur = ovEnd - ovStart;
  if (ovDur < 0.8) return null;

  const sampleDur = Math.min(ovDur, 16);
  const sampleStart = ovStart + (ovDur - sampleDur) * 0.5;
  const dtSec = 0.004; // 4ms (250 Hz) STFT Complex SD resolution

  const refFlux = buildTimelineComplexOnset(
    project,
    referenceClip,
    referenceAsset,
    sampleStart,
    sampleDur,
    dtSec
  );
  const tgtFlux = buildTimelineComplexOnset(
    project,
    targetClip,
    targetAsset,
    sampleStart,
    sampleDur,
    dtSec
  );

  const n = Math.min(refFlux.length, tgtFlux.length);
  if (n < 80) return null;

  const midBpm = evaluateBpmAt(project, sampleStart + sampleDur * 0.5);
  const maxShiftSec = (60 / Math.max(50, midBpm)) * 0.52;
  const maxLagFrames = Math.min(Math.floor(n * 0.35), Math.ceil(maxShiftSec / dtSec));

  const sampleTgt = (idxFloat: number): number => {
    if (idxFloat < 0 || idxFloat >= n - 1) return 0;
    const i0 = Math.floor(idxFloat);
    const frac = idxFloat - i0;
    return tgtFlux[i0] * (1 - frac) + tgtFlux[i0 + 1] * frac;
  };

  const scoreLag = (lagFrames: number): number => {
    const fMin = Math.max(0, Math.ceil(lagFrames));
    const fMax = Math.min(n - 1, Math.floor(n - 1 + lagFrames));
    if (fMax - fMin < 40) return -1;

    let dot = 0;
    let eRef = 1e-12;
    let eTgt = 1e-12;
    for (let f = fMin; f <= fMax; f++) {
      const r = refFlux[f];
      const t = sampleTgt(f - lagFrames);
      dot += r * t;
      eRef += r * r;
      eTgt += t * t;
    }
    return dot / Math.sqrt(eRef * eTgt);
  };

  // Coarse search at 4ms resolution across ±half-beat
  let bestLag = 0;
  let bestScore = -1;
  for (let lag = -maxLagFrames; lag <= maxLagFrames; lag++) {
    const sc = scoreLag(lag);
    if (sc > bestScore) {
      bestScore = sc;
      bestLag = lag;
    }
  }

  // Fine sub-millisecond refinement (±4ms at 0.5ms steps)
  let refinedLag = bestLag;
  let refinedScore = bestScore;
  for (let lag = bestLag - 1.0; lag <= bestLag + 1.0 + 1e-6; lag += 0.125) {
    const sc = scoreLag(lag);
    if (sc > refinedScore) {
      refinedScore = sc;
      refinedLag = lag;
    }
  }

  if (refinedScore <= 0.02) return null;

  const deltaSec = Math.round(refinedLag * dtSec * 10000) / 10000;
  return { deltaSec, confidence: refinedScore };
}

/**
 * Estimates the musical key + Camelot code via Goertzel pitch-class chroma
 * accumulation matched against Krumhansl-Schmuckler major/minor profiles.
 */
function detectMusicalKey(buffer: AudioBuffer): { musicalKey: string; camelotCode: string } {
  const sr = buffer.sampleRate;
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;

  const chroma = new Float64Array(12);
  // Sample 12 evenly distributed 2048-sample windows across the middle of the track
  const windowSize = 2048;
  const numWindows = 12;
  const usableLength = Math.max(0, ch0.length - windowSize);
  if (usableLength < windowSize) {
    return { musicalKey: 'Am', camelotCode: '8A' };
  }

  // Precompute Hann window
  const hann = new Float64Array(windowSize);
  for (let i = 0; i < windowSize; i++) {
    hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (windowSize - 1)));
  }

  // Target octaves 2..5 (MIDI 36..83 -> ~65Hz to ~987Hz) for harmonic pitch clarity
  const freqs: { pc: number; coeff: number }[] = [];
  for (let midi = 36; midi <= 83; midi++) {
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const omega = (2 * Math.PI * freq) / sr;
    freqs.push({ pc: midi % 12, coeff: 2 * Math.cos(omega) });
  }

  for (let w = 0; w < numWindows; w++) {
    const start = Math.floor(((w + 1) / (numWindows + 1)) * usableLength);
    const frame = new Float64Array(windowSize);
    for (let i = 0; i < windowSize; i++) {
      frame[i] = ((ch0[start + i] + ch1[start + i]) * 0.5) * hann[i];
    }

    for (let f = 0; f < freqs.length; f++) {
      const { pc, coeff } = freqs[f];
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < windowSize; i++) {
        s0 = frame[i] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      const magSq = s1 * s1 + s2 * s2 - coeff * s1 * s2;
      chroma[pc] += Math.max(0, magSq);
    }
  }

  // Normalize chroma vector
  let chromaMean = 0;
  for (let i = 0; i < 12; i++) chromaMean += chroma[i];
  chromaMean /= 12;
  if (chromaMean <= 0) {
    return { musicalKey: 'Am', camelotCode: '8A' };
  }

  let bestKey = 'Am';
  let bestCorr = -Infinity;

  const correlate = (profile: number[], shift: number): number => {
    let pMean = 0;
    for (let i = 0; i < 12; i++) pMean += profile[i];
    pMean /= 12;

    let num = 0;
    let denA = 0;
    let denB = 0;
    for (let i = 0; i < 12; i++) {
      const a = chroma[(i + shift) % 12] - chromaMean;
      const b = profile[i] - pMean;
      num += a * b;
      denA += a * a;
      denB += b * b;
    }
    return denA * denB > 0 ? num / Math.sqrt(denA * denB) : 0;
  };

  for (let root = 0; root < 12; root++) {
    const majCorr = correlate(MAJOR_PROFILE, root);
    if (majCorr > bestCorr) {
      bestCorr = majCorr;
      bestKey = NOTE_NAMES[root];
    }
    const minCorr = correlate(MINOR_PROFILE, root);
    if (minCorr > bestCorr) {
      bestCorr = minCorr;
      bestKey = `${NOTE_NAMES[root]}m`;
    }
  }

  return {
    musicalKey: bestKey,
    camelotCode: getCamelotForKey(bestKey),
  };
}

const AUDIO_EXTENSION_RE = /\.(mp3|wav|ogg|flac|m4a|aac|webm)$/i;

/** Checks MIME type or file extension to determine whether a file is decodable audio. */
export function isSupportedAudioFile(fileName: string, mimeType?: string): boolean {
  return Boolean(
    (mimeType && mimeType.startsWith('audio/')) || AUDIO_EXTENSION_RE.test(fileName)
  );
}

export interface DecodeTrackOptions {
  /** Reuse a saved TrackAsset ID so existing timeline clip references stay intact */
  id?: string;
  /** Path relative to a linked DJ Folder */
  relativePath?: string;
  /** Pre-saved metadata overrides (skips redundant BPM/key analysis when relinking) */
  preservedMeta?: {
    name?: string;
    bpm: number;
    beatOffsetSec: number;
    manualBeatgrid?: boolean;
    musicalKey: string;
    camelotCode: string;
    orderIndex?: number;
  };
}

/**
 * Computes BPM, beat phase offset, musical key, Camelot code, and duration
 * directly from an already-decoded AudioBuffer.
 */
export function analyzeAudioBufferMeta(audioBuffer: AudioBuffer): TrackAnalysisMeta {
  const { bpm, beatOffsetSec } = detectBpmAndOffset(audioBuffer);
  const { musicalKey, camelotCode } = detectMusicalKey(audioBuffer);

  return {
    bpm,
    beatOffsetSec,
    musicalKey,
    camelotCode,
    duration: audioBuffer.duration,
    analyzedAt: Date.now(),
  };
}

/**
 * Decodes an audio file solely to extract BPM, beat phase offset, musical key,
 * Camelot code, and duration, letting the temporary AudioBuffer be garbage-collected.
 */
export async function analyzeAudioFileMeta(
  file: File,
  audioCtx: AudioContext
): Promise<TrackAnalysisMeta> {
  const arrayBuffer = await file.arrayBuffer();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  return analyzeAudioBufferMeta(audioBuffer);
}

/** Parses a Camelot wheel code like "8A" or "12B" into numeric position (1-12) and mode. */
function parseCamelotCode(code?: string | null): { num: number; mode: 'A' | 'B' } | null {
  if (!code) return null;
  const match = code.trim().toUpperCase().match(/^(\d{1,2})([AB])$/);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  if (num < 1 || num > 12) return null;
  return { num, mode: match[2] as 'A' | 'B' };
}

/**
 * Scores how well a candidate track fits harmonically (Camelot wheel) and rhythmically (BPM)
 * against a reference track (or project BPM when no reference key is provided).
 */
export function scoreTrackCompatibility(
  candidate: { bpm: number; camelotCode: string },
  reference: { bpm: number; camelotCode?: string | null }
): TrackCompatibility {
  const refBpm = reference.bpm > 0 ? reference.bpm : 120;
  const candBpm = candidate.bpm > 0 ? candidate.bpm : 120;

  // Evaluate direct tempo as well as half-time / double-time compatibility
  const ratios = [
    { effective: candBpm, isHalfDouble: false },
    { effective: candBpm * 2, isHalfDouble: true },
    { effective: candBpm * 0.5, isHalfDouble: true },
  ];

  let bestDiffPct = ((candBpm - refBpm) / refBpm) * 100;
  let isHalfOrDoubleTime = false;
  for (const r of ratios) {
    const pct = ((r.effective - refBpm) / refBpm) * 100;
    if (Math.abs(pct) < Math.abs(bestDiffPct)) {
      bestDiffPct = pct;
      isHalfOrDoubleTime = r.isHalfDouble;
    }
  }

  const absPct = Math.abs(bestDiffPct);
  let bpmScore = 0;
  if (absPct <= 1.5) bpmScore = 40;
  else if (absPct <= 3.5) bpmScore = 35;
  else if (absPct <= 6.0) bpmScore = 28;
  else if (absPct <= 9.0) bpmScore = 18;
  else if (absPct <= 13.0) bpmScore = 8;
  else bpmScore = 0;

  const candCam = parseCamelotCode(candidate.camelotCode);
  const refCam = parseCamelotCode(reference.camelotCode);

  // If no reference musical key (e.g., matching against global Project BPM only), score by tempo
  if (!candCam || !refCam) {
    const tempoOnlyScore = Math.round((bpmScore / 40) * 100);
    const tier =
      absPct <= 2
        ? 'perfect'
        : absPct <= 5
        ? 'great'
        : absPct <= 8
        ? 'good'
        : absPct <= 12
        ? 'stretch'
        : 'clash';
    return {
      score: tempoOnlyScore,
      tier,
      keyRelation: isHalfOrDoubleTime ? '½ / 2× Tempo' : 'BPM Match',
      bpmDiffPct: Math.round(bestDiffPct * 10) / 10,
      isHalfOrDoubleTime,
    };
  }

  // Shortest circular distance on the 12-hour Camelot wheel (0..6)
  const rawDist = Math.abs(candCam.num - refCam.num);
  const wheelDist = Math.min(rawDist, 12 - rawDist);
  const sameMode = candCam.mode === refCam.mode;

  let keyScore = 0;
  let keyRelation = 'Off-Key';

  if (wheelDist === 0 && sameMode) {
    keyScore = 60;
    keyRelation = 'Exact Key';
  } else if (wheelDist === 0 && !sameMode) {
    keyScore = 55;
    keyRelation = 'Relative';
  } else if (wheelDist === 1 && sameMode) {
    keyScore = 52;
    keyRelation = '±1 Wheel';
  } else if (wheelDist === 2 && sameMode) {
    keyScore = 38;
    keyRelation = 'Energy ±2';
  } else if (wheelDist === 1 && !sameMode) {
    keyScore = 34;
    keyRelation = 'Modulate';
  } else if (wheelDist === 3 && sameMode) {
    keyScore = 22;
    keyRelation = '±3 Step';
  } else {
    keyScore = Math.max(0, 14 - wheelDist * 3);
    keyRelation = 'Off-Key';
  }

  // Penalize slightly if tempo requires half/double time or excessive pitch/time stretch
  const halfDoublePenalty = isHalfOrDoubleTime ? 4 : 0;
  const totalScore = Math.max(0, Math.min(100, keyScore + bpmScore - halfDoublePenalty));

  const tier =
    totalScore >= 85
      ? 'perfect'
      : totalScore >= 70
      ? 'great'
      : totalScore >= 50
      ? 'good'
      : totalScore >= 32
      ? 'stretch'
      : 'clash';

  return {
    score: totalScore,
    tier,
    keyRelation,
    bpmDiffPct: Math.round(bestDiffPct * 10) / 10,
    isHalfOrDoubleTime,
  };
}

export async function decodeAndAnalyzeFile(
  file: File,
  audioCtx: AudioContext,
  orderIndex: number,
  options?: DecodeTrackOptions
): Promise<TrackAsset> {
  const arrayBuffer = await file.arrayBuffer();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

  const { peaks, low, mid, high } = extractWaveformPeaks(audioBuffer);
  const preserved = options?.preservedMeta;

  // Preserve user-edited or previously analyzed BPM/key when hydrating a saved project
  const { bpm, beatOffsetSec } = preserved
    ? { bpm: preserved.bpm, beatOffsetSec: preserved.beatOffsetSec }
    : detectBpmAndOffset(audioBuffer);

  const { musicalKey, camelotCode } = preserved
    ? { musicalKey: preserved.musicalKey, camelotCode: preserved.camelotCode }
    : detectMusicalKey(audioBuffer);

  const cleanTitle = preserved?.name ?? file.name.replace(/\.[^/.]+$/, '');

  return {
    id: options?.id ?? `trk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: cleanTitle,
    fileName: file.name,
    relativePath: options?.relativePath,
    fileSize: file.size,
    lastModified: file.lastModified,
    duration: audioBuffer.duration,
    sampleRate: audioBuffer.sampleRate,
    channels: audioBuffer.numberOfChannels,
    audioBuffer,
    waveformPeaks: peaks,
    waveformBands: { low, mid, high },
    bpm,
    beatOffsetSec,
    manualBeatgrid: preserved?.manualBeatgrid ? true : undefined,
    musicalKey,
    camelotCode,
    orderIndex: preserved?.orderIndex ?? orderIndex,
  };
}

export function formatTimecode(seconds: number, showTenths = false): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  if (!showTenths) return `${mm}:${ss}`;
  const tenths = Math.floor((safe % 1) * 10);
  return `${mm}:${ss}.${tenths}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
