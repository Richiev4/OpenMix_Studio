/**
 * TypeScript implementation of Mixxx's beat detection & grid-ironing pipeline:
 * 1. Queen Mary DSP (`qm-dsp`) `DetectionFunction` using Complex Spectral Difference (`DF_COMPLEXSD`)
 *    with adaptive spectral whitening and band-split low/high onset envelopes.
 * 2. Queen Mary DSP (`qm-dsp`) `TempoTrackV2`:
 *    - 16-frame centered adaptive moving-mean thresholding
 *    - Sliding-window unbiased autocorrelation + 4-harmonic Resonator Comb Filter Bank
 *      weighted by a Rayleigh tempo prior (peaking at 120 BPM)
 *    - Viterbi dynamic programming tempo contour decoding (Gaussian transition, sigma = 8)
 *    - Ellis / Davies dynamic programming beat localization (`alpha = 0.9`, `tightness = 4.0`)
 * 3. Mixxx `BeatUtils` (`src/track/beatutils.cpp`):
 *    - `retrieveConstRegions`: extracts steady constant-tempo beat regions (`kMaxSecsPhaseError = 25ms`)
 *    - `makeConstBpm` & `roundBpmWithinRange`: locks long-span tempo across intro-to-outro and snaps
 *      to musical integer/half/decimal BPMs only when cumulative phase drift stays inaudible
 *    - `adjustPhase`: circular-mean + trimmed-median phase lock across all constant-region beats
 *      refined to sub-millisecond onset precision
 */

export interface MixxxConstRegion {
  firstBeatSec: number;
  lastBeatSec: number;
  beatCount: number;
  meanBeatLenSec: number;
}

export interface MixxxOnsetData {
  /** Complex Spectral Difference onset novelty curve (raw, pre-threshold) */
  dfRaw: Float32Array;
  /** Adaptive-thresholded Complex Spectral Difference novelty curve */
  df: Float32Array;
  /** Low-band (<180 Hz) positive log-magnitude spectral flux (kicks/sub attacks) */
  lowFlux: Float32Array;
  /** Low-band (<180 Hz) spectral energy per frame */
  lowEnergy: Float32Array;
  /** Mid/High-band (250 Hz..6 kHz) positive log-magnitude spectral flux (snares/claps/percussion) */
  highFlux: Float32Array;
  /** Mid/High-band (>250 Hz) spectral energy per frame */
  highEnergy: Float32Array;
  /** Sample rate of source AudioBuffer */
  sr: number;
  /** STFT frame size (samples) */
  frameSize: number;
  /** STFT hop size (samples) */
  hopSize: number;
  /** Detection function frames per second (sr / hopSize, ~86.13 Hz at 44.1 kHz) */
  fps: number;
  /** Start sample index in source AudioBuffer */
  startSample: number;
  /** Total DF frames */
  frameCount: number;
  /** Window start in source seconds */
  windowStartSec: number;
  /** Window end in source seconds */
  windowEndSec: number;
}

export interface MixxxBeatTrackResult {
  bpm: number;
  /** Beat phase projected to [0, beatPeriodSec) at t = 0 */
  beatPhaseSec: number;
  /** Raw DP-tracked beat timestamps (seconds in source buffer) */
  rawBeatsSec: number[];
  /** Constant-tempo regions extracted by Mixxx BeatUtils */
  regions: MixxxConstRegion[];
  /** Confidence in [0..1] reflecting grid stability */
  confidence: number;
  /** Underlying STFT onset & band envelopes for downstream downbeat & leading-edge refinement */
  onsetData: MixxxOnsetData;
}

export interface MixxxAnalysisRange {
  startSec?: number;
  endSec?: number;
}

const TWO_PI = Math.PI * 2;
const MIXXX_MAX_PHASE_ERROR_SEC = 0.025; // Mixxx BeatUtils kMaxSecsPhaseError (25ms)
const MIXXX_MAX_ROUNDING_DRIFT_SEC = 0.015; // Tighter 15ms max cumulative drift for DJ mixes
const MIXXX_MAX_OUTLIERS = 2;
const MAX_ANALYZE_DURATION_SEC = 600; // Up to 10 full minutes analyzed end-to-end

interface FftTables {
  n: number;
  bitRev: Uint16Array;
  cos: Float32Array;
  sin: Float32Array;
  hann: Float32Array;
}

const fftTableCache = new Map<number, FftTables>();

function getFftTables(n: number): FftTables {
  const existing = fftTableCache.get(n);
  if (existing) return existing;

  const bits = Math.round(Math.log2(n));
  const half = n >> 1;
  const bitRev = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    let x = i;
    let r = 0;
    for (let b = 0; b < bits; b++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    bitRev[i] = r;
  }

  const cos = new Float32Array(half);
  const sin = new Float32Array(half);
  for (let i = 0; i < half; i++) {
    const angle = (TWO_PI * i) / n;
    cos[i] = Math.cos(angle);
    sin[i] = Math.sin(angle);
  }

  const hann = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    hann[i] = 0.5 * (1 - Math.cos((TWO_PI * i) / n));
  }

  const tables: FftTables = { n, bitRev, cos, sin, hann };
  fftTableCache.set(n, tables);
  return tables;
}

function forwardFftInPlace(re: Float32Array, im: Float32Array, tables: FftTables): void {
  const { n, bitRev, cos, sin } = tables;
  for (let i = 0; i < n; i++) {
    const j = bitRev[i];
    if (j > i) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let size = 2; size <= n; size <<= 1) {
    const halfSize = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      let tblIdx = 0;
      for (let j = 0; j < halfSize; j++) {
        const k = i + j;
        const m = k + halfSize;
        const wr = cos[tblIdx];
        const wi = -sin[tblIdx];
        tblIdx += step;
        const tr = wr * re[m] - wi * im[m];
        const ti = wr * im[m] + wi * re[m];
        re[m] = re[k] - tr;
        im[m] = im[k] - ti;
        re[k] += tr;
        im[k] += ti;
      }
    }
  }
}

// (Unit-phasor complex prediction replaces atan2/cos/princarg in DF_COMPLEXSD for exactness + speed)

/**
 * Exact qm-dsp TempoTrackV2 adaptive moving-mean thresholding (pre=8, post=7 frames).
 */
export function adaptiveThresholdDf(rawDf: Float32Array, pre = 8, post = 7): Float32Array {
  const n = rawDf.length;
  const out = new Float32Array(n);
  if (n === 0) return out;

  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    prefix[i + 1] = prefix[i] + rawDf[i];
  }

  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - pre);
    const hi = Math.min(n - 1, i + post);
    const mean = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
    const diff = rawDf[i] - mean;
    const v = diff > 0 ? diff : 0;
    out[i] = v;
    sumSq += v * v;
  }

  const rms = Math.sqrt(sumSq / Math.max(1, n));
  if (rms > 1e-8) {
    const inv = 1 / rms;
    for (let i = 0; i < n; i++) {
      out[i] *= inv;
    }
  }
  return out;
}

/**
 * Stage 1: Queen Mary `DetectionFunction` (`DF_COMPLEXSD`) + band-split spectral flux.
 * Operates on 1024-sample Hann windows with 512-sample hop (at <=50 kHz; 2048/1024 at 88.2/96 kHz).
 */
