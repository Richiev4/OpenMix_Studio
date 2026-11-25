import { Mp3Encoder } from '@breezystack/lamejs';
import type { ExportFormat, LossyBitrateKbps } from '../types/audio';

/** Standard 32-bit RIFF WAV header byte ceiling (~4.29 GB). */
export const MAX_RIFF_WAV_BYTES = 0xffffffff;
/** Conservative single-file threshold (~2 GB) where browser tab memory may get tight. */
export const RECOMMENDED_MAX_WAV_BYTES = 2 * 1024 * 1024 * 1024;

/** Available CBR/target bitrate options (kbps) for compressed exports. */
export const LOSSY_BITRATE_OPTIONS: readonly LossyBitrateKbps[] = [128, 192, 256, 320];

const MP3_SUPPORTED_SAMPLE_RATES = [44100, 48000, 32000, 24000, 22050, 16000] as const;
const ADTS_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
] as const;

/**
 * Estimates the uncompressed output byte size of a RIFF WAV export.
 */
export function estimateWavByteSize(
  durationSec: number,
  bitDepth: 16 | 24,
  sampleRate = 44100,
  numChannels = 2
): number {
  const safeDuration = Math.max(0, Number.isFinite(durationSec) ? durationSec : 0);
  const totalFrames = Math.ceil(safeDuration * sampleRate);
  return 44 + totalFrames * numChannels * (bitDepth / 8);
}

/**
 * Estimates the output byte size of a lossy compressed export (MP3, AAC, or WebM Opus)
 * based on the target bitrate in kbps.
 */
export function estimateCompressedByteSize(
  durationSec: number,
  bitrateKbps: LossyBitrateKbps
): number {
  const safeDuration = Math.max(0, Number.isFinite(durationSec) ? durationSec : 0);
  return Math.ceil(safeDuration * ((bitrateKbps * 1000) / 8));
}

/**
 * Peak-normalizes an AudioBuffer safely so maximum sample peak reaches targetDb (e.g., -0.5 dBFS).
 * When `inPlace` is true, samples are scaled directly on `buffer` to avoid allocating a second
 * multi-gigabyte AudioBuffer during long mixdown exports.
 */
export function normalizeAudioBuffer(
  buffer: AudioBuffer,
  targetDb = -0.5,
  inPlace = false
): AudioBuffer {
  const targetLinear = Math.pow(10, targetDb / 20);
  let maxPeak = 0;

  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const abs = Math.abs(data[i]);
      if (abs > maxPeak) maxPeak = abs;
    }
  }

  if (maxPeak <= 0.00001) return buffer;
  const gain = targetLinear / maxPeak;

  const out = inPlace
    ? buffer
    : new AudioBuffer({
        length: buffer.length,
        numberOfChannels: buffer.numberOfChannels,
        sampleRate: buffer.sampleRate,
      });

  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0; i < src.length; i++) {
      dst[i] = Math.max(-1, Math.min(1, src[i] * gain));
    }
  }

  return out;
}

/**
 * Resamples an AudioBuffer to `targetSampleRate` using OfflineAudioContext when its native
 * sample rate is not supported by the target encoder.
 */
async function resampleAudioBuffer(
  buffer: AudioBuffer,
  targetSampleRate: number,
  targetChannels: number
): Promise<AudioBuffer> {
  if (buffer.sampleRate === targetSampleRate && buffer.numberOfChannels === targetChannels) {
    return buffer;
  }
  const frameCount = Math.max(1, Math.ceil(buffer.duration * targetSampleRate));
  const offline = new OfflineAudioContext(targetChannels, frameCount, targetSampleRate);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start(0);
  return offline.startRendering();
}

