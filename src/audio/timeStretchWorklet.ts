/**
 * Self-contained AudioWorkletProcessor and offline buffer processor implementing a
 * zero-latency Stereo Phase-Locked Phase Vocoder (2048-pt FFT, 512-sample hop,
 * Laroche-Dolson peak phase locking, joint stereo cross-power instantaneous frequency,
 * exact inter-channel phase difference preservation, and band-aware transient phase reset),
 * plus a stereo PCM capture processor for lossless live mix recording.
 */

const WORKLET_CODE = `
class TimeStretchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'tempoRatio', defaultValue: 1, minValue: 0.25, maxValue: 4.0, automationRate: 'k-rate' },
      { name: 'playbackSpeed', defaultValue: 1, minValue: 0.25, maxValue: 4.0, automationRate: 'k-rate' },
      { name: 'pitchSemitones', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.left = null;
    this.right = null;
    this.totalSamples = 0;
    this.sourceSampleRate = 44100;

    this.isPlaying = false;
    this.sourceEnded = false;
    this.retired = false;
    this.autoRetire = false;
    this.useAudioParams = false;

    this.cursor = 0; // fractional playback position in source samples
    this.frameCursor = 0; // monotonic analysis center position for STFT frames
    this.tempoRatio = 1.0;
    this.keyLock = true;
    this.pitchSemitones = 0;

    this.startCtxTime = 0;
    this.hasStarted = false;
    this.maxOutSamples = Infinity;
    this.playedOutSamples = 0;

    this.loopEnabled = false;
    this.loopStart = 0;
    this.loopEnd = 0;

    // Stereo Phase-Locked Phase Vocoder constants (75% overlap Hann-squared exact COLA)
    this.N = 2048;
    this.HALF = 1024;
    this.HOP_S = 512;
    this.TWO_PI = Math.PI * 2;
    this.INV_TWO_PI = 1 / (Math.PI * 2);
    this.TWO_PI_OVER_N = (Math.PI * 2) / this.N;

    // Precompute bit-reversal & twiddle tables for in-place radix-2 FFT
    this.bitRev = new Uint16Array(this.N);
    const bits = 11; // log2(2048)
    for (let i = 0; i < this.N; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.bitRev[i] = r;
    }

    this.cosTable = new Float32Array(this.HALF);
    this.sinTable = new Float32Array(this.HALF);
    for (let i = 0; i < this.HALF; i++) {
      const angle = (this.TWO_PI * i) / this.N;
      this.cosTable[i] = Math.cos(angle);
      this.sinTable[i] = Math.sin(angle);
    }

    // Periodic Hann analysis & exact 1/1.5 COLA synthesis windows
    this.anaWin = new Float32Array(this.N);
    this.synthWin = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) {
      const w = 0.5 * (1 - Math.cos((this.TWO_PI * i) / this.N));
      this.anaWin[i] = w;
      this.synthWin[i] = w / 1.5;
    }

    // FFT scratch buffers (pack stereo L + j*R into one complex FFT for 2x throughput)
    this.fftRe = new Float32Array(this.N);
    this.fftIm = new Float32Array(this.N);

    const bins = this.HALF + 1;
    this.reL = new Float32Array(bins);
    this.imL = new Float32Array(bins);
    this.reR = new Float32Array(bins);
    this.imR = new Float32Array(bins);
    this.prevReL = new Float32Array(bins);
    this.prevImL = new Float32Array(bins);
    this.prevReR = new Float32Array(bins);
    this.prevImR = new Float32Array(bins);
    this.outReL = new Float32Array(bins);
    this.outImL = new Float32Array(bins);
    this.outReR = new Float32Array(bins);
    this.outImR = new Float32Array(bins);

    this.mag = new Float32Array(bins);
    this.prevMag = new Float32Array(bins);
    this.prevBinRot = new Float32Array(bins);
    this.currBinRot = new Float32Array(bins);
    this.peaks = new Int16Array(bins);

    // Sliding overlap-add accumulator (size N) + finalized stereo ring (size 4096)
    this.olaL = new Float32Array(this.N);
    this.olaR = new Float32Array(this.N);
    this.OUT_RING_SIZE = 4096;
    this.OUT_RING_MASK = 4095;
    this.outRingL = new Float32Array(this.OUT_RING_SIZE);
    this.outRingR = new Float32Array(this.OUT_RING_SIZE);
    this.outWriteTotal = 0;
    this.outReadPos = 0;

    this.stftPrimed = false;
    this.prevAnaCenter = 0;
    this.avgHiFlux = 0;
    this.avgLowFlux = 0;
    this.framesSinceHiReset = 10;
    this.framesSinceLowReset = 10;
    this.reportCounter = 0;

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;
      switch (msg.type) {
        case 'load': {
          this.left = msg.left;
          this.right = msg.right || msg.left;
          this.totalSamples = this.left ? this.left.length : 0;
          this.sourceSampleRate = msg.sampleRate || 44100;
          this.cursor = Math.max(0, Math.min(Math.max(0, this.totalSamples - 1), msg.startSample || 0));
          this.frameCursor = this.cursor;
          this.keyLock = msg.keyLock !== undefined ? !!msg.keyLock : true;
          this.loopEnabled = !!msg.loopEnabled;
          this.loopStart = msg.loopStart || 0;
          this.loopEnd = msg.loopEnd || 0;
          this.startCtxTime = typeof msg.startCtxTime === 'number' ? msg.startCtxTime : 0;
          this.hasStarted = false;
          this.maxOutSamples =
            typeof msg.durationSec === 'number' && msg.durationSec > 0
              ? Math.max(1, Math.round(msg.durationSec * sampleRate))
              : Infinity;
          this.playedOutSamples = 0;
          this.sourceEnded = false;
          this.retired = false;
          this.autoRetire = !!msg.autoRetire;
          this.useAudioParams = !!msg.useAudioParams;
          if (msg.autoPlay) {
            this.isPlaying = true;
          }
          this.resetStft();
          break;
        }
        case 'play':
          this.sourceEnded = false;
          this.isPlaying = true;
          break;
        case 'pause':
          this.isPlaying = false;
          this.hasStarted = false;
          this.resetStft();
          break;
        case 'retire':
          this.isPlaying = false;
          this.hasStarted = false;
          this.retired = true;
          this.left = null;
          this.right = null;
          this.totalSamples = 0;
          this.resetStft();
          this.port.onmessage = null;
          break;
        case 'seek':
          if (this.totalSamples > 0) {
            this.cursor = Math.max(0, Math.min(this.totalSamples - 1, msg.sample || 0));
            this.frameCursor = this.cursor;
            this.hasStarted = false;
            this.sourceEnded = false;
            this.resetStft();
          }
          break;
        case 'params':
          this.useAudioParams = false;
          if (typeof msg.tempoRatio === 'number') this.tempoRatio = Math.max(0.25, Math.min(4.0, msg.tempoRatio));
          if (typeof msg.keyLock === 'boolean') this.keyLock = msg.keyLock;
          if (typeof msg.pitchSemitones === 'number') this.pitchSemitones = Math.max(-24, Math.min(24, msg.pitchSemitones));
          break;
        case 'loop':
          this.loopEnabled = !!msg.enabled;
          if (typeof msg.startSample === 'number') this.loopStart = Math.max(0, msg.startSample);
          if (typeof msg.endSample === 'number') this.loopEnd = Math.max(this.loopStart + 256, msg.endSample);
          break;
      }
    };
  }

  resetStft() {
    this.olaL.fill(0);
    this.olaR.fill(0);
    this.outRingL.fill(0);
    this.outRingR.fill(0);
    this.outWriteTotal = 0;
    this.outReadPos = 0;
    this.stftPrimed = false;
    this.prevAnaCenter = 0;
    this.prevReL.fill(0);
    this.prevImL.fill(0);
    this.prevReR.fill(0);
    this.prevImR.fill(0);
    this.prevMag.fill(0);
    this.prevBinRot.fill(0);
    this.currBinRot.fill(0);
    this.avgHiFlux = 0;
    this.avgLowFlux = 0;
    this.framesSinceHiReset = 10;
    this.framesSinceLowReset = 10;
  }

  wrapIndex(idx) {
    if (this.loopEnabled && this.loopEnd > this.loopStart + 256) {
      const len = this.loopEnd - this.loopStart;
      if (idx >= this.loopEnd) {
        return this.loopStart + ((idx - this.loopStart) % len);
      }
      if (idx < this.loopStart) {
        const mod = (idx - this.loopStart) % len;
        return this.loopStart + (mod < 0 ? mod + len : mod);
      }
    }
    if (idx < 0) return 0;
    if (idx >= this.totalSamples) return this.totalSamples - 1;
    return idx;
  }

  // 4-point Catmull-Rom cubic interpolation for zero-artifact repitch / pitch-shift resampling
  sampleAt(arr, fracIdx) {
    if (!arr || this.totalSamples === 0) return 0;
    if (!this.loopEnabled && (fracIdx < 0 || fracIdx >= this.totalSamples)) {
      return 0;
    }
    const wrapped = this.wrapIndex(fracIdx);
    const i1 = Math.floor(wrapped);
    const t = wrapped - i1;
    if (t < 1e-6) return arr[i1];

    const maxIdx = this.totalSamples - 1;
    let i0, i2, i3;
    if (!this.loopEnabled && i1 >= 1 && i1 <= maxIdx - 2) {
      i0 = i1 - 1;
      i2 = i1 + 1;
      i3 = i1 + 2;
    } else {
      i0 = Math.floor(this.wrapIndex(i1 - 1));
      i2 = Math.floor(this.wrapIndex(i1 + 1));
      i3 = Math.floor(this.wrapIndex(i1 + 2));
    }

    const y0 = arr[i0];
    const y1 = arr[i1];
    const y2 = arr[i2];
    const y3 = arr[i3];
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * t + c2) * t + c1) * t + y1;
  }

  sampleRingCubic(ring, fracPos) {
    const mask = this.OUT_RING_MASK;
    const i1 = Math.floor(fracPos);
    const t = fracPos - i1;
    if (t < 1e-6) return ring[i1 & mask];
    const i0 = i1 > 0 ? i1 - 1 : 0;
    const y0 = ring[i0 & mask];
    const y1 = ring[i1 & mask];
    const y2 = ring[(i1 + 1) & mask];
    const y3 = ring[(i1 + 2) & mask];
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * t + c2) * t + c1) * t + y1;
  }

  fftTransform(re, im, inverse) {
    const N = this.N;
    const bitRev = this.bitRev;
    for (let i = 0; i < N; i++) {
      const j = bitRev[i];
      if (j > i) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr;
        const ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }

    const cosTable = this.cosTable;
    const sinTable = this.sinTable;
    const dirSign = inverse ? 1 : -1;

    for (let size = 2; size <= N; size <<= 1) {
      const halfSize = size >> 1;
      const step = N / size;
      for (let i = 0; i < N; i += size) {
        let tblIdx = 0;
        for (let j = 0; j < halfSize; j++) {
          const k = i + j;
          const m = k + halfSize;
          const wr = cosTable[tblIdx];
          const wi = dirSign * sinTable[tblIdx];
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

    if (inverse) {
      const invN = 1 / N;
      for (let i = 0; i < N; i++) {
        re[i] *= invN;
        im[i] *= invN;
      }
    }
  }

  analyzeStereoFrame(anaCenter) {
    const N = this.N;
    const HALF = this.HALF;
    const left = this.left;
    const right = this.right;
    const total = this.totalSamples;
    const win = this.anaWin;
    const fftRe = this.fftRe;
    const fftIm = this.fftIm;
    const baseIdx = anaCenter - HALF;
    const loopOn = this.loopEnabled && this.loopEnd > this.loopStart + 256;

    // Pack stereo L + j*R with zero-phase fftshift (window center placed at sample 0)
    if (!loopOn && baseIdx >= 0 && baseIdx + N <= total) {
      for (let i = 0; i < HALF; i++) {
        const iHi = i + HALF;
        const wHi = win[iHi];
        const wLo = win[i];
        fftRe[i] = left[baseIdx + iHi] * wHi;
        fftIm[i] = right[baseIdx + iHi] * wHi;
        fftRe[iHi] = left[baseIdx + i] * wLo;
        fftIm[iHi] = right[baseIdx + i] * wLo;
      }
    } else if (loopOn) {
      const loopStart = this.loopStart;
      const loopLen = this.loopEnd - loopStart;
      for (let i = 0; i < HALF; i++) {
        const iHi = i + HALF;
        let idxA = baseIdx + iHi;
        if (idxA >= this.loopEnd || idxA < loopStart) {
          const mod = (idxA - loopStart) % loopLen;
          idxA = loopStart + (mod < 0 ? mod + loopLen : mod);
        }
        let idxB = baseIdx + i;
        if (idxB >= this.loopEnd || idxB < loopStart) {
          const mod = (idxB - loopStart) % loopLen;
          idxB = loopStart + (mod < 0 ? mod + loopLen : mod);
        }
        const wHi = win[iHi];
        const wLo = win[i];
        fftRe[i] = left[idxA] * wHi;
        fftIm[i] = right[idxA] * wHi;
        fftRe[iHi] = left[idxB] * wLo;
        fftIm[iHi] = right[idxB] * wLo;
      }
    } else {
      for (let i = 0; i < HALF; i++) {
        const iHi = i + HALF;
        const idxA = baseIdx + iHi;
        const idxB = baseIdx + i;
        const wHi = win[iHi];
        const wLo = win[i];
        if (idxA >= 0 && idxA < total) {
          fftRe[i] = left[idxA] * wHi;
          fftIm[i] = right[idxA] * wHi;
        } else {
          fftRe[i] = 0;
          fftIm[i] = 0;
        }
        if (idxB >= 0 && idxB < total) {
          fftRe[iHi] = left[idxB] * wLo;
          fftIm[iHi] = right[idxB] * wLo;
        } else {
          fftRe[iHi] = 0;
          fftIm[iHi] = 0;
        }
      }
    }

    this.fftTransform(fftRe, fftIm, false);

    // Unpack real spectra of L and R from single complex FFT Z = XL + j*XR
    const reL = this.reL;
    const imL = this.imL;
    const reR = this.reR;
    const imR = this.imR;
    const mag = this.mag;

    reL[0] = fftRe[0];
    imL[0] = 0;
    reR[0] = fftIm[0];
    imR[0] = 0;
    mag[0] = Math.sqrt(reL[0] * reL[0] + reR[0] * reR[0]);

    reL[HALF] = fftRe[HALF];
    imL[HALF] = 0;
    reR[HALF] = fftIm[HALF];
    imR[HALF] = 0;
    mag[HALF] = Math.sqrt(reL[HALF] * reL[HALF] + reR[HALF] * reR[HALF]);

    for (let k = 1; k < HALF; k++) {
      const m = N - k;
      const zrk = fftRe[k];
      const zik = fftIm[k];
      const zrm = fftRe[m];
      const zim = fftIm[m];
      const lRe = 0.5 * (zrk + zrm);
      const lIm = 0.5 * (zik - zim);
      const rRe = 0.5 * (zik + zim);
      const rIm = 0.5 * (zrm - zrk);
      reL[k] = lRe;
      imL[k] = lIm;
      reR[k] = rRe;
      imR[k] = rIm;
      mag[k] = Math.sqrt(lRe * lRe + lIm * lIm + rRe * rRe + rIm * rIm);
    }
  }

  processFrameAndOverlapAdd(anaCenter, addStartN, emitHop) {
    const N = this.N;
    const HALF = this.HALF;
    const HOP_S = this.HOP_S;
    const TWO_PI = this.TWO_PI;
    const INV_TWO_PI = this.INV_TWO_PI;
    const TWO_PI_OVER_N = this.TWO_PI_OVER_N;

    this.analyzeStereoFrame(anaCenter);
    const actualHa = anaCenter - this.prevAnaCenter;

    const reL = this.reL;
    const imL = this.imL;
    const reR = this.reR;
    const imR = this.imR;
    const prevReL = this.prevReL;
    const prevImL = this.prevImL;
    const prevReR = this.prevReR;
    const prevImR = this.prevImR;
    const outReL = this.outReL;
    const outImL = this.outImL;
    const outReR = this.outReR;
    const outImR = this.outImR;
    const mag = this.mag;
    const prevMag = this.prevMag;
    const prevBinRot = this.prevBinRot;
    const currBinRot = this.currBinRot;

    // Band-aware positive spectral flux transient detection (Low: kicks, Mid/High: hats/snares)
    let lowFlux = 0;
    let lowMag = 0;
    for (let k = 1; k < 12; k++) {
      const m = mag[k];
      lowMag += m;
      const d = m - prevMag[k];
      if (d > 0) lowFlux += d;
    }
    let hiFlux = 0;
    let hiMag = 0;
    for (let k = 12; k <= 640; k++) {
      const m = mag[k];
      hiMag += m;
      const d = m - prevMag[k];
      if (d > 0) hiFlux += d;
    }

    this.framesSinceLowReset++;
    this.framesSinceHiReset++;

    const isLowTransient =
      lowMag > 0.8 &&
      lowFlux > this.avgLowFlux * 2.25 &&
      lowFlux > lowMag * 0.25 &&
      this.framesSinceLowReset >= 4;
    const isHiTransient =
      hiMag > 0.5 &&
      hiFlux > this.avgHiFlux * 2.35 &&
      hiFlux > hiMag * 0.28 &&
      this.framesSinceHiReset >= 3;

    if (isLowTransient) {
      this.framesSinceLowReset = 0;
      this.framesSinceHiReset = 0;
    } else if (isHiTransient) {
      this.framesSinceHiReset = 0;
    }

    this.avgLowFlux = this.avgLowFlux * 0.88 + lowFlux * 0.12;
    this.avgHiFlux = this.avgHiFlux * 0.88 + hiFlux * 0.12;

    // DC and Nyquist bins stay real & phase-unrotated
    outReL[0] = reL[0];
    outImL[0] = 0;
    outReR[0] = reR[0];
    outImR[0] = 0;
    currBinRot[0] = 0;

    outReL[HALF] = reL[HALF];
    outImL[HALF] = 0;
    outReR[HALF] = reR[HALF];
    outImR[HALF] = 0;
    currBinRot[HALF] = 0;

    // Locate spectral peaks (3-point neighborhood in bass < 260 Hz, 5-point in mids/highs)
    const peaks = this.peaks;
    let numPeaks = 0;
    for (let k = 1; k < 12; k++) {
      const mk = mag[k];
      if (mk > mag[k - 1] && mk >= mag[k + 1]) {
        peaks[numPeaks++] = k;
      }
    }
    for (let k = 12; k < HALF - 1; k++) {
      const mk = mag[k];
      if (mk >= mag[k - 1] && mk >= mag[k + 1] && mk > mag[k - 2] && mk >= mag[k + 2]) {
        peaks[numPeaks++] = k;
      }
    }
    if (numPeaks === 0) {
      peaks[numPeaks++] = 1;
    }

    // Laroche-Dolson Rigid Peak Phase Locking with Valley-Split Regions & Exact Stereo IPD
    let regionStart = 1;
    for (let pi = 0; pi < numPeaks; pi++) {
      const p = peaks[pi];
      let regionEnd;
      if (pi === numPeaks - 1) {
        regionEnd = HALF - 1;
      } else {
        const nextP = peaks[pi + 1];
        let minVal = mag[p];
        let valley = (p + nextP) >> 1;
        for (let v = p + 1; v < nextP; v++) {
          if (mag[v] < minVal) {
            minVal = mag[v];
            valley = v;
          }
        }
        regionEnd = valley;
      }

      let rot;
      if (isLowTransient || (isHiTransient && p >= 12)) {
        // Hard phase reset on transients keeps drum attacks razor-sharp
        rot = 0;
      } else if (actualHa === 0) {
        rot = prevBinRot[p];
      } else {
        // Joint stereo cross-power Z = L_curr * conj(L_prev) + R_curr * conj(R_prev)
        const cr =
          reL[p] * prevReL[p] +
          imL[p] * prevImL[p] +
          reR[p] * prevReR[p] +
          imR[p] * prevImR[p];
        const ci =
          imL[p] * prevReL[p] -
          reL[p] * prevImL[p] +
          imR[p] * prevReR[p] -
          reR[p] * prevImR[p];

        if (cr * cr + ci * ci < 1e-22) {
          rot = 0;
        } else {
          const dPhiAna = Math.atan2(ci, cr);
          const omegaK = TWO_PI_OVER_N * p;
          let dev = dPhiAna - omegaK * actualHa;
          dev -= TWO_PI * Math.round(dev * INV_TWO_PI);
          const trueFreq = omegaK + dev / actualHa;
          const dPhiSynth = trueFreq * HOP_S;
          rot = prevBinRot[p] + (dPhiSynth - dPhiAna);
          rot -= TWO_PI * Math.round(rot * INV_TWO_PI);
        }
      }

      if (rot === 0) {
        for (let k = regionStart; k <= regionEnd; k++) {
          outReL[k] = reL[k];
          outImL[k] = imL[k];
          outReR[k] = reR[k];
          outImR[k] = imR[k];
          currBinRot[k] = 0;
        }
      } else {
        const cosR = Math.cos(rot);
        const sinR = Math.sin(rot);
        for (let k = regionStart; k <= regionEnd; k++) {
          const lRe = reL[k];
          const lIm = imL[k];
          const rRe = reR[k];
          const rIm = imR[k];
          outReL[k] = lRe * cosR - lIm * sinR;
          outImL[k] = lRe * sinR + lIm * cosR;
          outReR[k] = rRe * cosR - rIm * sinR;
          outImR[k] = rRe * sinR + rIm * cosR;
          currBinRot[k] = rot;
        }
      }

      regionStart = regionEnd + 1;
    }

    // Re-pack stereo spectra into single complex buffer Z_out = outL + j*outR for inverse FFT
    const fftRe = this.fftRe;
    const fftIm = this.fftIm;
    fftRe[0] = outReL[0];
    fftIm[0] = outReR[0];
    fftRe[HALF] = outReL[HALF];
    fftIm[HALF] = outReR[HALF];
    for (let k = 1; k < HALF; k++) {
      const m = N - k;
      const lRe = outReL[k];
      const lIm = outImL[k];
      const rRe = outReR[k];
      const rIm = outImR[k];
      fftRe[k] = lRe - rIm;
      fftIm[k] = lIm + rRe;
      fftRe[m] = lRe + rIm;
      fftIm[m] = rRe - lIm;
    }

    this.fftTransform(fftRe, fftIm, true);

    // Undo zero-phase shift, apply COLA synthesis window, and accumulate into sliding OLA buffer
    const synthWin = this.synthWin;
    const olaL = this.olaL;
    const olaR = this.olaR;

    if (addStartN === 0) {
      for (let i = 0; i < HALF; i++) {
        const iHi = i + HALF;
        const wLo = synthWin[i];
        const wHi = synthWin[iHi];
        olaL[i] += fftRe[iHi] * wLo;
        olaR[i] += fftIm[iHi] * wLo;
        olaL[iHi] += fftRe[i] * wHi;
        olaR[iHi] += fftIm[i] * wHi;
      }
    } else {
      for (let n = addStartN; n < N; n++) {
        const srcIdx = n < HALF ? n + HALF : n - HALF;
        const w = synthWin[n];
        const dst = n - addStartN;
        olaL[dst] += fftRe[srcIdx] * w;
        olaR[dst] += fftIm[srcIdx] * w;
      }
    }

    if (emitHop) {
      const outRingL = this.outRingL;
      const outRingR = this.outRingR;
      const mask = this.OUT_RING_MASK;
      let wPos = this.outWriteTotal;
      for (let i = 0; i < HOP_S; i++) {
        const idx = (wPos + i) & mask;
        outRingL[idx] = olaL[i];
        outRingR[idx] = olaR[i];
      }
      this.outWriteTotal = wPos + HOP_S;
      olaL.copyWithin(0, HOP_S);
      olaR.copyWithin(0, HOP_S);
      olaL.fill(0, N - HOP_S);
      olaR.fill(0, N - HOP_S);
    }

    // O(1) pointer swaps for previous-frame spectral state
    this.prevAnaCenter = anaCenter;
    this.prevReL = reL; this.reL = prevReL;
    this.prevImL = imL; this.imL = prevImL;
    this.prevReR = reR; this.reR = prevReR;
    this.prevImR = imR; this.imR = prevImR;
    this.prevMag = mag; this.mag = prevMag;
    this.prevBinRot = currBinRot; this.currBinRot = prevBinRot;
  }

  primeStft(stftStretch) {
    const c0 = this.cursor;
    const h0 = this.HOP_S * stftStretch;

    // Seed previous-frame spectrum at c0 - 2*h0 so frame m=-1 has valid instantaneous frequency
    const seedCenter = Math.round(c0 - 2 * h0);
    this.analyzeStereoFrame(seedCenter);
    this.prevAnaCenter = seedCenter;
    let tmp;
    tmp = this.prevReL; this.prevReL = this.reL; this.reL = tmp;
    tmp = this.prevImL; this.prevImL = this.imL; this.imL = tmp;
    tmp = this.prevReR; this.prevReR = this.reR; this.reR = tmp;
    tmp = this.prevImR; this.prevImR = this.imR; this.imR = tmp;
    tmp = this.prevMag; this.prevMag = this.mag; this.mag = tmp;
    this.prevBinRot.fill(0);

    // Zero-latency priming: frames m=-1, m=0, m=1 populate OLA tails aligned to output sample 0
    this.processFrameAndOverlapAdd(Math.round(c0 - h0), 1536, false);
    this.processFrameAndOverlapAdd(Math.round(c0), 1024, false);
    this.processFrameAndOverlapAdd(Math.round(c0 + h0), 512, false);

    this.frameCursor = c0 + 2 * h0;
    this.stftPrimed = true;
  }

  synthesizeStftHop(stftStretch, effectiveTempo, pitchRate) {
    if (!this.left || this.totalSamples === 0) return;
    if (!this.stftPrimed) {
      this.primeStft(stftStretch);
    }
    // Zero-drift phase lock: anchor STFT frame center directly to sample-integrated cursor
    // projected forward to this frame's synthesis center (outWriteTotal + HALF) so two tracks
    // crossing a tempo ramp stay locked to sub-millisecond precision with zero cumulative drift.
    const leadRingSamples = this.outWriteTotal + this.HALF - this.outReadPos;
    const leadOutSamples = leadRingSamples / Math.max(0.05, pitchRate);
    const lockedTarget = this.cursor + leadOutSamples * effectiveTempo;
    if (Number.isFinite(lockedTarget)) {
      this.frameCursor = lockedTarget;
    }
    const anaCenter = Math.round(this.frameCursor);
    this.processFrameAndOverlapAdd(anaCenter, 0, true);
    this.frameCursor += this.HOP_S * stftStretch;
  }

  process(_inputs, outputs, parameters) {
    const out = outputs[0];
    if (!out || out.length === 0) return !this.retired;
    const outL = out[0];
    const outR = out[1] || out[0];
    const frames = outL.length;

    if (!this.isPlaying || !this.left || this.totalSamples === 0) {
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
      return !this.retired;
    }

    const blockStartSec = currentTime;
    const blockEndSec = blockStartSec + frames / sampleRate;
    if (!this.hasStarted && blockEndSec <= this.startCtxTime) {
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
      return !this.retired;
    }

    const rawTempo =
      this.useAudioParams && parameters && parameters.tempoRatio
        ? parameters.tempoRatio[0]
        : this.tempoRatio;
    const rawSpeed =
      this.useAudioParams && parameters && parameters.playbackSpeed
        ? parameters.playbackSpeed[0]
        : 1.0;
    const rawPitch =
      this.useAudioParams && parameters && parameters.pitchSemitones
        ? parameters.pitchSemitones[0]
        : this.pitchSemitones;

    const tempoRatio = Math.max(0.25, Math.min(4.0, rawTempo));
    const playbackSpeed = Math.max(0.25, Math.min(4.0, rawSpeed));
    const pitchSemitones = Math.max(-24, Math.min(24, rawPitch));

    let silentFrames = 0;
    if (!this.hasStarted) {
      this.hasStarted = true;
      if (blockStartSec < this.startCtxTime) {
        silentFrames = Math.max(
          0,
          Math.min(frames, Math.round((this.startCtxTime - blockStartSec) * sampleRate))
        );
      } else if (this.startCtxTime > 0 && blockStartSec > this.startCtxTime + 0.00025) {
        const missedOutSamples = Math.round((blockStartSec - this.startCtxTime) * sampleRate);
        const srRatio = this.sourceSampleRate / sampleRate;
        const effectiveTempo = tempoRatio * playbackSpeed * srRatio;
        this.playedOutSamples += missedOutSamples;
        const jumpedCursor = this.cursor + missedOutSamples * effectiveTempo;
        if (!this.loopEnabled && jumpedCursor >= this.totalSamples - 1) {
          this.cursor = this.totalSamples - 1;
          this.sourceEnded = true;
        } else {
          this.cursor = this.loopEnabled ? this.wrapIndex(jumpedCursor) : jumpedCursor;
        }
        this.frameCursor = this.cursor;
      }
      this.resetStft();
    }

    const remainingClipSamples = this.maxOutSamples - this.playedOutSamples;
    if (remainingClipSamples <= 0) {
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
      this.isPlaying = false;
      this.resetStft();
      if (this.autoRetire) {
        this.retired = true;
        this.left = null;
        this.right = null;
        this.totalSamples = 0;
        return false;
      }
      return true;
    }

    const activeBudget = Math.min(frames - silentFrames, remainingClipSamples);

    for (let i = 0; i < silentFrames; i++) {
      outL[i] = 0;
      if (outR !== outL) outR[i] = 0;
    }

    let produced = 0;
    const srRatio = this.sourceSampleRate / sampleRate;
    const effectiveTempo = tempoRatio * playbackSpeed * srRatio;

    // Zero-artifact vinyl/repitch fast path when Key Lock is OFF and no manual pitch shift is set
    if (!this.keyLock && Math.abs(pitchSemitones) < 0.01) {
      const left = this.left;
      const right = this.right;

      for (let i = 0; i < activeBudget; i++) {
        if (this.sourceEnded) break;
        const dst = silentFrames + i;
        outL[dst] = this.sampleAt(left, this.cursor);
        if (outR !== outL) outR[dst] = this.sampleAt(right, this.cursor);
        const nextCursor = this.cursor + effectiveTempo;
        if (!this.loopEnabled && nextCursor >= this.totalSamples - 1) {
          this.cursor = this.totalSamples - 1;
          this.sourceEnded = true;
        } else {
          this.cursor = this.loopEnabled ? this.wrapIndex(nextCursor) : nextCursor;
        }
        produced++;
      }
      this.frameCursor = this.cursor;
      this.playedOutSamples += produced;
    } else {
      const pitchMul = Math.pow(2, pitchSemitones / 12);
      const pitchRate = (this.keyLock ? 1.0 : tempoRatio) * playbackSpeed * pitchMul * srRatio;
      const stftStretch = Math.max(0.25, Math.min(4.0, effectiveTempo / Math.max(0.05, pitchRate)));
      const directCopy =
        Math.abs(pitchRate - 1.0) < 1e-6 &&
        Math.abs(this.outReadPos - Math.round(this.outReadPos)) < 1e-6;
      const outRingL = this.outRingL;
      const outRingR = this.outRingR;
      const mask = this.OUT_RING_MASK;

      for (let i = 0; i < activeBudget; i++) {
        if (this.sourceEnded) break;

        const neededWrite = Math.floor(this.outReadPos) + 3;
        while (this.outWriteTotal < neededWrite) {
          this.synthesizeStftHop(stftStretch, effectiveTempo, pitchRate);
        }

        const dst = silentFrames + i;
        if (directCopy) {
          const rIdx = Math.round(this.outReadPos) & mask;
          outL[dst] = outRingL[rIdx];
          if (outR !== outL) outR[dst] = outRingR[rIdx];
        } else {
          outL[dst] = this.sampleRingCubic(outRingL, this.outReadPos);
          if (outR !== outL) outR[dst] = this.sampleRingCubic(outRingR, this.outReadPos);
        }

        this.outReadPos += pitchRate;
        const nextCursor = this.cursor + effectiveTempo;
        if (!this.loopEnabled && nextCursor >= this.totalSamples - 1) {
          this.cursor = this.totalSamples - 1;
          this.sourceEnded = true;
        } else {
          this.cursor = this.loopEnabled ? this.wrapIndex(nextCursor) : nextCursor;
        }
        produced++;
      }
      this.playedOutSamples += produced;
    }

    for (let i = silentFrames + produced; i < frames; i++) {
      outL[i] = 0;
      if (outR !== outL) outR[i] = 0;
    }

    if (!this.autoRetire) {
      this.reportCounter += produced;
      if (this.reportCounter >= 1470) { // ~30Hz position updates
        this.reportCounter = 0;
        this.port.postMessage({ type: 'position', sample: this.cursor });
      }
    }

    if (this.sourceEnded || this.playedOutSamples >= this.maxOutSamples) {
      this.isPlaying = false;
      this.resetStft();
      this.port.postMessage({ type: 'ended', sample: this.cursor });
      if (this.autoRetire) {
        this.retired = true;
        this.left = null;
        this.right = null;
        this.totalSamples = 0;
        return false;
      }
    }

    return true;
  }
}

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'setRecording') {
        this.recording = !!e.data.recording;
      }
    };
  }

  process(inputs) {
    if (!this.recording) return true;
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const left = input[0] ? new Float32Array(input[0]) : null;
    const right = input[1] ? new Float32Array(input[1]) : left ? new Float32Array(left) : null;
    if (left && right) {
      this.port.postMessage({ type: 'chunk', left, right }, [left.buffer, right.buffer]);
    }
    return true;
  }
}

registerProcessor('time-stretch-processor', TimeStretchProcessor);
registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
`;