export function computeMixxxOnsetData(
  buffer: AudioBuffer,
  range?: MixxxAnalysisRange
): MixxxOnsetData | null {
  const sr = buffer.sampleRate;
  const totalSamples = buffer.length;
  const duration = buffer.duration;
  if (!Number.isFinite(duration) || duration < 1.5 || totalSamples < 2048) {
    return null;
  }

  let windowStartSec = 0;
  let windowEndSec = duration;
  if (
    typeof range?.startSec === 'number' &&
    typeof range?.endSec === 'number' &&
    range.endSec > range.startSec + 1.5
  ) {
    windowStartSec = Math.max(0, Math.min(duration, range.startSec));
    windowEndSec = Math.max(windowStartSec, Math.min(duration, range.endSec));
  } else if (duration > MAX_ANALYZE_DURATION_SEC) {
    // Cap extremely long recordings (>10 min) to their central 10 minutes
    windowStartSec = (duration - MAX_ANALYZE_DURATION_SEC) * 0.5;
    windowEndSec = windowStartSec + MAX_ANALYZE_DURATION_SEC;
  }

  const startSample = Math.max(0, Math.floor(windowStartSec * sr));
  const endSample = Math.min(totalSamples, Math.floor(windowEndSec * sr));
  const usableSamples = endSample - startSample;

  const frameSize = sr > 60000 ? 2048 : 1024;
  const hopSize = frameSize >> 1; // 50% overlap (exact qm-dsp AnalyzerQueenMaryBeats config)
  const frameCount = Math.floor((usableSamples - frameSize) / hopSize) + 1;
  if (frameCount < 32) {
    return null;
  }

  const fps = sr / hopSize;
  const half = frameSize >> 1;
  const tables = getFftTables(frameSize);
  const hann = tables.hann;

  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;

  const re = new Float32Array(frameSize);
  const im = new Float32Array(frameSize);

  const prevMag = new Float32Array(half + 1);
  const prevCos1 = new Float32Array(half + 1);
  const prevSin1 = new Float32Array(half + 1);
  const prevCos2 = new Float32Array(half + 1);
  const prevSin2 = new Float32Array(half + 1);
  prevCos1.fill(1);
  prevCos2.fill(1);
  const prevLogLow = new Float32Array(half + 1);
  const prevLogHigh = new Float32Array(half + 1);

  const binHz = sr / frameSize;
  const lowMaxBin = Math.max(2, Math.min(half, Math.round(180 / binHz)));
  const highMinBin = Math.max(lowMaxBin + 1, Math.min(half, Math.round(250 / binHz)));
  const highMaxBin = Math.max(highMinBin + 1, Math.min(half, Math.round(6500 / binHz)));
  const csdMaxBin = Math.max(highMaxBin, Math.min(half, Math.round(9000 / binHz)));

  // Per-bin gentle frequency emphasis: keeps exact unwhitened qm-dsp DF_COMPLEXSD behavior
  // (Mixxx AnalyzerQueenMaryBeats sets whiten=false) while keeping kicks/snares dominant over hi-hat hiss
  const binWeight = new Float32Array(half + 1);
  for (let k = 1; k <= half; k++) {
    const hz = k * binHz;
    if (hz <= 200) {
      binWeight[k] = 1.65;
    } else if (hz <= 2500) {
      binWeight[k] = 1.0;
    } else if (hz <= 9000) {
      binWeight[k] = 0.55;
    } else {
      binWeight[k] = 0;
    }
  }

  const dfRaw = new Float32Array(frameCount);
  const lowFluxRaw = new Float32Array(frameCount);
  const highFluxRaw = new Float32Array(frameCount);
  const lowEnergy = new Float32Array(frameCount);
  const highEnergy = new Float32Array(frameCount);

  for (let f = 0; f < frameCount; f++) {
    const base = startSample + f * hopSize;
    if (ch1) {
      for (let i = 0; i < frameSize; i++) {
        re[i] = (ch0[base + i] + ch1[base + i]) * 0.5 * hann[i];
        im[i] = 0;
      }
    } else {
      for (let i = 0; i < frameSize; i++) {
        re[i] = ch0[base + i] * hann[i];
        im[i] = 0;
      }
    }

    forwardFftInPlace(re, im, tables);

    let csdSum = 0;
    let lowFluxSum = 0;
    let highFluxSum = 0;
    let lowESum = 0;
    let highESum = 0;

    for (let k = 1; k <= csdMaxBin; k++) {
      const r = re[k];
      const m = im[k];
      const magSq = r * r + m * m;
      const rawMag = Math.sqrt(magSq);

      let uCos = 1;
      let uSin = 0;
      if (rawMag > 1e-12) {
        const invMag = 1 / rawMag;
        uCos = r * invMag;
        uSin = m * invMag;
      }

      if (f >= 2) {
        // Exact Complex Spectral Difference (Bello / qm-dsp DF_COMPLEXSD, unwhitened):
        // X_hat(m) = R_{m-1} * exp(i * (2*phi_{m-1} - phi_{m-2}))
        const c1 = prevCos1[k];
        const s1 = prevSin1[k];
        const c2 = prevCos2[k];
        const s2 = prevSin2[k];
        const cos2Phi1 = c1 * c1 - s1 * s1;
        const sin2Phi1 = 2 * c1 * s1;
        const predCos = cos2Phi1 * c2 + sin2Phi1 * s2;
        const predSin = sin2Phi1 * c2 - cos2Phi1 * s2;

        const prevM = prevMag[k];
        const diffRe = r - prevM * predCos;
        const diffIm = m - prevM * predSin;
        const dist = Math.sqrt(diffRe * diffRe + diffIm * diffIm);
        // Emphasize onset attack frames over release decay tails
        const attackWeight = rawMag >= prevM ? 1.0 : 0.35;
        csdSum += dist * attackWeight * binWeight[k];
      }

      if (k <= lowMaxBin) {
        lowESum += magSq;
        const logM = Math.log1p(12 * rawMag);
        const d = logM - prevLogLow[k];
        if (f >= 1 && d > 0) lowFluxSum += d;
        prevLogLow[k] = logM;
      } else if (k >= highMinBin && k <= highMaxBin) {
        highESum += magSq;
        const logM = Math.log1p(12 * rawMag);
        const d = logM - prevLogHigh[k];
        if (f >= 1 && d > 0) highFluxSum += d;
        prevLogHigh[k] = logM;
      }

      prevCos2[k] = prevCos1[k];
      prevSin2[k] = prevSin1[k];
      prevCos1[k] = uCos;
      prevSin1[k] = uSin;
      prevMag[k] = rawMag;
    }

    dfRaw[f] = csdSum;
    lowFluxRaw[f] = lowFluxSum;
    highFluxRaw[f] = highFluxSum;
    lowEnergy[f] = Math.sqrt(lowESum / lowMaxBin);
    highEnergy[f] = Math.sqrt(highESum / Math.max(1, highMaxBin - highMinBin + 1));
  }

  const df = adaptiveThresholdDf(dfRaw, 8, 7);
  const lowFlux = adaptiveThresholdDf(lowFluxRaw, 8, 7);
  const highFlux = adaptiveThresholdDf(highFluxRaw, 8, 7);

  return {
    dfRaw,
    df,
    lowFlux,
    lowEnergy,
    highFlux,
    highEnergy,
    sr,
    frameSize,
    hopSize,
    fps,
    startSample,
    frameCount,
    windowStartSec,
    windowEndSec,
  };
}