function buildWavHeaderBytes(
  totalFrames: number,
  numChannels: number,
  sampleRate: number,
  bitDepth: 16 | 24
): Uint8Array<ArrayBuffer> {
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = totalFrames * blockAlign;
  const totalSize = 44 + dataSize;

  if (totalSize > MAX_RIFF_WAV_BYTES) {
    throw new Error(
      'Export exceeds the 4 GB RIFF WAV file size limit. Switch to WAV 16-bit, MP3, AAC, or WebM, or split the mix into shorter parts.'
    );
  }

  const headerBuffer = new ArrayBuffer(44);
  const view = new DataView(headerBuffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format = 1
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  return new Uint8Array(headerBuffer);
}

function encodeWavFrameChunk(
  channels: Float32Array[],
  startFrame: number,
  frameCount: number,
  bitDepth: 16 | 24
): Uint8Array<ArrayBuffer> {
  const numChannels = channels.length;
  const bytesPerSample = bitDepth / 8;
  const chunkBuffer = new ArrayBuffer(frameCount * numChannels * bytesPerSample);
  const bytes = new Uint8Array(chunkBuffer);
  let offset = 0;

  if (bitDepth === 16) {
    const view = new DataView(chunkBuffer);
    for (let i = 0; i < frameCount; i++) {
      const frameIdx = startFrame + i;
      for (let c = 0; c < numChannels; c++) {
        const clamped = Math.max(-1, Math.min(1, channels[c][frameIdx]));
        const sample = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
        view.setInt16(offset, sample, true);
        offset += 2;
      }
    }
  } else {
    for (let i = 0; i < frameCount; i++) {
      const frameIdx = startFrame + i;
      for (let c = 0; c < numChannels; c++) {
        const clamped = Math.max(-1, Math.min(1, channels[c][frameIdx]));
        const sample = Math.round(clamped < 0 ? clamped * 0x800000 : clamped * 0x7fffff);
        bytes[offset] = sample & 0xff;
        bytes[offset + 1] = (sample >> 8) & 0xff;
        bytes[offset + 2] = (sample >> 16) & 0xff;
        offset += 3;
      }
    }
  }

  return bytes;
}

/**
 * Encodes an AudioBuffer into an uncompressed lossless RIFF WAV Blob (16-bit or 24-bit PCM)
 * using chunked Blob parts to avoid giant contiguous ArrayBuffer allocations.
 */
export function encodeWav(buffer: AudioBuffer, bitDepth: 16 | 24 = 24): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const header = buildWavHeaderBytes(buffer.length, numChannels, sampleRate, bitDepth);

  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) {
    channels.push(buffer.getChannelData(c));
  }

  // Encode in ~30-second chunks so large mixes do not require a single contiguous ArrayBuffer
  const chunkFrames = Math.max(4096, sampleRate * 30);
  const parts: BlobPart[] = [header];

  for (let start = 0; start < buffer.length; start += chunkFrames) {
    const count = Math.min(chunkFrames, buffer.length - start);
    parts.push(encodeWavFrameChunk(channels, start, count, bitDepth));
  }

  return new Blob(parts, { type: 'audio/wav' });
}

/**
 * Async chunked WAV encoder that yields periodically to the main thread so progress updates
 * stay responsive and multi-hour exports do not freeze the browser tab.
 */
export async function encodeWavAsync(
  buffer: AudioBuffer,
  bitDepth: 16 | 24 = 24,
  onProgress?: (pct: number) => void
): Promise<Blob> {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const header = buildWavHeaderBytes(buffer.length, numChannels, sampleRate, bitDepth);

  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) {
    channels.push(buffer.getChannelData(c));
  }

  // ~20 seconds per chunk (~5.3 MB for 24-bit stereo, ~3.5 MB for 16-bit stereo)
  const chunkFrames = Math.max(4096, sampleRate * 20);
  const parts: BlobPart[] = [header];
  const totalFrames = Math.max(1, buffer.length);

  for (let start = 0; start < buffer.length; start += chunkFrames) {
    const count = Math.min(chunkFrames, buffer.length - start);
    parts.push(encodeWavFrameChunk(channels, start, count, bitDepth));
    onProgress?.(Math.min(0.98, (start + count) / totalFrames));
    // Yield to browser event loop between chunks on multi-chunk exports
    if (start + count < buffer.length) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }

  onProgress?.(1);
  return new Blob(parts, { type: 'audio/wav' });
}

/**
 * Converts a Float32Array slice of normalized audio [-1, 1] into Int16Array PCM samples.
 */
function floatSliceToInt16(src: Float32Array, start: number, count: number): Int16Array {
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    const clamped = Math.max(-1, Math.min(1, src[start + i]));
    out[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
  }
  return out;
}

/**
 * Copies a Uint8Array view into an ArrayBuffer-backed Uint8Array suitable for BlobPart.
 */
function copyToBlobBytes(view: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(view.byteLength));
  copy.set(view);
  return copy;
}

/**
 * Async chunked MP3 encoder using `@breezystack/lamejs`.
 * Resamples unsupported sample rates (e.g., 96 kHz) to 48 kHz / 44.1 kHz and yields
 * periodically between MPEG frame batches so the UI stays responsive.
 */
