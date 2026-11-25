import React, { useEffect, useRef, useState } from 'react';
import { AudioWaveform, ChevronDown, ExternalLink, Heart, Info, X } from 'lucide-react';

interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AboutModal: React.FC<AboutModalProps> = ({ isOpen, onClose }) => {
  const [expandedCredits, setExpandedCredits] = useState<Record<'mixxx' | 'qmdsp', boolean>>({
    mixxx: false,
    qmdsp: false,
  });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    setExpandedCredits({ mixxx: false, qmdsp: false });
  }, [isOpen]);

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

  const toggleCredit = (key: 'mixxx' | 'qmdsp') => {
    setExpandedCredits((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="about-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-[520px] bg-om-panel border border-white/[0.12] rounded-lg shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-white/[0.08] flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <Info className="w-4 h-4 text-om-accent shrink-0" />
            <div className="min-w-0">
              <h3
                id="about-modal-title"
                className="font-display text-base font-semibold text-om-text truncate"
              >
                About OpenMix Studio
              </h3>
              <p className="text-xs text-om-text-subtle mt-0.5">
                Non-linear multi-track DJ studio &amp; mix workstation
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 text-om-text-subtle hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 flex flex-col gap-4 text-xs text-om-text-secondary leading-relaxed">
          <p>
            OpenMix Studio is a browser-based non-linear DJ editor featuring pitch-preserving
            time stretching, automated beatmatching, beatgrid editing, transition automation, and
            lossless audio export.
          </p>

          {/* Credits & Acknowledgments */}
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-om-text-subtle">
              <Heart className="w-3.5 h-3.5 text-om-accent shrink-0" />
              <span>Credits &amp; Open-Source Acknowledgments</span>
            </div>

            {/* Mixxx Credit */}
            <div className="rounded-md bg-om-well border border-white/[0.08] overflow-hidden">
              <div className="px-3.5 py-2.5 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => toggleCredit('mixxx')}
                  aria-expanded={expandedCredits.mixxx}
                  className="flex-1 min-w-0 flex items-center gap-2 text-left cursor-pointer group"
                >
                  <ChevronDown
                    className={`w-3.5 h-3.5 text-om-text-subtle group-hover:text-om-text shrink-0 transition-transform ${
                      expandedCredits.mixxx ? 'rotate-180' : ''
                    }`}
                  />
                  <AudioWaveform className="w-4 h-4 text-om-accent shrink-0" />
                  <span className="font-display text-sm font-semibold text-om-text truncate">
                    Mixxx DJ Software
                  </span>
                </button>
                <a
                  href="https://mixxx.org"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] font-medium text-om-accent hover:text-om-accent-bright inline-flex items-center gap-1 transition-colors shrink-0"
                >
                  <span>mixxx.org</span>
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </a>
              </div>

              {expandedCredits.mixxx && (
                <div className="px-3.5 pb-3.5 pt-2 border-t border-white/[0.06] flex flex-col gap-2">
                  <p className="text-xs text-om-text-secondary">
                    Beat detection and constant-tempo grid-ironing in OpenMix Studio are directly
                    inspired by and adapted from{' '}
                    <strong className="text-om-text">Mixxx</strong> — originally created by{' '}
                    <strong className="text-om-text">Tue Haste Andersen</strong> (with{' '}
                    <strong className="text-om-text">Ken Haste Andersen</strong>) and developed by
                    the <strong className="text-om-text">Mixxx Development Team</strong> and
                    open-source contributors.
                  </p>

                  <p className="text-[11px] text-om-text-subtle">
                    Specifically modeled on Mixxx&apos;s{' '}
                    <span className="font-mono">BeatUtils</span> constant-region tempo locking,
                    musical BPM rounding, and sub-millisecond phase alignment pipeline (GPLv2+).
                  </p>
                </div>
              )}
            </div>

            {/* Queen Mary DSP Credit */}
            <div className="rounded-md bg-om-well border border-white/[0.08] overflow-hidden">
              <div className="px-3.5 py-2.5 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => toggleCredit('qmdsp')}
                  aria-expanded={expandedCredits.qmdsp}
                  className="flex-1 min-w-0 flex items-center gap-2 text-left cursor-pointer group"
                >
                  <ChevronDown
                    className={`w-3.5 h-3.5 text-om-text-subtle group-hover:text-om-text shrink-0 transition-transform ${
                      expandedCredits.qmdsp ? 'rotate-180' : ''
                    }`}
                  />
                  <span className="font-semibold text-om-text truncate">
                    Queen Mary DSP (qm-dsp)
                  </span>
                </button>
                <a
                  href="https://github.com/c4dm/qm-dsp"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] font-medium text-om-accent hover:text-om-accent-bright inline-flex items-center gap-1 transition-colors shrink-0"
                >
                  <span>C4DM / QMUL</span>
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </a>
              </div>

              {expandedCredits.qmdsp && (
                <div className="px-3.5 pb-3 pt-2 border-t border-white/[0.06]">
                  <p className="text-[11px] text-om-text-subtle">
                    Complex Spectral Difference onset detection (
                    <span className="font-mono">DetectionFunction</span>) and dynamic-programming
                    beat tracking (<span className="font-mono">TempoTrackV2</span>) used within
                    Mixxx&apos;s analyzer, developed by the Centre for Digital Music at Queen Mary
                    University of London (M. E. P. Davies, C. Landone, and D. P. W. Ellis).
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="pt-2 border-t border-white/[0.08] flex items-center justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-md bg-om-accent hover:bg-om-accent-bright text-om-accent-ink text-xs font-semibold transition-colors cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