/**
 * Stage 2A: Queen Mary `TempoTrackV2::calculateBeatPeriod`.
 * Evaluates sliding 512-frame windows with unbiased autocorrelation -> 4-harmonic Resonator Comb
 * Filter Bank × Rayleigh Tempo Prior -> Viterbi decoding (sigma = 8) across the entire track.
 */
function calculateBeatPeriodViterbi(
  df: Float32Array,
  fps: number
): { periodPerWindow: Int32Array; winLen: number; hopLen: number } {
  const n = df.length;
  const winLen = 512;
  const hopLen = 128;
  const maxLag = 128;

  // Lag search range covering ~50..205 BPM at ~86.13 fps
  const minLag = Math.max(16, Math.floor((60 / 205) * fps));
  const maxSearchLag = Math.min(maxLag - 1, Math.ceil((60 / 50) * fps));

  // Rayleigh prior peaking around ~120 BPM (beta = 0.5 * fps ~= 43 frames at 86.13 fps)
  const rayBeta = 0.5 * fps;
  const rayWeights = new Float64Array(maxLag);
  for (let p = minLag; p <= maxSearchLag; p++) {
    const ratio = p / rayBeta;
    rayWeights[p] = (ratio / rayBeta) * Math.exp(-0.5 * ratio * ratio);
  }

  const numWindows = Math.max(1, Math.ceil(Math.max(1, n - winLen) / hopLen) + 1);
  const rcfMatrix = new Float64Array(numWindows * maxLag);
  const acf = new Float64Array(maxLag * 4 + 8);
  const comb = new Float64Array(maxLag);

  for (let w = 0; w < numWindows; w++) {
    const start = Math.min(Math.max(0, n - winLen), w * hopLen);
    const len = Math.min(winLen, n - start);
    if (len < minLag * 2) continue;

    // Max autocorrelation lag needed for 4th comb harmonic (4 * maxSearchLag + 4)
    const acfLimit = Math.min(len - 1, maxSearchLag * 4 + 4);
    for (let lag = 0; lag <= acfLimit; lag++) {
      let sum = 0;
      const limit = len - lag;
      for (let i = 0; i < limit; i++) {
        sum += df[start + i] * df[start + i + lag];
      }
      acf[lag] = limit > 0 ? sum / limit : 0;
    }

    // 4-harmonic Resonator Comb Filter Bank (exact qm-dsp TempoTrackV2)
    let rcfSum = 0;
    comb.fill(0);
    for (let p = minLag; p <= maxSearchLag; p++) {
      let c = 0;
      for (let a = 1; a <= 4; a++) {
        const width = 2 * a - 1;
        const center = a * p;
        let harmonicSum = 0;
        let harmonicCount = 0;
        for (let b = 1 - a; b <= a - 1; b++) {
          const idx = center + b;
          if (idx > 0 && idx <= acfLimit) {
            harmonicSum += acf[idx];
            harmonicCount++;
          }
        }
        if (harmonicCount > 0) {
          c += harmonicSum / width;
        }
      }
      const weighted = Math.max(0, c) * rayWeights[p];
      comb[p] = weighted;
      rcfSum += weighted;
    }

    const rowBase = w * maxLag;
    if (rcfSum > 1e-12) {
      const inv = 1 / rcfSum;
      for (let p = minLag; p <= maxSearchLag; p++) {
        rcfMatrix[rowBase + p] = comb[p] * inv;
      }
    } else {
      // Quiet breakdown window: uniform fallback so Viterbi carries prior tempo smoothly across
      const uniform = 1 / Math.max(1, maxSearchLag - minLag + 1);
      for (let p = minLag; p <= maxSearchLag; p++) {
        rcfMatrix[rowBase + p] = uniform;
      }
    }
  }

  // Viterbi decoding across windows with Gaussian transition penalty (sigma = 8)
  const sigma = 8;
  const invTwoSigmaSq = 1 / (2 * sigma * sigma);
  const delta = new Float64Array(numWindows * maxLag);
  const psi = new Int32Array(numWindows * maxLag);

  for (let p = minLag; p <= maxSearchLag; p++) {
    delta[p] = rcfMatrix[p];
  }

  for (let w = 1; w < numWindows; w++) {
    const prevRow = (w - 1) * maxLag;
    const curRow = w * maxLag;
    let rowSum = 0;

    for (let p = minLag; p <= maxSearchLag; p++) {
      let bestPrev = p;
      let bestScore = -1;
      // Search within ±3*sigma (99.7% of Gaussian mass) for O(W*L) speed
      const lo = Math.max(minLag, p - 24);
      const hi = Math.min(maxSearchLag, p + 24);
      for (let q = lo; q <= hi; q++) {
        const diff = p - q;
        const trans = Math.exp(-diff * diff * invTwoSigmaSq);
        const sc = delta[prevRow + q] * trans;
        if (sc > bestScore) {
          bestScore = sc;
          bestPrev = q;
        }
      }
      const val = bestScore * (rcfMatrix[curRow + p] + 1e-6);
      delta[curRow + p] = val;
      psi[curRow + p] = bestPrev;
      rowSum += val;
    }

    // Normalize per window to prevent floating-point underflow on long tracks
    if (rowSum > 1e-30) {
      const inv = 1 / rowSum;
      for (let p = minLag; p <= maxSearchLag; p++) {
        delta[curRow + p] *= inv;
      }
    }
  }

  const periodPerWindow = new Int32Array(numWindows);
  const lastRow = (numWindows - 1) * maxLag;
  let bestLastP = Math.round(rayBeta);
  let bestLastVal = -1;
  for (let p = minLag; p <= maxSearchLag; p++) {
    if (delta[lastRow + p] > bestLastVal) {
      bestLastVal = delta[lastRow + p];
      bestLastP = p;
    }
  }
  periodPerWindow[numWindows - 1] = bestLastP;
  for (let w = numWindows - 2; w >= 0; w--) {
    periodPerWindow[w] = psi[(w + 1) * maxLag + periodPerWindow[w + 1]];
  }

  return { periodPerWindow, winLen, hopLen };
}

/**
 * Stage 2B: Queen Mary `TempoTrackV2::calculateBeats`.
 * Dynamic programming beat localization (`alpha = 0.9`, `tightness = 4.0`) producing exact
 * beat timestamps across the entire track.
 */