export async function encodeMp3Async(
  buffer: AudioBuffer,
  bitrateKbps: LossyBitrateKbps = 320,
  onProgress?: (pct: number) => void
): Promise<Blob> {
  const targetChannels = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const isRateSupported = (MP3_SUPPORTED_SAMPLE_RATES as readonly number[]).includes(
    buffer.sampleRate
  );
  const targetRate = isRateSupported
    ? buffer.sampleRate
    : buffer.sampleRate % 48000 === 0
      ? 48000
      : 44100;

  const workingBuffer =
    isRateSupported && buffer.numberOfChannels <= 2
      ? buffer
      : await resampleAudioBuffer(buffer, targetRate, targetChannels);

  const encoder = new Mp3Encoder(targetChannels, workingBuffer.sampleRate, bitrateKbps);
  const left = workingBuffer.getChannelData(0);
  const right = targetChannels > 1 ? workingBuffer.getChannelData(1) : null;

  // 1152 samples is one MPEG-1 Layer III frame; batch 40 frames (~1.04s at 44.1kHz) per yield
  const chunkFrames = 1152 * 40;
  const totalFrames = Math.max(1, workingBuffer.length);
  const parts: BlobPart[] = [];

  for (let start = 0; start < workingBuffer.length; start += chunkFrames) {
    const count = Math.min(chunkFrames, workingBuffer.length - start);
    const leftInt16 = floatSliceToInt16(left, start, count);
    const encoded = right
      ? encoder.encodeBuffer(leftInt16, floatSliceToInt16(right, start, count))
      : encoder.encodeBuffer(leftInt16);

    if (encoded.length > 0) {
      parts.push(copyToBlobBytes(encoded));
    }

    onProgress?.(Math.min(0.96, (start + count) / totalFrames));
    if (start + count < workingBuffer.length) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }

  const tail = encoder.flush();
  if (tail.length > 0) {
    parts.push(copyToBlobBytes(tail));
  }

  onProgress?.(1);
  return new Blob(parts, { type: 'audio/mpeg' });
}

/**
 * Prepends a 7-byte ISO/IEC 13818-7 ADTS header to a raw AAC-LC frame when a WebCodecs
 * encoder emits raw `aac` packets rather than ADTS-wrapped frames.
 */
function wrapWithAdtsHeader(
  payload: Uint8Array,
  sampleRate: number,
  channels: number
): Uint8Array<ArrayBuffer> {
  // If chunk already starts with an ADTS syncword (0xFFF), keep as-is
  if (payload.byteLength >= 2 && payload[0] === 0xff && (payload[1] & 0xf0) === 0xf0) {
    return copyToBlobBytes(payload);
  }

  const freqIdx = (ADTS_SAMPLE_RATES as readonly number[]).indexOf(sampleRate);
  const safeFreqIdx = freqIdx >= 0 ? freqIdx : 4; // Fallback to 44100 Hz index
  const profile = 1; // AAC-LC (AudioObjectType 2 - 1)
  const frameLen = 7 + payload.byteLength;

  const out = new Uint8Array(new ArrayBuffer(frameLen));
  out[0] = 0xff;
  out[1] = 0xf1;
  out[2] = ((profile & 0x03) << 6) | ((safeFreqIdx & 0x0f) << 2) | ((channels >> 2) & 0x01);
  out[3] = ((channels & 0x03) << 6) | ((frameLen >> 11) & 0x03);
  out[4] = (frameLen >> 3) & 0xff;
  out[5] = ((frameLen & 0x07) << 5) | 0x1f;
  out[6] = 0xfc;
  out.set(payload, 7);
  return out;
}

type WebCodecsAacConfig = AudioEncoderConfig & {
  aac?: { format: 'aac' | 'adts' };
};

function getMediaRecorderAacMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

