import type {
  AutomationLane,
  AutomationParam,
  FadeCurve,
  NleClip,
  NleProjectState,
  NleTrack,
  TrackAsset,
} from '../types/audio';
import {
  evaluateBpmAt,
  getConstantBpmInRange,
  getEffectiveBpmRatio,
  getTempoSignatureForRange,
  integrateClipSourceOffsetSec,
} from './tempoMap';
import {
  buildEqTransitionCurve,
  buildFilterSweepCurve,
  evaluateBassTransitionFraction,
  evaluateVolumeFadeGain,
  getEffectiveClipBassFade,
  getEffectiveClipVolumeFade,
  hasActiveEqOrFilterTransition,
} from './mixTransitions';
import {
  ensureWorkletsRegistered,
  isWorkletRegistered,
  renderTimeStretchedBuffer,
} from './timeStretchWorklet';

export function createImpulseResponse(
  ctx: BaseAudioContext,
  durationSec = 1.8,
  decay = 2.4
): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * durationSec));
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const env = Math.pow(1 - i / length, decay);
      data[i] = (Math.random() * 2 - 1) * env;
    }
  }
  return impulse;
}

function createSoftClipCurve(amount: number): Float32Array<ArrayBuffer> {
  const samples = 1024;
  const buffer = new ArrayBuffer(samples * 4);
  const curve = new Float32Array(buffer);
  const k = 1 + amount * 28;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

function buildFadeCurveValues(
  direction: 'in' | 'out',
  curve: FadeCurve,
  tension = 0,
  steps = 64
): Float32Array {
  const arr = new Float32Array(steps);
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const x = direction === 'in' ? t : 1 - t;
    arr[i] = evaluateVolumeFadeGain(x, curve, tension);
  }
  return arr;
}

function resolveDualFadeBounds(
  clipStartSec: number,
  clipDurationSec: number,
  inOffsetSec: number,
  inDurSec: number,
  outInsetSec: number,
  outDurSec: number
): {
  inStartTimeline: number;
  inEndTimeline: number;
  hasInHold: boolean;
  hasInRamp: boolean;
  outStartTimeline: number;
  outEndTimeline: number;
  hasOutRamp: boolean;
  hasOutHold: boolean;
} {
  const clipEnd = clipStartSec + clipDurationSec;
  const safeInOffset = Math.max(0, Math.min(clipDurationSec * 0.9, inOffsetSec));
  const safeInDur = Math.max(0, Math.min(clipDurationSec - safeInOffset, inDurSec));
  const inStartTimeline = clipStartSec + safeInOffset;
  const inEndTimeline = inStartTimeline + safeInDur;
  const hasInHold = safeInOffset > 0.005;
  const hasInRamp = safeInDur > 0.01;

  const minOutStart = hasInHold || hasInRamp ? inEndTimeline + 0.004 : clipStartSec;
  const safeOutInset = Math.max(0, Math.min(clipDurationSec * 0.9, outInsetSec));
  const outEndTimeline = Math.max(minOutStart, clipEnd - safeOutInset);
  const outStartTimeline = Math.max(minOutStart, outEndTimeline - Math.max(0, outDurSec));
  const hasOutRamp = outEndTimeline - outStartTimeline > 0.01;
  const hasOutHold = clipEnd - outEndTimeline > 0.005;

  return {
    inStartTimeline,
    inEndTimeline,
    hasInHold,
    hasInRamp,
    outStartTimeline,
    outEndTimeline,
    hasOutRamp,
    hasOutHold,
  };
}

function evaluateClipFadeGainAt(clip: NleClip, timeSec: number): number {
  const baseGain = Math.pow(10, clip.gainDb / 20);
  const volIn = getEffectiveClipVolumeFade(clip, 'in');
  const volOut = getEffectiveClipVolumeFade(clip, 'out');
  const b = resolveDualFadeBounds(
    clip.startSec,
    clip.durationSec,
    volIn.offsetSec,
    volIn.durationSec,
    volOut.offsetSec,
    volOut.durationSec
  );

  if (b.hasInHold && timeSec < b.inStartTimeline) {
    return 0;
  }

  if (b.hasInRamp && timeSec <= b.inEndTimeline) {
    const x =
      timeSec <= b.inStartTimeline
        ? 0
        : (timeSec - b.inStartTimeline) / (b.inEndTimeline - b.inStartTimeline);
    return (
      evaluateVolumeFadeGain(x, clip.fadeInCurve ?? clip.fadeCurve, clip.fadeInCurveTension ?? 0) *
      baseGain
    );
  }

  if ((b.hasOutRamp || b.hasOutHold) && timeSec >= b.outStartTimeline) {
    if (timeSec >= b.outEndTimeline) return 0;
    if (b.hasOutRamp) {
      const x = (b.outEndTimeline - timeSec) / (b.outEndTimeline - b.outStartTimeline);
      return (
        evaluateVolumeFadeGain(
          x,
          clip.fadeOutCurve ?? clip.fadeCurve,
          clip.fadeOutCurveTension ?? 0
        ) * baseGain
      );
    }
  }

  return baseGain;
}

function evaluateClipBassEqDbAt(clip: NleClip, timeSec: number): number {
  const bassIn = getEffectiveClipBassFade(clip, 'in');
  const bassOut = getEffectiveClipBassFade(clip, 'out');
  const b = resolveDualFadeBounds(
    clip.startSec,
    clip.durationSec,
    bassIn.offsetSec,
    bassIn.durationSec,
    bassOut.offsetSec,
    bassOut.durationSec
  );

  if (b.hasInHold && timeSec < b.inStartTimeline) {
    return bassIn.cutDb;
  }

  if (b.hasInRamp && timeSec <= b.inEndTimeline) {
    const t =
      timeSec <= b.inStartTimeline
        ? 0
        : (timeSec - b.inStartTimeline) / (b.inEndTimeline - b.inStartTimeline);
    const frac = evaluateBassTransitionFraction(t, 'in', bassIn.mode, bassIn.curveTension);
    return bassIn.cutDb * (1 - frac);
  }

  if ((b.hasOutRamp || b.hasOutHold) && timeSec >= b.outStartTimeline) {
    if (timeSec >= b.outEndTimeline) return bassOut.cutDb;
    if (b.hasOutRamp) {
      const t = (timeSec - b.outStartTimeline) / (b.outEndTimeline - b.outStartTimeline);
      const frac = evaluateBassTransitionFraction(t, 'out', bassOut.mode, bassOut.curveTension);
      return bassOut.cutDb * (1 - frac);
    }
  }

  return 0;
}

/**
 * Evaluates a normalized [0..1] automation lane at any timeline timestamp.
 */
export function evaluateAutomationAt(lane: AutomationLane, timeSec: number): number | null {
  const pts = lane.points;
  if (!pts || pts.length === 0) return null;
  if (pts.length === 1) return pts[0].value;
  if (timeSec <= pts[0].timeSec) return pts[0].value;
  if (timeSec >= pts[pts.length - 1].timeSec) return pts[pts.length - 1].value;

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (timeSec >= a.timeSec && timeSec <= b.timeSec) {
      const span = Math.max(0.0001, b.timeSec - a.timeSec);
      const t = (timeSec - a.timeSec) / span;
      if (a.curve === 'step') return a.value;
      if (a.curve === 'smooth') {
        const s = 0.5 - 0.5 * Math.cos(Math.PI * t);
        return a.value + (b.value - a.value) * s;
      }
      return a.value + (b.value - a.value) * t;
    }
  }
  return pts[pts.length - 1].value;
}

function mapAutomationParamValue(param: AutomationParam, norm: number): number {
  const v = Math.max(0, Math.min(1, norm));
  switch (param) {
    case 'volume':
      return v * 1.25; // 0..1.25 linear gain
    case 'pan':
      return v * 2 - 1; // -1..+1
    case 'filterCutoff':
      // Exponential sweep 60 Hz .. 18000 Hz
      return 60 * Math.pow(18000 / 60, v);
    case 'fxWet':
      return v; // 0..1
    case 'speed':
      return 0.75 + v * 0.5; // 0.75x..1.25x
  }
}