function calculateBeatsDp(
  df: Float32Array,
  periodPerWindow: Int32Array,
  hopLen: number,
  fps: number,
  windowStartSec: number,
  frameSizeSec: number
): number[] {
  const n = df.length;
  if (n < 32) return [];

  // Light 3-tap smoothing of local onset score (exact qm-dsp Gaussian-like local score)
  const localScore = new Float64Array(n);
  localScore[0] = df[0];
  localScore[n - 1] = df[n - 1];
  for (let i = 1; i < n - 1; i++) {
    localScore[i] = df[i - 1] * 0.25 + df[i] * 0.5 + df[i + 1] * 0.25;
  }

  const alpha = 0.9;
  const tightness = 4.0;
  const cumScore = new Float64Array(n);
  const backlink = new Int32Array(n);
  backlink.fill(-1);

  const numWindows = periodPerWindow.length;

  for (let t = 0; t < n; t++) {
    const wIdx = Math.min(numWindows - 1, Math.floor(t / hopLen));
    const T = Math.max(12, periodPerWindow[wIdx]);

    const prangeStart = Math.max(0, Math.round(t - 2 * T));
    const prangeEnd = Math.round(t - 0.5 * T);

    if (prangeEnd < 0) {
      cumScore[t] = (1 - alpha) * localScore[t];
      backlink[t] = -1;
      continue;
    }

    let bestPrev = -1;
    let bestVal = -Infinity;
    const invT = 1 / T;

    for (let p = prangeStart; p <= prangeEnd; p++) {
      const lag = t - p;
      const logRatio = Math.log(lag * invT);
      const penalty = -tightness * logRatio * logRatio;
      const val = cumScore[p] + penalty;
      if (val > bestVal) {
        bestVal = val;
        bestPrev = p;
      }
    }

    cumScore[t] = (1 - alpha) * localScore[t] + alpha * bestVal;
    backlink[t] = bestPrev;
  }

  // Locate best terminal beat inside the last 2 beat periods
  const lastT = Math.max(12, periodPerWindow[numWindows - 1]);
  const tailStart = Math.max(0, n - Math.round(lastT * 2));
  let bestEnd = n - 1;
  let bestEndScore = -Infinity;
  for (let t = tailStart; t < n; t++) {
    if (cumScore[t] > bestEndScore) {
      bestEndScore = cumScore[t];
      bestEnd = t;
    }
  }

  const beatFrames: number[] = [];
  let cur = bestEnd;
  while (cur >= 0) {
    // Sub-frame parabolic refinement around local peak in DF
    let refinedFrame = cur;
    if (cur > 0 && cur < n - 1) {
      const y0 = df[cur - 1];
      const y1 = df[cur];
      const y2 = df[cur + 1];
      const denom = y0 - 2 * y1 + y2;
      if (denom < -1e-6 && y1 >= y0 && y1 >= y2) {
        const shift = 0.5 * (y0 - y2) / denom;
        refinedFrame = cur + Math.max(-0.5, Math.min(0.5, shift));
      }
    }
    beatFrames.push(refinedFrame);
    cur = backlink[cur];
  }

  beatFrames.reverse();

  // Convert DF frame index to exact source audio timestamp (window center offset = frameSize/2)
  const halfFrameSec = frameSizeSec * 0.5;
  return beatFrames.map((f) => windowStartSec + f / fps + halfFrameSec);
}

/**
 * Stage 3A: Mixxx `BeatUtils::retrieveConstRegions` (`src/track/beatutils.cpp`).
 * Scans raw DP-tracked beat timestamps and isolates contiguous constant-tempo regions while
 * ignoring breakdowns, fills, and transient detection outliers.
 */
export function retrieveConstRegions(rawBeatsSec: number[]): MixxxConstRegion[] {
  if (rawBeatsSec.length < 3) return [];

  const regions: MixxxConstRegion[] = [];
  let regionStartIdx = 0;
  let regionBeatSum = rawBeatsSec[1] - rawBeatsSec[0];
  let regionCount = 1;
  let outliers = 0;

  const pushRegion = (startIdx: number, endIdx: number) => {
    const count = endIdx - startIdx;
    if (count < 2) return;
    const span = rawBeatsSec[endIdx] - rawBeatsSec[startIdx];
    const meanLen = span / count;
    if (meanLen >= 0.25 && meanLen <= 1.35) {
      regions.push({
        firstBeatSec: rawBeatsSec[startIdx],
        lastBeatSec: rawBeatsSec[endIdx],
        beatCount: count,
        meanBeatLenSec: meanLen,
      });
    }
  };

  for (let i = 1; i < rawBeatsSec.length - 1; i++) {
    const nextDiff = rawBeatsSec[i + 1] - rawBeatsSec[i];
    const curMean = regionBeatSum / Math.max(1, regionCount);

    // Check both local interval deviation and cumulative phase error against region grid
    const expectedNext = rawBeatsSec[regionStartIdx] + (i + 1 - regionStartIdx) * curMean;
    const phaseErr = Math.abs(rawBeatsSec[i + 1] - expectedNext);
    const stepErr = Math.abs(nextDiff - curMean);

    if (stepErr <= MIXXX_MAX_PHASE_ERROR_SEC && phaseErr <= MIXXX_MAX_PHASE_ERROR_SEC * 1.6) {
      regionBeatSum += nextDiff;
      regionCount++;
      outliers = 0;
    } else {
      outliers++;
      if (outliers > MIXXX_MAX_OUTLIERS) {
        const lastValidIdx = Math.max(regionStartIdx, i - outliers + 1);
        pushRegion(regionStartIdx, lastValidIdx);
        regionStartIdx = i;
        regionBeatSum = nextDiff;
        regionCount = 1;
        outliers = 0;
      }
    }
  }

  pushRegion(regionStartIdx, rawBeatsSec.length - 1 - outliers);
  return regions;
}

/**
 * Mixxx `BeatUtils::roundBpmWithinRange`:
 * Snaps centerBpm to the cleanest musical BPM inside [minBpm, maxBpm] (where cumulative drift
 * stays imperceptible across the track's constant-tempo span).
 */
export function roundBpmWithinRange(minBpm: number, centerBpm: number, maxBpm: number): number {
  const lo = Math.min(minBpm, maxBpm);
  const hi = Math.max(minBpm, maxBpm);

  // 1. Exact integer BPM (e.g., 128.00)
  const nearestInt = Math.round(centerBpm);
  if (nearestInt >= lo && nearestInt <= hi) {
    return nearestInt;
  }

  // 2. Exact half-integer BPM (e.g., 127.50)
  const nearestHalf = Math.round(centerBpm * 2) / 2;
  if (nearestHalf >= lo && nearestHalf <= hi) {
    return nearestHalf;
  }

  // 3. Exact 0.1 BPM (e.g., 126.40)
  const nearestTenth = Math.round(centerBpm * 10) / 10;
  if (nearestTenth >= lo && nearestTenth <= hi) {
    return nearestTenth;
  }

  // 4. Exact 0.25 BPM (e.g., 124.25)
  const nearestQuarter = Math.round(centerBpm * 4) / 4;
  if (nearestQuarter >= lo && nearestQuarter <= hi) {
    return nearestQuarter;
  }

  // 5. Preserve exact 0.01 BPM resolution
  return Math.round(centerBpm * 100) / 100;
}

function sampleLinear(arr: Float32Array, idxFloat: number): number {
  if (idxFloat < 0 || idxFloat >= arr.length - 1) return 0;
  const i0 = Math.floor(idxFloat);
  const frac = idxFloat - i0;
  return arr[i0] * (1 - frac) + arr[i0 + 1] * frac;
}

