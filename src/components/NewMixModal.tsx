import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, FilePlus2, FileText, Save, Trash2, X } from 'lucide-react';

interface NewMixModalProps {
  isOpen: boolean;
  currentProjectName: string;
  trackCount: number;
  clipCount: number;
  onSaveAndNew: (saveName: string, alsoExportPlaylistTxt: boolean) => void;
  onDiscardAndNew: () => void;
  onClose: () => void;
}

export const NewMixModal: React.FC<NewMixModalProps> = ({
  isOpen,
  currentProjectName,
  trackCount,
  clipCount,
  onSaveAndNew,
  onDiscardAndNew,
  onClose,
}) => {
  const [mixName, setMixName] = useState(currentProjectName);
  const [alsoExportTxt, setAlsoExportTxt] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    setMixName(currentProjectName);
    setAlsoExportTxt(false);
    const frameId = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frameId);
  }, [isOpen, currentProjectName]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSaveAndNew(mixName.trim() || 'Untitled Mix', alsoExportTxt && trackCount > 0);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-mix-modal-title"
    >
      <div className="w-full max-w-[460px] bg-om-panel border border-white/[0.12] rounded-lg shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-white/[0.08] flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <FilePlus2 className="w-4 h-4 text-om-accent shrink-0" />
            <div className="min-w-0">
              <h3
                id="new-mix-modal-title"
                className="font-display text-base font-semibold text-om-text truncate"
              >
                Start a New Mix?
              </h3>
              <p className="text-xs text-om-text-subtle mt-0.5">
                This will clear all timeline clips and empty the current playlist.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cancel"
            className="p-1 text-om-text-subtle hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 flex flex-col gap-4">
          {/* Current Mix Summary */}
          <div className="p-3 rounded-md bg-om-well border border-white/[0.08] flex items-center gap-2.5 text-xs text-om-text-secondary">
            <AlertTriangle className="w-4 h-4 text-om-accent shrink-0" />
            <span>
              Current workspace has{' '}
              <strong className="text-om-text">
                {clipCount} {clipCount === 1 ? 'clip' : 'clips'}
              </strong>{' '}
              and{' '}
              <strong className="text-om-text">
                {trackCount} playlist {trackCount === 1 ? 'track' : 'tracks'}
              </strong>
              .
            </span>
          </div>

          {/* Mix Name Input */}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="new-mix-save-name"
              className="text-xs font-medium text-om-text-secondary"
            >
              Save current mix as
            </label>
            <input
              ref={inputRef}
              id="new-mix-save-name"
              type="text"
              value={mixName}
              onChange={(e) => setMixName(e.target.value)}
              placeholder="Untitled Mix"
              className="w-full bg-om-base border border-white/[0.12] focus:border-om-accent/80 rounded-md px-3 py-2 text-xs text-om-text focus:outline-none"
            />
            <p className="text-[11px] text-om-text-subtle">
              Downloads a lightweight <span className="font-mono">.openmix.json</span> project file
              containing your playlist and timeline arrangement.
            </p>
          </div>

          {/* Optional Playlist .txt Export */}
          {trackCount > 0 && (
            <label className="flex items-center gap-2.5 text-xs text-om-text-secondary cursor-pointer select-none">
              <input
                type="checkbox"
                checked={alsoExportTxt}
                onChange={(e) => setAlsoExportTxt(e.target.checked)}
                className="rounded border-white/20 bg-om-base accent-om-accent cursor-pointer"
              />
              <FileText className="w-3.5 h-3.5 text-om-secondary shrink-0" />
              <span>Also export playlist tracklist (.txt)</span>
            </label>
          )}

          {/* Actions */}
          <div className="pt-2 border-t border-white/[0.08] flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={onDiscardAndNew}
              className="px-3 py-2 rounded-md bg-om-danger/15 hover:bg-om-danger/25 border border-om-danger/40 text-om-danger-soft text-xs font-medium inline-flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5 shrink-0" />
              <span>Discard &amp; Clear</span>
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-2 rounded-md bg-om-control hover:bg-om-control-hover border border-white/[0.08] text-om-text text-xs font-medium transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-3.5 py-2 rounded-md bg-om-accent hover:bg-om-accent-bright text-om-accent-ink text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <Save className="w-3.5 h-3.5 shrink-0" />
                <span>Save &amp; New Mix</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