function scheduleAutomationLane(
  audioParam: AudioParam,
  lane: AutomationLane,
  paramType: AutomationParam,
  playbackStartSec: number,
  ctxStartTime: number,
  endSec: number
): void {
  const pts = [...lane.points].sort((a, b) => a.timeSec - b.timeSec);
  if (pts.length === 0) return;

  const initNorm = evaluateAutomationAt(lane, playbackStartSec) ?? pts[0].value;
  audioParam.setValueAtTime(mapAutomationParamValue(paramType, initNorm), ctxStartTime);

  for (let i = 0; i < pts.length; i++) {
    const pt = pts[i];
    if (pt.timeSec <= playbackStartSec) continue;
    if (pt.timeSec > endSec) break;
    const when = ctxStartTime + (pt.timeSec - playbackStartSec);
    const val = mapAutomationParamValue(paramType, pt.value);

    const prev = i > 0 ? pts[i - 1] : null;
    if (prev && prev.curve === 'step') {
      audioParam.setValueAtTime(val, when);
    } else if (prev && prev.curve === 'smooth') {
      // Subdivide smooth cosine segments into short linear steps
      const segStart = Math.max(playbackStartSec, prev.timeSec);
      const steps = 8;
      for (let s = 1; s <= steps; s++) {
        const subT = segStart + ((pt.timeSec - segStart) * s) / steps;
        const subVal = evaluateAutomationAt(lane, subT) ?? pt.value;
        audioParam.linearRampToValueAtTime(
          mapAutomationParamValue(paramType, subVal),
          ctxStartTime + (subT - playbackStartSec)
        );
      }
    } else {
      audioParam.linearRampToValueAtTime(val, when);
    }
  }
}

const MAX_STRETCH_CACHE_BYTES = 400 * 1024 * 1024; // 400 MB memory budget
const MAX_STRETCH_CACHE_ENTRIES = 48;
const stretchBufferCache = new Map<string, { buffer: AudioBuffer; bytes: number }>();
let stretchBufferCacheBytes = 0;

function getAudioBufferByteSize(buffer: AudioBuffer): number {
  return buffer.length * buffer.numberOfChannels * 4;
}

export function clearStretchBufferCache(): void {
  stretchBufferCache.clear();
  stretchBufferCacheBytes = 0;
}

function getCachedStretchBuffer(key: string): AudioBuffer | undefined {
  const entry = stretchBufferCache.get(key);
  if (!entry) return undefined;
  // Refresh LRU position on hit
  stretchBufferCache.delete(key);
  stretchBufferCache.set(key, entry);
  return entry.buffer;
}

function setCachedStretchBuffer(key: string, buffer: AudioBuffer): void {
  const bytes = getAudioBufferByteSize(buffer);
  // Skip caching massive single-stem renders that would evict the entire playback cache
  if (bytes > MAX_STRETCH_CACHE_BYTES * 0.6) return;

  const existing = stretchBufferCache.get(key);
  if (existing) {
    stretchBufferCacheBytes -= existing.bytes;
    stretchBufferCache.delete(key);
  }

  while (
    stretchBufferCache.size > 0 &&
    (stretchBufferCache.size >= MAX_STRETCH_CACHE_ENTRIES ||
      stretchBufferCacheBytes + bytes > MAX_STRETCH_CACHE_BYTES)
  ) {
    const oldest = stretchBufferCache.entries().next().value;
    if (!oldest) break;
    stretchBufferCache.delete(oldest[0]);
    stretchBufferCacheBytes = Math.max(0, stretchBufferCacheBytes - oldest[1].bytes);
  }

  stretchBufferCache.set(key, { buffer, bytes });
  stretchBufferCacheBytes += bytes;
}

function getStretchedClipBuffer(
  clip: NleClip,
  asset: TrackAsset,
  project: NleProjectState,
  persistToCache = true
): { buffer: AudioBuffer; isPreStretched: boolean } {
  const canStretchToMap = clip.stretchToMasterBpm && asset.bpm > 0;
  const clipEndSec = clip.startSec + clip.durationSec;

  if (!canStretchToMap) {
    if (Math.abs(clip.pitchSemitones) <= 0.01) {
      return { buffer: asset.audioBuffer, isPreStretched: false };
    }
    const cacheKey = `${asset.id}_1.0000_${clip.pitchSemitones.toFixed(2)}_${clip.offsetSec.toFixed(3)}_${clip.durationSec.toFixed(3)}`;
    const cached = getCachedStretchBuffer(cacheKey);
    if (cached) return { buffer: cached, isPreStretched: true };

    const stretched = renderTimeStretchedBuffer(
      asset.audioBuffer,
      1.0,
      clip.pitchSemitones,
      true,
      clip.offsetSec,
      clip.durationSec
    );
    if (persistToCache) {
      setCachedStretchBuffer(cacheKey, stretched);
    }
    return { buffer: stretched, isPreStretched: true };
  }

  const keyLock = project.keyLock ?? true;
  const constantBpm = getConstantBpmInRange(project, clip.startSec, clipEndSec);
  if (constantBpm !== null) {
    const tempoRatio = getEffectiveBpmRatio(constantBpm, asset.bpm);
    const needsStretch =
      Math.abs(tempoRatio - 1) > 0.0001 || Math.abs(clip.pitchSemitones) > 0.01;
    if (!needsStretch) {
      return { buffer: asset.audioBuffer, isPreStretched: false };
    }

    const cacheKey = `${asset.id}_${tempoRatio.toFixed(4)}_kl${keyLock ? 1 : 0}_${clip.pitchSemitones.toFixed(2)}_${clip.offsetSec.toFixed(3)}_${clip.durationSec.toFixed(3)}`;
    const cached = getCachedStretchBuffer(cacheKey);
    if (cached) return { buffer: cached, isPreStretched: true };

    const stretched = renderTimeStretchedBuffer(
      asset.audioBuffer,
      tempoRatio,
      clip.pitchSemitones,
      keyLock,
      clip.offsetSec,
      clip.durationSec
    );
    if (persistToCache) {
      setCachedStretchBuffer(cacheKey, stretched);
    }
    return { buffer: stretched, isPreStretched: true };
  }

  // Variable BPM curve across this clip's timeline span
  const tempoSig = getTempoSignatureForRange(project, clip.startSec, clipEndSec);
  const cacheKey = `${asset.id}_var_${tempoSig}_kl${keyLock ? 1 : 0}_${clip.pitchSemitones.toFixed(2)}_${clip.offsetSec.toFixed(3)}_${clip.durationSec.toFixed(3)}`;
  const cached = getCachedStretchBuffer(cacheKey);
  if (cached) return { buffer: cached, isPreStretched: true };

  const nominalTempoRatio = getEffectiveBpmRatio(
    evaluateBpmAt(project, clip.startSec),
    asset.bpm
  );
  const stretched = renderTimeStretchedBuffer(
    asset.audioBuffer,
    nominalTempoRatio,
    clip.pitchSemitones,
    keyLock,
    clip.offsetSec,
    clip.durationSec,
    (outSec) => getEffectiveBpmRatio(evaluateBpmAt(project, clip.startSec + outSec), asset.bpm)
  );

  if (persistToCache) {
    setCachedStretchBuffer(cacheKey, stretched);
  }
  return { buffer: stretched, isPreStretched: true };
}