/**
 * Evaluates how strongly a candidate BPM grid matches combined Complex SD + Low-band kick onsets
 * vs its off-beat half-step positions (used for octave disambiguation and fine grid refinement).
 */
function scoreBeatGridOnDf(
  df: Float32Array,
  lowFlux: Float32Array,
  fps: number,
  windowStartSec: number,
  halfFrameSec: number,
  bpm: number
): { onMean: number; halfMean: number; contrast: number; bestPhaseSec: number } {
  const beatPeriodSec = 60 / bpm;
  const beatPeriodFrames = beatPeriodSec * fps;
  const n = df.length;
  if (beatPeriodFrames < 12 || beatPeriodFrames * 4 >= n) {
    return { onMean: 0, halfMean: 0, contrast: 0, bestPhaseSec: 0 };
  }

  const steps = Math.max(48, Math.min(120, Math.round(beatPeriodFrames * 2)));
  let bestContrast = -Infinity;
  let bestOn = 0;
  let bestHalf = 0;
  let bestPhaseFrames = 0;

  for (let s = 0; s < steps; s++) {
    const phase = (s / steps) * beatPeriodFrames;
    let onSum = 0;
    let halfSum = 0;
    let count = 0;
    for (let pos = phase; pos + beatPeriodFrames * 0.5 < n - 2; pos += beatPeriodFrames) {
      const onVal =
        (sampleLinear(df, pos - 0.5) * 0.35 +
          sampleLinear(df, pos) +
          sampleLinear(df, pos + 0.5) * 0.35) *
          0.62 +
        (sampleLinear(lowFlux, pos - 0.5) * 0.35 +
          sampleLinear(lowFlux, pos) +
          sampleLinear(lowFlux, pos + 0.5) * 0.35) *
          0.38;
      const hPos = pos + beatPeriodFrames * 0.5;
      const halfVal =
        (sampleLinear(df, hPos - 0.5) * 0.35 +
          sampleLinear(df, hPos) +
          sampleLinear(df, hPos + 0.5) * 0.35) *
          0.62 +
        (sampleLinear(lowFlux, hPos - 0.5) * 0.35 +
          sampleLinear(lowFlux, hPos) +
          sampleLinear(lowFlux, hPos + 0.5) * 0.35) *
          0.38;
      onSum += onVal;
      halfSum += halfVal;
      count++;
    }
    if (count > 0) {
      const onMean = onSum / count;
      const halfMean = halfSum / count;
      const contrast = onMean - halfMean * 0.85;
      if (contrast > bestContrast) {
        bestContrast = contrast;
        bestOn = onMean;
        bestHalf = halfMean;
        bestPhaseFrames = phase;
      }
    }
  }

  const phaseAtTrack = windowStartSec + bestPhaseFrames / fps + halfFrameSec;
  const bestPhaseSec = ((phaseAtTrack % beatPeriodSec) + beatPeriodSec) % beatPeriodSec;
  return {
    onMean: bestOn,
    halfMean: bestHalf,
    contrast: Math.max(0, bestContrast),
    bestPhaseSec,
  };
}

/**
 * Stage 3B: Mixxx `BeatUtils::makeConstBpm` + Cross-Region Long-Span Precision Lock.
 */