async function resolveWebCodecsAacConfig(
  sampleRate: number,
  channels: number,
  bitrateKbps: LossyBitrateKbps
): Promise<{ config: WebCodecsAacConfig; useAdtsWrapper: boolean } | null> {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') {
    return null;
  }

  const candidateRates = (ADTS_SAMPLE_RATES as readonly number[]).includes(sampleRate)
    ? [sampleRate, 48000, 44100]
    : [48000, 44100];

  const uniqueRates = Array.from(new Set(candidateRates));

  for (const rate of uniqueRates) {
    const adtsConfig: WebCodecsAacConfig = {
      codec: 'mp4a.40.2',
      sampleRate: rate,
      numberOfChannels: channels,
      bitrate: bitrateKbps * 1000,
      aac: { format: 'adts' },
    };
    try {
      const adtsSupport = await AudioEncoder.isConfigSupported(adtsConfig);
      if (adtsSupport.supported) {
        return { config: adtsConfig, useAdtsWrapper: false };
      }
    } catch {
      // Try raw AAC config fallback below
    }

    const rawConfig: WebCodecsAacConfig = {
      codec: 'mp4a.40.2',
      sampleRate: rate,
      numberOfChannels: channels,
      bitrate: bitrateKbps * 1000,
    };
    try {
      const rawSupport = await AudioEncoder.isConfigSupported(rawConfig);
      if (rawSupport.supported) {
        return { config: rawConfig, useAdtsWrapper: true };
      }
    } catch {
      // Continue trying remaining sample rates
    }
  }

  return null;
}

/**
 * Checks whether the current browser supports AAC export via WebCodecs or MediaRecorder.
 */
export async function detectAacSupport(): Promise<{
  supported: boolean;
  via: 'webcodecs' | 'mediarecorder' | 'none';
}> {
  const webCodecsConfig = await resolveWebCodecsAacConfig(44100, 2, 256);
  if (webCodecsConfig) {
    return { supported: true, via: 'webcodecs' };
  }
  if (getMediaRecorderAacMimeType()) {
    return { supported: true, via: 'mediarecorder' };
  }
  return { supported: false, via: 'none' };
}

async function encodeViaMediaRecorder(
  buffer: AudioBuffer,
  mimeType: string,
  bitrateKbps: LossyBitrateKbps,
  errorLabel: string,
  onProgress?: (pct: number) => void
): Promise<Blob> {
  const ctx = new AudioContext({ sampleRate: buffer.sampleRate });
  const dest = ctx.createMediaStreamDestination();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(dest);

  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(dest.stream, {
    mimeType,
    audioBitsPerSecond: bitrateKbps * 1000,
  });

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      chunks.push(e.data);
    }
  };

  return new Promise<Blob>((resolve, reject) => {
    const durationMs = Math.max(100, buffer.duration * 1000);
    const startTime = performance.now();
    const timer = window.setInterval(() => {
      if (onProgress) {
        const elapsed = performance.now() - startTime;
        onProgress(Math.min(0.98, elapsed / durationMs));
      }
    }, 100);

    recorder.onerror = () => {
      window.clearInterval(timer);
      void ctx.close();
      reject(new Error(`${errorLabel} recording failed during encoding.`));
    };

    recorder.onstop = () => {
      window.clearInterval(timer);
      onProgress?.(1);
      void ctx.close();
      resolve(new Blob(chunks, { type: mimeType }));
    };

    source.onended = () => {
      // Allow trailing 80ms buffer flush before stopping recorder
      window.setTimeout(() => {
        if (recorder.state !== 'inactive') {
          recorder.stop();
        }
      }, 80);
    };

    recorder.start(100);
    source.start(0);
  });
}

/**
 * Encodes an AudioBuffer into AAC-LC audio at the selected bitrate.
 * Prefers offline WebCodecs `AudioEncoder` (ADTS `.aac`), falling back to `MediaRecorder`
 * (`audio/mp4` / `audio/aac`) where supported.
 */