function buildTrackChain(
  ctx: BaseAudioContext,
  track: NleTrack,
  destination: AudioNode,
  sharedReverbImpulse: AudioBuffer,
  playbackStartSec: number,
  ctxStartTime: number,
  mixEndSec: number,
  initialAudible = true
): {
  input: GainNode;
  volumeGain: GainNode;
  panner: StereoPannerNode;
  muteGain: GainNode;
  filterNode: BiquadFilterNode;
  fxWetNodes: GainNode[];
} {
  const input = ctx.createGain();
  const fx = track.effects;

  // Filter
  const filterNode = ctx.createBiquadFilter();
  if (!fx.filterEnabled || Math.abs(fx.filterValue) < 0.025) {
    filterNode.type = 'lowpass';
    filterNode.frequency.value = 20000;
    filterNode.Q.value = 0.707;
  } else if (fx.filterValue < 0) {
    const t = 1 + fx.filterValue;
    filterNode.type = 'lowpass';
    filterNode.frequency.value = 60 * Math.pow(18000 / 60, t);
    filterNode.Q.value = fx.filterResonance;
  } else {
    filterNode.type = 'highpass';
    filterNode.frequency.value = 35 * Math.pow(11000 / 35, fx.filterValue);
    filterNode.Q.value = fx.filterResonance;
  }

  // 3-band EQ
  const eqLow = ctx.createBiquadFilter();
  eqLow.type = 'lowshelf';
  eqLow.frequency.value = 240;
  eqLow.gain.value = fx.eqLow;

  const eqMid = ctx.createBiquadFilter();
  eqMid.type = 'peaking';
  eqMid.frequency.value = 1000;
  eqMid.Q.value = 0.75;
  eqMid.gain.value = fx.eqMid;

  const eqHigh = ctx.createBiquadFilter();
  eqHigh.type = 'highshelf';
  eqHigh.frequency.value = 3600;
  eqHigh.gain.value = fx.eqHigh;

  // Drive / Saturation
  const shaper = ctx.createWaveShaper();
  if (fx.driveEnabled && fx.driveAmount > 0.02) {
    shaper.curve = createSoftClipCurve(fx.driveAmount);
    shaper.oversample = '2x';
  }

  // Post-EQ bus -> Delay + Reverb parallel wet/dry
  const fxBus = ctx.createGain();
  const dryGain = ctx.createGain();
  dryGain.gain.value = 1;

  const fxWetNodes: GainNode[] = [];
  const delayNode = ctx.createDelay(2.0);
  delayNode.delayTime.value = fx.delayTimeSec;
  const delayFb = ctx.createGain();
  delayFb.gain.value = fx.delayFeedback;
  const delayWet = ctx.createGain();
  delayWet.gain.value = fx.delayEnabled ? fx.delayWet : 0;
  delayNode.connect(delayFb);
  delayFb.connect(delayNode);
  fxWetNodes.push(delayWet);

  const reverbNode = ctx.createConvolver();
  reverbNode.buffer = sharedReverbImpulse;
  const reverbWet = ctx.createGain();
  reverbWet.gain.value = fx.reverbEnabled ? fx.reverbWet : 0;
  fxWetNodes.push(reverbWet);

  const volumeGain = ctx.createGain();
  volumeGain.gain.value = track.volume;

  const panner = ctx.createStereoPanner();
  panner.pan.value = track.pan;

  input.connect(filterNode);
  filterNode.connect(eqLow);
  eqLow.connect(eqMid);
  eqMid.connect(eqHigh);
  eqHigh.connect(shaper);
  shaper.connect(fxBus);

  fxBus.connect(dryGain);
  dryGain.connect(volumeGain);

  fxBus.connect(delayNode);
  delayNode.connect(delayWet);
  delayWet.connect(volumeGain);

  fxBus.connect(reverbNode);
  reverbNode.connect(reverbWet);
  reverbWet.connect(volumeGain);

  const muteGain = ctx.createGain();
  muteGain.gain.value = initialAudible ? 1 : 0;

  volumeGain.connect(panner);
  panner.connect(muteGain);
  muteGain.connect(destination);

  // Schedule automation curves on the track
  const lanes = track.automationLanes;
  if (lanes.volume.points.length > 0) {
    scheduleAutomationLane(volumeGain.gain, lanes.volume, 'volume', playbackStartSec, ctxStartTime, mixEndSec);
  }
  if (lanes.pan.points.length > 0) {
    scheduleAutomationLane(panner.pan, lanes.pan, 'pan', playbackStartSec, ctxStartTime, mixEndSec);
  }
  if (lanes.filterCutoff.points.length > 0) {
    filterNode.type = 'lowpass';
    scheduleAutomationLane(
      filterNode.frequency,
      lanes.filterCutoff,
      'filterCutoff',
      playbackStartSec,
      ctxStartTime,
      mixEndSec
    );
  }
  if (lanes.fxWet.points.length > 0) {
    for (const w of fxWetNodes) {
      scheduleAutomationLane(w.gain, lanes.fxWet, 'fxWet', playbackStartSec, ctxStartTime, mixEndSec);
    }
  }

  return { input, volumeGain, panner, muteGain, filterNode, fxWetNodes };
}

/**
 * Returns the earliest safe AudioContext time for scheduling AudioParam curves.
 * On live AudioContexts, adding a small headroom prevents the browser from clamping
 * startTime forward to currentTime (which shifts a setValueCurveAtTime end time later
 * and causes NotSupportedError overlaps with subsequent events).
 */
function getSafeAudioParamFloor(ctx: BaseAudioContext): number {
  if (typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext) {
    return 0;
  }
  return ctx.currentTime + 0.02;
}

/**
 * Helper to schedule a sliced Float32Array curve onto an AudioParam, safely handling
 * mid-transition seeks and live AudioContext clock drift without overlapping events.
 * Returns the exact scheduled end time in AudioContext seconds, or null if skipped.
 */
function scheduleSlicedParamCurve(
  param: AudioParam,
  fullCurve: Float32Array,
  windowStartTimeline: number,
  windowEndTimeline: number,
  playbackStartSec: number,
  ctxStartTime: number,
  scale = 1,
  allowImmediateValueAssign = true,
  minCtxTime = 0
): number | null {
  const windowDur = windowEndTimeline - windowStartTimeline;
  if (windowDur <= 0.002 || playbackStartSec >= windowEndTimeline) return null;

  const ctxWindowStart = ctxStartTime + (windowStartTimeline - playbackStartSec);
  const ctxWindowEnd = ctxStartTime + (windowEndTimeline - playbackStartSec);

  const floorCtx = Math.max(ctxStartTime, minCtxTime);
  const actualCtxStart = Math.max(ctxWindowStart, floorCtx);
  const remainingDur = ctxWindowEnd - actualCtxStart;
  const finalVal = fullCurve[fullCurve.length - 1] * scale;

  if (remainingDur < 0.002) {
    const settleTime = Math.max(floorCtx, ctxWindowEnd);
    if (allowImmediateValueAssign && settleTime <= floorCtx + 0.001) {
      param.value = finalVal;
    }
    param.setValueAtTime(finalVal, settleTime);
    return settleTime;
  }

  const effectiveTimelineStart = windowStartTimeline + (actualCtxStart - ctxWindowStart);
  const fracStart = Math.max(
    0,
    Math.min(0.98, (effectiveTimelineStart - windowStartTimeline) / windowDur)
  );
  const startIdx = Math.min(fullCurve.length - 2, Math.floor(fracStart * fullCurve.length));
  const sliced = new Float32Array(fullCurve.length - startIdx);
  for (let i = 0; i < sliced.length; i++) {
    sliced[i] = fullCurve[startIdx + i] * scale;
  }

  // Anchor right before the curve only when there is clean gap after floorCtx
  if (actualCtxStart > floorCtx + 0.002) {
    param.setValueAtTime(sliced[0], actualCtxStart - 0.001);
  } else if (allowImmediateValueAssign) {
    param.value = sliced[0];
  }

  param.setValueCurveAtTime(sliced, actualCtxStart, remainingDur);
  return actualCtxStart + remainingDur;
}

function scheduleClipFadeEnvelope(
  ctx: BaseAudioContext,
  gainParam: AudioParam,
  clip: NleClip,
  fromTimelineSec: number,
  fromCtxTime: number,
  options?: { setInitialValue?: boolean }
): void {
  const baseGain = Math.pow(10, clip.gainDb / 20);
  const setInitialValue = options?.setInitialValue ?? true;
  const volIn = getEffectiveClipVolumeFade(clip, 'in');
  const volOut = getEffectiveClipVolumeFade(clip, 'out');
  const b = resolveDualFadeBounds(
    clip.startSec,
    clip.durationSec,
    volIn.offsetSec,
    volIn.durationSec,
    volOut.offsetSec,
    volOut.durationSec
  );

  const floorCtx = Math.max(fromCtxTime, getSafeAudioParamFloor(ctx));
  const effectiveFromTimeline = fromTimelineSec + Math.max(0, floorCtx - fromCtxTime);

  if (setInitialValue) {
    gainParam.value = evaluateClipFadeGainAt(clip, effectiveFromTimeline);
  }

  let lastEventEndCtx = floorCtx;

  if (b.hasInHold && effectiveFromTimeline < b.inStartTimeline) {
    const ctxClipStart = fromCtxTime + Math.max(0, clip.startSec - fromTimelineSec);
    const ctxInStart = Math.max(floorCtx, fromCtxTime + (b.inStartTimeline - fromTimelineSec));
    if (clip.startSec > effectiveFromTimeline && ctxClipStart > floorCtx) {
      gainParam.setValueAtTime(0, ctxClipStart);
      lastEventEndCtx = Math.max(lastEventEndCtx, ctxClipStart);
    }
    if (!b.hasInRamp) {
      const rampStart = Math.max(lastEventEndCtx, ctxInStart);
      gainParam.setValueAtTime(0, rampStart);
      gainParam.linearRampToValueAtTime(baseGain, rampStart + 0.004);
      lastEventEndCtx = rampStart + 0.004;
    }
  }

  if (b.hasInRamp && effectiveFromTimeline < b.inEndTimeline) {
    const curveMinCtx = lastEventEndCtx > floorCtx ? lastEventEndCtx + 0.002 : floorCtx;
    const curve = buildFadeCurveValues(
      'in',
      clip.fadeInCurve ?? clip.fadeCurve,
      clip.fadeInCurveTension ?? 0
    );
    const inEndCtx = scheduleSlicedParamCurve(
      gainParam,
      curve,
      b.inStartTimeline,
      b.inEndTimeline,
      fromTimelineSec,
      fromCtxTime,
      baseGain,
      setInitialValue,
      curveMinCtx
    );
    if (inEndCtx !== null) {
      lastEventEndCtx = Math.max(lastEventEndCtx, inEndCtx);
    }
  }

  if (b.hasOutRamp && effectiveFromTimeline < b.outEndTimeline) {
    const curveMinCtx = lastEventEndCtx > floorCtx ? lastEventEndCtx + 0.002 : floorCtx;
    const curve = buildFadeCurveValues(
      'out',
      clip.fadeOutCurve ?? clip.fadeCurve,
      clip.fadeOutCurveTension ?? 0
    );
    const outEndCtx = scheduleSlicedParamCurve(
      gainParam,
      curve,
      b.outStartTimeline,
      b.outEndTimeline,
      fromTimelineSec,
      fromCtxTime,
      baseGain,
      setInitialValue,
      curveMinCtx
    );
    if (outEndCtx !== null) {
      lastEventEndCtx = Math.max(lastEventEndCtx, outEndCtx);
    }
  } else if (b.hasOutHold && !b.hasOutRamp && effectiveFromTimeline < b.outEndTimeline) {
    const nextMinCtx = lastEventEndCtx > floorCtx ? lastEventEndCtx + 0.002 : floorCtx;
    const ctxDropStart = Math.max(
      nextMinCtx,
      fromCtxTime + (b.outEndTimeline - 0.004 - fromTimelineSec)
    );
    const ctxOutEnd = Math.max(
      ctxDropStart + 0.004,
      fromCtxTime + (b.outEndTimeline - fromTimelineSec)
    );
    gainParam.setValueAtTime(baseGain, ctxDropStart);
    gainParam.linearRampToValueAtTime(0, ctxOutEnd);
  }
}