const registeredContexts = new WeakSet<BaseAudioContext>();
const registrationPromises = new WeakMap<BaseAudioContext, Promise<void>>();

export function isWorkletRegistered(ctx: BaseAudioContext): boolean {
  return registeredContexts.has(ctx);
}

export async function ensureWorkletsRegistered(ctx: BaseAudioContext): Promise<void> {
  if (registeredContexts.has(ctx)) return;
  const inflight = registrationPromises.get(ctx);
  if (inflight) return inflight;

  const promise = (async () => {
    const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      await ctx.audioWorklet.addModule(url);
      registeredContexts.add(ctx);
    } finally {
      URL.revokeObjectURL(url);
      registrationPromises.delete(ctx);
    }
  })();

  registrationPromises.set(ctx, promise);
  return promise;
}

// Precomputed module-level LUTs for offline 2048-pt Stereo Phase-Locked Phase Vocoder
const PV_N = 2048;
const PV_HALF = 1024;
const PV_HOP_S = 512;
const PV_TWO_PI = Math.PI * 2;
const PV_INV_TWO_PI = 1 / PV_TWO_PI;
const PV_TWO_PI_OVER_N = PV_TWO_PI / PV_N;

const PV_BIT_REV = new Uint16Array(PV_N);
const PV_COS_TABLE = new Float32Array(PV_HALF);
const PV_SIN_TABLE = new Float32Array(PV_HALF);
const PV_ANA_WIN = new Float32Array(PV_N);
const PV_SYNTH_WIN = new Float32Array(PV_N);