export async function encodeAacAsync(
  buffer: AudioBuffer,
  bitrateKbps: LossyBitrateKbps = 256,
  onProgress?: (pct: number) => void
): Promise<{ blob: Blob; extension: string }> {
  const targetChannels = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const resolved = await resolveWebCodecsAacConfig(
    buffer.sampleRate,
    targetChannels,
    bitrateKbps
  );

  if (resolved) {
    const { config } = resolved;
    const targetRate = config.sampleRate;
    const workingBuffer =
      buffer.sampleRate === targetRate && buffer.numberOfChannels <= 2
        ? buffer
        : await resampleAudioBuffer(buffer, targetRate, targetChannels);

    const parts: BlobPart[] = [];
    let encoderError: Error | null = null;

    const encoder = new AudioEncoder({
      output: (chunk) => {
        const raw = new Uint8Array(new ArrayBuffer(chunk.byteLength));
        chunk.copyTo(raw);
        parts.push(wrapWithAdtsHeader(raw, targetRate, targetChannels));
      },
      error: (err) => {
        encoderError = err instanceof Error ? err : new Error('WebCodecs AAC encoding failed.');
      },
    });

    encoder.configure(config);

    const channelArrays: Float32Array[] = [];
    for (let c = 0; c < targetChannels; c++) {
      channelArrays.push(workingBuffer.getChannelData(c));
    }

    const chunkFrames = 4096;
    const totalFrames = Math.max(1, workingBuffer.length);

    try {
      for (let start = 0; start < workingBuffer.length; start += chunkFrames) {
        if (encoderError) throw encoderError;

        const count = Math.min(chunkFrames, workingBuffer.length - start);
        const planar = new Float32Array(count * targetChannels);
        for (let c = 0; c < targetChannels; c++) {
          planar.set(channelArrays[c].subarray(start, start + count), c * count);
        }

        const timestampUs = Math.round((start / targetRate) * 1_000_000);
        const audioData = new AudioData({
          format: 'f32-planar',
          sampleRate: targetRate,
          numberOfFrames: count,
          numberOfChannels: targetChannels,
          timestamp: timestampUs,
          data: planar,
        });

        encoder.encode(audioData);
        audioData.close();

        // Apply backpressure and keep UI responsive during long exports
        if (encoder.encodeQueueSize >= 8) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        }
        onProgress?.(Math.min(0.95, (start + count) / totalFrames));
      }

      await encoder.flush();
      if (encoderError) throw encoderError;
    } finally {
      if (encoder.state !== 'closed') {
        encoder.close();
      }
    }

    onProgress?.(1);
    return {
      blob: new Blob(parts, { type: 'audio/aac' }),
      extension: 'aac',
    };
  }

  const fallbackMime = getMediaRecorderAacMimeType();
  if (fallbackMime) {
    const blob = await encodeViaMediaRecorder(
      buffer,
      fallbackMime,
      bitrateKbps,
      'AAC',
      onProgress
    );
    return {
      blob,
      extension: fallbackMime.includes('aac') ? 'aac' : 'm4a',
    };
  }

  throw new Error(
    'AAC encoding is not supported by this browser. Choose MP3, WebM Opus, or WAV instead.'
  );
}

/**
 * Encodes an AudioBuffer into WebM (Opus) via MediaStreamAudioDestinationNode + MediaRecorder.
 */
export async function encodeWebm(
  buffer: AudioBuffer,
  bitrateKbps: LossyBitrateKbps = 256,
  onProgress?: (pct: number) => void
): Promise<Blob> {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('MediaRecorder is not supported in this browser for WebM export.');
  }

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/webm')
      ? 'audio/webm'
      : '';

  if (!mimeType) {
    throw new Error('WebM audio encoding is not supported by this browser.');
  }

  return encodeViaMediaRecorder(buffer, mimeType, bitrateKbps, 'WebM', onProgress);
}

export async function exportAudioBufferToFormat(
  rawBuffer: AudioBuffer,
  format: ExportFormat,
  normalize: boolean,
  onProgress?: (pct: number) => void,
  options?: { bitrateKbps?: LossyBitrateKbps }
): Promise<{ blob: Blob; extension: string }> {
  // Normalize in-place because rawBuffer is an ephemeral render from renderNleMixdown
  const buffer = normalize ? normalizeAudioBuffer(rawBuffer, -0.5, true) : rawBuffer;
  const bitrateKbps: LossyBitrateKbps = options?.bitrateKbps ?? 256;
  onProgress?.(0.15);

  if (format === 'wav16') {
    const blob = await encodeWavAsync(buffer, 16, (pct) => onProgress?.(0.15 + pct * 0.85));
    return { blob, extension: 'wav' };
  }
  if (format === 'wav24') {
    const blob = await encodeWavAsync(buffer, 24, (pct) => onProgress?.(0.15 + pct * 0.85));
    return { blob, extension: 'wav' };
  }
  if (format === 'mp3') {
    const blob = await encodeMp3Async(buffer, bitrateKbps, (pct) =>
      onProgress?.(0.15 + pct * 0.85)
    );
    return { blob, extension: 'mp3' };
  }
  if (format === 'aac') {
    return encodeAacAsync(buffer, bitrateKbps, (pct) => onProgress?.(0.15 + pct * 0.85));
  }

  const blob = await encodeWebm(buffer, bitrateKbps, (pct) => onProgress?.(0.15 + pct * 0.85));
  return { blob, extension: 'webm' };
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}