function scheduleClipBassEnvelope(
  ctx: BaseAudioContext,
  eqLowGainParam: AudioParam,
  clip: NleClip,
  fromTimelineSec: number,
  fromCtxTime: number,
  options?: { setInitialValue?: boolean }
): void {
  const bassIn = getEffectiveClipBassFade(clip, 'in');
  const bassOut = getEffectiveClipBassFade(clip, 'out');
  const setInitialValue = options?.setInitialValue ?? true;
  const b = resolveDualFadeBounds(
    clip.startSec,
    clip.durationSec,
    bassIn.offsetSec,
    bassIn.durationSec,
    bassOut.offsetSec,
    bassOut.durationSec
  );

  const floorCtx = Math.max(fromCtxTime, getSafeAudioParamFloor(ctx));
  const effectiveFromTimeline = fromTimelineSec + Math.max(0, floorCtx - fromCtxTime);

  if (setInitialValue) {
    eqLowGainParam.value = evaluateClipBassEqDbAt(clip, effectiveFromTimeline);
  }

  let lastEventEndCtx = floorCtx;

  if (b.hasInHold && effectiveFromTimeline < b.inStartTimeline) {
    const ctxClipStart = fromCtxTime + Math.max(0, clip.startSec - fromTimelineSec);
    const ctxInStart = Math.max(floorCtx, fromCtxTime + (b.inStartTimeline - fromTimelineSec));
    if (clip.startSec > effectiveFromTimeline && ctxClipStart > floorCtx) {
      eqLowGainParam.setValueAtTime(bassIn.cutDb, ctxClipStart);
      lastEventEndCtx = Math.max(lastEventEndCtx, ctxClipStart);
    }
    if (!b.hasInRamp) {
      const rampStart = Math.max(lastEventEndCtx, ctxInStart);
      eqLowGainParam.setValueAtTime(bassIn.cutDb, rampStart);
      eqLowGainParam.linearRampToValueAtTime(0, rampStart + 0.004);
      lastEventEndCtx = rampStart + 0.004;
    }
  }

  if (b.hasInRamp && effectiveFromTimeline < b.inEndTimeline) {
    const curveMinCtx = lastEventEndCtx > floorCtx ? lastEventEndCtx + 0.002 : floorCtx;
    const curve = buildEqTransitionCurve('in', bassIn.mode, bassIn.cutDb, 64, bassIn.curveTension);
    const inEndCtx = scheduleSlicedParamCurve(
      eqLowGainParam,
      curve,
      b.inStartTimeline,
      b.inEndTimeline,
      fromTimelineSec,
      fromCtxTime,
      1,
      setInitialValue,
      curveMinCtx
    );
    if (inEndCtx !== null) {
      lastEventEndCtx = Math.max(lastEventEndCtx, inEndCtx);
    }
  }

  if (b.hasOutRamp && effectiveFromTimeline < b.outEndTimeline) {
    const curveMinCtx = lastEventEndCtx > floorCtx ? lastEventEndCtx + 0.002 : floorCtx;
    const curve = buildEqTransitionCurve(
      'out',
      bassOut.mode,
      bassOut.cutDb,
      64,
      bassOut.curveTension
    );
    const outEndCtx = scheduleSlicedParamCurve(
      eqLowGainParam,
      curve,
      b.outStartTimeline,
      b.outEndTimeline,
      fromTimelineSec,
      fromCtxTime,
      1,
      setInitialValue,
      curveMinCtx
    );
    if (outEndCtx !== null) {
      lastEventEndCtx = Math.max(lastEventEndCtx, outEndCtx);
    }
  } else if (b.hasOutHold && !b.hasOutRamp && effectiveFromTimeline < b.outEndTimeline) {
    const nextMinCtx = lastEventEndCtx > floorCtx ? lastEventEndCtx + 0.002 : floorCtx;
    const ctxDropStart = Math.max(
      nextMinCtx,
      fromCtxTime + (b.outEndTimeline - 0.004 - fromTimelineSec)
    );
    const ctxOutEnd = Math.max(
      ctxDropStart + 0.004,
      fromCtxTime + (b.outEndTimeline - fromTimelineSec)
    );
    eqLowGainParam.setValueAtTime(0, ctxDropStart);
    eqLowGainParam.linearRampToValueAtTime(bassOut.cutDb, ctxOutEnd);
  }
}

interface ActiveClipHandle {
  clipId: string;
  clipGain: GainNode;
  clipBassEq: BiquadFilterNode;
  stop: () => void;
  endTimelineSec: number;
}

function analyzeClipStretchRequirement(
  clip: NleClip,
  asset: TrackAsset,
  project: NleProjectState
): {
  needsWorklet: boolean;
  constantTempoRatio: number;
  isVariableTempo: boolean;
} {
  const hasPitch = Math.abs(clip.pitchSemitones) > 0.01;
  const canStretchToMap = clip.stretchToMasterBpm && asset.bpm > 0;
  if (!canStretchToMap) {
    return {
      needsWorklet: hasPitch,
      constantTempoRatio: 1.0,
      isVariableTempo: false,
    };
  }

  const clipEndSec = clip.startSec + clip.durationSec;
  const constantBpm = getConstantBpmInRange(project, clip.startSec, clipEndSec);
  if (constantBpm !== null) {
    const tempoRatio = getEffectiveBpmRatio(constantBpm, asset.bpm);
    return {
      needsWorklet: Math.abs(tempoRatio - 1) > 0.0001 || hasPitch,
      constantTempoRatio: tempoRatio,
      isVariableTempo: false,
    };
  }

  return {
    needsWorklet: true,
    constantTempoRatio: getEffectiveBpmRatio(evaluateBpmAt(project, clip.startSec), asset.bpm),
    isVariableTempo: true,
  };
}