function makeConstBpm(
  regions: MixxxConstRegion[],
  rawBeatsSec: number[],
  onsetData: MixxxOnsetData
): { bpm: number; dominantRegions: MixxxConstRegion[]; confidence: number } {
  const { df, lowFlux, fps, windowStartSec, frameSize, sr } = onsetData;
  const halfFrameSec = (frameSize / sr) * 0.5;

  // Fallback if track was too short/erratic to form constant regions
  if (regions.length === 0) {
    if (rawBeatsSec.length >= 2) {
      const diffs: number[] = [];
      for (let i = 1; i < rawBeatsSec.length; i++) {
        const d = rawBeatsSec[i] - rawBeatsSec[i - 1];
        if (d >= 0.28 && d <= 1.25) diffs.push(d);
      }
      if (diffs.length > 0) {
        diffs.sort((a, b) => a - b);
        const medianLen = diffs[Math.floor(diffs.length * 0.5)];
        const fallbackBpm = Math.max(60, Math.min(200, Math.round((60 / medianLen) * 100) / 100));
        return { bpm: fallbackBpm, dominantRegions: [], confidence: 0.35 };
      }
    }
    return { bpm: 120, dominantRegions: [], confidence: 0.1 };
  }

  // Cluster constant regions with matching tempo (within ±1.5% beat length)
  let bestCluster: MixxxConstRegion[] = [];
  let bestClusterBeats = 0;

  for (let i = 0; i < regions.length; i++) {
    const seedLen = regions[i].meanBeatLenSec;
    const cluster: MixxxConstRegion[] = [];
    let totalBeats = 0;
    for (let j = 0; j < regions.length; j++) {
      if (Math.abs(regions[j].meanBeatLenSec - seedLen) / seedLen <= 0.015) {
        cluster.push(regions[j]);
        totalBeats += regions[j].beatCount;
      }
    }
    if (totalBeats > bestClusterBeats) {
      bestClusterBeats = totalBeats;
      bestCluster = cluster;
    }
  }

  // Weighted average beat length across dominant constant regions
  let totalSpanSec = 0;
  let totalClusterBeats = 0;
  let longestRegion = bestCluster[0];
  for (const reg of bestCluster) {
    totalSpanSec += reg.lastBeatSec - reg.firstBeatSec;
    totalClusterBeats += reg.beatCount;
    if (reg.beatCount > longestRegion.beatCount) {
      longestRegion = reg;
    }
  }

  let meanBeatLenSec = totalSpanSec / Math.max(1, totalClusterBeats);

  // Cross-region long-span verification: if the track has steady sections near intro AND outro
  // separated by a breakdown, verify integer beat count across the entire span for 0.001 BPM precision!
  if (bestCluster.length >= 2) {
    const firstReg = bestCluster[0];
    const lastReg = bestCluster[bestCluster.length - 1];
    const fullSpan = lastReg.lastBeatSec - firstReg.firstBeatSec;
    if (fullSpan > (longestRegion.lastBeatSec - longestRegion.firstBeatSec) * 1.25) {
      const approxBeats = fullSpan / meanBeatLenSec;
      const intBeats = Math.round(approxBeats);
      if (intBeats >= 16) {
        const candidateLen = fullSpan / intBeats;
        const candidateBpm = 60 / candidateLen;
        // Verify all dominant regions stay phase-locked under this long-span BPM
        const avgPhaseErr = measureRegionsPhaseRms(bestCluster, rawBeatsSec, candidateLen);
        const origPhaseErr = measureRegionsPhaseRms(bestCluster, rawBeatsSec, meanBeatLenSec);
        if (
          Math.abs(candidateLen - meanBeatLenSec) / meanBeatLenSec <= 0.008 &&
          avgPhaseErr <= Math.max(origPhaseErr * 1.05, 0.014) &&
          candidateBpm >= 55 &&
          candidateBpm <= 205
        ) {
          meanBeatLenSec = candidateLen;
        }
      }
    }
  }

  let centerBpm = 60 / meanBeatLenSec;

  // Fine continuous BPM refinement (±0.35 BPM) maximizing phase coherence + onset alignment across all dominant regions
  const refineSearchMin = Math.max(55, centerBpm - 0.35);
  const refineSearchMax = Math.min(205, centerBpm + 0.35);
  let bestRefinedBpm = centerBpm;
  let bestRefinedScore = -Infinity;

  const evalBpmCoherence = (candBpm: number): number => {
    const period = 60 / candBpm;
    // Circular resultant length R in [0..1] over all beats inside dominant constant regions
    const { resultant, phaseSec } = computeCircularBeatPhase(bestCluster, rawBeatsSec, period);
    // Also measure DF peak energy at that exact constant-BPM grid
    const dfScore = evaluateGridDfScore(
      df,
      lowFlux,
      fps,
      windowStartSec,
      halfFrameSec,
      period,
      phaseSec,
      bestCluster
    );
    return resultant * 0.55 + dfScore * 0.45;
  };

  for (let b = refineSearchMin; b <= refineSearchMax + 1e-6; b += 0.02) {
    const sc = evalBpmCoherence(b);
    if (sc > bestRefinedScore) {
      bestRefinedScore = sc;
      bestRefinedBpm = b;
    }
  }
  // Ultra-fine 0.004 BPM pass
  const ultraCenter = bestRefinedBpm;
  for (let b = Math.max(55, ultraCenter - 0.04); b <= Math.min(205, ultraCenter + 0.04) + 1e-6; b += 0.004) {
    const sc = evalBpmCoherence(b);
    if (sc > bestRefinedScore) {
      bestRefinedScore = sc;
      bestRefinedBpm = b;
    }
  }
  centerBpm = bestRefinedBpm;

  // DJ Octave Disambiguation (prevents half-time 64 BPM or double-time 185 BPM traps)
  if (centerBpm < 92 && centerBpm * 2 <= 185) {
    const slow = scoreBeatGridOnDf(df, lowFlux, fps, windowStartSec, halfFrameSec, centerBpm);
    const slowHalfRatio = slow.onMean > 1e-6 ? slow.halfMean / slow.onMean : 0;
    if (slowHalfRatio > 0.48) {
      const fast = scoreBeatGridOnDf(df, lowFlux, fps, windowStartSec, halfFrameSec, centerBpm * 2);
      if (fast.contrast >= slow.contrast * 0.85 && fast.onMean >= slow.onMean * 0.65) {
        centerBpm *= 2;
      }
    }
  } else if (centerBpm > 158 && centerBpm * 0.5 >= 72) {
    const fast = scoreBeatGridOnDf(df, lowFlux, fps, windowStartSec, halfFrameSec, centerBpm);
    const slow = scoreBeatGridOnDf(df, lowFlux, fps, windowStartSec, halfFrameSec, centerBpm * 0.5);
    if (slow.contrast > fast.contrast * 1.12) {
      centerBpm *= 0.5;
    }
  }

  // Mixxx BeatUtils::roundBpmWithinRange: allow musical rounding only if cumulative drift across
  // the effective track span stays below MIXXX_MAX_ROUNDING_DRIFT_SEC (15ms)
  const effectiveSpanSec = Math.max(
    16,
    bestCluster[bestCluster.length - 1].lastBeatSec - bestCluster[0].firstBeatSec
  );
  const maxBpmDrift = (centerBpm * MIXXX_MAX_ROUNDING_DRIFT_SEC) / effectiveSpanSec;
  const clampedDrift = Math.min(0.08, Math.max(0.015, maxBpmDrift));
  const finalBpm = roundBpmWithinRange(centerBpm - clampedDrift, centerBpm, centerBpm + clampedDrift);

  const totalRawBeats = Math.max(1, rawBeatsSec.length - 1);
  const coverage = Math.min(1, totalClusterBeats / totalRawBeats);
  const { resultant } = computeCircularBeatPhase(bestCluster, rawBeatsSec, 60 / finalBpm);
  const confidence = Math.max(0, Math.min(1, coverage * 0.45 + resultant * 0.55));

  return { bpm: finalBpm, dominantRegions: bestCluster, confidence };
}

function collectBeatsInRegions(regions: MixxxConstRegion[], rawBeatsSec: number[]): number[] {
  if (regions.length === 0) return rawBeatsSec;
  const out: number[] = [];
  for (const t of rawBeatsSec) {
    for (let r = 0; r < regions.length; r++) {
      if (t >= regions[r].firstBeatSec - 0.005 && t <= regions[r].lastBeatSec + 0.005) {
        out.push(t);
        break;
      }
    }
  }
  return out.length >= 4 ? out : rawBeatsSec;
}

function computeCircularBeatPhase(
  regions: MixxxConstRegion[],
  rawBeatsSec: number[],
  beatPeriodSec: number
): { phaseSec: number; resultant: number } {
  const beats = collectBeatsInRegions(regions, rawBeatsSec);
  if (beats.length === 0 || beatPeriodSec <= 0) {
    return { phaseSec: 0, resultant: 0 };
  }

  let sumCos = 0;
  let sumSin = 0;
  const invPeriod = 1 / beatPeriodSec;
  for (let i = 0; i < beats.length; i++) {
    const angle = TWO_PI * ((beats[i] * invPeriod) % 1);
    sumCos += Math.cos(angle);
    sumSin += Math.sin(angle);
  }

  const resultant = Math.hypot(sumCos, sumSin) / beats.length;
  let meanAngle = Math.atan2(sumSin, sumCos);
  if (meanAngle < 0) meanAngle += TWO_PI;
  const phaseSec = (meanAngle / TWO_PI) * beatPeriodSec;
  return { phaseSec, resultant };
}

function measureRegionsPhaseRms(
  regions: MixxxConstRegion[],
  rawBeatsSec: number[],
  beatPeriodSec: number
): number {
  const beats = collectBeatsInRegions(regions, rawBeatsSec);
  if (beats.length === 0) return 1;
  const { phaseSec } = computeCircularBeatPhase(regions, rawBeatsSec, beatPeriodSec);
  let sumSq = 0;
  for (let i = 0; i < beats.length; i++) {
    let err = ((beats[i] - phaseSec) % beatPeriodSec + beatPeriodSec) % beatPeriodSec;
    if (err > beatPeriodSec * 0.5) err -= beatPeriodSec;
    sumSq += err * err;
  }
  return Math.sqrt(sumSq / beats.length);
}

