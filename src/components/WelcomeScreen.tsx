import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  FolderOpen,
  FolderSync,
  Loader2,
  RotateCcw,
} from 'lucide-react';

export type WelcomeDjFolderStatus = 'checking' | 'ok' | 'needs-permission' | 'not-linked';

interface WelcomeScreenProps {
  pendingAutosaveName?: string | null;
  pendingAutosaveTrackCount?: number;
  djFolderStatus: WelcomeDjFolderStatus;
  djFolderName?: string | null;
  djFolderFileCount?: number;
  onLinkDjFolder: () => void;
  onReconnectDjFolder?: () => void;
  onEnterStudio: () => void;
  onLoadMix: () => void;
  onResumeAutosave?: () => void;
}

const WELCOME_LOGO_SRC = '/assets/aistudio/OpenMixStudioLogo_new_69f73222.jpeg';

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  pendingAutosaveName,
  pendingAutosaveTrackCount = 0,
  djFolderStatus,
  djFolderName,
  djFolderFileCount = 0,
  onLinkDjFolder,
  onReconnectDjFolder,
  onEnterStudio,
  onLoadMix,
  onResumeAutosave,
}) => {
  const [isExiting, setIsExiting] = useState(false);
  const [imageError, setImageError] = useState(false);
  const isExitingRef = useRef(false);
  const dismissTimerRef = useRef<number | null>(null);

  const dismissWith = useCallback((action: () => void) => {
    if (isExitingRef.current) return;
    isExitingRef.current = true;
    setIsExiting(true);
    dismissTimerRef.current = window.setTimeout(() => {
      dismissTimerRef.current = null;
      action();
    }, 240);
  }, []);

  const handleEnter = useCallback(() => {
    dismissWith(onEnterStudio);
  }, [dismissWith, onEnterStudio]);

  const handleEnterRef = useRef(handleEnter);
  handleEnterRef.current = handleEnter;

  const handleLoad = useCallback(() => {
    onLoadMix();
    dismissWith(onEnterStudio);
  }, [dismissWith, onEnterStudio, onLoadMix]);

  const handleResume = useCallback(() => {
    if (!onResumeAutosave) return;
    dismissWith(() => {
      onEnterStudio();
      onResumeAutosave();
    });
  }, [dismissWith, onEnterStudio, onResumeAutosave]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === 'Enter' &&
        event.target instanceof HTMLButtonElement &&
        event.target.dataset.welcomeAction !== 'enter'
      ) {
        return;
      }
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault();
        handleEnterRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (dismissTimerRef.current !== null) {
        window.clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
    };
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to OpenMix Studio"
      className={`fixed inset-0 z-[100] flex flex-col items-center justify-between bg-[#171A21] text-om-text select-none overflow-hidden transition-[opacity,transform] duration-250 ease-out ${
        isExiting ? 'opacity-0 scale-[1.02] pointer-events-none' : 'opacity-100 scale-100'
      }`}
    >
      {/* Subtle radial ambient glow matching the studio backdrop */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(34,228,255,0.05)_0%,rgba(23,26,33,0.85)_65%,rgba(19,22,28,1)_100%)]"
      />

      {/* Centered Hero Logo Stage with smooth slight zoom-in on arrival */}
      <div className="relative z-10 flex-1 min-h-0 w-full flex items-center justify-center px-6 pt-8 pb-4 overflow-hidden">
        {!imageError ? (
          <div className="relative w-full max-w-5xl max-h-full aspect-video flex items-center justify-center overflow-hidden rounded-2xl">
            <img
              src={WELCOME_LOGO_SRC}
              alt="OpenMix Studio — The Open-Source NLE DJ Studio"
              referrerPolicy="no-referrer"
              onError={() => setImageError(true)}
              className="w-full h-full object-contain om-welcome-zoom"
            />
            {/* Edge feathering scrim so the artwork melts seamlessly into the dark canvas */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 shadow-[inset_0_0_80px_36px_#171A21]"
            />
          </div>
        ) : (
          <div className="om-welcome-zoom flex flex-col items-center justify-center text-center px-8 py-12">
            <h1 className="font-display text-4xl md:text-6xl font-bold tracking-tight text-white">
              OpenMix Studio
            </h1>
            <p className="mt-3 text-sm tracking-widest uppercase text-slate-400">
              The Open-Source NLE DJ Studio
            </p>
          </div>
        )}
      </div>

      {/* Bottom Action Bar */}
      <div className="relative z-10 w-full px-6 pb-10 pt-2 flex flex-col items-center gap-4 om-welcome-actions">
        {/* DJ Folder Link Status Check */}
        <div
          role="status"
          aria-live="polite"
          className={`flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1.5 rounded-lg border px-3.5 py-2 text-xs transition-colors ${
            djFolderStatus === 'ok'
              ? 'bg-emerald-500/10 border-emerald-400/30 text-emerald-200'
              : djFolderStatus === 'checking'
              ? 'bg-white/[0.04] border-white/[0.1] text-slate-300'
              : 'bg-amber-500/10 border-amber-400/30 text-amber-200'
          }`}
        >
          {djFolderStatus === 'checking' && (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400 shrink-0" />
              <span>Checking DJ Folder...</span>
            </>
          )}

          {djFolderStatus === 'ok' && (
            <>
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="font-medium text-emerald-100">DJ Folder is OK</span>
              {djFolderName && (
                <span className="text-emerald-200/75 font-mono text-[11px] max-w-[260px] truncate">
                  · {djFolderName}
                  {djFolderFileCount > 0
                    ? ` (${djFolderFileCount} ${djFolderFileCount === 1 ? 'track' : 'tracks'})`
                    : ''}
                </span>
              )}
            </>
          )}

          {djFolderStatus === 'needs-permission' && (
            <>
              <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span className="font-medium text-amber-100">DJ Folder is not linked</span>
              {djFolderName && (
                <span className="text-amber-200/75 font-mono text-[11px] max-w-[220px] truncate">
                  ({djFolderName} needs access)
                </span>
              )}
              {onReconnectDjFolder && (
                <button
                  type="button"
                  onClick={onReconnectDjFolder}
                  className="ml-1 px-2.5 py-1 rounded bg-amber-400/20 hover:bg-amber-400/30 border border-amber-400/40 text-amber-100 text-[11px] font-medium inline-flex items-center gap-1 transition-colors cursor-pointer"
                >
                  <FolderSync className="w-3 h-3 shrink-0" />
                  <span>Reconnect</span>
                </button>
              )}
              <button
                type="button"
                onClick={onLinkDjFolder}
                className="px-2.5 py-1 rounded bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.12] text-slate-200 text-[11px] font-medium transition-colors cursor-pointer"
              >
                Change Folder
              </button>
            </>
          )}

          {djFolderStatus === 'not-linked' && (
            <>
              <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span className="font-medium text-amber-100">DJ Folder is not linked</span>
              <button
                type="button"
                onClick={onLinkDjFolder}
                className="ml-1 px-2.5 py-1 rounded bg-amber-400/20 hover:bg-amber-400/30 border border-amber-400/40 text-amber-100 text-[11px] font-medium inline-flex items-center gap-1 transition-colors cursor-pointer"
              >
                <FolderOpen className="w-3 h-3 shrink-0" />
                <span>Link DJ Folder</span>
              </button>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            autoFocus
            data-welcome-action="enter"
            onClick={handleEnter}
            className="min-h-[42px] px-6 py-2.5 rounded-lg bg-[#22E4FF] hover:bg-[#67F0FF] active:scale-[0.99] text-[#06111A] font-display text-sm font-semibold tracking-tight inline-flex items-center gap-2 transition-[background-color,transform] duration-150 cursor-pointer whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#22E4FF]"
          >
            <span>Enter Studio</span>
            <ArrowRight className="w-4 h-4 shrink-0" />
          </button>

          <button
            type="button"
            onClick={handleLoad}
            className="min-h-[42px] px-5 py-2.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.11] border border-white/[0.12] text-slate-100 text-sm font-medium inline-flex items-center gap-2 transition-colors duration-150 cursor-pointer whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60"
          >
            <FolderOpen className="w-4 h-4 text-[#22E4FF] shrink-0" />
            <span>Load Mix</span>
          </button>

          {pendingAutosaveName && onResumeAutosave && (
            <button
              type="button"
              onClick={handleResume}
              className="min-h-[42px] px-5 py-2.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.09] border border-[#22E4FF]/30 text-slate-200 text-sm font-medium inline-flex items-center gap-2 transition-colors duration-150 cursor-pointer whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#22E4FF]"
            >
              <RotateCcw className="w-4 h-4 text-[#22E4FF] shrink-0" />
              <span className="max-w-[220px] truncate">
                Resume {pendingAutosaveName}
                {pendingAutosaveTrackCount > 0 ? ` (${pendingAutosaveTrackCount})` : ''}
              </span>
            </button>
          )}
        </div>

        <p className="text-xs text-slate-500">
          Press Enter to open workspace
        </p>
      </div>
    </div>
  );
};