function connectClipEffectsAndFades(
  ctx: BaseAudioContext,
  sourceNode: AudioNode,
  clip: NleClip,
  trackInput: GainNode,
  playbackStartSec: number,
  ctxStartTime: number
): { clipGain: GainNode; clipBassEq: BiquadFilterNode } {
  const clipEnd = clip.startSec + clip.durationSec;
  const clipGain = ctx.createGain();
  scheduleClipFadeEnvelope(ctx, clipGain.gain, clip, playbackStartSec, ctxStartTime, {
    setInitialValue: true,
  });

  // Always attach per-clip Low-Shelf Bass EQ so Bass Fade In/Out handles work live without restarting playback
  const clipBassEq = ctx.createBiquadFilter();
  clipBassEq.type = 'lowshelf';
  clipBassEq.frequency.value = 240;
  clipBassEq.gain.value = 0;
  scheduleClipBassEnvelope(ctx, clipBassEq.gain, clip, playbackStartSec, ctxStartTime, {
    setInitialValue: true,
  });

  sourceNode.connect(clipBassEq);
  let tailNode: AudioNode = clipBassEq;

  // Optional Per-Clip Mid/High EQ & Filter Transition Chain
  const mixIn = clip.mixIn;
  const mixOut = clip.mixOut;
  const useEqIn = hasActiveEqOrFilterTransition(mixIn);
  const useEqOut = hasActiveEqOrFilterTransition(mixOut);

  if (useEqIn || useEqOut) {
    const safeInDur = mixIn ? Math.min(mixIn.durationSec, clip.durationSec * 0.85) : 0;
    const inEndTimeline = clip.startSec + safeInDur;
    const minOutStart = safeInDur > 0.01 ? inEndTimeline + 0.004 : clip.startSec;
    const outStartTimeline = mixOut
      ? Math.max(minOutStart, clipEnd - mixOut.durationSec)
      : clipEnd;
    const hasOutWindow = Boolean(mixOut && outStartTimeline < clipEnd - 0.01);
    const liveFloor = getSafeAudioParamFloor(ctx);

    const needsMidHighBands =
      (useEqIn && (mixIn!.midMode !== 'none' || mixIn!.highMode !== 'none')) ||
      (useEqOut && (mixOut!.midMode !== 'none' || mixOut!.highMode !== 'none'));

    if (needsMidHighBands) {
      const eqMid = ctx.createBiquadFilter();
      eqMid.type = 'peaking';
      eqMid.frequency.value = 1000;
      eqMid.Q.value = 0.75;
      eqMid.gain.value = 0;

      const eqHigh = ctx.createBiquadFilter();
      eqHigh.type = 'highshelf';
      eqHigh.frequency.value = 3600;
      eqHigh.gain.value = 0;

      let midInEndCtx: number | null = null;
      let highInEndCtx: number | null = null;

      if (useEqIn && mixIn && safeInDur > 0.01 && playbackStartSec < inEndTimeline) {
        const inMidCut = mixIn.volumeCrossfade ? -8 : -18;
        const inHighCut = mixIn.volumeCrossfade ? -5 : -18;
        if (mixIn.midMode !== 'none') {
          midInEndCtx = scheduleSlicedParamCurve(
            eqMid.gain,
            buildEqTransitionCurve('in', mixIn.midMode, inMidCut),
            clip.startSec,
            inEndTimeline,
            playbackStartSec,
            ctxStartTime,
            1,
            true,
            liveFloor
          );
        }
        if (mixIn.highMode !== 'none') {
          highInEndCtx = scheduleSlicedParamCurve(
            eqHigh.gain,
            buildEqTransitionCurve('in', mixIn.highMode, inHighCut),
            clip.startSec,
            inEndTimeline,
            playbackStartSec,
            ctxStartTime,
            1,
            true,
            liveFloor
          );
        }
      }

      if (useEqOut && mixOut && hasOutWindow && playbackStartSec < clipEnd) {
        const outMidCut = mixOut.volumeCrossfade ? -8 : -18;
        const outHighCut = mixOut.volumeCrossfade ? -5 : -18;
        if (mixOut.midMode !== 'none') {
          scheduleSlicedParamCurve(
            eqMid.gain,
            buildEqTransitionCurve('out', mixOut.midMode, outMidCut),
            outStartTimeline,
            clipEnd,
            playbackStartSec,
            ctxStartTime,
            1,
            true,
            Math.max(liveFloor, midInEndCtx !== null ? midInEndCtx + 0.002 : 0)
          );
        }
        if (mixOut.highMode !== 'none') {
          scheduleSlicedParamCurve(
            eqHigh.gain,
            buildEqTransitionCurve('out', mixOut.highMode, outHighCut),
            outStartTimeline,
            clipEnd,
            playbackStartSec,
            ctxStartTime,
            1,
            true,
            Math.max(liveFloor, highInEndCtx !== null ? highInEndCtx + 0.002 : 0)
          );
        }
      }

      tailNode.connect(eqMid);
      eqMid.connect(eqHigh);
      tailNode = eqHigh;
    }

    // Separate incoming LPF and outgoing HPF filters so both can coexist cleanly on one clip
    if (useEqIn && mixIn && safeInDur > 0.01 && playbackStartSec < inEndTimeline) {
      const inFilterSpec = buildFilterSweepCurve('in', mixIn.filterMode);
      if (inFilterSpec) {
        const inFilter = ctx.createBiquadFilter();
        inFilter.type = inFilterSpec.type;
        inFilter.Q.value = 1.1;
        inFilter.frequency.value = inFilterSpec.values[0];
        scheduleSlicedParamCurve(
          inFilter.frequency,
          inFilterSpec.values,
          clip.startSec,
          inEndTimeline,
          playbackStartSec,
          ctxStartTime,
          1,
          true,
          liveFloor
        );
        tailNode.connect(inFilter);
        tailNode = inFilter;
      }
    }

    if (useEqOut && mixOut && hasOutWindow && playbackStartSec < clipEnd) {
      const outFilterSpec = buildFilterSweepCurve('out', mixOut.filterMode);
      if (outFilterSpec) {
        const outFilter = ctx.createBiquadFilter();
        outFilter.type = outFilterSpec.type;
        outFilter.Q.value = 1.1;
        outFilter.frequency.value = outFilterSpec.values[0];
        scheduleSlicedParamCurve(
          outFilter.frequency,
          outFilterSpec.values,
          outStartTimeline,
          clipEnd,
          playbackStartSec,
          ctxStartTime,
          1,
          true,
          liveFloor
        );
        tailNode.connect(outFilter);
        tailNode = outFilter;
      }
    }
  }

  tailNode.connect(clipGain);
  clipGain.connect(trackInput);
  return { clipGain, clipBassEq };
}

/**
 * Schedules a clip for real-time playback using either a direct AudioBufferSourceNode
 * (unity tempo/pitch) or a real-time TimeStretchProcessor AudioWorkletNode (non-blocking).
 */