for (let i = 0; i < PV_N; i++) {
  let x = i;
  let r = 0;
  for (let b = 0; b < 11; b++) {
    r = (r << 1) | (x & 1);
    x >>= 1;
  }
  PV_BIT_REV[i] = r;
  const w = 0.5 * (1 - Math.cos((PV_TWO_PI * i) / PV_N));
  PV_ANA_WIN[i] = w;
  PV_SYNTH_WIN[i] = w / 1.5;
}
for (let i = 0; i < PV_HALF; i++) {
  const angle = (PV_TWO_PI * i) / PV_N;
  PV_COS_TABLE[i] = Math.cos(angle);
  PV_SIN_TABLE[i] = Math.sin(angle);
}

function offlineFftTransform(re: Float32Array, im: Float32Array, inverse: boolean): void {
  for (let i = 0; i < PV_N; i++) {
    const j = PV_BIT_REV[i];
    if (j > i) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  const dirSign = inverse ? 1 : -1;
  for (let size = 2; size <= PV_N; size <<= 1) {
    const halfSize = size >> 1;
    const step = PV_N / size;
    for (let i = 0; i < PV_N; i += size) {
      let tblIdx = 0;
      for (let j = 0; j < halfSize; j++) {
        const k = i + j;
        const m = k + halfSize;
        const wr = PV_COS_TABLE[tblIdx];
        const wi = dirSign * PV_SIN_TABLE[tblIdx];
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

  if (inverse) {
    const invN = 1 / PV_N;
    for (let i = 0; i < PV_N; i++) {
      re[i] *= invN;
      im[i] *= invN;
    }
  }
}

/**
 * Pure TypeScript offline Stereo Phase-Locked Phase Vocoder for NLE clips and
 * OfflineAudioContext mixdown rendering. Matches the real-time AudioWorklet DSP
 * (2048-pt zero-phase FFT, 512-sample hop, Laroche-Dolson peak phase locking,
 * exact inter-channel stereo phase preservation, and band-aware transient phase reset),
 * plus a zero-artifact direct Catmull-Rom repitch fast path when keyLock is disabled.
 */
export function renderTimeStretchedBuffer(
  source: AudioBuffer,
  tempoRatio: number,
  pitchSemitones: number,
  keyLock: boolean,
  offsetSec = 0,
  clipDurationSec?: number,
  tempoRatioAtOutSec?: (outSec: number) => number
): AudioBuffer {
  const sr = source.sampleRate;
  const safeTempo = Math.max(0.4, Math.min(2.2, tempoRatio));
  const pitchMul = Math.pow(2, Math.max(-12, Math.min(12, pitchSemitones)) / 12);
  const constantPitchRate = (keyLock ? 1.0 : safeTempo) * pitchMul;

  const startSample = Math.max(0, Math.floor(offsetSec * sr));
  const maxSourceAvail = Math.max(1, source.length - startSample);

  // Fast unity-bypass when no stretching, tempo curve, or pitch-shifting is needed
  if (!tempoRatioAtOutSec) {
    const srcLenToUse = clipDurationSec
      ? Math.min(maxSourceAvail, Math.floor(clipDurationSec * safeTempo * sr))
      : maxSourceAvail;

    if (Math.abs(safeTempo - 1) < 0.0001 && Math.abs(constantPitchRate - 1) < 0.0001) {
      const out = new AudioBuffer({
        numberOfChannels: source.numberOfChannels,
        length: srcLenToUse,
        sampleRate: sr,
      });
      for (let c = 0; c < source.numberOfChannels; c++) {
        const ch = source.getChannelData(c);
        out.getChannelData(c).set(ch.subarray(startSample, startSample + srcLenToUse));
      }
      return out;
    }
  }

  let outLength: number;
  if (tempoRatioAtOutSec) {
    const targetOutSamples = clipDurationSec
      ? Math.max(256, Math.floor(clipDurationSec * sr))
      : Math.max(256, Math.floor(maxSourceAvail / safeTempo));

    // Pre-integrate source consumption using midpoint rule so output stops cleanly if source runs out
    let simCursor = 0;
    let reachableOut = 0;
    for (let outPos = 0; outPos < targetOutSamples; outPos += PV_HOP_S) {
      const localTempo = Math.max(
        0.4,
        Math.min(2.2, tempoRatioAtOutSec((outPos + PV_HOP_S * 0.5) / sr))
      );
      const nextCursor = simCursor + PV_HOP_S * localTempo;
      if (nextCursor >= maxSourceAvail) {
        reachableOut = Math.max(256, outPos);
        break;
      }
      simCursor = nextCursor;
      reachableOut = Math.min(targetOutSamples, outPos + PV_HOP_S);
    }
    outLength = Math.max(256, reachableOut);
  } else {
    const srcLenToUse = clipDurationSec
      ? Math.min(maxSourceAvail, Math.floor(clipDurationSec * safeTempo * sr))
      : maxSourceAvail;
    outLength = Math.max(256, Math.floor(srcLenToUse / safeTempo));
  }

  const out = new AudioBuffer({
    numberOfChannels: source.numberOfChannels,
    length: outLength,
    sampleRate: sr,
  });

  const srcChannels: Float32Array[] = [];
  const dstChannels: Float32Array[] = [];
  for (let c = 0; c < source.numberOfChannels; c++) {
    srcChannels.push(source.getChannelData(c));
    dstChannels.push(out.getChannelData(c));
  }

  const srcCh0 = srcChannels[0];
  const srcCh1 = srcChannels[1] ?? srcCh0;
  const dstCh0 = dstChannels[0];
  const dstCh1 = dstChannels[1] ?? null;
  const totalSrcLen = source.length;
  const maxSrcIdx = totalSrcLen - 1;

  // 4-point Catmull-Rom cubic interpolation for high-frequency clarity
  const sampleAt = (arr: Float32Array, idx: number): number => {
    const absIdx = startSample + idx;
    if (absIdx < 0 || absIdx > maxSrcIdx) return 0;
    const i1 = Math.floor(absIdx);
    const t = absIdx - i1;
    if (t < 1e-6) return arr[i1];
    const i0 = i1 > 0 ? i1 - 1 : 0;
    const i2 = i1 < maxSrcIdx ? i1 + 1 : maxSrcIdx;
    const i3 = i1 + 2 <= maxSrcIdx ? i1 + 2 : maxSrcIdx;
    const y0 = arr[i0];
    const y1 = arr[i1];
    const y2 = arr[i2];
    const y3 = arr[i3];
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * t + c2) * t + c1) * t + y1;
  };

  // Zero-artifact vinyl/repitch fast path when Key Lock is OFF and no manual pitch shift is set
  if (!keyLock && Math.abs(pitchSemitones) < 0.01) {
    let cursor = 0;
    for (let i = 0; i < outLength; i++) {
      const localTempo = tempoRatioAtOutSec
        ? Math.max(0.4, Math.min(2.2, tempoRatioAtOutSec(i / sr)))
        : safeTempo;
      for (let c = 0; c < srcChannels.length; c++) {
        dstChannels[c][i] = sampleAt(srcChannels[c], cursor);
      }
      cursor += localTempo;
      if (startSample + cursor >= maxSrcIdx) break;
    }
    return out;
  }

  // Offline Stereo Phase-Locked Phase Vocoder state
  const bins = PV_HALF + 1;
  const fftRe = new Float32Array(PV_N);
  const fftIm = new Float32Array(PV_N);
  let reL = new Float32Array(bins);
  let imL = new Float32Array(bins);
  let reR = new Float32Array(bins);
  let imR = new Float32Array(bins);
  let prevReL = new Float32Array(bins);
  let prevImL = new Float32Array(bins);
  let prevReR = new Float32Array(bins);
  let prevImR = new Float32Array(bins);
  const outReL = new Float32Array(bins);
  const outImL = new Float32Array(bins);
  const outReR = new Float32Array(bins);
  const outImR = new Float32Array(bins);
  let mag = new Float32Array(bins);
  let prevMag = new Float32Array(bins);
  let prevBinRot = new Float32Array(bins);
  let currBinRot = new Float32Array(bins);
  const peaks = new Int16Array(bins);

  const olaL = new Float32Array(PV_N);
  const olaR = new Float32Array(PV_N);
  const OUT_RING_SIZE = 4096;
  const OUT_RING_MASK = 4095;
  const outRingL = new Float32Array(OUT_RING_SIZE);
  const outRingR = new Float32Array(OUT_RING_SIZE);
  let outWriteTotal = 0;
  let outReadPos = 0;

  let prevAnaCenter = 0;
  let avgLowFlux = 0;
  let avgHiFlux = 0;
  let framesSinceLowReset = 10;
  let framesSinceHiReset = 10;

  const analyzeFrame = (absAnaCenter: number): void => {
    const baseIdx = absAnaCenter - PV_HALF;
    if (baseIdx >= 0 && baseIdx + PV_N <= totalSrcLen) {
      for (let i = 0; i < PV_HALF; i++) {
        const iHi = i + PV_HALF;
        const wHi = PV_ANA_WIN[iHi];
        const wLo = PV_ANA_WIN[i];
        fftRe[i] = srcCh0[baseIdx + iHi] * wHi;
        fftIm[i] = srcCh1[baseIdx + iHi] * wHi;
        fftRe[iHi] = srcCh0[baseIdx + i] * wLo;
        fftIm[iHi] = srcCh1[baseIdx + i] * wLo;
      }
    } else {
      for (let i = 0; i < PV_HALF; i++) {
        const iHi = i + PV_HALF;
        const idxA = baseIdx + iHi;
        const idxB = baseIdx + i;
        const wHi = PV_ANA_WIN[iHi];
        const wLo = PV_ANA_WIN[i];
        if (idxA >= 0 && idxA < totalSrcLen) {
          fftRe[i] = srcCh0[idxA] * wHi;
          fftIm[i] = srcCh1[idxA] * wHi;
        } else {
          fftRe[i] = 0;
          fftIm[i] = 0;
        }
        if (idxB >= 0 && idxB < totalSrcLen) {
          fftRe[iHi] = srcCh0[idxB] * wLo;
          fftIm[iHi] = srcCh1[idxB] * wLo;
        } else {
          fftRe[iHi] = 0;
          fftIm[iHi] = 0;
        }
      }
    }

    offlineFftTransform(fftRe, fftIm, false);

    reL[0] = fftRe[0];
    imL[0] = 0;
    reR[0] = fftIm[0];
    imR[0] = 0;
    mag[0] = Math.sqrt(reL[0] * reL[0] + reR[0] * reR[0]);

    reL[PV_HALF] = fftRe[PV_HALF];
    imL[PV_HALF] = 0;
    reR[PV_HALF] = fftIm[PV_HALF];
    imR[PV_HALF] = 0;
    mag[PV_HALF] = Math.sqrt(reL[PV_HALF] * reL[PV_HALF] + reR[PV_HALF] * reR[PV_HALF]);

    for (let k = 1; k < PV_HALF; k++) {
      const m = PV_N - k;
      const zrk = fftRe[k];
      const zik = fftIm[k];
      const zrm = fftRe[m];
      const zim = fftIm[m];
      const lRe = 0.5 * (zrk + zrm);
      const lIm = 0.5 * (zik - zim);
      const rRe = 0.5 * (zik + zim);
      const rIm = 0.5 * (zrm - zrk);
      reL[k] = lRe;
      imL[k] = lIm;
      reR[k] = rRe;
      imR[k] = rIm;
      mag[k] = Math.sqrt(lRe * lRe + lIm * lIm + rRe * rRe + rIm * rIm);
    }
  };

  const processFrame = (absAnaCenter: number, addStartN: number, emitHop: boolean): void => {
    analyzeFrame(absAnaCenter);
    const actualHa = absAnaCenter - prevAnaCenter;

    let lowFlux = 0;
    let lowMag = 0;
    for (let k = 1; k < 12; k++) {
      const m = mag[k];
      lowMag += m;
      const d = m - prevMag[k];
      if (d > 0) lowFlux += d;
    }
    let hiFlux = 0;
    let hiMag = 0;
    for (let k = 12; k <= 640; k++) {
      const m = mag[k];
      hiMag += m;
      const d = m - prevMag[k];
      if (d > 0) hiFlux += d;
    }

    framesSinceLowReset++;
    framesSinceHiReset++;

    const isLowTransient =
      lowMag > 0.8 &&
      lowFlux > avgLowFlux * 2.25 &&
      lowFlux > lowMag * 0.25 &&
      framesSinceLowReset >= 4;
    const isHiTransient =
      hiMag > 0.5 &&
      hiFlux > avgHiFlux * 2.35 &&
      hiFlux > hiMag * 0.28 &&
      framesSinceHiReset >= 3;

    if (isLowTransient) {
      framesSinceLowReset = 0;
      framesSinceHiReset = 0;
    } else if (isHiTransient) {
      framesSinceHiReset = 0;
    }

    avgLowFlux = avgLowFlux * 0.88 + lowFlux * 0.12;
    avgHiFlux = avgHiFlux * 0.88 + hiFlux * 0.12;

    outReL[0] = reL[0];
    outImL[0] = 0;
    outReR[0] = reR[0];
    outImR[0] = 0;
    currBinRot[0] = 0;

    outReL[PV_HALF] = reL[PV_HALF];
    outImL[PV_HALF] = 0;
    outReR[PV_HALF] = reR[PV_HALF];
    outImR[PV_HALF] = 0;
    currBinRot[PV_HALF] = 0;

    let numPeaks = 0;
    for (let k = 1; k < 12; k++) {
      const mk = mag[k];
      if (mk > mag[k - 1] && mk >= mag[k + 1]) {
        peaks[numPeaks++] = k;
      }
    }
    for (let k = 12; k < PV_HALF - 1; k++) {
      const mk = mag[k];
      if (mk >= mag[k - 1] && mk >= mag[k + 1] && mk > mag[k - 2] && mk >= mag[k + 2]) {
        peaks[numPeaks++] = k;
      }
    }
    if (numPeaks === 0) {
      peaks[numPeaks++] = 1;
    }

    let regionStart = 1;
    for (let pi = 0; pi < numPeaks; pi++) {
      const p = peaks[pi];
      let regionEnd: number;
      if (pi === numPeaks - 1) {
        regionEnd = PV_HALF - 1;
      } else {
        const nextP = peaks[pi + 1];
        let minVal = mag[p];
        let valley = (p + nextP) >> 1;
        for (let v = p + 1; v < nextP; v++) {
          if (mag[v] < minVal) {
            minVal = mag[v];
            valley = v;
          }
        }
        regionEnd = valley;
      }

      let rot: number;
      if (isLowTransient || (isHiTransient && p >= 12)) {
        rot = 0;
      } else if (actualHa === 0) {
        rot = prevBinRot[p];
      } else {
        const cr =
          reL[p] * prevReL[p] +
          imL[p] * prevImL[p] +
          reR[p] * prevReR[p] +
          imR[p] * prevImR[p];
        const ci =
          imL[p] * prevReL[p] -
          reL[p] * prevImL[p] +
          imR[p] * prevReR[p] -
          reR[p] * prevImR[p];

        if (cr * cr + ci * ci < 1e-22) {
          rot = 0;
        } else {
          const dPhiAna = Math.atan2(ci, cr);
          const omegaK = PV_TWO_PI_OVER_N * p;
          let dev = dPhiAna - omegaK * actualHa;
          dev -= PV_TWO_PI * Math.round(dev * PV_INV_TWO_PI);
          const trueFreq = omegaK + dev / actualHa;
          const dPhiSynth = trueFreq * PV_HOP_S;
          rot = prevBinRot[p] + (dPhiSynth - dPhiAna);
          rot -= PV_TWO_PI * Math.round(rot * PV_INV_TWO_PI);
        }
      }

      if (rot === 0) {
        for (let k = regionStart; k <= regionEnd; k++) {
          outReL[k] = reL[k];
          outImL[k] = imL[k];
          outReR[k] = reR[k];
          outImR[k] = imR[k];
          currBinRot[k] = 0;
        }
      } else {
        const cosR = Math.cos(rot);
        const sinR = Math.sin(rot);
        for (let k = regionStart; k <= regionEnd; k++) {
          const lRe = reL[k];
          const lIm = imL[k];
          const rRe = reR[k];
          const rIm = imR[k];
          outReL[k] = lRe * cosR - lIm * sinR;
          outImL[k] = lRe * sinR + lIm * cosR;
          outReR[k] = rRe * cosR - rIm * sinR;
          outImR[k] = rRe * sinR + rIm * cosR;
          currBinRot[k] = rot;
        }
      }

      regionStart = regionEnd + 1;
    }

    fftRe[0] = outReL[0];
    fftIm[0] = outReR[0];
    fftRe[PV_HALF] = outReL[PV_HALF];
    fftIm[PV_HALF] = outReR[PV_HALF];
    for (let k = 1; k < PV_HALF; k++) {
      const m = PV_N - k;
      const lRe = outReL[k];
      const lIm = outImL[k];
      const rRe = outReR[k];
      const rIm = outImR[k];
      fftRe[k] = lRe - rIm;
      fftIm[k] = lIm + rRe;
      fftRe[m] = lRe + rIm;
      fftIm[m] = rRe - lIm;
    }

    offlineFftTransform(fftRe, fftIm, true);

    if (addStartN === 0) {
      for (let i = 0; i < PV_HALF; i++) {
        const iHi = i + PV_HALF;
        const wLo = PV_SYNTH_WIN[i];
        const wHi = PV_SYNTH_WIN[iHi];
        olaL[i] += fftRe[iHi] * wLo;
        olaR[i] += fftIm[iHi] * wLo;
        olaL[iHi] += fftRe[i] * wHi;
        olaR[iHi] += fftIm[i] * wHi;
      }
    } else {
      for (let n = addStartN; n < PV_N; n++) {
        const srcIdx = n < PV_HALF ? n + PV_HALF : n - PV_HALF;
        const w = PV_SYNTH_WIN[n];
        const dst = n - addStartN;
        olaL[dst] += fftRe[srcIdx] * w;
        olaR[dst] += fftIm[srcIdx] * w;
      }
    }

    if (emitHop) {
      for (let i = 0; i < PV_HOP_S; i++) {
        const idx = (outWriteTotal + i) & OUT_RING_MASK;
        outRingL[idx] = olaL[i];
        outRingR[idx] = olaR[i];
      }
      outWriteTotal += PV_HOP_S;
      olaL.copyWithin(0, PV_HOP_S);
      olaR.copyWithin(0, PV_HOP_S);
      olaL.fill(0, PV_N - PV_HOP_S);
      olaR.fill(0, PV_N - PV_HOP_S);
    }

    prevAnaCenter = absAnaCenter;
    let tmp: Float32Array<ArrayBuffer>;
    tmp = prevReL; prevReL = reL; reL = tmp;
    tmp = prevImL; prevImL = imL; imL = tmp;
    tmp = prevReR; prevReR = reR; reR = tmp;
    tmp = prevImR; prevImR = imR; imR = tmp;
    tmp = prevMag; prevMag = mag; mag = tmp;
    tmp = prevBinRot; prevBinRot = currBinRot; currBinRot = tmp;
  };

  const sampleRingCubic = (ring: Float32Array, fracPos: number): number => {
    const i1 = Math.floor(fracPos);
    const t = fracPos - i1;
    if (t < 1e-6) return ring[i1 & OUT_RING_MASK];
    const i0 = i1 > 0 ? i1 - 1 : 0;
    const y0 = ring[i0 & OUT_RING_MASK];
    const y1 = ring[i1 & OUT_RING_MASK];
    const y2 = ring[(i1 + 1) & OUT_RING_MASK];
    const y3 = ring[(i1 + 2) & OUT_RING_MASK];
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * t + c2) * t + c1) * t + y1;
  };

  // Zero-latency priming aligned to startSample
  const initTempo = tempoRatioAtOutSec
    ? Math.max(0.4, Math.min(2.2, tempoRatioAtOutSec(0)))
    : safeTempo;
  const initPitchRate = (keyLock ? 1.0 : initTempo) * pitchMul;
  const initStftStretch = Math.max(0.25, Math.min(4.0, initTempo / Math.max(0.05, initPitchRate)));
  const h0 = PV_HOP_S * initStftStretch;

  const seedCenter = Math.round(startSample - 2 * h0);
  analyzeFrame(seedCenter);
  prevAnaCenter = seedCenter;
  {
    let tmp: Float32Array<ArrayBuffer>;
    tmp = prevReL; prevReL = reL; reL = tmp;
    tmp = prevImL; prevImL = imL; imL = tmp;
    tmp = prevReR; prevReR = reR; reR = tmp;
    tmp = prevImR; prevImR = imR; imR = tmp;
    tmp = prevMag; prevMag = mag; mag = tmp;
  }

  processFrame(Math.round(startSample - h0), 1536, false);
  processFrame(Math.round(startSample), 1024, false);
  processFrame(Math.round(startSample + h0), 512, false);

  let frameCursor = startSample + 2 * h0;

  if (keyLock && Math.abs(pitchSemitones) < 0.01) {
    // Direct 1:1 output path with exact tempo-integral phase lock for variable BPM ramps
    const evalTempo = (outSample: number): number =>
      tempoRatioAtOutSec
        ? Math.max(0.4, Math.min(2.2, tempoRatioAtOutSec(Math.max(0, outSample) / sr)))
        : safeTempo;

    // Integrate exact source cursor from 0 -> PV_HALF (output sample 1024) for first emitted frame
    let exactFrameCursor = startSample;
    if (tempoRatioAtOutSec) {
      const subStep = 64;
      for (let s = 0; s < PV_HALF; s += subStep) {
        exactFrameCursor += subStep * evalTempo(s + subStep * 0.5);
      }
    } else {
      exactFrameCursor = startSample + PV_HALF * safeTempo;
    }

    for (let outPos = 0; outPos < outLength; outPos += PV_HOP_S) {
      const writeBase = outWriteTotal;
      processFrame(Math.round(exactFrameCursor), 0, true);

      // Advance exactFrameCursor across [outPos + PV_HALF .. outPos + PV_HALF + PV_HOP_S]
      if (tempoRatioAtOutSec) {
        const subStep = 64;
        const baseOut = outPos + PV_HALF;
        for (let s = 0; s < PV_HOP_S; s += subStep) {
          exactFrameCursor += subStep * evalTempo(baseOut + s + subStep * 0.5);
        }
      } else {
        exactFrameCursor += PV_HOP_S * safeTempo;
      }

      const count = Math.min(PV_HOP_S, outLength - outPos);
      for (let i = 0; i < count; i++) {
        const rIdx = (writeBase + i) & OUT_RING_MASK;
        dstCh0[outPos + i] = outRingL[rIdx];
        if (dstCh1) dstCh1[outPos + i] = outRingR[rIdx];
      }
    }
  } else {
    // Combined STFT time-stretch + Catmull-Rom cubic pitch resampling path with exact cursor lock
    let exactCursor = startSample;
    for (let i = 0; i < outLength; i++) {
      const localTempo = tempoRatioAtOutSec
        ? Math.max(0.4, Math.min(2.2, tempoRatioAtOutSec(i / sr)))
        : safeTempo;
      const localPitchRate = (keyLock ? 1.0 : localTempo) * pitchMul;

      const neededWrite = Math.floor(outReadPos) + 3;
      while (outWriteTotal < neededWrite) {
        const leadRing = outWriteTotal + PV_HALF - outReadPos;
        const leadOut = leadRing / Math.max(0.05, localPitchRate);
        frameCursor = exactCursor + leadOut * localTempo;
        processFrame(Math.round(frameCursor), 0, true);
      }

      dstCh0[i] = sampleRingCubic(outRingL, outReadPos);
      if (dstCh1) dstCh1[i] = sampleRingCubic(outRingR, outReadPos);
      outReadPos += localPitchRate;
      exactCursor += localTempo;
    }
  }

  return out;
}
