import React, { useEffect, useState } from 'react';
import { AlertTriangle, Download, X } from 'lucide-react';
import { formatTimecode } from '../audio/analysis';
import {
  detectAacSupport,
  estimateCompressedByteSize,
  estimateWavByteSize,
  exportAudioBufferToFormat,
  LOSSY_BITRATE_OPTIONS,
  MAX_RIFF_WAV_BYTES,
  RECOMMENDED_MAX_WAV_BYTES,
  triggerBlobDownload,
} from '../audio/exportUtils';
import { getProjectMixDuration, renderNleMixdown } from '../audio/nleEngine';
import type {
  ExportFormat,
  LossyBitrateKbps,
  NleProjectState,
  TrackAsset,
} from '../types/audio';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  project: NleProjectState;
  assetsMap: Map<string, TrackAsset>;
}

function formatEstimatedSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function isLossyFormat(format: ExportFormat): boolean {
  return format === 'mp3' || format === 'aac' || format === 'webm';
}

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  project,
  assetsMap,
}) => {
  const nleDuration = getProjectMixDuration(project);
  const [format, setFormat] = useState<ExportFormat>('wav24');
  const [bitrateKbps, setBitrateKbps] = useState<LossyBitrateKbps>(320);
  const [normalize, setNormalize] = useState(true);
  const [filename, setFilename] = useState('openmix-mixdown');
  const [rendering, setRendering] = useState(false);
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [aacSupported, setAacSupported] = useState<boolean>(true);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void detectAacSupport().then((res) => {
      if (!cancelled) {
        setAacSupported(res.supported);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const canExportTimeline = nleDuration > 0.05;
  const exportDurationWithTail = canExportTimeline ? nleDuration + 1.2 : 0;
  const isWavFormat = format === 'wav24' || format === 'wav16';
  const showBitrateSelector = isLossyFormat(format);

  const estimatedBytes =
    format === 'wav24'
      ? estimateWavByteSize(exportDurationWithTail, 24)
      : format === 'wav16'
        ? estimateWavByteSize(exportDurationWithTail, 16)
        : estimateCompressedByteSize(exportDurationWithTail, bitrateKbps);

  const exceedsRiffLimit = isWavFormat && estimatedBytes > MAX_RIFF_WAV_BYTES;
  const isLargeWavExport =
    isWavFormat && !exceedsRiffLimit && estimatedBytes > RECOMMENDED_MAX_WAV_BYTES;
  const aacUnavailableSelected = format === 'aac' && !aacSupported;

  const handleExport = async () => {
    if (exceedsRiffLimit || aacUnavailableSelected) return;
    setErrorMsg(null);
    setRendering(true);
    setProgress(0.05);

    try {
      // Allow React to paint the rendering progress state before heavy synchronous graph scheduling
      await new Promise<void>((resolve) => window.setTimeout(resolve, 20));

      const masterBuffer = await renderNleMixdown(project, assetsMap, (p) =>
        setProgress(p * 0.65)
      );

      const { blob, extension } = await exportAudioBufferToFormat(
        masterBuffer,
        format,
        normalize,
        (p) => setProgress(0.65 + p * 0.35),
        { bitrateKbps }
      );

      const cleanName = (filename.trim() || 'openmix-mixdown').replace(/[^a-zA-Z0-9_-]/g, '-');
      triggerBlobDownload(blob, `${cleanName}.${extension}`);
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Export failed unexpectedly.');
    } finally {
      setRendering(false);
      setProgress(0);
    }
  };

  const formatOptions: ReadonlyArray<{
    id: ExportFormat;
    title: string;
    sub: string;
  }> = [
    { id: 'wav24', title: 'WAV 24-bit', sub: 'Lossless PCM' },
    { id: 'wav16', title: 'WAV 16-bit', sub: 'CD Quality' },
    { id: 'mp3', title: 'MP3', sub: `${bitrateKbps} kbps` },
    { id: 'aac', title: 'AAC', sub: aacSupported ? `${bitrateKbps} kbps` : 'Unsupported' },
    { id: 'webm', title: 'WebM Opus', sub: `${bitrateKbps} kbps` },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
      <div className="w-full max-w-[490px] bg-om-panel border border-white/[0.12] rounded-lg shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-white/[0.08] flex items-center justify-between">
          <div>
            <h3 className="font-display text-base font-semibold text-om-text">
              Export Master Mix
            </h3>
            <p className="text-xs text-om-text-subtle mt-0.5">
              Render full NLE mixdown to lossless WAV or compressed MP3, AAC, and WebM
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={rendering}
            className="p-1 text-om-text-subtle hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-4">
          {/* Mix Summary */}
          <div className="p-3 rounded-md bg-om-well border border-white/[0.08] space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-om-text-secondary">Timeline Mixdown Length</span>
              <span className="text-xs font-mono tabular-nums text-om-accent">
                {canExportTimeline ? formatTimecode(nleDuration, true) : 'Empty timeline'}
              </span>
            </div>
            {canExportTimeline && (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-om-text-subtle">Estimated File Size</span>
                <span className="text-[11px] font-mono tabular-nums text-om-text-muted">
                  ~{formatEstimatedSize(estimatedBytes)}
                </span>
              </div>
            )}
          </div>

          {/* Format Selection */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-om-text-secondary">Audio Format</label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {formatOptions.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  disabled={rendering}
                  onClick={() => {
                    setErrorMsg(null);
                    setFormat(opt.id);
                  }}
                  className={`p-2.5 rounded-md border text-left transition-colors cursor-pointer ${
                    format === opt.id
                      ? 'bg-om-control border-om-accent text-om-text'
                      : 'bg-om-well border-white/[0.08] text-om-text-dim hover:border-white/[0.16]'
                  }`}
                >
                  <div className="text-xs font-semibold">{opt.title}</div>
                  <div className="text-[10px] text-om-text-subtle mt-0.5">{opt.sub}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Bitrate Selection for Compressed Formats */}
          {showBitrateSelector && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-om-text-secondary">Bitrate</label>
                <span className="text-[11px] font-mono text-om-text-subtle">
                  {bitrateKbps === 320
                    ? 'Maximum quality'
                    : bitrateKbps === 256
                      ? 'High quality'
                      : bitrateKbps === 192
                        ? 'Balanced'
                        : 'Compact'}
                </span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {LOSSY_BITRATE_OPTIONS.map((kbps) => (
                  <button
                    key={kbps}
                    type="button"
                    disabled={rendering}
                    onClick={() => setBitrateKbps(kbps)}
                    className={`py-2 px-2.5 rounded-md border text-center font-mono text-xs transition-colors cursor-pointer ${
                      bitrateKbps === kbps
                        ? 'bg-om-control border-om-accent text-om-accent font-semibold'
                        : 'bg-om-well border-white/[0.08] text-om-text-dim hover:border-white/[0.16]'
                    }`}
                  >
                    {kbps} kbps
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Filename & Normalization */}
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-om-text-secondary">Output Filename</label>
              <input
                type="text"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                disabled={rendering}
                className="w-full bg-om-base border border-white/[0.1] rounded-md px-3 py-2 text-xs font-mono text-om-text focus:outline-none focus:border-om-accent"
              />
            </div>

            <label className="flex items-center gap-2 text-xs text-om-text-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={normalize}
                disabled={rendering}
                onChange={(e) => setNormalize(e.target.checked)}
                className="accent-om-accent"
              />
              <span>Peak-normalize master output to -0.5 dBFS</span>
            </label>
          </div>

          {aacUnavailableSelected && (
            <div className="p-2.5 rounded bg-om-danger/10 border border-om-danger/40 text-xs text-om-danger-soft flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                AAC encoding is not supported in this browser. Choose <strong>MP3</strong>,{' '}
                <strong>WebM Opus</strong>, or <strong>WAV</strong> instead.
              </span>
            </div>
          )}

          {exceedsRiffLimit && (
            <div className="p-2.5 rounded bg-om-danger/10 border border-om-danger/40 text-xs text-om-danger-soft flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                This mix exceeds the 4 GB standard WAV format limit. Switch to{' '}
                <strong>WAV 16-bit</strong>, <strong>MP3</strong>, or <strong>AAC</strong>, or
                split the timeline into shorter parts to export.
              </span>
            </div>
          )}

          {isLargeWavExport && (
            <div className="p-2.5 rounded bg-om-accent/10 border border-om-accent/35 text-xs text-om-accent-soft flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-om-accent" />
              <span>
                Large WAV export (~{formatEstimatedSize(estimatedBytes)}). If your browser runs low
                on memory, try <strong>WAV 16-bit</strong>, <strong>MP3</strong>, or{' '}
                <strong>AAC</strong>.
              </span>
            </div>
          )}

          {errorMsg && (
            <div className="p-2.5 rounded bg-om-danger/10 border border-om-danger/40 text-xs text-om-danger-soft">
              {errorMsg}
            </div>
          )}

          {rendering && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-[11px] font-mono text-om-text-muted">
                <span>Rendering mixdown...</span>
                <span>{Math.round(progress * 100)}%</span>
              </div>
              <div className="w-full h-1.5 bg-om-base rounded-full overflow-hidden">
                <div
                  className="h-full bg-om-accent transition-all duration-150"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3.5 bg-om-footer border-t border-white/[0.08] flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={rendering}
            className="px-4 py-2 rounded-md text-xs font-medium text-om-text-muted hover:text-white cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={
              rendering || !canExportTimeline || exceedsRiffLimit || aacUnavailableSelected
            }
            onClick={handleExport}
            className="px-4 py-2 rounded-md bg-om-accent hover:bg-om-accent-bright text-om-accent-ink text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Download className="w-3.5 h-3.5" />
            {rendering ? 'Rendering...' : 'Render & Download'}
          </button>
        </div>
      </div>
    </div>
  );
};