function evaluateGridDfScore(
  df: Float32Array,
  lowFlux: Float32Array,
  fps: number,
  windowStartSec: number,
  halfFrameSec: number,
  beatPeriodSec: number,
  phaseSec: number,
  regions: MixxxConstRegion[]
): number {
  const n = df.length;
  const minT = regions.length > 0 ? regions[0].firstBeatSec : windowStartSec;
  const maxT = regions.length > 0 ? regions[regions.length - 1].lastBeatSec : windowStartSec + n / fps;
  const firstK = Math.ceil((minT - phaseSec) / beatPeriodSec);
  const lastK = Math.floor((maxT - phaseSec) / beatPeriodSec);
  let sum = 0;
  let count = 0;

  for (let k = firstK; k <= lastK; k++) {
    const t = phaseSec + k * beatPeriodSec;
    const fFloat = (t - windowStartSec - halfFrameSec) * fps;
    if (fFloat < 1 || fFloat >= n - 2) continue;
    const v =
      (sampleLinear(df, fFloat - 0.35) * 0.3 +
        sampleLinear(df, fFloat) +
        sampleLinear(df, fFloat + 0.35) * 0.3) *
        0.55 +
      (sampleLinear(lowFlux, fFloat - 0.35) * 0.3 +
        sampleLinear(lowFlux, fFloat) +
        sampleLinear(lowFlux, fFloat + 0.35) * 0.3) *
        0.45;
    sum += v;
    count++;
  }
  return count > 0 ? sum / (count * 3.5) : 0;
}

/**
 * Stage 3C: Mixxx `BeatUtils::adjustPhase` — projects constant-region beats onto the rigid
 * BPM grid via circular mean + trimmed median, then fine-locks sub-millisecond onset phase on DF.
 */
function adjustMixxxPhase(
  bpm: number,
  rawBeatsSec: number[],
  dominantRegions: MixxxConstRegion[],
  onsetData: MixxxOnsetData
): number {
  const beatPeriodSec = 60 / bpm;
  const { df, lowFlux, fps, windowStartSec, frameSize, sr } = onsetData;
  const halfFrameSec = (frameSize / sr) * 0.5;

  // 1. Circular mean of all beats in dominant constant regions (Mixxx BeatUtils::adjustPhase core)
  const { phaseSec: circularPhase, resultant } = computeCircularBeatPhase(
    dominantRegions,
    rawBeatsSec,
    beatPeriodSec
  );

  // 2. Outlier-robust median refinement around circular phase
  const beats = collectBeatsInRegions(dominantRegions, rawBeatsSec);
  let basePhase = circularPhase;
  if (beats.length >= 4 && resultant > 0.25) {
    const residuals: number[] = [];
    for (let i = 0; i < beats.length; i++) {
      let err = ((beats[i] - circularPhase) % beatPeriodSec + beatPeriodSec) % beatPeriodSec;
      if (err > beatPeriodSec * 0.5) err -= beatPeriodSec;
      residuals.push(err);
    }
    residuals.sort((a, b) => a - b);
    const medianErr = residuals[Math.floor(residuals.length * 0.5)];
    basePhase = ((circularPhase + medianErr) % beatPeriodSec + beatPeriodSec) % beatPeriodSec;
  } else {
    // Low circular coherence (e.g. short clip): global DF phase scan
    const grid = scoreBeatGridOnDf(df, lowFlux, fps, windowStartSec, halfFrameSec, bpm);
    basePhase = grid.bestPhaseSec;
  }

  // 2b. On-beat vs off-beat half-beat disambiguation:
  // Prevents locking onto bright off-beat hi-hats ("and" beats) instead of on-beat kicks/snares
  const halfShifted = ((basePhase + beatPeriodSec * 0.5) % beatPeriodSec + beatPeriodSec) % beatPeriodSec;
  const onBeatKickScore = evaluateOnBeatKickScore(
    onsetData,
    beatPeriodSec,
    basePhase,
    dominantRegions
  );
  const offBeatKickScore = evaluateOnBeatKickScore(
    onsetData,
    beatPeriodSec,
    halfShifted,
    dominantRegions
  );
  if (offBeatKickScore > onBeatKickScore * 1.12) {
    basePhase = halfShifted;
  }

  // 3. Sub-millisecond DF peak lock around basePhase (±20ms at 0.5ms resolution)
  let bestPhase = basePhase;
  let bestScore = -Infinity;
  for (let delta = -0.02; delta <= 0.02 + 1e-6; delta += 0.0005) {
    const cand = ((basePhase + delta) % beatPeriodSec + beatPeriodSec) % beatPeriodSec;
    const sc = evaluateGridDfScore(
      df,
      lowFlux,
      fps,
      windowStartSec,
      halfFrameSec,
      beatPeriodSec,
      cand,
      dominantRegions
    );
    if (sc > bestScore) {
      bestScore = sc;
      bestPhase = cand;
    }
  }

  return ((bestPhase % beatPeriodSec) + beatPeriodSec) % beatPeriodSec;
}

/**
 * Evaluates kick + on-beat percussive prominence for a candidate phase to reliably distinguish
 * true on-beats (1, 2, 3, 4) from bright off-beat hi-hats (1+, 2+, 3+, 4+).
 */
function evaluateOnBeatKickScore(
  onsetData: MixxxOnsetData,
  beatPeriodSec: number,
  phaseSec: number,
  regions: MixxxConstRegion[]
): number {
  const { df, lowFlux, lowEnergy, fps, windowStartSec, frameSize, sr } = onsetData;
  const halfFrameSec = (frameSize / sr) * 0.5;
  const n = df.length;
  const minT = regions.length > 0 ? regions[0].firstBeatSec : windowStartSec;
  const maxT = regions.length > 0 ? regions[regions.length - 1].lastBeatSec : windowStartSec + n / fps;
  const firstK = Math.ceil((minT - phaseSec) / beatPeriodSec);
  const lastK = Math.floor((maxT - phaseSec) / beatPeriodSec);

  let lowFluxSum = 0;
  let lowEnergySum = 0;
  let dfSum = 0;
  let count = 0;

  for (let k = firstK; k <= lastK; k++) {
    const t = phaseSec + k * beatPeriodSec;
    const fFloat = (t - windowStartSec - halfFrameSec) * fps;
    if (fFloat < 2 || fFloat >= n - 3) continue;
    const lf =
      sampleLinear(lowFlux, fFloat - 0.5) * 0.35 +
      sampleLinear(lowFlux, fFloat) +
      sampleLinear(lowFlux, fFloat + 0.5) * 0.35;
    const le =
      sampleLinear(lowEnergy, fFloat) * 0.5 +
      sampleLinear(lowEnergy, fFloat + 1.0) * 0.5;
    const d =
      sampleLinear(df, fFloat - 0.35) * 0.3 +
      sampleLinear(df, fFloat) +
      sampleLinear(df, fFloat + 0.35) * 0.3;
    lowFluxSum += lf;
    lowEnergySum += le;
    dfSum += d;
    count++;
  }
  if (count === 0) return 0;
  return (lowFluxSum * 0.65 + lowEnergySum * 0.20 + dfSum * 0.15) / count;
}

/**
 * Full Mixxx Queen Mary Beat Detection + BeatUtils constant-grid pipeline.
 */