function scheduleLiveClipOnTrack(
  ctx: AudioContext,
  clip: NleClip,
  asset: TrackAsset,
  track: NleTrack,
  trackInput: GainNode,
  project: NleProjectState,
  playbackStartSec: number,
  ctxStartTime: number
): ActiveClipHandle | null {
  const clipEnd = clip.startSec + clip.durationSec;
  if (clipEnd <= playbackStartSec) return null;

  const startOffsetOnTimeline = Math.max(0, playbackStartSec - clip.startSec);
  const when = ctxStartTime + Math.max(0, clip.startSec - playbackStartSec);
  const playDuration = Math.max(0.01, clip.durationSec - startOffsetOnTimeline);
  const effectiveTimelineStart = Math.max(playbackStartSec, clip.startSec);

  const stretchInfo = analyzeClipStretchRequirement(clip, asset, project);

  if (!stretchInfo.needsWorklet || !isWorkletRegistered(ctx)) {
    const source = ctx.createBufferSource();
    source.buffer = asset.audioBuffer;

    const speedLane = track.automationLanes.speed;
    if (speedLane && speedLane.points.length > 0) {
      scheduleAutomationLane(
        source.playbackRate,
        speedLane,
        'speed',
        playbackStartSec,
        ctxStartTime,
        clipEnd
      );
    }

    const bufferOffset = clip.offsetSec + startOffsetOnTimeline;
    if (bufferOffset >= asset.audioBuffer.duration) return null;
    const safeDur = Math.min(playDuration, asset.audioBuffer.duration - bufferOffset);

    const { clipGain, clipBassEq } = connectClipEffectsAndFades(
      ctx,
      source,
      clip,
      trackInput,
      playbackStartSec,
      ctxStartTime
    );
    source.start(when, bufferOffset, safeDur);

    return {
      clipId: clip.id,
      clipGain,
      clipBassEq,
      endTimelineSec: clipEnd,
      stop: () => {
        try {
          source.stop();
          source.disconnect();
        } catch {
          // Ignore already-stopped sources
        }
      },
    };
  }

  const sr = asset.audioBuffer.sampleRate;
  const consumedSrcSec =
    clip.stretchToMasterBpm && asset.bpm > 0
      ? integrateClipSourceOffsetSec(project, clip.startSec, startOffsetOnTimeline, asset.bpm)
      : startOffsetOnTimeline;
  const sourceStartSec = clip.offsetSec + consumedSrcSec;
  if (sourceStartSec >= asset.audioBuffer.duration - 0.005) return null;

  const loopBoundedPlayDuration =
    project.loopEnabled &&
    project.loopEndSec > project.loopStartSec + 0.05 &&
    effectiveTimelineStart < project.loopEndSec
      ? Math.min(playDuration, Math.max(0.25, project.loopEndSec - effectiveTimelineStart + 1.5))
      : playDuration;

  const expectedSrcDur =
    clip.stretchToMasterBpm && asset.bpm > 0
      ? integrateClipSourceOffsetSec(
          project,
          effectiveTimelineStart,
          loopBoundedPlayDuration,
          asset.bpm
        )
      : loopBoundedPlayDuration;
  const hasSpeedLane = Boolean(track.automationLanes.speed?.points.length);
  const speedMargin = hasSpeedLane ? 1.3 : 1.05;

  const exactStartSample = Math.max(0, sourceStartSec * sr);
  const absStartSample = Math.floor(exactStartSample);
  const sliceStart = Math.max(0, absStartSample - 4096);
  const sliceEnd = Math.min(
    asset.audioBuffer.length,
    absStartSample + Math.ceil(expectedSrcDur * speedMargin * sr) + 8192
  );
  if (sliceEnd <= absStartSample + 64) return null;

  const localStartSample = exactStartSample - sliceStart;
  const workletNode = new AudioWorkletNode(ctx, 'time-stretch-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });

  const tempoParam = workletNode.parameters.get('tempoRatio');
  if (tempoParam) {
    if (!stretchInfo.isVariableTempo) {
      const clampedRatio = Math.max(0.25, Math.min(4.0, stretchInfo.constantTempoRatio));
      tempoParam.value = clampedRatio;
      tempoParam.setValueAtTime(clampedRatio, when);
    } else {
      const steps = Math.max(2, Math.min(4096, Math.ceil(playDuration * 40)));
      const curve = new Float32Array(steps);
      for (let i = 0; i < steps; i++) {
        const t = effectiveTimelineStart + (playDuration * i) / (steps - 1);
        curve[i] = Math.max(
          0.25,
          Math.min(4.0, getEffectiveBpmRatio(evaluateBpmAt(project, t), asset.bpm))
        );
      }
      scheduleSlicedParamCurve(
        tempoParam,
        curve,
        effectiveTimelineStart,
        effectiveTimelineStart + playDuration,
        playbackStartSec,
        ctxStartTime,
        1,
        true,
        getSafeAudioParamFloor(ctx)
      );
    }
  }

  const speedParam = workletNode.parameters.get('playbackSpeed');
  const speedLane = track.automationLanes.speed;
  if (speedParam && speedLane && speedLane.points.length > 0) {
    scheduleAutomationLane(speedParam, speedLane, 'speed', playbackStartSec, ctxStartTime, clipEnd);
  }

  const pitchParam = workletNode.parameters.get('pitchSemitones');
  if (pitchParam) {
    pitchParam.value = clip.pitchSemitones;
    pitchParam.setValueAtTime(clip.pitchSemitones, when);
  }

  const { clipGain, clipBassEq } = connectClipEffectsAndFades(
    ctx,
    workletNode,
    clip,
    trackInput,
    playbackStartSec,
    ctxStartTime
  );

  const left = new Float32Array(asset.audioBuffer.getChannelData(0).subarray(sliceStart, sliceEnd));
  const hasStereo = asset.audioBuffer.numberOfChannels > 1;
  const right = hasStereo
    ? new Float32Array(asset.audioBuffer.getChannelData(1).subarray(sliceStart, sliceEnd))
    : null;
  const transfer: Transferable[] = right ? [left.buffer, right.buffer] : [left.buffer];

  workletNode.port.postMessage(
    {
      type: 'load',
      left,
      right: right ?? left,
      sampleRate: sr,
      startSample: localStartSample,
      startCtxTime: when,
      durationSec: playDuration,
      keyLock: project.keyLock ?? true,
      useAudioParams: true,
      autoRetire: true,
      autoPlay: true,
    },
    transfer
  );

  return {
    clipId: clip.id,
    clipGain,
    clipBassEq,
    endTimelineSec: clipEnd,
    stop: () => {
      try {
        workletNode.port.postMessage({ type: 'retire' });
        workletNode.port.onmessage = null;
        workletNode.disconnect();
      } catch {
        // Ignore already-disconnected nodes
      }
    },
  };
}

/**
 * Schedules a clip for offline mixdown rendering using deterministic pre-stretched buffers.
 */
function scheduleClipOnTrack(
  ctx: BaseAudioContext,
  clip: NleClip,
  asset: TrackAsset,
  track: NleTrack,
  trackInput: GainNode,
  project: NleProjectState,
  playbackStartSec: number,
  ctxStartTime: number,
  persistStretchCache = true
): AudioBufferSourceNode | null {
  const clipEnd = clip.startSec + clip.durationSec;
  if (clipEnd <= playbackStartSec) return null;

  const { buffer, isPreStretched } = getStretchedClipBuffer(
    clip,
    asset,
    project,
    persistStretchCache
  );

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  // Apply speed automation curve if points exist on the track's speed lane
  const speedLane = track.automationLanes.speed;
  if (speedLane && speedLane.points.length > 0) {
    scheduleAutomationLane(
      source.playbackRate,
      speedLane,
      'speed',
      playbackStartSec,
      ctxStartTime,
      clipEnd
    );
  }

  const startOffsetOnTimeline = Math.max(0, playbackStartSec - clip.startSec);
  const when = ctxStartTime + Math.max(0, clip.startSec - playbackStartSec);
  const bufferOffset = (isPreStretched ? 0 : clip.offsetSec) + startOffsetOnTimeline;
  const playDuration = Math.max(0.01, clip.durationSec - startOffsetOnTimeline);

  connectClipEffectsAndFades(ctx, source, clip, trackInput, playbackStartSec, ctxStartTime);

  if (bufferOffset < buffer.duration) {
    const safeDur = Math.min(playDuration, buffer.duration - bufferOffset);
    source.start(when, bufferOffset, safeDur);
    return source;
  }
  return null;
}

export const DEFAULT_MASTER_VOLUME = 0.92;
const METER_FFT_SIZE = 1024;
const MIN_METER_DB = -60;

export interface MasterAudioLevels {
  /** Linear RMS level [0..1+] for left channel */
  leftRms: number;
  /** Linear RMS level [0..1+] for right channel */
  rightRms: number;
  /** Instantaneous linear peak [0..1+] for left channel */
  leftPeak: number;
  /** Instantaneous linear peak [0..1+] for right channel */
  rightPeak: number;
  /** Left RMS level in dBFS */
  leftDb: number;
  /** Right RMS level in dBFS */
  rightDb: number;
  /** Left peak level in dBFS */
  leftPeakDb: number;
  /** Right peak level in dBFS */
  rightPeakDb: number;
}

function linearToDb(linear: number): number {
  if (!Number.isFinite(linear) || linear <= 1e-5) return MIN_METER_DB;
  return Math.max(MIN_METER_DB, 20 * Math.log10(linear));
}

function clampMasterVolume(volume: number): number {
  if (!Number.isFinite(volume)) return DEFAULT_MASTER_VOLUME;
  return Math.max(0, Math.min(1.25, volume));
}

const LOOKAHEAD_WINDOW_SEC = 18;
const LOOKAHEAD_INTERVAL_MS = 400;

export class NlePlaybackEngine {
  private ctx: AudioContext | null = null;
  private activeHandles: ActiveClipHandle[] = [];
  private activeClipHandles = new Map<string, ActiveClipHandle>();
  private activeTrackNodes = new Map<
    string,
    { volumeGain: GainNode; panner: StereoPannerNode; muteGain: GainNode }
  >();
  private activeTrackInputs = new Map<string, GainNode>();
  private scheduledClipIds = new Set<string>();
  private lookaheadTimer: number | null = null;
  private playSessionId = 0;
  private activeProject: NleProjectState | null = null;
  private activeAssetsMap: Map<string, TrackAsset> | null = null;

  private masterGain: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private splitter: ChannelSplitterNode | null = null;
  private analyserLeft: AnalyserNode | null = null;
  private analyserRight: AnalyserNode | null = null;
  private meterBufLeft = new Float32Array(METER_FFT_SIZE);
  private meterBufRight = new Float32Array(METER_FFT_SIZE);
  private reverbImpulse: AudioBuffer | null = null;
  private playStartCtxTime = 0;
  private playStartTimelineSec = 0;
  private isPlaying = false;

  private previewSource: AudioBufferSourceNode | null = null;
  private previewTrackId: string | null = null;
  private previewStartCtxTime = 0;
  private previewStartOffsetSec = 0;
  private previewDurationSec = 0;
  private previewSessionId = 0;

  public getContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    if (!this.reverbImpulse) {
      this.reverbImpulse = createImpulseResponse(this.ctx, 1.8, 2.5);
    }
    if (!isWorkletRegistered(this.ctx)) {
      void ensureWorkletsRegistered(this.ctx);
    }
    return this.ctx;
  }

  private beginPlaybackGraph(
    ctx: AudioContext,
    project: NleProjectState,
    assetsMap: Map<string, TrackAsset>,
    startSec: number
  ): void {
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = clampMasterVolume(project.masterVolume ?? DEFAULT_MASTER_VOLUME);

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1.0;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.06;
    this.limiter = limiter;

    // Split post-limiter stereo master output into Left/Right analysers for accurate metering
    const splitter = ctx.createChannelSplitter(2);
    const analyserLeft = ctx.createAnalyser();
    const analyserRight = ctx.createAnalyser();
    analyserLeft.fftSize = METER_FFT_SIZE;
    analyserRight.fftSize = METER_FFT_SIZE;
    analyserLeft.smoothingTimeConstant = 0.25;
    analyserRight.smoothingTimeConstant = 0.25;

    this.splitter = splitter;
    this.analyserLeft = analyserLeft;
    this.analyserRight = analyserRight;

    this.masterGain.connect(limiter);
    limiter.connect(ctx.destination);
    limiter.connect(splitter);
    splitter.connect(analyserLeft, 0);
    splitter.connect(analyserRight, 1);

    const hasSolo = project.tracks.some((t) => t.soloed);
    const mixEndSec = getProjectMixDuration(project) + 2;
    const ctxStart = ctx.currentTime + 0.06;

    this.playStartCtxTime = ctxStart;
    this.playStartTimelineSec = startSec;
    this.activeProject = project;
    this.activeAssetsMap = assetsMap;

    for (const track of project.tracks) {
      const audible = hasSolo ? track.soloed && !track.muted : !track.muted;

      const chain = buildTrackChain(
        ctx,
        track,
        this.masterGain,
        this.reverbImpulse!,
        startSec,
        ctxStart,
        mixEndSec,
        audible
      );
      this.activeTrackNodes.set(track.id, {
        volumeGain: chain.volumeGain,
        panner: chain.panner,
        muteGain: chain.muteGain,
      });
      this.activeTrackInputs.set(track.id, chain.input);
    }

    this.scheduleLookaheadClips(startSec);
    this.lookaheadTimer = window.setInterval(() => {
      if (!this.isPlaying) return;
      const cur = this.getCurrentPlayheadSec();
      this.scheduleLookaheadClips(cur);
      this.pruneFinishedHandles(cur);
    }, LOOKAHEAD_INTERVAL_MS);
  }

  private scheduleLookaheadClips(currentPlayheadSec: number): void {
    if (!this.ctx || !this.activeProject || !this.activeAssetsMap) return;
    const horizon = currentPlayheadSec + LOOKAHEAD_WINDOW_SEC;

    for (const track of this.activeProject.tracks) {
      const trackInput = this.activeTrackInputs.get(track.id);
      if (!trackInput) continue;

      for (const clip of track.clips) {
        if (this.scheduledClipIds.has(clip.id)) continue;
        const clipEnd = clip.startSec + clip.durationSec;
        if (clipEnd <= this.playStartTimelineSec) continue;
        if (clip.startSec > horizon) continue;

        const asset = this.activeAssetsMap.get(clip.trackAssetId);
        if (!asset) continue;

        this.scheduledClipIds.add(clip.id);
        const handle = scheduleLiveClipOnTrack(
          this.ctx,
          clip,
          asset,
          track,
          trackInput,
          this.activeProject,
          this.playStartTimelineSec,
          this.playStartCtxTime
        );
        if (handle) {
          this.activeHandles.push(handle);
          this.activeClipHandles.set(handle.clipId, handle);
        }
      }
    }
  }

  private pruneFinishedHandles(currentPlayheadSec: number): void {
    if (this.activeHandles.length === 0) return;
    const remaining: ActiveClipHandle[] = [];
    for (const handle of this.activeHandles) {
      if (handle.endTimelineSec < currentPlayheadSec - 2) {
        handle.stop();
        this.activeClipHandles.delete(handle.clipId);
      } else {
        remaining.push(handle);
      }
    }
    this.activeHandles = remaining;
  }

  public start(
    project: NleProjectState,
    assetsMap: Map<string, TrackAsset>,
    startSec: number
  ): void {
    this.stop();
    this.stopPreview();
    const sessionId = ++this.playSessionId;
    const ctx = this.getContext();

    this.playStartCtxTime = ctx.currentTime + 0.06;
    this.playStartTimelineSec = startSec;
    this.isPlaying = true;

    const initialHorizon = startSec + LOOKAHEAD_WINDOW_SEC;
    const needsInitialWorklet = project.tracks.some((track) => {
      return track.clips.some((clip) => {
        if (clip.startSec + clip.durationSec <= startSec) return false;
        if (clip.startSec > initialHorizon) return false;
        const asset = assetsMap.get(clip.trackAssetId);
        return asset ? analyzeClipStretchRequirement(clip, asset, project).needsWorklet : false;
      });
    });

    if (needsInitialWorklet && !isWorkletRegistered(ctx)) {
      void ensureWorkletsRegistered(ctx).then(() => {
        if (this.playSessionId !== sessionId || !this.isPlaying) return;
        this.beginPlaybackGraph(ctx, project, assetsMap, startSec);
      });
      return;
    }

    this.beginPlaybackGraph(ctx, project, assetsMap, startSec);
  }

  public stop(): void {
    this.playSessionId += 1;
    this.isPlaying = false;
    if (this.lookaheadTimer !== null) {
      window.clearInterval(this.lookaheadTimer);
      this.lookaheadTimer = null;
    }
    for (const handle of this.activeHandles) {
      handle.stop();
    }
    this.activeHandles = [];
    this.activeClipHandles.clear();
    this.scheduledClipIds.clear();
    this.activeTrackNodes.clear();
    this.activeTrackInputs.clear();
    this.activeProject = null;
    this.activeAssetsMap = null;
    if (this.masterGain) {
      try {
        this.masterGain.disconnect();
      } catch {
        // Ignore
      }
      this.masterGain = null;
    }
    for (const node of [this.limiter, this.splitter, this.analyserLeft, this.analyserRight]) {
      if (node) {
        try {
          node.disconnect();
        } catch {
          // Ignore
        }
      }
    }
    this.limiter = null;
    this.splitter = null;
    this.analyserLeft = null;
    this.analyserRight = null;
  }

  public getCurrentPlayheadSec(): number {
    if (!this.isPlaying || !this.ctx) return this.playStartTimelineSec;
    const elapsed = Math.max(0, this.ctx.currentTime - this.playStartCtxTime);
    return this.playStartTimelineSec + elapsed;
  }

  public setMasterVolumeLive(volume: number): void {
    if (!this.masterGain || !this.ctx) return;
    const clamped = clampMasterVolume(volume);
    this.masterGain.gain.setTargetAtTime(clamped, this.ctx.currentTime, 0.015);
  }

  public getMasterLevels(): MasterAudioLevels {
    if (!this.isPlaying || !this.analyserLeft || !this.analyserRight) {
      return {
        leftRms: 0,
        rightRms: 0,
        leftPeak: 0,
        rightPeak: 0,
        leftDb: MIN_METER_DB,
        rightDb: MIN_METER_DB,
        leftPeakDb: MIN_METER_DB,
        rightPeakDb: MIN_METER_DB,
      };
    }

    this.analyserLeft.getFloatTimeDomainData(this.meterBufLeft);
    this.analyserRight.getFloatTimeDomainData(this.meterBufRight);

    let sumSqL = 0;
    let sumSqR = 0;
    let peakL = 0;
    let peakR = 0;
    const len = this.meterBufLeft.length;

    for (let i = 0; i < len; i++) {
      const sL = this.meterBufLeft[i];
      const sR = this.meterBufRight[i];
      const absL = sL < 0 ? -sL : sL;
      const absR = sR < 0 ? -sR : sR;
      sumSqL += sL * sL;
      sumSqR += sR * sR;
      if (absL > peakL) peakL = absL;
      if (absR > peakR) peakR = absR;
    }

    const leftRms = Math.sqrt(sumSqL / len);
    const rightRms = Math.sqrt(sumSqR / len);

    return {
      leftRms,
      rightRms,
      leftPeak: peakL,
      rightPeak: peakR,
      leftDb: linearToDb(leftRms),
      rightDb: linearToDb(rightRms),
      leftPeakDb: linearToDb(peakL),
      rightPeakDb: linearToDb(peakR),
    };
  }

  public updateTrackMixLive(track: NleTrack, allTracks?: NleTrack[]): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const nodes = this.activeTrackNodes.get(track.id);
    if (nodes) {
      if (track.automationLanes.volume.points.length === 0) {
        nodes.volumeGain.gain.setTargetAtTime(track.volume, now, 0.015);
      }
      if (track.automationLanes.pan.points.length === 0) {
        nodes.panner.pan.setTargetAtTime(track.pan, now, 0.015);
      }
    }

    if (allTracks) {
      if (this.activeProject) {
        this.activeProject = { ...this.activeProject, tracks: allTracks };
      }
      const hasSolo = allTracks.some((t) => t.soloed);
      for (const t of allTracks) {
        const trackNodes = this.activeTrackNodes.get(t.id);
        if (!trackNodes) continue;
        const audible = hasSolo ? t.soloed && !t.muted : !t.muted;
        trackNodes.muteGain.gain.setTargetAtTime(audible ? 1 : 0, now, 0.01);
      }
    }
  }

  public updateClipFadesLive(clip: NleClip, updatedProject?: NleProjectState): void {
    if (updatedProject && this.isPlaying) {
      this.activeProject = updatedProject;
    }
    if (!this.isPlaying || !this.ctx) return;

    const handle = this.activeClipHandles.get(clip.id);
    if (!handle) return;

    const gainParam = handle.clipGain.gain;
    const bassParam = handle.clipBassEq.gain;
    const now = this.ctx.currentTime;

    if (now + 0.025 < this.playStartCtxTime) {
      gainParam.cancelScheduledValues(0);
      scheduleClipFadeEnvelope(
        this.ctx,
        gainParam,
        clip,
        this.playStartTimelineSec,
        this.playStartCtxTime,
        {
          setInitialValue: true,
        }
      );
      bassParam.cancelScheduledValues(0);
      scheduleClipBassEnvelope(
        this.ctx,
        bassParam,
        clip,
        this.playStartTimelineSec,
        this.playStartCtxTime,
        {
          setInitialValue: true,
        }
      );
      return;
    }

    const currentVal = gainParam.value;
    const currentBassVal = bassParam.value;
    const rampSec = 0.02;
    const rampEndCtx = now + rampSec;
    const envelopeStartCtx = rampEndCtx + 0.002;
    const envelopeStartTimeline =
      this.playStartTimelineSec + (envelopeStartCtx - this.playStartCtxTime);
    const targetAtRampEnd = evaluateClipFadeGainAt(clip, envelopeStartTimeline);
    const targetBassAtRampEnd = evaluateClipBassEqDbAt(clip, envelopeStartTimeline);

    gainParam.cancelScheduledValues(0);
    gainParam.setValueAtTime(currentVal, now);
    gainParam.linearRampToValueAtTime(targetAtRampEnd, rampEndCtx);

    scheduleClipFadeEnvelope(this.ctx, gainParam, clip, envelopeStartTimeline, envelopeStartCtx, {
      setInitialValue: false,
    });

    bassParam.cancelScheduledValues(0);
    bassParam.setValueAtTime(currentBassVal, now);
    bassParam.linearRampToValueAtTime(targetBassAtRampEnd, rampEndCtx);

    scheduleClipBassEnvelope(this.ctx, bassParam, clip, envelopeStartTimeline, envelopeStartCtx, {
      setInitialValue: false,
    });
  }

  /**
   * Plays a playlist track's raw AudioBuffer directly to ctx.destination with zero EQ,
   * filters, effects, limiting, or tempo stretching.
   */
  public playPreview(asset: TrackAsset, offsetSec = 0, onEnded?: () => void): void {
    this.stop();
    this.stopPreview();

    const ctx = this.getContext();
    const sessionId = ++this.previewSessionId;
    const duration = asset.audioBuffer.duration;
    const safeOffset = Math.max(0, Math.min(offsetSec, Math.max(0, duration - 0.05)));

    const source = ctx.createBufferSource();
    source.buffer = asset.audioBuffer;
    source.connect(ctx.destination);

    source.onended = () => {
      if (this.previewSessionId !== sessionId) return;
      try {
        source.disconnect();
      } catch {
        // Ignore already-disconnected source
      }
      this.previewSource = null;
      this.previewTrackId = null;
      this.previewStartCtxTime = 0;
      this.previewStartOffsetSec = 0;
      this.previewDurationSec = 0;
      onEnded?.();
    };

    this.previewSource = source;
    this.previewTrackId = asset.id;
    this.previewStartCtxTime = ctx.currentTime;
    this.previewStartOffsetSec = safeOffset;
    this.previewDurationSec = duration;

    source.start(0, safeOffset);
  }

  public stopPreview(): void {
    this.previewSessionId += 1;
    if (this.previewSource) {
      const src = this.previewSource;
      this.previewSource = null;
      src.onended = null;
      try {
        src.stop();
        src.disconnect();
      } catch {
        // Ignore already-stopped source
      }
    }
    this.previewTrackId = null;
    this.previewStartCtxTime = 0;
    this.previewStartOffsetSec = 0;
    this.previewDurationSec = 0;
  }

  public getPreviewPositionSec(): number {
    if (!this.previewSource || !this.ctx || !this.previewTrackId) return 0;
    const elapsed = Math.max(0, this.ctx.currentTime - this.previewStartCtxTime);
    return Math.min(this.previewDurationSec, this.previewStartOffsetSec + elapsed);
  }
}

