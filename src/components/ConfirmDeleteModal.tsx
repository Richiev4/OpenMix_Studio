import React, { useEffect, useRef } from 'react';
import { AlertTriangle, Trash2, X } from 'lucide-react';

interface ConfirmDeleteModalProps {
  isOpen: boolean;
  title: string;
  subtitle: string;
  itemLabel: string;
  warningText?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Reusable confirmation modal for destructive track removal actions
 * (deleting a timeline track lane or removing a track from the playlist).
 */
export const ConfirmDeleteModal: React.FC<ConfirmDeleteModalProps> = ({
  isOpen,
  title,
  subtitle,
  itemLabel,
  warningText,
  confirmLabel = 'Delete',
  onConfirm,
  onCancel,
}) => {
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  // Focus the non-destructive Cancel button on open to prevent accidental Enter confirmation.
  useEffect(() => {
    if (!isOpen) return;
    const frameId = requestAnimationFrame(() => {
      cancelBtnRef.current?.focus();
    });
    return () => cancelAnimationFrame(frameId);
  }, [isOpen]);

  // Dismiss on Escape key.
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancelRef.current();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-delete-modal-title"
      aria-describedby="confirm-delete-modal-desc"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onCancel();
        }
      }}
    >
      <div className="w-full max-w-[420px] bg-om-panel border border-white/[0.12] rounded-lg shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-white/[0.08] flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <Trash2 className="w-4 h-4 text-om-danger shrink-0" />
            <div className="min-w-0">
              <h3
                id="confirm-delete-modal-title"
                className="font-display text-base font-semibold text-om-text truncate"
              >
                {title}
              </h3>
              <p id="confirm-delete-modal-desc" className="text-xs text-om-text-subtle mt-0.5">
                {subtitle}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="p-1 text-om-text-subtle hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 flex flex-col gap-4">
          <div className="p-3 rounded-md bg-om-well border border-white/[0.08] flex items-start gap-2.5 text-xs text-om-text-secondary">
            <AlertTriangle className="w-4 h-4 text-om-danger shrink-0 mt-0.5" />
            <div className="min-w-0 flex flex-col gap-1">
              <span className="font-semibold text-om-text break-words">{itemLabel}</span>
              {warningText && <span className="text-om-text-subtle">{warningText}</span>}
            </div>
          </div>

          {/* Actions */}
          <div className="pt-2 border-t border-white/[0.08] flex items-center justify-end gap-2">
            <button
              ref={cancelBtnRef}
              type="button"
              onClick={onCancel}
              className="px-3 py-2 rounded-md bg-om-control hover:bg-om-control-hover border border-white/[0.08] text-om-text text-xs font-medium transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="px-3.5 py-2 rounded-md bg-om-danger/20 hover:bg-om-danger/30 border border-om-danger/50 text-om-danger-soft text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5 shrink-0" />
              <span>{confirmLabel}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