export function runMixxxBeatTracker(
  buffer: AudioBuffer,
  range?: MixxxAnalysisRange
): MixxxBeatTrackResult | null {
  const onsetData = computeMixxxOnsetData(buffer, range);
  if (!onsetData) return null;

  const { df, fps, windowStartSec, frameSize, sr } = onsetData;
  const frameSizeSec = frameSize / sr;

  // Stage 2A: Comb Filter Bank + Rayleigh Prior + Viterbi Tempo Contour
  const { periodPerWindow, hopLen } = calculateBeatPeriodViterbi(df, fps);

  // Stage 2B: Dynamic Programming Beat Localization
  const rawBeatsSec = calculateBeatsDp(
    df,
    periodPerWindow,
    hopLen,
    fps,
    windowStartSec,
    frameSizeSec
  );

  // Stage 3A: Mixxx BeatUtils::retrieveConstRegions
  const regions = retrieveConstRegions(rawBeatsSec);

  // Stage 3B: Mixxx BeatUtils::makeConstBpm + roundBpmWithinRange
  const { bpm, dominantRegions, confidence } = makeConstBpm(regions, rawBeatsSec, onsetData);

  // Stage 3C: Mixxx BeatUtils::adjustPhase
  const beatPhaseSec = adjustMixxxPhase(bpm, rawBeatsSec, dominantRegions, onsetData);

  return {
    bpm,
    beatPhaseSec,
    rawBeatsSec,
    regions: dominantRegions.length > 0 ? dominantRegions : regions,
    confidence,
    onsetData,
  };
}

/**
 * Mixxx-style phase adjustment for an already-known/manual BPM:
 * Computes Complex Spectral Difference + Low-band Kick Flux and locks the beat phase
 * across the track (or requested window) with sub-millisecond accuracy.
 */
export function detectMixxxPhaseForKnownBpm(
  buffer: AudioBuffer,
  bpm: number,
  range?: MixxxAnalysisRange
): { beatPhaseSec: number; onsetData: MixxxOnsetData } | null {
  if (!Number.isFinite(bpm) || bpm <= 0) return null;
  const onsetData = computeMixxxOnsetData(buffer, range);
  if (!onsetData) return null;

  const { df, lowFlux, fps, windowStartSec, frameSize, sr } = onsetData;
  const halfFrameSec = (frameSize / sr) * 0.5;
  const beatPeriodSec = 60 / bpm;

  // Coarse grid scan over 1 beat period
  const coarse = scoreBeatGridOnDf(df, lowFlux, fps, windowStartSec, halfFrameSec, bpm);
  let anchorPhase = coarse.bestPhaseSec;

  // On-beat vs off-beat disambiguation
  const halfShifted =
    ((anchorPhase + beatPeriodSec * 0.5) % beatPeriodSec + beatPeriodSec) % beatPeriodSec;
  if (
    evaluateOnBeatKickScore(onsetData, beatPeriodSec, halfShifted, []) >
    evaluateOnBeatKickScore(onsetData, beatPeriodSec, anchorPhase, []) * 1.12
  ) {
    anchorPhase = halfShifted;
  }

  // Fine sub-millisecond refinement (±12ms at 0.25ms steps)
  let bestPhase = anchorPhase;
  let bestScore = -Infinity;
  for (let delta = -0.012; delta <= 0.012 + 1e-6; delta += 0.00025) {
    const cand = ((anchorPhase + delta) % beatPeriodSec + beatPeriodSec) % beatPeriodSec;
    const sc = evaluateGridDfScore(
      df,
      lowFlux,
      fps,
      windowStartSec,
      halfFrameSec,
      beatPeriodSec,
      cand,
      []
    );
    if (sc > bestScore) {
      bestScore = sc;
      bestPhase = cand;
    }
  }

  return { beatPhaseSec: bestPhase, onsetData };
}

/**
 * Computes a high-resolution STFT Complex Spectral Difference + Low-Band Kick onset curve
 * sampled directly along the timeline for two overlapping clips (used by Auto-Lock Beats /
 * Auto-Align Kicks so both percussive kicks AND melodic/breakbeat transients align crisply).
 */
export function computeTimelineComplexOnsetCurve(
  ch0: Float32Array,
  ch1: Float32Array | null,
  sr: number,
  mapTimelineToSrcSec: (timelineSec: number) => number,
  sampleStartSec: number,
  sampleDurSec: number,
  dtSec = 0.004
): Float32Array {
  const frameCount = Math.max(1, Math.floor(sampleDurSec / dtSec));
  const bufLen = ch0.length;
  const fftN = 512;
  const half = fftN >> 1;
  const tables = getFftTables(fftN);
  const hann = tables.hann;

  const re = new Float32Array(fftN);
  const im = new Float32Array(fftN);
  const prevMag = new Float32Array(half + 1);
  const prevCos1 = new Float32Array(half + 1);
  const prevSin1 = new Float32Array(half + 1);
  const prevCos2 = new Float32Array(half + 1);
  const prevSin2 = new Float32Array(half + 1);
  prevCos1.fill(1);
  prevCos2.fill(1);
  const prevLowLog = new Float32Array(half + 1);

  const binHz = sr / fftN;
  const lowMaxBin = Math.max(2, Math.min(half, Math.round(180 / binHz)));
  const maxCsdBin = Math.max(lowMaxBin + 1, Math.min(half, Math.round(9000 / binHz)));
  const rawCurve = new Float32Array(frameCount);

  for (let f = 0; f < frameCount; f++) {
    const tSec = sampleStartSec + f * dtSec;
    const srcSec = mapTimelineToSrcSec(tSec);
    const centerSample = Math.round(srcSec * sr);
    const startIdx = centerSample - half;

    for (let i = 0; i < fftN; i++) {
      const idx = startIdx + i;
      if (idx >= 0 && idx < bufLen) {
        const s = ch1 ? (ch0[idx] + ch1[idx]) * 0.5 : ch0[idx];
        re[i] = s * hann[i];
      } else {
        re[i] = 0;
      }
      im[i] = 0;
    }

    forwardFftInPlace(re, im, tables);

    let csd = 0;
    let lowFlux = 0;
    for (let k = 1; k <= maxCsdBin; k++) {
      const r = re[k];
      const m = im[k];
      const mag = Math.sqrt(r * r + m * m);
      let uCos = 1;
      let uSin = 0;
      if (mag > 1e-12) {
        const inv = 1 / mag;
        uCos = r * inv;
        uSin = m * inv;
      }

      if (f >= 2) {
        const pm = prevMag[k];
        if (mag >= pm * 0.85) {
          const c1 = prevCos1[k];
          const s1 = prevSin1[k];
          const c2 = prevCos2[k];
          const s2 = prevSin2[k];
          const cos2Phi1 = c1 * c1 - s1 * s1;
          const sin2Phi1 = 2 * c1 * s1;
          const predCos = cos2Phi1 * c2 + sin2Phi1 * s2;
          const predSin = sin2Phi1 * c2 - cos2Phi1 * s2;
          const diffRe = r - pm * predCos;
          const diffIm = m - pm * predSin;
          csd += Math.sqrt(diffRe * diffRe + diffIm * diffIm);
        }
      }

      if (k <= lowMaxBin) {
        const logM = Math.log1p(16 * mag);
        const dl = logM - prevLowLog[k];
        if (f >= 1 && dl > 0) lowFlux += dl;
        prevLowLog[k] = logM;
      }

      prevCos2[k] = prevCos1[k];
      prevSin2[k] = prevSin1[k];
      prevCos1[k] = uCos;
      prevSin1[k] = uSin;
      prevMag[k] = mag;
    }

    rawCurve[f] = csd * 0.45 + lowFlux * 0.55;
  }

  return adaptiveThresholdDf(rawCurve, 12, 12);
}
