import React, { useRef } from 'react';
import { AlertTriangle, CheckCircle2, FileAudio, FolderOpen, RefreshCw, X } from 'lucide-react';
import { formatFileSize, formatTimecode } from '../audio/analysis';
import type { MissingTrackInfo, SavedProjectManifest, SerializedTrackRef } from '../types/audio';

interface RelinkTracksModalProps {
  isOpen: boolean;
  manifest: SavedProjectManifest | null;
  pendingHandleName: string | null;
  missingTracks: MissingTrackInfo[];
  resolvedCount: number;
  isProcessing: boolean;
  progressText: string | null;
  onGrantFolderPermission: () => void;
  onChooseFolder: () => void;
  onLocateSingleTrack: (trackRef: SerializedTrackRef, file: File) => void;
  onContinueWithPartial: () => void;
  onClose: () => void;
}

export const RelinkTracksModal: React.FC<RelinkTracksModalProps> = ({
  isOpen,
  manifest,
  pendingHandleName,
  missingTracks,
  resolvedCount,
  isProcessing,
  progressText,
  onGrantFolderPermission,
  onChooseFolder,
  onLocateSingleTrack,
  onContinueWithPartial,
  onClose,
}) => {
  const singleFileInputRef = useRef<HTMLInputElement | null>(null);
  const targetTrackRef = useRef<SerializedTrackRef | null>(null);

  if (!isOpen || !manifest) return null;

  const totalRefs = manifest.trackRefs.length;

  const handleSingleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const ref = targetTrackRef.current;
    e.target.value = '';
    targetTrackRef.current = null;
    if (file && ref) {
      onLocateSingleTrack(ref, file);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
      <input
        ref={singleFileInputRef}
        type="file"
        accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aac,.webm"
        onChange={handleSingleFileChange}
        className="hidden"
      />

      <div className="w-full max-w-[540px] bg-om-panel border border-white/[0.12] rounded-lg shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-white/[0.08] flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h3 className="font-display text-base font-semibold text-om-text truncate">
              Load &ldquo;{manifest.projectName}&rdquo;
            </h3>
            <p className="text-xs text-om-text-subtle mt-0.5">
              {pendingHandleName
                ? 'Reconnect your DJ Folder to read referenced tracks locally from disk'
                : 'Point to your DJ Folder or locate audio files locally (files never leave your device)'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isProcessing}
            className="p-1 text-om-text-subtle hover:text-white cursor-pointer disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 flex flex-col gap-4">
          {/* Status Summary */}
          <div className="p-3 rounded-md bg-om-well border border-white/[0.08] flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 text-om-text-secondary">
              {missingTracks.length === 0 ? (
                <CheckCircle2 className="w-4 h-4 text-om-positive shrink-0" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-om-accent shrink-0" />
              )}
              <span>
                {resolvedCount} of {totalRefs} referenced {totalRefs === 1 ? 'track' : 'tracks'} ready
              </span>
            </div>
            {manifest.djFolderName && (
              <span className="font-mono text-[11px] text-om-text-dim truncate max-w-[200px]">
                Saved Folder: {manifest.djFolderName}
              </span>
            )}
          </div>

          {/* Persisted Handle Permission Prompt */}
          {pendingHandleName && (
            <div className="p-3.5 rounded-md bg-om-elevated border border-om-accent/40 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-om-text truncate">
                  Linked DJ Folder: {pendingHandleName}
                </p>
                <p className="text-[11px] text-om-text-dim mt-0.5">
                  Browsers require one click per session to re-authorize local folder read access.
                </p>
              </div>
              <button
                type="button"
                disabled={isProcessing}
                onClick={onGrantFolderPermission}
                className="px-3 py-2 rounded-md bg-om-accent hover:bg-om-accent-bright text-om-accent-ink text-xs font-semibold inline-flex items-center gap-1.5 shrink-0 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Reconnect
              </button>
            </div>
          )}

          {/* Missing Track List */}
          {missingTracks.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-om-text-secondary">
                  Unlinked Tracks ({missingTracks.length})
                </span>
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={onChooseFolder}
                  title={`Scan your DJ Folder locally. Your browser may say "Upload" on the next screen. Please be assured that this only "Uploads/Indexes" data to this app's local database — everything stays local.`}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-om-control-alt hover:bg-om-control-hover border border-white/[0.1] text-[11px] font-medium text-om-text cursor-pointer disabled:opacity-50"
                >
                  <FolderOpen className="w-3.5 h-3.5 text-om-accent" />
                  Scan DJ Folder
                </button>
              </div>

              <div className="max-h-56 overflow-y-auto divide-y divide-white/[0.06] rounded-md border border-white/[0.08] bg-om-base">
                {missingTracks.map(({ trackRef, reason }) => (
                  <div
                    key={trackRef.id}
                    className="px-3 py-2.5 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <FileAudio className="w-3.5 h-3.5 text-om-text-dim shrink-0" />
                        <span className="text-xs font-medium text-om-text truncate">
                          {trackRef.fileName}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[10px] font-mono text-om-text-faint truncate">
                        {trackRef.relativePath ? `${trackRef.relativePath} · ` : ''}
                        {formatFileSize(trackRef.fileSize)} · {formatTimecode(trackRef.duration)} ·{' '}
                        {trackRef.bpm.toFixed(1)} BPM
                        {reason === 'decode-error' ? ' · Decode failed' : ''}
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={isProcessing}
                      onClick={() => {
                        targetTrackRef.current = trackRef;
                        singleFileInputRef.current?.click();
                      }}
                      className="px-2.5 py-1 rounded bg-om-card hover:bg-om-accent text-om-text-secondary hover:text-om-accent-ink border border-white/[0.08] text-[11px] font-medium transition-colors shrink-0 cursor-pointer disabled:opacity-50"
                    >
                      Locate File
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {isProcessing && progressText && (
            <div className="p-2.5 rounded bg-om-well border border-white/[0.08] text-xs font-mono text-om-accent truncate">
              {progressText}
            </div>
          )}
          {/* Clarify browser native webkitdirectory "Upload" dialog wording */}
          <p className="text-[11px] text-om-text-faint leading-relaxed">
            Your browser may say{' '}
            <span className="font-medium text-om-text-secondary">&ldquo;Upload&rdquo;</span> on the
            next screen. Please be assured that this only{' '}
            <span className="font-medium text-om-text-secondary">
              &ldquo;Uploads/Indexes&rdquo;
            </span>{' '}
            data to this app&rsquo;s local database &mdash; everything stays local.
          </p>
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 bg-om-footer border-t border-white/[0.08] flex items-center justify-between gap-2">
          <button
            type="button"
            disabled={isProcessing}
            onClick={onChooseFolder}
            title={`Select your DJ Folder locally. Your browser may say "Upload" on the next screen. Please be assured that this only "Uploads/Indexes" data to this app's local database — everything stays local.`}
            className="px-3 py-2 rounded-md bg-om-control hover:bg-om-control-hover border border-white/[0.08] text-xs font-medium text-om-text inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <FolderOpen className="w-3.5 h-3.5 text-om-accent" />
            Select DJ Folder
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isProcessing}
              className="px-3 py-2 rounded-md text-xs font-medium text-om-text-muted hover:text-white cursor-pointer disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isProcessing}
              onClick={onContinueWithPartial}
              className="px-4 py-2 rounded-md bg-om-accent hover:bg-om-accent-bright text-om-accent-ink text-xs font-semibold cursor-pointer disabled:opacity-40"
            >
              {missingTracks.length > 0 ? 'Open Anyway' : 'Open Project'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