export function getProjectMixDuration(project: NleProjectState): number {
  let maxEnd = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const end = clip.startSec + clip.durationSec;
      if (end > maxEnd) maxEnd = end;
    }
  }
  return maxEnd;
}

/**
 * Renders the full NLE timeline arrangement (clips, time-stretch, fades, effects,
 * and automation curves) deterministically via OfflineAudioContext.
 */
export async function renderNleMixdown(
  project: NleProjectState,
  assetsMap: Map<string, TrackAsset>,
  onProgress?: (pct: number) => void
): Promise<AudioBuffer> {
  const mixDuration = getProjectMixDuration(project);
  if (mixDuration <= 0.05) {
    throw new Error('Timeline is empty. Drag at least one track onto a timeline lane before exporting.');
  }

  // Free cached playback time-stretch buffers on longer mixes before allocating OfflineAudioContext
  if (mixDuration > 600) {
    clearStretchBufferCache();
  }

  onProgress?.(0.08);
  const sampleRate = 44100;
  const tailSec = 1.2;
  const totalSamples = Math.ceil((mixDuration + tailSec) * sampleRate);
  const offlineCtx = new OfflineAudioContext(2, totalSamples, sampleRate);
  const reverbImpulse = createImpulseResponse(offlineCtx, 1.8, 2.5);

  const masterGain = offlineCtx.createGain();
  masterGain.gain.value = clampMasterVolume(project.masterVolume ?? 0.94);
  const limiter = offlineCtx.createDynamicsCompressor();
  limiter.threshold.value = -1.0;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.06;
  masterGain.connect(limiter);
  limiter.connect(offlineCtx.destination);

  const hasSolo = project.tracks.some((t) => t.soloed);
  const totalClips = project.tracks.reduce((acc, t) => acc + t.clips.length, 0);
  let processedClips = 0;

  for (const track of project.tracks) {
    const audible = hasSolo ? track.soloed && !track.muted : !track.muted;
    if (!audible) continue;

    const chain = buildTrackChain(
      offlineCtx,
      track,
      masterGain,
      reverbImpulse,
      0,
      0,
      mixDuration + tailSec
    );

    for (const clip of track.clips) {
      const asset = assetsMap.get(clip.trackAssetId);
      if (asset) {
        scheduleClipOnTrack(
          offlineCtx,
          clip,
          asset,
          track,
          chain.input,
          project,
          0,
          0,
          false
        );
      }
      processedClips++;
      onProgress?.(0.1 + (processedClips / Math.max(1, totalClips)) * 0.45);
    }
  }

  onProgress?.(0.6);
  const rendered = await offlineCtx.startRendering();
  onProgress?.(0.95);
  return rendered;
}

export const nleEngine = new NlePlaybackEngine();
