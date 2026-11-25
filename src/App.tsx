import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Download,
  FilePlus2,
  FileText,
  FolderOpen,
  HelpCircle,
  Info,
  Palette,
  PanelBottomClose,
  PanelBottomOpen,
  PanelTopClose,
  PanelTopOpen,
  RotateCcw,
  Save,
} from 'lucide-react';
import {
  analyzeAudioBufferMeta,
  analyzeAudioFileMeta,
  decodeAndAnalyzeFile,
  detectBeatOffsetForBuffer,
  getCamelotForKey,
} from './audio/analysis';
import { DEFAULT_MASTER_VOLUME, getProjectMixDuration, nleEngine } from './audio/nleEngine';
import { integrateClipSourceOffsetSec, syncTempoMapToTimeline } from './audio/tempoMap';
import { AboutModal } from './components/AboutModal';
import { BeatgridEditorModal } from './components/BeatgridEditorModal';
import { ConfirmDeleteModal } from './components/ConfirmDeleteModal';
import { ExportModal } from './components/ExportModal';
import { HelpModal } from './components/HelpModal';
import { DjFolderPanel } from './components/DjFolderPanel';
import { NewMixModal } from './components/NewMixModal';
import { NleTimeline } from './components/NleTimeline';
import { RelinkTracksModal } from './components/RelinkTracksModal';
import { TrackCrate } from './components/TrackCrate';
import { WelcomeScreen, type WelcomeDjFolderStatus } from './components/WelcomeScreen';
import {
  type DirectoryHandleLike,
  DjFolderPickerUnavailableError,
  diffFolderSnapshots,
  getFolderFileCacheKey,
  hydrateFolderFilesWithCache,
  loadDjFolderHandle,
  loadDjFolderSnapshot,
  pickDjFolderHandle,
  saveCachedTrackAnalysis,
  saveDjFolderSnapshot,
  scanDirectoryHandle,
  scanFileListFromDirectoryInput,
  verifyFolderPermission,
} from './storage/djFolder';
import {
  clearAutosaveManifest,
  downloadPlaylistText,
  downloadProjectManifest,
  loadAutosaveManifest,
  matchTrackRefsToFolderFiles,
  parseProjectManifestFile,
  saveAutosaveManifest,
  serializeProjectManifest,
} from './storage/projectStorage';
import {
  applyPresetToClipMix,
  computeAutoMixPlacement,
  computeBeatAlignedOverlap,
  DEFAULT_AUTO_MIX_OPTIONS,
  detectClipMixPreset,
  findClipById,
  findIncomingMixContext,
  findPreviousClip,
  resolveAutoMixDefaults,
  syncPairedMixOnClipMove,
} from './audio/mixTransitions';
import type {
  AutomationLane,
  AutomationParam,
  ClipMixEnvelope,
  DjFolderDiffSummary,
  FolderAudioFile,
  MissingTrackInfo,
  MixPresetId,
  NleClip,
  NleProjectState,
  NleTrack,
  SavedProjectManifest,
  SerializedTrackRef,
  TrackAsset,
} from './types/audio';
import { THEME_LIST, ThemeProvider, useTheme } from './theme/themes';

const TRACK_ACCENTS = ['#F59E0B', '#06B6D4', '#10B981', '#A78BFA', '#F472B6'];

function createDefaultAutomationLanes(): Record<AutomationParam, AutomationLane> {
  return {
    volume: { param: 'volume', visible: true, points: [] },
    pan: { param: 'pan', visible: false, points: [] },
    filterCutoff: { param: 'filterCutoff', visible: false, points: [] },
    fxWet: { param: 'fxWet', visible: false, points: [] },
    speed: { param: 'speed', visible: false, points: [] },
  };
}

function createNleTrack(index: number): NleTrack {
  return {
    id: `lane_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 6)}`,
    name: `Track ${index + 1}`,
    accentColor: TRACK_ACCENTS[index % TRACK_ACCENTS.length],
    volume: 0.9,
    pan: 0,
    muted: false,
    soloed: false,
    showEffects: false,
    showAutomation: false,
    activeAutomationParam: 'volume',
    effects: {
      filterEnabled: false,
      filterValue: 0,
      filterResonance: 1.2,
      eqLow: 0,
      eqMid: 0,
      eqHigh: 0,
      delayEnabled: false,
      delayTimeSec: 0.375,
      delayFeedback: 0.35,
      delayWet: 0.25,
      reverbEnabled: false,
      reverbSize: 1.8,
      reverbWet: 0.22,
      driveEnabled: false,
      driveAmount: 0.15,
    },
    automationLanes: createDefaultAutomationLanes(),
    clips: [],
  };
}

function reorderPlaylistByTimeline(
  currentTracks: TrackAsset[],
  timelineLanes: NleTrack[]
): TrackAsset[] {
  if (currentTracks.length <= 1) return currentTracks;

  const earliestPosByTrackId = new Map<string, { startSec: number; laneIdx: number }>();
  timelineLanes.forEach((lane, laneIdx) => {
    for (const clip of lane.clips) {
      const existing = earliestPosByTrackId.get(clip.trackAssetId);
      if (
        !existing ||
        clip.startSec < existing.startSec - 1e-4 ||
        (Math.abs(clip.startSec - existing.startSec) <= 1e-4 && laneIdx < existing.laneIdx)
      ) {
        earliestPosByTrackId.set(clip.trackAssetId, {
          startSec: clip.startSec,
          laneIdx,
        });
      }
    }
  });

  if (earliestPosByTrackId.size === 0) return currentTracks;

  const originalIndex = new Map<string, number>();
  currentTracks.forEach((t, idx) => originalIndex.set(t.id, idx));

  const sorted = [...currentTracks].sort((a, b) => {
    const posA = earliestPosByTrackId.get(a.id);
    const posB = earliestPosByTrackId.get(b.id);
    if (posA && posB) {
      if (Math.abs(posA.startSec - posB.startSec) > 1e-4) {
        return posA.startSec - posB.startSec;
      }
      if (posA.laneIdx !== posB.laneIdx) {
        return posA.laneIdx - posB.laneIdx;
      }
      return (originalIndex.get(a.id) ?? 0) - (originalIndex.get(b.id) ?? 0);
    }
    if (posA) return -1;
    if (posB) return 1;
    return (originalIndex.get(a.id) ?? 0) - (originalIndex.get(b.id) ?? 0);
  });

  const changed = sorted.some(
    (t, idx) => t.id !== currentTracks[idx].id || t.orderIndex !== idx
  );
  if (!changed) return currentTracks;
  return sorted.map((t, idx) => ({ ...t, orderIndex: idx }));
}

function AppStudio() {
  const { themeId, theme, setThemeId } = useTheme();
  const [projectName, setProjectName] = useState('Untitled Mix');
  const [tracks, setTracks] = useState<TrackAsset[]>([]);
  const [importingCount, setImportingCount] = useState(0);
  const [importError, setImportError] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [showWelcome, setShowWelcome] = useState(true);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [newMixModalOpen, setNewMixModalOpen] = useState(false);
  const [aboutModalOpen, setAboutModalOpen] = useState(false);
  const [helpModalOpen, setHelpModalOpen] = useState(false);
  const [pendingDeleteTarget, setPendingDeleteTarget] = useState<
    { kind: 'playlist'; trackId: string } | { kind: 'timeline'; trackId: string } | null
  >(null);
  const [beatgridEditorTarget, setBeatgridEditorTarget] = useState<{
    trackId: string;
    initialBpm: number;
    initialKey: string;
  } | null>(null);
  const [mixMenuOpen, setMixMenuOpen] = useState(false);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);

  // Linked DJ Folder state & background pre-analysis queue
  const [djFolderHandle, setDjFolderHandle] = useState<DirectoryHandleLike | null>(null);
  const [djFolderName, setDjFolderName] = useState<string | null>(null);
  const [djFolderFiles, setDjFolderFiles] = useState<FolderAudioFile[]>([]);
  const [folderNeedsPermission, setFolderNeedsPermission] = useState(false);
  const [djFolderChecked, setDjFolderChecked] = useState(false);
  const [djFolderVerified, setDjFolderVerified] = useState(false);
  const [folderDiffSummary, setFolderDiffSummary] = useState<DjFolderDiffSummary | null>(null);
  const [isAnalyzingFolder, setIsAnalyzingFolder] = useState(false);
  const [folderAnalysisProgress, setFolderAnalysisProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [isRescanningPlaylist, setIsRescanningPlaylist] = useState(false);
  const [playlistRescanProgress, setPlaylistRescanProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const folderAnalysisSessionRef = useRef(0);
  const playlistRescanSessionRef = useRef(0);
  const djFolderFilesRef = useRef<FolderAudioFile[]>([]);
  djFolderFilesRef.current = djFolderFiles;
  const startFolderAnalysisRef = useRef<
    (filesOverride?: FolderAudioFile[], forceRescan?: boolean) => void
  >(() => {});

  // Autosave resume banner
  const [pendingAutosave, setPendingAutosave] = useState<SavedProjectManifest | null>(null);

  // Project Load / Relink Modal state
  const [relinkModalOpen, setRelinkModalOpen] = useState(false);
  const [pendingManifest, setPendingManifest] = useState<SavedProjectManifest | null>(null);
  const [pendingHandleForModal, setPendingHandleForModal] = useState<DirectoryHandleLike | null>(null);
  const [relinkResolvedMap, setRelinkResolvedMap] = useState<Map<string, TrackAsset>>(new Map());
  const [relinkMissingTracks, setRelinkMissingTracks] = useState<MissingTrackInfo[]>([]);
  const [relinkProcessing, setRelinkProcessing] = useState(false);
  const [relinkProgressText, setRelinkProgressText] = useState<string | null>(null);
  const [topPaneHeightPx, setTopPaneHeightPx] = useState<number>(276);
  const [djFolderWidthPx, setDjFolderWidthPx] = useState<number>(460);
  const [djFolderCollapsed, setDjFolderCollapsed] = useState(false);
  const [playlistCollapsed, setPlaylistCollapsed] = useState(false);
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);
  const [autoOrderPlaylist, setAutoOrderPlaylist] = useState(true);
  const [previewTrackId, setPreviewTrackId] = useState<string | null>(null);
  const [previewTimeSec, setPreviewTimeSec] = useState(0);
  const previewTrackIdRef = useRef<string | null>(null);
  previewTrackIdRef.current = previewTrackId;

  const loadProjectInputRef = useRef<HTMLInputElement | null>(null);
  const directoryFallbackInputRef = useRef<HTMLInputElement | null>(null);
  const directoryFallbackModeRef = useRef<'crate' | 'relink'>('crate');
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const mixMenuRef = useRef<HTMLDivElement | null>(null);
  const themeMenuRef = useRef<HTMLDivElement | null>(null);

  const [nleProject, setNleProject] = useState<NleProjectState>(() => ({
    masterBpm: 124,
    masterVolume: DEFAULT_MASTER_VOLUME,
    showTempoLane: false,
    showBeatMarkers: true,
    tempoPoints: [],
    snapMode: 'bar',
    rippleMove: true,
    zoomPxPerSec: 28,
    playheadSec: 0,
    isPlaying: false,
    loopEnabled: false,
    loopStartSec: 0,
    loopEndSec: 32,
    defaultMixOptions: { ...DEFAULT_AUTO_MIX_OPTIONS },
    tracks: [createNleTrack(0), createNleTrack(1), createNleTrack(2)],
  }));

  const assetsMap = useMemo(() => {
    const map = new Map<string, TrackAsset>();
    for (const t of tracks) map.set(t.id, t);
    return map;
  }, [tracks]);

  const timelineTrackCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const lane of nleProject.tracks) {
      for (const clip of lane.clips) {
        counts.set(clip.trackAssetId, (counts.get(clip.trackAssetId) ?? 0) + 1);
      }
    }
    return counts;
  }, [nleProject.tracks]);

  const timelineMixInfo = useMemo(() => {
    const info = new Map<
      string,
      {
        trackId: string;
        clipId: string;
        presetId: MixPresetId;
        startSec: number;
        mixWindows: Array<{ startSec: number; endSec: number }>;
      }
    >();
    for (const lane of nleProject.tracks) {
      for (const clip of lane.clips) {
        const ctx = findIncomingMixContext(nleProject.tracks, lane.id, clip);
        if (!ctx) continue;
        const mixWindow =
          ctx.overlapSec > 0.01
            ? { startSec: clip.startSec, endSec: clip.startSec + ctx.overlapSec }
            : null;
        const existing = info.get(clip.trackAssetId);
        if (!existing) {
          info.set(clip.trackAssetId, {
            trackId: lane.id,
            clipId: clip.id,
            presetId: detectClipMixPreset(clip, ctx.pairedPrevClip),
            startSec: clip.startSec,
            mixWindows: mixWindow ? [mixWindow] : [],
          });
        } else {
          if (mixWindow) existing.mixWindows.push(mixWindow);
          if (clip.startSec < existing.startSec) {
            existing.trackId = lane.id;
            existing.clipId = clip.id;
            existing.presetId = detectClipMixPreset(clip, ctx.pairedPrevClip);
            existing.startSec = clip.startSec;
          }
        }
      }
    }
    return info;
  }, [nleProject.tracks]);

  const activeMixTrackIds = useMemo(() => {
    const active = new Set<string>();
    const playhead = nleProject.playheadSec;
    for (const [trackAssetId, item] of timelineMixInfo) {
      if (
        item.mixWindows.some((w) => playhead >= w.startSec && playhead <= w.endSec)
      ) {
        active.add(trackAssetId);
      }
    }
    return active;
  }, [timelineMixInfo, nleProject.playheadSec]);

  const playingTrackProgress = useMemo(() => {
    const progressMap = new Map<string, number>();
    if (!nleProject.isPlaying) return progressMap;
    const hasSolo = nleProject.tracks.some((lane) => lane.soloed);
    const playhead = nleProject.playheadSec;
    for (const lane of nleProject.tracks) {
      if (hasSolo ? !lane.soloed : lane.muted) continue;
      for (const clip of lane.clips) {
        if (clip.durationSec <= 0) continue;
        if (playhead >= clip.startSec && playhead <= clip.startSec + clip.durationSec) {
          const progress = Math.max(
            0,
            Math.min(1, (playhead - clip.startSec) / clip.durationSec)
          );
          const prev = progressMap.get(clip.trackAssetId);
          if (prev === undefined || progress > prev) {
            progressMap.set(clip.trackAssetId, progress);
          }
        }
      }
    }
    return progressMap;
  }, [nleProject.isPlaying, nleProject.playheadSec, nleProject.tracks]);

  const assetsMapRef = useRef(assetsMap);
  const nleProjectRef = useRef(nleProject);
  const tracksRef = useRef(tracks);
  const playheadAnchorSecRef = useRef(0);
  const commitTempoTimerRef = useRef<number | null>(null);
  const seekRestartTimerRef = useRef<number | null>(null);
  const pendingSeekSecRef = useRef<number | null>(null);
  assetsMapRef.current = assetsMap;
  nleProjectRef.current = nleProject;
  tracksRef.current = tracks;

  // Automatically keep the Current Playlist ordered to match the timeline's chronological clip order
  useEffect(() => {
    if (!autoOrderPlaylist) return;
    setTracks((prev) => reorderPlaylistByTimeline(prev, nleProject.tracks));
  }, [autoOrderPlaylist, nleProject.tracks]);

  /**
   * Scans a persisted DirectoryHandle, compares contents against the stored snapshot,
   * updates folder info/UI indicators, and auto-analyzes newly added or modified tracks.
   */
  const scanHandleAndDetectChanges = useCallback(
    async (
      handle: DirectoryHandleLike,
      options: {
        requestPermission: boolean;
        isStartup: boolean;
        isCancelled?: () => boolean;
      }
    ): Promise<boolean> => {
      const perm = await verifyFolderPermission(handle, options.requestPermission);
      if (options.isCancelled?.()) return false;

      if (perm !== 'granted') {
        setDjFolderVerified(false);
        if (options.requestPermission) {
          setImportError('Read permission was not granted for the linked DJ Folder.');
        } else {
          setFolderNeedsPermission(true);
        }
        return false;
      }

      setFolderNeedsPermission(false);
      const scanned = await scanDirectoryHandle(handle);
      if (options.isCancelled?.()) return false;

      const hydrated = await hydrateFolderFilesWithCache(scanned);
      if (options.isCancelled?.()) return false;

      const prevSnapshot = await loadDjFolderSnapshot();
      if (options.isCancelled?.()) return false;

      const diff = diffFolderSnapshots(prevSnapshot, handle.name, hydrated);
      await saveDjFolderSnapshot(handle.name, hydrated);
      if (options.isCancelled?.()) return false;

      folderAnalysisSessionRef.current += 1;
      setIsAnalyzingFolder(false);
      setFolderAnalysisProgress(null);
      setDjFolderFiles(hydrated);
      setDjFolderVerified(true);

      if (diff.hasBaseline) {
        setFolderDiffSummary(diff);
        const changedCount =
          diff.addedPaths.length + diff.modifiedPaths.length + diff.removedPaths.length;

        if (changedCount > 0) {
          const parts: string[] = [];
          if (diff.addedPaths.length > 0) parts.push(`+${diff.addedPaths.length} added`);
          if (diff.modifiedPaths.length > 0) parts.push(`${diff.modifiedPaths.length} modified`);
          if (diff.removedPaths.length > 0) parts.push(`${diff.removedPaths.length} removed`);
          setStatusNotice(`"${handle.name}" updated (${parts.join(', ')}).`);

          // Automatically analyze newly added or modified uncached tracks so BPM/Key info stays current
          if (diff.addedPaths.length > 0 || diff.modifiedPaths.length > 0) {
            const changedSet = new Set(
              [...diff.addedPaths, ...diff.modifiedPaths].map((p) => p.toLowerCase())
            );
            const changedUncached = hydrated.filter(
              (f) =>
                changedSet.has(f.relativePath.toLowerCase()) && !f.analysis && !f.analysisError
            );
            if (changedUncached.length > 0) {
              startFolderAnalysisRef.current(changedUncached);
            }
          }
        } else if (!options.isStartup) {
          setStatusNotice(
            `Rescanned "${handle.name}" — up to date (${hydrated.length} audio ${
              hydrated.length === 1 ? 'file' : 'files'
            }).`
          );
        }
      } else {
        setFolderDiffSummary(null);
        if (!options.isStartup) {
          setStatusNotice(
            `Rescanned "${handle.name}" (${hydrated.length} audio ${
              hydrated.length === 1 ? 'file' : 'files'
            } indexed).`
          );
        }
      }

      return true;
    },
    []
  );

  // Check for persisted DJ Folder handle and IndexedDB autosave on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [savedHandle, savedManifest] = await Promise.all([
        loadDjFolderHandle(),
        loadAutosaveManifest(),
      ]);
      if (cancelled) return;

      if (savedHandle) {
        setDjFolderHandle(savedHandle);
        setDjFolderName(savedHandle.name);
        try {
          await scanHandleAndDetectChanges(savedHandle, {
            requestPermission: false,
            isStartup: true,
            isCancelled: () => cancelled,
          });
        } catch {
          // Folder may have been moved, renamed, or temporarily unavailable
          if (!cancelled) setDjFolderVerified(false);
        }
      }
      if (!cancelled) {
        setDjFolderChecked(true);
      }

      if (
        !cancelled &&
        savedManifest &&
        (savedManifest.trackRefs.length > 0 ||
          savedManifest.project.tracks.some((t) => t.clips.length > 0))
      ) {
        setPendingAutosave(savedManifest);
      }
    })();

    return () => {
      cancelled = true;
      // Cancel any active background folder or playlist scans on unmount
      folderAnalysisSessionRef.current += 1;
      playlistRescanSessionRef.current += 1;
    };
  }, [scanHandleAndDetectChanges]);

  // Debounced IndexedDB autosave (skips 60fps playheadSec / isPlaying updates)
  useEffect(() => {
    const hasContent =
      tracks.length > 0 || nleProject.tracks.some((t) => t.clips.length > 0);
    if (!hasContent) return;

    const timer = window.setTimeout(() => {
      const manifest = serializeProjectManifest(
        projectName,
        nleProjectRef.current,
        tracksRef.current,
        djFolderName ?? undefined
      );
      void saveAutosaveManifest(manifest);
    }, 1200);

    return () => window.clearTimeout(timer);
  }, [
    projectName,
    djFolderName,
    tracks,
    nleProject.masterBpm,
    nleProject.masterVolume,
    nleProject.showTempoLane,
    nleProject.showBeatMarkers,
    nleProject.tempoPoints,
    nleProject.snapMode,
    nleProject.rippleMove,
    nleProject.zoomPxPerSec,
    nleProject.loopEnabled,
    nleProject.loopStartSec,
    nleProject.loopEndSec,
    nleProject.defaultMixOptions,
    nleProject.tracks,
  ]);

  // NLE Playhead animation loop while playing
  useEffect(() => {
    if (!nleProject.isPlaying) return;
    let rafId = 0;

    const tick = () => {
      if (pendingSeekSecRef.current !== null) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      const cur = nleEngine.getCurrentPlayheadSec();
      const proj = nleProjectRef.current;
      const mixEnd = Math.max(10, getProjectMixDuration(proj));

      if (
        proj.loopEnabled &&
        proj.loopEndSec > proj.loopStartSec + 0.05 &&
        cur >= proj.loopEndSec
      ) {
        nleEngine.start(proj, assetsMapRef.current, proj.loopStartSec);
        setNleProject((prev) => ({ ...prev, playheadSec: proj.loopStartSec }));
      } else if (!proj.loopEnabled && cur >= mixEnd + 0.5) {
        nleEngine.stop();
        setNleProject((prev) => ({
          ...prev,
          isPlaying: false,
          playheadSec: playheadAnchorSecRef.current,
        }));
        return;
      } else {
        setNleProject((prev) => ({ ...prev, playheadSec: cur }));
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [nleProject.isPlaying]);

  // Clean unfiltered playlist preview progress loop
  useEffect(() => {
    if (!previewTrackId) return;
    let rafId = 0;
    const tick = () => {
      setPreviewTimeSec(nleEngine.getPreviewPositionSec());
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [previewTrackId]);

  useEffect(() => {
    return () => {
      if (commitTempoTimerRef.current !== null) {
        window.clearTimeout(commitTempoTimerRef.current);
        commitTempoTimerRef.current = null;
      }
      if (seekRestartTimerRef.current !== null) {
        window.clearTimeout(seekRestartTimerRef.current);
        seekRestartTimerRef.current = null;
      }
      pendingSeekSecRef.current = null;
      nleEngine.stopPreview();
    };
  }, []);

  /** Imports audio files discovered inside a DJ Folder, deduplicating against existing crate tracks. */
  const importFolderFilesIntoCrate = useCallback(
    async (folderFiles: FolderAudioFile[], folderTitle?: string | null) => {
      if (folderTitle) setDjFolderName(folderTitle);
      const hydratedFolderFiles = await hydrateFolderFilesWithCache(folderFiles);

      // Merge into current djFolderFiles when importing a subset from the folder panel
      setDjFolderFiles((prev) => {
        if (prev.length === 0 || hydratedFolderFiles.length >= prev.length) {
          return hydratedFolderFiles;
        }
        const byRel = new Map(
          hydratedFolderFiles.map((f) => [f.relativePath.toLowerCase(), f])
        );
        return prev.map((existingItem) => byRel.get(existingItem.relativePath.toLowerCase()) ?? existingItem);
      });

      const existing = tracksRef.current;
      const existingKeys = new Set(
        existing.map((t) =>
          t.relativePath
            ? `rel:${t.relativePath.toLowerCase()}`
            : `name:${t.fileName.toLowerCase()}::${t.fileSize}`
        )
      );

      const newFiles = hydratedFolderFiles.filter((ff) => {
        const relKey = `rel:${ff.relativePath.toLowerCase()}`;
        const nameKey = `name:${ff.fileName.toLowerCase()}::${ff.fileSize}`;
        return !existingKeys.has(relKey) && !existingKeys.has(nameKey);
      });

      if (newFiles.length === 0) {
        setStatusNotice(
          hydratedFolderFiles.length > 0
            ? `DJ Folder "${folderTitle ?? 'Selected'}" is up to date (${hydratedFolderFiles.length} audio files indexed).`
            : 'No supported audio files found in that folder.'
        );
        return;
      }

      setImportError(null);
      setImportingCount((c) => c + newFiles.length);
      const ctx = nleEngine.getContext();
      const baseCount = existing.length;
      const decoded: TrackAsset[] = [];

      for (let i = 0; i < newFiles.length; i++) {
        const item = newFiles[i];
        try {
          // Reuse pre-scanned BPM/key metadata when available to skip duplicate detection work
          const asset = await decodeAndAnalyzeFile(item.file, ctx, baseCount + i, {
            relativePath: item.relativePath,
            preservedMeta: item.analysis
              ? {
                  bpm: item.analysis.bpm,
                  beatOffsetSec: item.analysis.beatOffsetSec,
                  manualBeatgrid: item.analysis.manualBeatgrid,
                  musicalKey: item.analysis.musicalKey,
                  camelotCode: item.analysis.camelotCode,
                }
              : undefined,
          });
          decoded.push(asset);

          // Persist freshly computed metadata into IndexedDB cache if not already cached
          if (!item.analysis) {
            const meta = {
              bpm: asset.bpm,
              beatOffsetSec: asset.beatOffsetSec,
              musicalKey: asset.musicalKey,
              camelotCode: asset.camelotCode,
              duration: asset.duration,
              analyzedAt: Date.now(),
            };
            void saveCachedTrackAnalysis(getFolderFileCacheKey(item), meta);
            setDjFolderFiles((prev) =>
              prev.map((f) =>
                f.relativePath === item.relativePath ? { ...f, analysis: meta } : f
              )
            );
          }
        } catch {
          setImportError(`Could not decode "${item.fileName}".`);
        } finally {
          setImportingCount((c) => Math.max(0, c - 1));
        }
      }

      if (decoded.length > 0) {
        setTracks((prev) =>
          [...prev, ...decoded].map((t, idx) => ({
            ...t,
            orderIndex: idx,
          }))
        );
        if (baseCount === 0) {
          setNleProject((p) => ({ ...p, masterBpm: decoded[0].bpm }));
        }
        setStatusNotice(
          `Loaded ${decoded.length} ${decoded.length === 1 ? 'track' : 'tracks'} from "${folderTitle ?? 'DJ Folder'}".`
        );
      }
    },
    []
  );

  /** Commits a hydrated SavedProjectManifest and its resolved TrackAssets into active workspace state. */
  const commitLoadedProject = useCallback(
    (manifest: SavedProjectManifest, resolvedAssets: TrackAsset[]) => {
      nleEngine.stop();
      nleEngine.stopPreview();
      setPreviewTrackId(null);
      setPreviewTimeSec(0);
      const sorted = [...resolvedAssets].sort((a, b) => a.orderIndex - b.orderIndex);
      setTracks(sorted);
      setProjectName(manifest.projectName);
      if (manifest.djFolderName && !djFolderName) {
        setDjFolderName(manifest.djFolderName);
      }
      const loadedPlayheadSec = Math.max(0, manifest.project.playheadSec ?? 0);
      playheadAnchorSecRef.current = loadedPlayheadSec;
      setNleProject({
        ...manifest.project,
        defaultMixOptions: resolveAutoMixDefaults(manifest.project.defaultMixOptions),
        isPlaying: false,
        playheadSec: loadedPlayheadSec,
      });
      setPendingAutosave(null);
      setRelinkModalOpen(false);
      setPendingManifest(null);
      setPendingHandleForModal(null);
      setRelinkResolvedMap(new Map());
      setRelinkMissingTracks([]);
      setRelinkProgressText(null);
      setStatusNotice(`Loaded "${manifest.projectName}" (${sorted.length} tracks ready).`);
    },
    [djFolderName]
  );

  /** Decodes matched SerializedTrackRefs using a given FolderAudioFile list, updating modal/workspace state. */
  const resolveManifestAgainstFiles = useCallback(
    async (
      manifest: SavedProjectManifest,
      candidateFiles: FolderAudioFile[],
      initialResolved: Map<string, TrackAsset>,
      autoCommitIfComplete: boolean
    ) => {
      setRelinkProcessing(true);
      setRelinkProgressText('Matching project tracks against DJ Folder...');

      const resolved = new Map<string, TrackAsset>(initialResolved);
      const unresolvedRefs = manifest.trackRefs.filter((ref) => !resolved.has(ref.id));
      const { matched, missing } = matchTrackRefsToFolderFiles(unresolvedRefs, candidateFiles);

      const nextMissing: MissingTrackInfo[] = missing.map((trackRef) => ({
        trackRef,
        reason: 'not-found',
      }));

      const ctx = nleEngine.getContext();
      for (let i = 0; i < matched.length; i++) {
        const { trackRef, folderFile } = matched[i];
        setRelinkProgressText(
          `Decoding (${i + 1}/${matched.length}): ${folderFile.fileName}`
        );
        try {
          const asset = await decodeAndAnalyzeFile(folderFile.file, ctx, trackRef.orderIndex, {
            id: trackRef.id,
            relativePath: folderFile.relativePath,
            preservedMeta: {
              name: trackRef.name,
              bpm: trackRef.bpm,
              beatOffsetSec: trackRef.beatOffsetSec,
              manualBeatgrid: trackRef.manualBeatgrid,
              musicalKey: trackRef.musicalKey,
              camelotCode: trackRef.camelotCode,
              orderIndex: trackRef.orderIndex,
            },
          });
          resolved.set(trackRef.id, asset);
        } catch {
          nextMissing.push({ trackRef, reason: 'decode-error' });
        }
      }

      setRelinkProcessing(false);
      setRelinkProgressText(null);
      setRelinkResolvedMap(resolved);
      setRelinkMissingTracks(nextMissing);

      if (nextMissing.length === 0 && autoCommitIfComplete) {
        commitLoadedProject(manifest, Array.from(resolved.values()));
      } else {
        setPendingManifest(manifest);
        setRelinkModalOpen(true);
      }
    },
    [commitLoadedProject]
  );

  /** Entry point for loading any SavedProjectManifest (from file import or IndexedDB autosave). */
  const startProjectHydration = useCallback(
    async (manifest: SavedProjectManifest) => {
      setImportError(null);
      setPendingManifest(manifest);

      // 1. Reuse any already-decoded TrackAssets currently in memory with matching id
      const initialResolved = new Map<string, TrackAsset>();
      for (const ref of manifest.trackRefs) {
        const inMem = assetsMapRef.current.get(ref.id);
        if (inMem && inMem.fileSize === ref.fileSize) {
          initialResolved.set(ref.id, {
            ...inMem,
            name: ref.name,
            bpm: ref.bpm,
            beatOffsetSec: ref.beatOffsetSec,
            manualBeatgrid: ref.manualBeatgrid ?? inMem.manualBeatgrid,
            musicalKey: ref.musicalKey,
            camelotCode: ref.camelotCode,
            orderIndex: ref.orderIndex,
          });
        }
      }

      if (initialResolved.size === manifest.trackRefs.length) {
        commitLoadedProject(manifest, Array.from(initialResolved.values()));
        return;
      }

      // 2. If we already have indexed DJ Folder files in memory, match against them immediately
      if (djFolderFiles.length > 0) {
        setPendingHandleForModal(null);
        await resolveManifestAgainstFiles(manifest, djFolderFiles, initialResolved, true);
        return;
      }

      // 3. Check persisted FileSystemDirectoryHandle permission
      const handle = djFolderHandle ?? (await loadDjFolderHandle());
      if (handle) {
        setDjFolderHandle(handle);
        setDjFolderName(handle.name);
        const perm = await verifyFolderPermission(handle, false);
        if (perm === 'granted') {
          const scanned = await scanDirectoryHandle(handle);
          setDjFolderFiles(scanned);
          setPendingHandleForModal(null);
          await resolveManifestAgainstFiles(manifest, scanned, initialResolved, true);
          return;
        }
        if (perm === 'prompt') {
          setPendingHandleForModal(handle);
          setRelinkResolvedMap(initialResolved);
          setRelinkMissingTracks(
            manifest.trackRefs
              .filter((r) => !initialResolved.has(r.id))
              .map((trackRef) => ({ trackRef, reason: 'not-found' as const }))
          );
          setRelinkModalOpen(true);
          return;
        }
      }

      // 4. Otherwise prompt user to select their DJ Folder or locate missing files
      setPendingHandleForModal(null);
      setRelinkResolvedMap(initialResolved);
      setRelinkMissingTracks(
        manifest.trackRefs
          .filter((r) => !initialResolved.has(r.id))
          .map((trackRef) => ({ trackRef, reason: 'not-found' as const }))
      );
      setRelinkModalOpen(true);
    },
    [commitLoadedProject, djFolderFiles, djFolderHandle, resolveManifestAgainstFiles]
  );

  /** Triggers folder selection via File System Access API, falling back to <input webkitdirectory>. */
  const triggerPickDjFolder = useCallback(
    async (mode: 'crate' | 'relink') => {
      directoryFallbackModeRef.current = mode;
      try {
        const handle = await pickDjFolderHandle();
        if (!handle) return; // User cancelled

        setDjFolderHandle(handle);
        setDjFolderName(handle.name);
        setFolderNeedsPermission(false);
        setFolderDiffSummary(null);
        setPendingHandleForModal(null);

        const scanned = await scanDirectoryHandle(handle);
        const hydrated = await hydrateFolderFilesWithCache(scanned);
        await saveDjFolderSnapshot(handle.name, hydrated);
        folderAnalysisSessionRef.current += 1;
        setIsAnalyzingFolder(false);
        setFolderAnalysisProgress(null);
        setDjFolderFiles(hydrated);
        setDjFolderVerified(true);
        setDjFolderChecked(true);

        if (mode === 'crate') {
          setStatusNotice(
            hydrated.length > 0
              ? `Indexed ${hydrated.length} audio ${hydrated.length === 1 ? 'file' : 'files'} in "${handle.name}". Click "Scan BPM/Key" to pre-analyze compatibility before importing.`
              : `No supported audio files found in "${handle.name}".`
          );
        } else if (pendingManifest) {
          await resolveManifestAgainstFiles(pendingManifest, hydrated, relinkResolvedMap, true);
        }
      } catch (err) {
        if (err instanceof DjFolderPickerUnavailableError) {
          directoryFallbackInputRef.current?.click();
        } else {
          setImportError(
            err instanceof Error ? err.message : 'Could not open the selected DJ Folder.'
          );
        }
      }
    },
    [pendingManifest, relinkResolvedMap, resolveManifestAgainstFiles]
  );

  const handleDirectoryFallbackChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const { folderName, files } = scanFileListFromDirectoryInput(fileList);
    e.target.value = '';

    const hydrated = await hydrateFolderFilesWithCache(files);
    await saveDjFolderSnapshot(folderName, hydrated);
    folderAnalysisSessionRef.current += 1;
    setIsAnalyzingFolder(false);
    setFolderAnalysisProgress(null);
    setFolderNeedsPermission(false);
    setFolderDiffSummary(null);
    setDjFolderHandle(null);
    setDjFolderName(folderName);
    setDjFolderFiles(hydrated);
    setDjFolderVerified(true);
    setDjFolderChecked(true);

    if (directoryFallbackModeRef.current === 'crate') {
      setStatusNotice(
        hydrated.length > 0
          ? `Indexed ${hydrated.length} audio ${hydrated.length === 1 ? 'file' : 'files'} in "${folderName}". Click "Scan BPM/Key" to pre-analyze compatibility before importing.`
          : `No supported audio files found in "${folderName}".`
      );
    } else if (pendingManifest) {
      await resolveManifestAgainstFiles(pendingManifest, hydrated, relinkResolvedMap, true);
    }
  };

  const handleSyncDjFolder = useCallback(async () => {
    if (!djFolderHandle) return;
    try {
      await scanHandleAndDetectChanges(djFolderHandle, {
        requestPermission: true,
        isStartup: false,
      });
    } catch (err) {
      setImportError(
        err instanceof Error ? err.message : 'Could not rescan the linked DJ Folder.'
      );
    }
  }, [djFolderHandle, scanHandleAndDetectChanges]);

  const handleIndexDroppedDjFolder = useCallback(
    (folderFiles: FolderAudioFile[], folderTitle?: string | null) => {
      folderAnalysisSessionRef.current += 1;
      setIsAnalyzingFolder(false);
      setFolderAnalysisProgress(null);
      setFolderNeedsPermission(false);
      setFolderDiffSummary(null);
      setDjFolderHandle(null);
      if (folderTitle) setDjFolderName(folderTitle);
      void (async () => {
        const hydrated = await hydrateFolderFilesWithCache(folderFiles);
        if (folderTitle) {
          await saveDjFolderSnapshot(folderTitle, hydrated);
        }
        setDjFolderFiles(hydrated);
        setDjFolderVerified(true);
        setDjFolderChecked(true);
        setStatusNotice(
          `Indexed ${hydrated.length} audio ${hydrated.length === 1 ? 'file' : 'files'} from "${folderTitle ?? 'Dropped Folder'}".`
        );
      })();
    },
    []
  );

  const handleStopFolderAnalysis = useCallback(() => {
    folderAnalysisSessionRef.current += 1;
    setIsAnalyzingFolder(false);
    setFolderAnalysisProgress(null);
  }, []);

  /**
   * Sequentially decodes DJ Folder tracks to compute BPM, beat phase offset, Key, Camelot code,
   * and duration without retaining heavy AudioBuffers in memory, caching results in IndexedDB.
   * Pass `forceRescan = true` to re-analyze all folder tracks and overwrite cached values.
   */
  const handleStartFolderAnalysis = useCallback(
    (filesOverride?: FolderAudioFile[], forceRescan = false) => {
      const snapshot = filesOverride ?? djFolderFilesRef.current;
      const isManuallyLockedFolderFile = (f: FolderAudioFile): boolean => {
        if (f.analysis?.manualBeatgrid) return true;
        const match = tracksRef.current.find(
          (t) =>
            (t.relativePath &&
              t.relativePath.toLowerCase() === f.relativePath.toLowerCase()) ||
            (t.fileName.toLowerCase() === f.fileName.toLowerCase() &&
              t.fileSize === f.fileSize)
        );
        return Boolean(match?.manualBeatgrid);
      };
      const protectedCount = forceRescan
        ? snapshot.filter((f) => isManuallyLockedFolderFile(f)).length
        : 0;
      const pendingItems = forceRescan
        ? snapshot.filter((f) => !isManuallyLockedFolderFile(f))
        : snapshot.filter((f) => !f.analysis && !f.analysisError);
      if (pendingItems.length === 0) {
        if (forceRescan && protectedCount > 0) {
          setStatusNotice(
            `All ${protectedCount} ${protectedCount === 1 ? 'track has a' : 'tracks have'} manually edited beatgrid — preserved without overwriting.`
          );
        }
        return;
      }

      const sessionId = ++folderAnalysisSessionRef.current;
      setIsAnalyzingFolder(true);
      setFolderAnalysisProgress({ done: 0, total: pendingItems.length });

      void (async () => {
        const ctx = nleEngine.getContext();
        let done = 0;
        let updatedPlaylistCount = 0;
        const updatedAssets = new Map<string, TrackAsset>();

        for (const item of pendingItems) {
          if (folderAnalysisSessionRef.current !== sessionId) return;

          const inPlaylist = tracksRef.current.find(
            (t) =>
              (t.relativePath &&
                t.relativePath.toLowerCase() === item.relativePath.toLowerCase()) ||
              (t.fileName.toLowerCase() === item.fileName.toLowerCase() &&
                t.fileSize === item.fileSize)
          );

          if (inPlaylist && !forceRescan) {
            // Reuse already-loaded playlist metadata during normal scan
            const meta = {
              bpm: inPlaylist.bpm,
              beatOffsetSec: inPlaylist.beatOffsetSec,
              musicalKey: inPlaylist.musicalKey,
              camelotCode: inPlaylist.camelotCode,
              duration: inPlaylist.duration,
              analyzedAt: Date.now(),
            };
            await saveCachedTrackAnalysis(getFolderFileCacheKey(item), meta);
            if (folderAnalysisSessionRef.current !== sessionId) return;
            setDjFolderFiles((prev) =>
              prev.map((f) =>
                f.relativePath === item.relativePath ? { ...f, analysis: meta } : f
              )
            );
          } else {
            try {
              const meta = inPlaylist
                ? analyzeAudioBufferMeta(inPlaylist.audioBuffer)
                : await analyzeAudioFileMeta(item.file, ctx);
              if (folderAnalysisSessionRef.current !== sessionId) return;
              await saveCachedTrackAnalysis(getFolderFileCacheKey(item), meta);
              setDjFolderFiles((prev) =>
                prev.map((f) =>
                  f.relativePath === item.relativePath
                    ? { ...f, analysis: meta, analysisError: false }
                    : f
                )
              );

              if (inPlaylist) {
                updatedPlaylistCount += 1;
                const nextAsset: TrackAsset = {
                  ...inPlaylist,
                  bpm: meta.bpm,
                  beatOffsetSec: meta.beatOffsetSec,
                  musicalKey: meta.musicalKey,
                  camelotCode: meta.camelotCode,
                };
                updatedAssets.set(inPlaylist.id, nextAsset);
                setTracks((prev) =>
                  prev.map((t) =>
                    t.id === inPlaylist.id
                      ? {
                          ...t,
                          bpm: meta.bpm,
                          beatOffsetSec: meta.beatOffsetSec,
                          musicalKey: meta.musicalKey,
                          camelotCode: meta.camelotCode,
                        }
                      : t
                  )
                );
              }
            } catch {
              if (folderAnalysisSessionRef.current !== sessionId) return;
              setDjFolderFiles((prev) =>
                prev.map((f) =>
                  f.relativePath === item.relativePath ? { ...f, analysisError: true } : f
                )
              );
            }
          }

          done += 1;
          if (folderAnalysisSessionRef.current !== sessionId) return;
          setFolderAnalysisProgress({ done, total: pendingItems.length });

          // Yield briefly between files so UI playback and interactions stay smooth
          await new Promise((resolve) => window.setTimeout(resolve, 16));
        }

        if (folderAnalysisSessionRef.current === sessionId) {
          if (updatedPlaylistCount > 0) {
            const nextAssetsMap = new Map(assetsMapRef.current);
            for (const [id, asset] of updatedAssets) {
              nextAssetsMap.set(id, asset);
            }
            setNleProject((prev) => {
              const synced = syncTempoMapToTimeline(
                { masterBpm: prev.masterBpm, tracks: prev.tracks },
                nextAssetsMap
              );
              return {
                ...prev,
                masterBpm: synced.masterBpm,
                tempoPoints: synced.tempoPoints,
              };
            });
            window.setTimeout(() => {
              if (nleProjectRef.current.isPlaying) {
                const curSec = nleEngine.getCurrentPlayheadSec();
                nleEngine.start(nleProjectRef.current, assetsMapRef.current, curSec);
              }
            }, 0);
          }

          setIsAnalyzingFolder(false);
          setFolderAnalysisProgress(null);
          if (forceRescan) {
            const preservedSuffix =
              protectedCount > 0
                ? ` (${protectedCount} manual ${protectedCount === 1 ? 'beatgrid' : 'beatgrids'} preserved)`
                : '';
            setStatusNotice(
              `Re-scanned BPM & Key for ${done} ${done === 1 ? 'track' : 'tracks'} in DJ Folder${preservedSuffix}.`
            );
          }
        }
      })();
    },
    []
  );

  startFolderAnalysisRef.current = handleStartFolderAnalysis;

  /**
   * Re-runs BPM, beat phase offset, and Key detection on all loaded playlist tracks,
   * updates the DJ Folder IndexedDB cache, re-syncs the timeline tempo map, and refreshes playback.
   */
  const handleRescanPlaylist = useCallback(() => {
    const snapshot = tracksRef.current;
    if (snapshot.length === 0) return;

    const isLockedTrack = (track: TrackAsset): boolean => {
      if (track.manualBeatgrid) return true;
      const folderMatch = djFolderFilesRef.current.find(
        (f) =>
          (track.relativePath &&
            f.relativePath.toLowerCase() === track.relativePath.toLowerCase()) ||
          (f.fileName.toLowerCase() === track.fileName.toLowerCase() &&
            f.fileSize === track.fileSize)
      );
      return Boolean(folderMatch?.analysis?.manualBeatgrid);
    };

    const tracksToScan = snapshot.filter((t) => !isLockedTrack(t));
    const protectedCount = snapshot.length - tracksToScan.length;

    if (tracksToScan.length === 0) {
      setStatusNotice(
        `All ${protectedCount} playlist ${protectedCount === 1 ? 'track has a' : 'tracks have'} manually edited beatgrid — preserved without overwriting.`
      );
      return;
    }

    const sessionId = ++playlistRescanSessionRef.current;
    setIsRescanningPlaylist(true);
    setPlaylistRescanProgress({ done: 0, total: tracksToScan.length });

    void (async () => {
      const updatedMap = new Map<string, TrackAsset>();
      let done = 0;

      for (const track of tracksToScan) {
        if (playlistRescanSessionRef.current !== sessionId) return;

        // Yield before heavy DSP so progress updates render smoothly
        await new Promise((resolve) => window.setTimeout(resolve, 16));
        if (playlistRescanSessionRef.current !== sessionId) return;

        const meta = analyzeAudioBufferMeta(track.audioBuffer);
        const updatedTrack: TrackAsset = {
          ...track,
          bpm: meta.bpm,
          beatOffsetSec: meta.beatOffsetSec,
          musicalKey: meta.musicalKey,
          camelotCode: meta.camelotCode,
        };
        updatedMap.set(track.id, updatedTrack);

        setTracks((prev) =>
          prev.map((t) =>
            t.id === track.id
              ? {
                  ...t,
                  bpm: meta.bpm,
                  beatOffsetSec: meta.beatOffsetSec,
                  musicalKey: meta.musicalKey,
                  camelotCode: meta.camelotCode,
                }
              : t
          )
        );

        // Keep matching DJ Folder entry and IndexedDB cache in sync
        const isMatchingFolderFile = (f: FolderAudioFile) =>
          (track.relativePath &&
            f.relativePath.toLowerCase() === track.relativePath.toLowerCase()) ||
          (f.fileName.toLowerCase() === track.fileName.toLowerCase() &&
            f.fileSize === track.fileSize);
        const matchedFolderFiles = djFolderFilesRef.current.filter(isMatchingFolderFile);

        if (matchedFolderFiles.length > 0) {
          for (const f of matchedFolderFiles) {
            void saveCachedTrackAnalysis(getFolderFileCacheKey(f), meta);
          }
          setDjFolderFiles((prev) =>
            prev.map((f) =>
              isMatchingFolderFile(f) ? { ...f, analysis: meta, analysisError: false } : f
            )
          );
        } else if (typeof track.lastModified === 'number') {
          void saveCachedTrackAnalysis(
            getFolderFileCacheKey({
              fileName: track.fileName,
              fileSize: track.fileSize,
              lastModified: track.lastModified,
            }),
            meta
          );
        }

        done += 1;
        if (playlistRescanSessionRef.current !== sessionId) return;
        setPlaylistRescanProgress({ done, total: tracksToScan.length });
      }

      if (playlistRescanSessionRef.current !== sessionId) return;

      const nextAssetsMap = new Map(assetsMapRef.current);
      for (const [id, asset] of updatedMap) {
        nextAssetsMap.set(id, asset);
      }

      setNleProject((prev) => {
        const hasClips = prev.tracks.some((t) => t.clips.length > 0);
        if (!hasClips && snapshot.length > 0) {
          const firstUpdated = updatedMap.get(snapshot[0].id);
          return firstUpdated ? { ...prev, masterBpm: firstUpdated.bpm } : prev;
        }
        const synced = syncTempoMapToTimeline(
          { masterBpm: prev.masterBpm, tracks: prev.tracks },
          nextAssetsMap
        );
        return {
          ...prev,
          masterBpm: synced.masterBpm,
          tempoPoints: synced.tempoPoints,
        };
      });

      window.setTimeout(() => {
        if (nleProjectRef.current.isPlaying) {
          const curSec = nleEngine.getCurrentPlayheadSec();
          nleEngine.start(nleProjectRef.current, assetsMapRef.current, curSec);
        }
      }, 0);

      setIsRescanningPlaylist(false);
      setPlaylistRescanProgress(null);
      const preservedSuffix =
        protectedCount > 0
          ? ` (${protectedCount} manual ${protectedCount === 1 ? 'beatgrid' : 'beatgrids'} preserved)`
          : '';
      setStatusNotice(
        `Re-scanned BPM, beat grid & Key for ${done} playlist ${done === 1 ? 'track' : 'tracks'}${preservedSuffix}.`
      );
    })();
  }, []);

  const handleGrantPendingFolderPermission = useCallback(async () => {
    if (!pendingHandleForModal || !pendingManifest) return;
    const perm = await verifyFolderPermission(pendingHandleForModal, true);
    if (perm !== 'granted') {
      setImportError('Folder access permission was denied. You can still select a folder manually.');
      setPendingHandleForModal(null);
      return;
    }
    setPendingHandleForModal(null);
    setFolderNeedsPermission(false);
    const scanned = await scanDirectoryHandle(pendingHandleForModal);
    const hydrated = await hydrateFolderFilesWithCache(scanned);
    const prevSnapshot = await loadDjFolderSnapshot();
    const diff = diffFolderSnapshots(prevSnapshot, pendingHandleForModal.name, hydrated);
    await saveDjFolderSnapshot(pendingHandleForModal.name, hydrated);
    if (diff.hasBaseline) {
      setFolderDiffSummary(diff);
    }
    setDjFolderFiles(hydrated);
    await resolveManifestAgainstFiles(pendingManifest, hydrated, relinkResolvedMap, true);
  }, [pendingHandleForModal, pendingManifest, relinkResolvedMap, resolveManifestAgainstFiles]);

  const handleLocateSingleTrack = useCallback(
    async (trackRef: SerializedTrackRef, file: File) => {
      setRelinkProcessing(true);
      setRelinkProgressText(`Decoding ${file.name}...`);
      try {
        const asset = await decodeAndAnalyzeFile(
          file,
          nleEngine.getContext(),
          trackRef.orderIndex,
          {
            id: trackRef.id,
            relativePath: trackRef.relativePath,
            preservedMeta: {
              name: trackRef.name,
              bpm: trackRef.bpm,
              beatOffsetSec: trackRef.beatOffsetSec,
              manualBeatgrid: trackRef.manualBeatgrid,
              musicalKey: trackRef.musicalKey,
              camelotCode: trackRef.camelotCode,
              orderIndex: trackRef.orderIndex,
            },
          }
        );

        const nextResolved = new Map(relinkResolvedMap);
        nextResolved.set(trackRef.id, asset);
        const nextMissing = relinkMissingTracks.filter((m) => m.trackRef.id !== trackRef.id);

        setRelinkResolvedMap(nextResolved);
        setRelinkMissingTracks(nextMissing);

        if (nextMissing.length === 0 && pendingManifest) {
          commitLoadedProject(pendingManifest, Array.from(nextResolved.values()));
        }
      } catch {
        setRelinkMissingTracks((prev) =>
          prev.map((m) =>
            m.trackRef.id === trackRef.id ? { ...m, reason: 'decode-error' } : m
          )
        );
      } finally {
        setRelinkProcessing(false);
        setRelinkProgressText(null);
      }
    },
    [commitLoadedProject, pendingManifest, relinkMissingTracks, relinkResolvedMap]
  );

  const handleSaveProject = () => {
    const manifest = serializeProjectManifest(
      projectName,
      nleProject,
      tracks,
      djFolderName ?? undefined
    );
    downloadProjectManifest(manifest);
    void saveAutosaveManifest(manifest);
    setStatusNotice(`Saved "${manifest.projectName}.openmix.json" (${manifest.trackRefs.length} track refs).`);
  };

  const handleExportPlaylistText = () => {
    if (tracks.length === 0) return;
    const filename = downloadPlaylistText(projectName, tracks, nleProject.masterBpm);
    setStatusNotice(`Exported playlist to "${filename}" (${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'}).`);
  };

  const totalClipCount = useMemo(
    () => nleProject.tracks.reduce((sum, lane) => sum + lane.clips.length, 0),
    [nleProject.tracks]
  );

  const resetWorkspaceForNewMix = useCallback(() => {
    nleEngine.stop();
    nleEngine.stopPreview();
    setPreviewTrackId(null);
    setPreviewTimeSec(0);
    playheadAnchorSecRef.current = 0;
    setTracks([]);
    setProjectName('Untitled Mix');
    setImportError(null);
    setPendingAutosave(null);
    void clearAutosaveManifest();
    setNleProject({
      masterBpm: 124,
      masterVolume: DEFAULT_MASTER_VOLUME,
      showTempoLane: false,
      showBeatMarkers: true,
      tempoPoints: [],
      snapMode: 'bar',
      zoomPxPerSec: 28,
      playheadSec: 0,
      isPlaying: false,
      loopEnabled: false,
      loopStartSec: 0,
      loopEndSec: 32,
      defaultMixOptions: { ...DEFAULT_AUTO_MIX_OPTIONS },
      tracks: [createNleTrack(0), createNleTrack(1), createNleTrack(2)],
    });
  }, []);

  const handleRequestNewMix = () => {
    if (tracks.length === 0 && totalClipCount === 0) {
      resetWorkspaceForNewMix();
      setStatusNotice('Started a new mix.');
      return;
    }
    setNewMixModalOpen(true);
  };

  const handleSaveAndStartNewMix = (saveName: string, alsoExportPlaylistTxt: boolean) => {
    const manifest = serializeProjectManifest(
      saveName,
      nleProject,
      tracks,
      djFolderName ?? undefined
    );
    downloadProjectManifest(manifest);
    let playlistFilename: string | null = null;
    if (alsoExportPlaylistTxt && tracks.length > 0) {
      playlistFilename = downloadPlaylistText(manifest.projectName, tracks, nleProject.masterBpm);
    }
    setNewMixModalOpen(false);
    resetWorkspaceForNewMix();
    setStatusNotice(
      playlistFilename
        ? `Saved "${manifest.projectName}.openmix.json" & "${playlistFilename}", then started a new mix.`
        : `Saved "${manifest.projectName}.openmix.json" and started a new mix.`
    );
  };

  const handleDiscardAndStartNewMix = () => {
    setNewMixModalOpen(false);
    resetWorkspaceForNewMix();
    setStatusNotice('Cleared workspace and started a new mix.');
  };

  const handleLoadProjectFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const manifest = await parseProjectManifestFile(file);
      await startProjectHydration(manifest);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Failed to load project file.');
    }
  };

  const handleReorderTracks = useCallback((fromIndex: number, toIndex: number) => {
    const current = tracksRef.current;
    const movedTrack = current[fromIndex];
    const targetTrack = current[toIndex];
    if (movedTrack && targetTrack) {
      const placedIds = new Set<string>();
      for (const lane of nleProjectRef.current.tracks) {
        for (const clip of lane.clips) placedIds.add(clip.trackAssetId);
      }
      if (placedIds.has(movedTrack.id) || placedIds.has(targetTrack.id)) {
        setAutoOrderPlaylist(false);
      }
    }

    setTracks((prev) => {
      if (
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= prev.length ||
        toIndex >= prev.length ||
        fromIndex === toIndex
      ) {
        return prev;
      }
      const copy = [...prev];
      const [moved] = copy.splice(fromIndex, 1);
      copy.splice(toIndex, 0, moved);
      return copy.map((t, idx) => ({ ...t, orderIndex: idx }));
    });
  }, []);

  const handleRemoveTrack = useCallback((trackId: string) => {
    if (previewTrackIdRef.current === trackId) {
      nleEngine.stopPreview();
      setPreviewTrackId(null);
      setPreviewTimeSec(0);
    }
    setTracks((prev) => prev.filter((t) => t.id !== trackId));
  }, []);

  const handleTogglePreview = useCallback((trackId: string) => {
    if (previewTrackIdRef.current === trackId) {
      nleEngine.stopPreview();
      setPreviewTrackId(null);
      setPreviewTimeSec(0);
      return;
    }

    const asset = assetsMapRef.current.get(trackId);
    if (!asset) return;

    if (nleProjectRef.current.isPlaying) {
      setNleProject((p) => (p.isPlaying ? { ...p, isPlaying: false } : p));
    }

    setPreviewTrackId(trackId);
    setPreviewTimeSec(0);
    nleEngine.playPreview(asset, 0, () => {
      setPreviewTrackId((cur) => (cur === trackId ? null : cur));
      setPreviewTimeSec(0);
    });
  }, []);

  const handleSeekPreview = useCallback((trackId: string, sec: number) => {
    const asset = assetsMapRef.current.get(trackId);
    if (!asset) return;

    const clamped = Math.max(0, Math.min(sec, Math.max(0, asset.duration - 0.05)));
    if (nleProjectRef.current.isPlaying) {
      setNleProject((p) => (p.isPlaying ? { ...p, isPlaying: false } : p));
    }

    setPreviewTrackId(trackId);
    setPreviewTimeSec(clamped);
    nleEngine.playPreview(asset, clamped, () => {
      setPreviewTrackId((cur) => (cur === trackId ? null : cur));
      setPreviewTimeSec(0);
    });
  }, []);

  const handleUpdateTrackMeta = useCallback(
    (trackId: string, bpm: number, musicalKey: string, explicitBeatOffsetSec?: number) => {
      const camelotCode = getCamelotForKey(musicalKey);
      const editedTrack = tracksRef.current.find((t) => t.id === trackId);
      const bpmChanged = Boolean(editedTrack && Math.abs(editedTrack.bpm - bpm) > 0.001);
      const hasExplicitOffset =
        explicitBeatOffsetSec !== undefined && Number.isFinite(explicitBeatOffsetSec);
      const nextBeatOffsetSec = hasExplicitOffset
        ? Math.max(0, explicitBeatOffsetSec)
        : editedTrack && bpmChanged
          ? detectBeatOffsetForBuffer(editedTrack.audioBuffer, bpm)
          : editedTrack?.beatOffsetSec ?? 0;

      const markManualBeatgrid = hasExplicitOffset || bpmChanged;

      setTracks((prev) =>
        prev.map((t) =>
          t.id === trackId
            ? {
                ...t,
                bpm,
                beatOffsetSec: nextBeatOffsetSec,
                manualBeatgrid: markManualBeatgrid ? true : t.manualBeatgrid,
                musicalKey,
                camelotCode,
              }
            : t
        )
      );

      // Re-sync timeline masterBpm & tempoPoints immediately when a track's BPM changes
      if (editedTrack && bpmChanged) {
        const updatedAsset: TrackAsset = {
          ...editedTrack,
          bpm,
          beatOffsetSec: nextBeatOffsetSec,
          manualBeatgrid: true,
          musicalKey,
          camelotCode,
        };
        const nextAssetsMap = new Map(assetsMapRef.current);
        nextAssetsMap.set(trackId, updatedAsset);

        setNleProject((prev) => {
          const synced = syncTempoMapToTimeline(
            { masterBpm: prev.masterBpm, tracks: prev.tracks },
            nextAssetsMap
          );
          return {
            ...prev,
            masterBpm: synced.masterBpm,
            tempoPoints: synced.tempoPoints,
          };
        });

        window.setTimeout(() => {
          if (nleProjectRef.current.isPlaying) {
            const curSec = nleEngine.getCurrentPlayheadSec();
            nleEngine.start(nleProjectRef.current, assetsMapRef.current, curSec);
          }
        }, 0);
      }

      // Keep DJ Folder and IndexedDB analysis cache in sync with manual BPM/Key/Beatgrid overrides
      if (editedTrack) {
        const isMatchingFolderFile = (f: FolderAudioFile) =>
          (editedTrack.relativePath &&
            f.relativePath.toLowerCase() === editedTrack.relativePath.toLowerCase()) ||
          (f.fileName.toLowerCase() === editedTrack.fileName.toLowerCase() &&
            f.fileSize === editedTrack.fileSize);
        const matchedFolderFiles = djFolderFilesRef.current.filter(isMatchingFolderFile);
        const now = Date.now();

        if (matchedFolderFiles.length > 0) {
          for (const f of matchedFolderFiles) {
            void saveCachedTrackAnalysis(getFolderFileCacheKey(f), {
              bpm,
              beatOffsetSec:
                hasExplicitOffset || bpmChanged
                  ? nextBeatOffsetSec
                  : f.analysis?.beatOffsetSec ?? editedTrack.beatOffsetSec,
              manualBeatgrid:
                markManualBeatgrid || f.analysis?.manualBeatgrid || editedTrack.manualBeatgrid
                  ? true
                  : undefined,
              musicalKey,
              camelotCode,
              duration: f.analysis?.duration ?? editedTrack.duration,
              analyzedAt: now,
            });
          }
          setDjFolderFiles((prev) =>
            prev.map((f) => {
              if (!isMatchingFolderFile(f)) return f;
              return {
                ...f,
                analysis: {
                  bpm,
                  beatOffsetSec:
                    hasExplicitOffset || bpmChanged
                      ? nextBeatOffsetSec
                      : f.analysis?.beatOffsetSec ?? editedTrack.beatOffsetSec,
                  manualBeatgrid:
                    markManualBeatgrid || f.analysis?.manualBeatgrid || editedTrack.manualBeatgrid
                      ? true
                      : undefined,
                  musicalKey,
                  camelotCode,
                  duration: f.analysis?.duration ?? editedTrack.duration,
                  analyzedAt: now,
                },
              };
            })
          );
        } else if (typeof editedTrack.lastModified === 'number') {
          // Also cache standalone dropped files (outside a linked DJ Folder) for future mixes
          void saveCachedTrackAnalysis(
            getFolderFileCacheKey({
              fileName: editedTrack.fileName,
              fileSize: editedTrack.fileSize,
              lastModified: editedTrack.lastModified,
            }),
            {
              bpm,
              beatOffsetSec: nextBeatOffsetSec,
              manualBeatgrid: markManualBeatgrid || editedTrack.manualBeatgrid ? true : undefined,
              musicalKey,
              camelotCode,
              duration: editedTrack.duration,
              analyzedAt: now,
            }
          );
        }
      }
    },
    []
  );

  const handleUpdateTrackBeatOffset = useCallback(
    (trackId: string, beatOffsetSec: number) => {
      const safeOffset = Number.isFinite(beatOffsetSec) ? Math.max(0, beatOffsetSec) : 0;
      const editedTrack = tracksRef.current.find((t) => t.id === trackId);
      setTracks((prev) =>
        prev.map((t) =>
          t.id === trackId ? { ...t, beatOffsetSec: safeOffset, manualBeatgrid: true } : t
        )
      );

      if (editedTrack) {
        const isMatchingFolderFile = (f: FolderAudioFile) =>
          (editedTrack.relativePath &&
            f.relativePath.toLowerCase() === editedTrack.relativePath.toLowerCase()) ||
          (f.fileName.toLowerCase() === editedTrack.fileName.toLowerCase() &&
            f.fileSize === editedTrack.fileSize);
        const matchedFolderFiles = djFolderFilesRef.current.filter(isMatchingFolderFile);
        const now = Date.now();

        if (matchedFolderFiles.length > 0) {
          for (const f of matchedFolderFiles) {
            void saveCachedTrackAnalysis(getFolderFileCacheKey(f), {
              bpm: f.analysis?.bpm ?? editedTrack.bpm,
              beatOffsetSec: safeOffset,
              manualBeatgrid: true,
              musicalKey: f.analysis?.musicalKey ?? editedTrack.musicalKey,
              camelotCode: f.analysis?.camelotCode ?? editedTrack.camelotCode,
              duration: f.analysis?.duration ?? editedTrack.duration,
              analyzedAt: now,
            });
          }
          setDjFolderFiles((prev) =>
            prev.map((f) => {
              if (!isMatchingFolderFile(f)) return f;
              return {
                ...f,
                analysis: {
                  bpm: f.analysis?.bpm ?? editedTrack.bpm,
                  beatOffsetSec: safeOffset,
                  manualBeatgrid: true,
                  musicalKey: f.analysis?.musicalKey ?? editedTrack.musicalKey,
                  camelotCode: f.analysis?.camelotCode ?? editedTrack.camelotCode,
                  duration: f.analysis?.duration ?? editedTrack.duration,
                  analyzedAt: now,
                },
              };
            })
          );
        } else if (typeof editedTrack.lastModified === 'number') {
          void saveCachedTrackAnalysis(
            getFolderFileCacheKey({
              fileName: editedTrack.fileName,
              fileSize: editedTrack.fileSize,
              lastModified: editedTrack.lastModified,
            }),
            {
              bpm: editedTrack.bpm,
              beatOffsetSec: safeOffset,
              manualBeatgrid: true,
              musicalKey: editedTrack.musicalKey,
              camelotCode: editedTrack.camelotCode,
              duration: editedTrack.duration,
              analyzedAt: now,
            }
          );
        }
      }
    },
    []
  );

  // NLE Timeline Handlers
  const clearPendingAudioRestarts = useCallback(() => {
    if (commitTempoTimerRef.current !== null) {
      window.clearTimeout(commitTempoTimerRef.current);
      commitTempoTimerRef.current = null;
    }
    if (seekRestartTimerRef.current !== null) {
      window.clearTimeout(seekRestartTimerRef.current);
      seekRestartTimerRef.current = null;
    }
    pendingSeekSecRef.current = null;
  }, []);

  const handleToggleNlePlay = () => {
    clearPendingAudioRestarts();
    if (nleProject.isPlaying) {
      nleEngine.stop();
      setNleProject((p) => ({ ...p, isPlaying: false }));
    } else {
      if (previewTrackIdRef.current) {
        nleEngine.stopPreview();
        setPreviewTrackId(null);
        setPreviewTimeSec(0);
      }
      const startSec =
        nleProject.loopEnabled &&
        nleProject.loopEndSec > nleProject.loopStartSec + 0.05 &&
        nleProject.playheadSec >= nleProject.loopEndSec - 0.02
          ? nleProject.loopStartSec
          : nleProject.playheadSec;
      nleEngine.start(nleProject, assetsMap, startSec);
      setNleProject((p) => ({ ...p, isPlaying: true, playheadSec: startSec }));
    }
  };

  const handleNleStop = () => {
    clearPendingAudioRestarts();
    nleEngine.stop();
    const { isPlaying, playheadSec } = nleProjectRef.current;
    const anchorSec = playheadAnchorSecRef.current;
    const isAlreadyAtAnchor = !isPlaying && Math.abs(playheadSec - anchorSec) < 0.005;
    const targetSec = isAlreadyAtAnchor ? 0 : anchorSec;
    if (isAlreadyAtAnchor) {
      playheadAnchorSecRef.current = 0;
    }
    setNleProject((p) => ({ ...p, isPlaying: false, playheadSec: targetSec }));
  };

  const handleNleSeek = (sec: number) => {
    const safeSec = Math.max(0, sec);
    playheadAnchorSecRef.current = safeSec;
    const wasPlaying = nleProjectRef.current.isPlaying;
    if (wasPlaying) {
      pendingSeekSecRef.current = safeSec;
      if (seekRestartTimerRef.current !== null) {
        window.clearTimeout(seekRestartTimerRef.current);
      }
      seekRestartTimerRef.current = window.setTimeout(() => {
        seekRestartTimerRef.current = null;
        const targetSec = pendingSeekSecRef.current;
        pendingSeekSecRef.current = null;
        if (targetSec !== null && nleProjectRef.current.isPlaying) {
          nleEngine.start(nleProjectRef.current, assetsMapRef.current, targetSec);
        }
      }, 45);
    }
    setNleProject((p) => ({ ...p, playheadSec: safeSec }));
  };

  const handleUpdateNleTrack = (trackId: string, patch: Partial<NleTrack>) => {
    setNleProject((prev) => {
      let updatedTrack: NleTrack | null = null;
      const nextTracks = prev.tracks.map((t) => {
        if (t.id !== trackId) return t;
        updatedTrack = { ...t, ...patch };
        return updatedTrack;
      });
      if (prev.isPlaying && updatedTrack) {
        nleEngine.updateTrackMixLive(updatedTrack, nextTracks);
      }
      return { ...prev, tracks: nextTracks };
    });
  };

  const withSyncedTempoMap = (
    prev: NleProjectState,
    nextTracks: NleTrack[]
  ): NleProjectState => {
    const synced = syncTempoMapToTimeline(
      { masterBpm: prev.masterBpm, tracks: nextTracks },
      assetsMapRef.current
    );
    return {
      ...prev,
      tracks: nextTracks,
      masterBpm: synced.masterBpm,
      tempoPoints: synced.tempoPoints,
    };
  };

  const handleAddNleClipAt = (
    trackId: string,
    assetId: string,
    startSec: number,
    options?: { bypassAutoMix?: boolean; isQuickAdd?: boolean }
  ) => {
    const asset = assetsMapRef.current.get(assetId);
    if (!asset) return;

    setNleProject((prev) => {
      const { newClip, previousClipPatch } = computeAutoMixPlacement({
        project: prev,
        targetTrackId: trackId,
        assetId: asset.id,
        assetDuration: asset.duration,
        requestedStartSec: startSec,
        assetsMap: assetsMapRef.current,
        bypassAutoMix: options?.bypassAutoMix,
        isQuickAdd: options?.isQuickAdd,
      });

      const nextTracks = prev.tracks.map((t) => {
        let updatedClips = t.clips;
        if (previousClipPatch && t.id === previousClipPatch.trackId) {
          updatedClips = updatedClips.map((c) =>
            c.id === previousClipPatch.clipId ? { ...c, ...previousClipPatch.patch } : c
          );
        }
        if (t.id === trackId) {
          updatedClips = [...updatedClips, newClip];
        }
        return updatedClips === t.clips ? t : { ...t, clips: updatedClips };
      });

      return withSyncedTempoMap(prev, nextTracks);
    });
    handleCommitTempoChange();
  };

  const handleQuickAddToTimeline = (assetId: string) => {
    const proj = nleProjectRef.current;
    const prevClip = findPreviousClip(proj.tracks);
    // Prefer an empty lane, or a lane different from the previous clip's lane for clean DJ A/B mixing
    const emptyLane = proj.tracks.find((t) => t.clips.length === 0);
    const alternateLane = prevClip
      ? proj.tracks.find((t) => t.id !== prevClip.track.id) ?? proj.tracks[0]
      : proj.tracks[0];
    const targetLane = emptyLane ?? alternateLane;
    if (!targetLane) return;

    const fallbackStart = targetLane.clips.reduce(
      (max, c) => Math.max(max, c.startSec + c.durationSec),
      0
    );
    handleAddNleClipAt(targetLane.id, assetId, prevClip ? prevClip.endSec : fallbackStart, {
      isQuickAdd: true,
    });
  };

  const handleUpdateNleClip = (
    trackId: string,
    clipId: string,
    patch: Partial<NleClip>
  ) => {
    setNleProject((prev) => {
      let updatedClip: NleClip | null = null;
      const nextTracks = prev.tracks.map((t) =>
        t.id === trackId
          ? {
              ...t,
              clips: t.clips.map((c) => {
                if (c.id !== clipId) return c;
                updatedClip = { ...c, ...patch };
                return updatedClip;
              }),
            }
          : t
      );
      const nextProject = withSyncedTempoMap(prev, nextTracks);
      if (
        prev.isPlaying &&
        updatedClip &&
        (patch.fadeInSec !== undefined ||
          patch.fadeOutSec !== undefined ||
          patch.fadeInEnabled !== undefined ||
          patch.fadeOutEnabled !== undefined ||
          patch.fadeInStartSec !== undefined ||
          patch.fadeOutEndSec !== undefined ||
          patch.bassFadeInSec !== undefined ||
          patch.bassFadeOutSec !== undefined ||
          patch.bassFadeInEnabled !== undefined ||
          patch.bassFadeOutEnabled !== undefined ||
          patch.bassFadeInStartSec !== undefined ||
          patch.bassFadeOutEndSec !== undefined ||
          patch.fadeCurve !== undefined ||
          patch.fadeInCurve !== undefined ||
          patch.fadeOutCurve !== undefined ||
          patch.fadeInCurveTension !== undefined ||
          patch.fadeOutCurveTension !== undefined ||
          patch.bassFadeInCurveTension !== undefined ||
          patch.bassFadeOutCurveTension !== undefined ||
          patch.mixIn !== undefined ||
          patch.mixOut !== undefined ||
          patch.gainDb !== undefined)
      ) {
        nleEngine.updateClipFadesLive(updatedClip, nextProject);
      }
      return nextProject;
    });
  };

  const handleMoveNleClip = (
    fromTrackId: string,
    toTrackId: string,
    clipId: string,
    startSec: number,
    rippleClipIds?: ReadonlySet<string>
  ) => {
    setNleProject((prev) => {
      const sourceTrack = prev.tracks.find((t) => t.id === fromTrackId);
      const movingClip = sourceTrack?.clips.find((c) => c.id === clipId);
      if (!sourceTrack || !movingClip) return prev;
      if (fromTrackId !== toTrackId && !prev.tracks.some((t) => t.id === toTrackId)) {
        return prev;
      }

      const safeStartSec = Math.max(0, startSec);
      const prevStartSec = movingClip.startSec;
      const deltaSec = safeStartSec - prevStartSec;
      const shouldRipple = prev.rippleMove !== false && Math.abs(deltaSec) > 1e-6;

      const shouldShiftClip = (c: NleClip): boolean => {
        if (!shouldRipple || c.id === clipId) return false;
        if (rippleClipIds) return rippleClipIds.has(c.id);
        return c.startSec > prevStartSec + 1e-4;
      };

      let nextTracks: NleTrack[];
      if (fromTrackId === toTrackId) {
        nextTracks = prev.tracks.map((t) => {
          let changed = false;
          const nextClips = t.clips.map((c) => {
            if (c.id === clipId) {
              changed = true;
              return { ...c, startSec: safeStartSec };
            }
            if (shouldShiftClip(c)) {
              changed = true;
              return { ...c, startSec: Math.max(0, c.startSec + deltaSec) };
            }
            return c;
          });
          return changed ? { ...t, clips: nextClips } : t;
        });
      } else {
        const movedClip: NleClip = {
          ...movingClip,
          laneId: toTrackId,
          startSec: safeStartSec,
        };

        nextTracks = prev.tracks.map((t) => {
          let clips = t.clips;
          let changed = false;

          if (t.id === fromTrackId) {
            clips = clips.filter((c) => c.id !== clipId);
            changed = true;
          }

          if (shouldRipple) {
            let shiftedAny = false;
            const shifted = clips.map((c) => {
              if (!shouldShiftClip(c)) return c;
              shiftedAny = true;
              return { ...c, startSec: Math.max(0, c.startSec + deltaSec) };
            });
            if (shiftedAny) {
              clips = shifted;
              changed = true;
            }
          }

          if (t.id === toTrackId) {
            clips = [...clips, movedClip];
            changed = true;
          }

          return changed ? { ...t, clips } : t;
        });
      }

      const provisionalTempo = syncTempoMapToTimeline(
        { masterBpm: prev.masterBpm, tracks: nextTracks },
        assetsMapRef.current
      );
      const syncedMixTracks = syncPairedMixOnClipMove(nextTracks, clipId, provisionalTempo);
      return withSyncedTempoMap(prev, syncedMixTracks);
    });
  };

  const handleUpdateClipTransition = (
    trackId: string,
    clipId: string,
    direction: 'in' | 'out',
    nextEnv: ClipMixEnvelope | undefined,
    options?: { realignToPrev?: boolean; syncPair?: boolean }
  ) => {
    setNleProject((prev) => {
      const targetTrack = prev.tracks.find((t) => t.id === trackId);
      const targetClip = targetTrack?.clips.find((c) => c.id === clipId);
      if (!targetClip) return prev;

      if (direction === 'in') {
        if (!nextEnv) {
          const nextTracks = prev.tracks.map((t) =>
            t.id === trackId
              ? {
                  ...t,
                  clips: t.clips.map((c) =>
                    c.id === clipId
                      ? {
                          ...c,
                          mixIn: undefined,
                          fadeInSec: 0,
                          fadeInStartSec: 0,
                          bassFadeInSec: 0,
                          bassFadeInStartSec: 0,
                        }
                      : c
                  ),
                }
              : t
          );
          return withSyncedTempoMap(prev, nextTracks);
        }

        const prevLookup =
          findClipById(prev.tracks, nextEnv.pairedClipId ?? targetClip.mixIn?.pairedClipId) ??
          findPreviousClip(
            prev.tracks,
            clipId,
            targetClip.startSec + (targetClip.mixIn?.durationSec ?? 0) + 1
          );

        let nextStartSec = targetClip.startSec;
        let nextDurationSec = nextEnv.durationSec;

        if (options?.realignToPrev && prevLookup) {
          const aligned = computeBeatAlignedOverlap({
            tempoSrc: prev,
            prevClip: prevLookup.clip,
            prevAsset: assetsMapRef.current.get(prevLookup.clip.trackAssetId),
            incomingDurationSec: targetClip.durationSec,
            incomingOffsetSec: targetClip.offsetSec,
            incomingAsset: assetsMapRef.current.get(targetClip.trackAssetId),
            overlapBars: nextEnv.overlapBars,
          });
          nextDurationSec = Math.round(aligned.overlapSec * 1000) / 1000;
          nextStartSec = aligned.alignedStartSec;
        } else {
          nextDurationSec = Math.max(
            0,
            Math.min(nextEnv.durationSec, targetClip.durationSec * 0.85)
          );
        }

        const finalEnv: ClipMixEnvelope = {
          ...nextEnv,
          durationSec: nextDurationSec,
          pairedClipId: prevLookup?.clip.id ?? nextEnv.pairedClipId,
        };
        const nextFadeSec = finalEnv.volumeCrossfade ? finalEnv.durationSec : 0;
        const nextBassFadeSec = finalEnv.bassMode !== 'none' ? finalEnv.durationSec : 0;

        const rippleDeltaSec = nextStartSec - targetClip.startSec;
        const shouldRipple =
          prev.rippleMove !== false && Math.abs(rippleDeltaSec) > 1e-6;

        const nextTracks = prev.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) => {
            if (c.id === clipId) {
              return {
                ...c,
                startSec: nextStartSec,
                fadeInSec: nextFadeSec,
                fadeInEnabled: finalEnv.volumeCrossfade ? true : c.fadeInEnabled,
                bassFadeInSec: nextBassFadeSec,
                bassFadeInEnabled: finalEnv.bassMode !== 'none' ? true : c.bassFadeInEnabled,
                mixIn: finalEnv,
              };
            }
            if (options?.syncPair && prevLookup && c.id === prevLookup.clip.id) {
              return {
                ...c,
                fadeOutSec: nextFadeSec,
                fadeOutEnabled: finalEnv.volumeCrossfade ? true : c.fadeOutEnabled,
                bassFadeOutSec: nextBassFadeSec,
                bassFadeOutEnabled: finalEnv.bassMode !== 'none' ? true : c.bassFadeOutEnabled,
                fadeOutCurve: targetClip.fadeInCurve ?? targetClip.fadeCurve,
                mixOut: {
                  ...finalEnv,
                  pairedClipId: clipId,
                },
              };
            }
            if (shouldRipple && c.startSec > targetClip.startSec + 1e-4) {
              return {
                ...c,
                startSec: Math.max(0, c.startSec + rippleDeltaSec),
              };
            }
            return c;
          }),
        }));
        return withSyncedTempoMap(prev, nextTracks);
      }

      // Direction === 'out'
      if (!nextEnv) {
        const nextTracks = prev.tracks.map((t) =>
          t.id === trackId
            ? {
                ...t,
                clips: t.clips.map((c) =>
                  c.id === clipId
                    ? {
                        ...c,
                        mixOut: undefined,
                        fadeOutSec: 0,
                        fadeOutEndSec: 0,
                        bassFadeOutSec: 0,
                        bassFadeOutEndSec: 0,
                      }
                    : c
                ),
              }
            : t
        );
        return withSyncedTempoMap(prev, nextTracks);
      }

      const clampedDur = Math.max(
        0,
        Math.min(nextEnv.durationSec, targetClip.durationSec * 0.85)
      );
      const finalOutEnv: ClipMixEnvelope = {
        ...nextEnv,
        durationSec: clampedDur,
      };
      const nextFadeOutSec = finalOutEnv.volumeCrossfade ? finalOutEnv.durationSec : 0;
      const nextBassFadeOutSec = finalOutEnv.bassMode !== 'none' ? finalOutEnv.durationSec : 0;

      const nextTracks = prev.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => {
          if (c.id === clipId) {
            return {
              ...c,
              fadeOutSec: nextFadeOutSec,
              fadeOutEnabled: finalOutEnv.volumeCrossfade ? true : c.fadeOutEnabled,
              bassFadeOutSec: nextBassFadeOutSec,
              bassFadeOutEnabled: finalOutEnv.bassMode !== 'none' ? true : c.bassFadeOutEnabled,
              mixOut: finalOutEnv,
            };
          }
          if (
            options?.syncPair &&
            finalOutEnv.pairedClipId &&
            c.id === finalOutEnv.pairedClipId
          ) {
            return {
              ...c,
              fadeInSec: nextFadeOutSec,
              fadeInEnabled: finalOutEnv.volumeCrossfade ? true : c.fadeInEnabled,
              bassFadeInSec: nextBassFadeOutSec,
              bassFadeInEnabled: finalOutEnv.bassMode !== 'none' ? true : c.bassFadeInEnabled,
              fadeInCurve: targetClip.fadeOutCurve ?? targetClip.fadeCurve,
              mixIn: {
                ...finalOutEnv,
                pairedClipId: clipId,
              },
            };
          }
          return c;
        }),
      }));
      return withSyncedTempoMap(prev, nextTracks);
    });

    window.setTimeout(() => {
      if (nleProjectRef.current.isPlaying) {
        const curSec = nleEngine.getCurrentPlayheadSec();
        nleEngine.start(nleProjectRef.current, assetsMapRef.current, curSec);
      }
    }, 0);
  };

  const handleChangeTrackMixPreset = (
    trackId: string,
    clipId: string,
    presetId: Exclude<MixPresetId, 'custom'>
  ) => {
    setNleProject((prev) => {
      const nextTracks = applyPresetToClipMix(prev.tracks, trackId, clipId, presetId, prev);
      if (nextTracks === prev.tracks) return prev;
      return withSyncedTempoMap(prev, nextTracks);
    });

    window.setTimeout(() => {
      if (nleProjectRef.current.isPlaying) {
        const curSec = nleEngine.getCurrentPlayheadSec();
        nleEngine.start(nleProjectRef.current, assetsMapRef.current, curSec);
      }
    }, 0);
  };

  const handleDeleteNleClip = (trackId: string, clipId: string) => {
    setNleProject((prev) => {
      const nextTracks = prev.tracks.map((t) =>
        t.id === trackId ? { ...t, clips: t.clips.filter((c) => c.id !== clipId) } : t
      );
      return withSyncedTempoMap(prev, nextTracks);
    });
    handleCommitTempoChange();
  };

  const handleDuplicateNleClip = (trackId: string, clipId: string) => {
    setNleProject((prev) => {
      const nextTracks = prev.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const orig = t.clips.find((c) => c.id === clipId);
        if (!orig) return t;
        const copy: NleClip = {
          ...orig,
          id: `clip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          startSec: orig.startSec + orig.durationSec,
        };
        return { ...t, clips: [...t.clips, copy] };
      });
      return withSyncedTempoMap(prev, nextTracks);
    });
    handleCommitTempoChange();
  };

  const handleSplitAtPlayhead = (selectedClipId: string | null) => {
    const ph = nleProject.playheadSec;
    setNleProject((prev) => {
      const nextTracks = prev.tracks.map((t) => {
        const nextClips: NleClip[] = [];
        for (const c of t.clips) {
          const matchesTarget = selectedClipId ? c.id === selectedClipId : true;
          const inside = ph > c.startSec + 0.08 && ph < c.startSec + c.durationSec - 0.08;
          if (matchesTarget && inside) {
            const leftDur = ph - c.startSec;
            const rightDur = c.durationSec - leftDur;
            const asset = assetsMapRef.current.get(c.trackAssetId);
            const srcDelta =
              c.stretchToMasterBpm && asset && asset.bpm > 0
                ? integrateClipSourceOffsetSec(prev, c.startSec, leftDur, asset.bpm)
                : leftDur;
            const leftClip: NleClip = {
              ...c,
              durationSec: leftDur,
              fadeOutSec: Math.min(c.fadeOutSec, leftDur * 0.5),
              bassFadeOutSec: Math.min(c.bassFadeOutSec ?? 0, leftDur * 0.5),
            };
            const rightClip: NleClip = {
              ...c,
              id: `clip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              startSec: ph,
              offsetSec: c.offsetSec + srcDelta,
              durationSec: rightDur,
              fadeInSec: Math.min(c.fadeInSec, rightDur * 0.5),
              bassFadeInSec: Math.min(c.bassFadeInSec ?? 0, rightDur * 0.5),
            };
            nextClips.push(leftClip, rightClip);
          } else {
            nextClips.push(c);
          }
        }
        return { ...t, clips: nextClips };
      });
      return withSyncedTempoMap(prev, nextTracks);
    });
    handleCommitTempoChange();
  };

  const handleCommitTempoChange = useCallback(() => {
    if (commitTempoTimerRef.current !== null) {
      window.clearTimeout(commitTempoTimerRef.current);
    }
    commitTempoTimerRef.current = window.setTimeout(() => {
      commitTempoTimerRef.current = null;
      if (nleProjectRef.current.isPlaying) {
        const curSec = pendingSeekSecRef.current ?? nleEngine.getCurrentPlayheadSec();
        nleEngine.start(nleProjectRef.current, assetsMapRef.current, curSec);
      }
    }, 45);
  }, []);

  const handleStartVerticalResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = topPaneHeightPx;
    const maxAllowed = workspaceRef.current
      ? Math.max(240, Math.floor(workspaceRef.current.clientHeight * 0.56))
      : 480;

    const onMove = (ev: PointerEvent) => {
      const next = Math.max(180, Math.min(maxAllowed, startHeight + (ev.clientY - startY)));
      setTopPaneHeightPx(next);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [topPaneHeightPx]);

  const handleStartHorizontalResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = djFolderWidthPx;
    const workspaceWidth = workspaceRef.current?.clientWidth ?? window.innerWidth;
    const minWidth = 260;
    const maxAllowed = Math.max(minWidth, workspaceWidth - 280);

    const onMove = (ev: PointerEvent) => {
      const next = Math.max(minWidth, Math.min(maxAllowed, startWidth + (ev.clientX - startX)));
      setDjFolderWidthPx(next);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [djFolderWidthPx]);

  useEffect(() => {
    if (!mixMenuOpen && !themeMenuOpen) return;
    const handleOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (mixMenuOpen && mixMenuRef.current && !mixMenuRef.current.contains(target)) {
        setMixMenuOpen(false);
      }
      if (themeMenuOpen && themeMenuRef.current && !themeMenuRef.current.contains(target)) {
        setThemeMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMixMenuOpen(false);
        setThemeMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handleOutside);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handleOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [mixMenuOpen, themeMenuOpen]);

  const handleToggleNlePlayRef = useRef(handleToggleNlePlay);
  handleToggleNlePlayRef.current = handleToggleNlePlay;

  const deleteModalConfig = useMemo(() => {
    if (!pendingDeleteTarget) return null;

    if (pendingDeleteTarget.kind === 'playlist') {
      const track = tracks.find((t) => t.id === pendingDeleteTarget.trackId);
      if (!track) return null;
      const usedCount = timelineTrackCounts.get(track.id) ?? 0;
      const itemLabel = track.name || track.fileName;
      const warningText =
        usedCount > 0
          ? `This track is currently used in ${usedCount} timeline ${usedCount === 1 ? 'clip' : 'clips'}. Removing it from the playlist will stop audio playback for those clips.`
          : 'Your original audio file on disk will not be affected.';

      return {
        kind: 'playlist' as const,
        trackId: track.id,
        title: 'Remove Track from Playlist?',
        subtitle: 'This will remove the track from your current playlist.',
        itemLabel,
        warningText,
        confirmLabel: 'Remove Track',
      };
    }

    const lane = nleProject.tracks.find((t) => t.id === pendingDeleteTarget.trackId);
    if (!lane || nleProject.tracks.length <= 1) return null;
    const clipCount = lane.clips.length;
    const warningText =
      clipCount > 0
        ? `This track contains ${clipCount} ${clipCount === 1 ? 'clip' : 'clips'} that will also be removed from the timeline.`
        : 'This track lane has no clips on it.';

    return {
      kind: 'timeline' as const,
      trackId: lane.id,
      title: 'Delete Timeline Track?',
      subtitle: 'This will remove the track lane from your NLE timeline.',
      itemLabel: lane.name,
      warningText,
      confirmLabel: 'Delete Track',
    };
  }, [pendingDeleteTarget, tracks, timelineTrackCounts, nleProject.tracks]);

  const isDeleteModalOpen = deleteModalConfig !== null;

  const handleConfirmDeleteTrack = useCallback(() => {
    if (!deleteModalConfig) return;
    const { kind, trackId } = deleteModalConfig;
    setPendingDeleteTarget(null);

    if (kind === 'playlist') {
      handleRemoveTrack(trackId);
      return;
    }

    setNleProject((prev) => {
      // Always preserve at least one timeline track lane.
      if (prev.tracks.length <= 1) return prev;
      const remaining = prev.tracks.filter((t) => t.id !== trackId);
      if (remaining.length === prev.tracks.length) return prev;
      return withSyncedTempoMap(prev, remaining);
    });
    handleCommitTempoChange();
  }, [deleteModalConfig, handleRemoveTrack, handleCommitTempoChange]);

  // Global keyboard shortcuts: ?/F1 (Help), Space (Play/Pause), L (toggle loop), [ (Set In), ] (Set Out)
  useEffect(() => {
    const handleGlobalShortcuts = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (e.key === 'F1' || e.key === '?') {
        if (showWelcome || isDeleteModalOpen || beatgridEditorTarget !== null) {
          return;
        }
        e.preventDefault();
        setThemeMenuOpen(false);
        setMixMenuOpen(false);
        setAboutModalOpen(false);
        setHelpModalOpen((prev) => (e.key === '?' ? !prev : true));
        return;
      }

      if (isDeleteModalOpen || helpModalOpen || aboutModalOpen) {
        return;
      }

      if (e.code === 'Space' || e.key === ' ') {
        if (
          showWelcome ||
          exportModalOpen ||
          relinkModalOpen ||
          newMixModalOpen ||
          beatgridEditorTarget !== null
        ) {
          return;
        }
        e.preventDefault();
        if (e.repeat) return;
        handleToggleNlePlayRef.current();
        return;
      }

      const key = e.key.toLowerCase();
      if (key === 'l') {
        e.preventDefault();
        setNleProject((prev) => {
          const nextEnabled = !prev.loopEnabled;
          if (nextEnabled && prev.loopEndSec <= prev.loopStartSec + 0.25) {
            const fourBars = (60 / Math.max(40, prev.masterBpm)) * 16;
            const start = Math.max(0, prev.playheadSec);
            return {
              ...prev,
              loopEnabled: true,
              loopStartSec: start,
              loopEndSec: start + fourBars,
            };
          }
          return { ...prev, loopEnabled: nextEnabled };
        });
      } else if (e.key === '[') {
        e.preventDefault();
        setNleProject((prev) => {
          const nextStart = Math.max(0, prev.playheadSec);
          const fourBars = (60 / Math.max(40, prev.masterBpm)) * 16;
          const nextEnd =
            prev.loopEndSec > nextStart + 0.25 ? prev.loopEndSec : nextStart + fourBars;
          return {
            ...prev,
            loopStartSec: nextStart,
            loopEndSec: nextEnd,
            loopEnabled: true,
          };
        });
      } else if (e.key === ']') {
        e.preventDefault();
        setNleProject((prev) => {
          const nextEnd = Math.max(0.25, prev.playheadSec);
          const fourBars = (60 / Math.max(40, prev.masterBpm)) * 16;
          const nextStart =
            prev.loopStartSec < nextEnd - 0.25
              ? prev.loopStartSec
              : Math.max(0, nextEnd - fourBars);
          return {
            ...prev,
            loopStartSec: nextStart,
            loopEndSec: nextEnd,
            loopEnabled: true,
          };
        });
      }
    };

    window.addEventListener('keydown', handleGlobalShortcuts);
    return () => window.removeEventListener('keydown', handleGlobalShortcuts);
  }, [
    showWelcome,
    exportModalOpen,
    relinkModalOpen,
    newMixModalOpen,
    beatgridEditorTarget,
    isDeleteModalOpen,
    helpModalOpen,
    aboutModalOpen,
  ]);

  const showAutosaveBanner =
    pendingAutosave !== null &&
    tracks.length === 0 &&
    nleProject.tracks.every((t) => t.clips.length === 0);

  const bothTopPanelsCollapsed = djFolderCollapsed && playlistCollapsed;

  const handleToggleBothTopPanels = () => {
    const nextCollapsed = !bothTopPanelsCollapsed;
    setDjFolderCollapsed(nextCollapsed);
    setPlaylistCollapsed(nextCollapsed);
    if (nextCollapsed) {
      setTimelineCollapsed(false);
    }
  };

  const handleToggleTimeline = () => {
    const next = !timelineCollapsed;
    setTimelineCollapsed(next);
    if (next && djFolderCollapsed && playlistCollapsed) {
      setDjFolderCollapsed(false);
      setPlaylistCollapsed(false);
    }
  };

  useEffect(() => {
    const input = directoryFallbackInputRef.current;
    if (!input) return;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
  }, []);

  return (
    <div className="h-screen w-screen bg-om-base text-om-text flex flex-col overflow-hidden">
      {/* Hidden File Inputs for Project JSON & Directory Picker Fallback */}
      <input
        ref={loadProjectInputRef}
        type="file"
        accept=".json,.openmix.json,.obsidian-mix.json,application/json"
        onChange={handleLoadProjectFileChange}
        className="hidden"
      />
      <input
        ref={directoryFallbackInputRef}
        type="file"
        multiple
        onChange={handleDirectoryFallbackChange}
        className="hidden"
      />

      {/* Clean Top Studio Header */}
      <header className="h-14 shrink-0 px-5 bg-om-panel border-b border-white/[0.08] flex items-center justify-between gap-6">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex flex-col leading-tight shrink-0">
            <span className="font-display text-base font-bold tracking-tight text-om-text whitespace-nowrap">
              OpenMix Studio
            </span>
            <span className="text-[11px] text-om-text-dim whitespace-nowrap hidden md:block">
              The open-source non-linear DJ mix studio
            </span>
          </div>
          <span aria-hidden="true" className="text-om-text-icon">
            /
          </span>
          <input
            type="text"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            aria-label="Project Name"
            className="w-40 sm:w-48 bg-om-base border border-white/[0.08] focus:border-om-accent/70 rounded px-2.5 py-1 text-xs font-medium text-om-text focus:outline-none truncate"
          />
        </div>

        {/* Right Studio Header Controls */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Theme Switcher Menu */}
          <div ref={themeMenuRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => {
                setMixMenuOpen(false);
                setThemeMenuOpen((prev) => !prev);
              }}
              aria-expanded={themeMenuOpen}
              aria-haspopup="menu"
              title={`Theme: ${theme.name}`}
              className="px-3 py-2 rounded-md bg-om-control hover:bg-om-control-hover border border-white/[0.08] text-om-text text-xs font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Palette className="w-3.5 h-3.5 text-om-accent shrink-0" />
              <span className="hidden sm:inline">{theme.shortName}</span>
              <span className="inline-flex items-center gap-1" aria-hidden="true">
                {theme.swatches.map((hex) => (
                  <span
                    key={hex}
                    className="w-2 h-2 rounded-full ring-1 ring-white/20"
                    style={{ backgroundColor: hex }}
                  />
                ))}
              </span>
              <ChevronDown
                className={`w-3.5 h-3.5 text-om-text-dim transition-transform ${
                  themeMenuOpen ? 'rotate-180' : ''
                }`}
              />
            </button>

            {themeMenuOpen && (
              <div
                role="menu"
                aria-label="Color theme"
                className="absolute right-0 mt-1.5 w-64 rounded-lg bg-om-panel border border-white/[0.12] shadow-2xl py-1.5 z-50"
              >
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-om-text-subtle">
                  Studio Theme
                </div>
                {THEME_LIST.map((option) => {
                  const isActive = option.id === themeId;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isActive}
                      onClick={() => {
                        setThemeId(option.id);
                        setThemeMenuOpen(false);
                      }}
                      className={`w-full px-3 py-2 text-left transition-colors flex items-start justify-between gap-2.5 cursor-pointer ${
                        isActive ? 'bg-om-control' : 'hover:bg-om-control/70'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-om-text">
                            {option.name}
                          </span>
                          <span className="inline-flex items-center gap-1" aria-hidden="true">
                            {option.swatches.map((hex) => (
                              <span
                                key={hex}
                                className="w-2 h-2 rounded-full ring-1 ring-white/25"
                                style={{ backgroundColor: hex }}
                              />
                            ))}
                          </span>
                        </div>
                        <p className="text-[11px] text-om-text-dim leading-snug mt-0.5">
                          {option.description}
                        </p>
                      </div>
                      {isActive && (
                        <Check className="w-3.5 h-3.5 text-om-accent shrink-0 mt-0.5" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={handleToggleBothTopPanels}
            aria-pressed={bothTopPanelsCollapsed}
            title={
              bothTopPanelsCollapsed
                ? 'Show DJ Folder and Current Playlist'
                : 'Hide DJ Folder and Current Playlist'
            }
            className="px-3 py-2 rounded-md bg-om-control hover:bg-om-control-hover border border-white/[0.08] text-om-text text-xs font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {bothTopPanelsCollapsed ? (
              <PanelTopOpen className="w-3.5 h-3.5 text-om-accent" />
            ) : (
              <PanelTopClose className="w-3.5 h-3.5 text-om-text-dim" />
            )}
            <span>{bothTopPanelsCollapsed ? 'Show Library' : 'Hide Library'}</span>
          </button>

          <button
            type="button"
            onClick={handleToggleTimeline}
            aria-pressed={timelineCollapsed}
            title={
              timelineCollapsed
                ? 'Show NLE Timeline'
                : 'Hide NLE Timeline to focus on DJ Folder and Current Playlist'
            }
            className="px-3 py-2 rounded-md bg-om-control hover:bg-om-control-hover border border-white/[0.08] text-om-text text-xs font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {timelineCollapsed ? (
              <PanelBottomOpen className="w-3.5 h-3.5 text-om-accent" />
            ) : (
              <PanelBottomClose className="w-3.5 h-3.5 text-om-text-dim" />
            )}
            <span>{timelineCollapsed ? 'Show Timeline' : 'Hide Timeline'}</span>
          </button>

          {/* Consolidated Mix Actions Menu */}
          <div ref={mixMenuRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => {
                setThemeMenuOpen(false);
                setMixMenuOpen((prev) => !prev);
              }}
              aria-expanded={mixMenuOpen}
              aria-haspopup="menu"
              className="px-3.5 py-2 rounded-md bg-om-control hover:bg-om-control-hover border border-white/[0.08] text-om-text text-xs font-medium inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <span>Mix</span>
              <ChevronDown
                className={`w-3.5 h-3.5 text-om-text-dim transition-transform ${
                  mixMenuOpen ? 'rotate-180' : ''
                }`}
              />
            </button>

          {mixMenuOpen && (
            <div
              role="menu"
              aria-label="Mix actions"
              className="absolute right-0 mt-1.5 w-52 rounded-lg bg-om-panel border border-white/[0.12] shadow-2xl py-1 z-50"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMixMenuOpen(false);
                  handleRequestNewMix();
                }}
                className="w-full px-3 py-2 text-left text-xs font-medium text-om-text hover:bg-om-control inline-flex items-center gap-2.5 transition-colors cursor-pointer"
              >
                <FilePlus2 className="w-3.5 h-3.5 text-om-accent shrink-0" />
                <span>New Mix</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMixMenuOpen(false);
                  loadProjectInputRef.current?.click();
                }}
                className="w-full px-3 py-2 text-left text-xs font-medium text-om-text hover:bg-om-control inline-flex items-center gap-2.5 transition-colors cursor-pointer"
              >
                <FolderOpen className="w-3.5 h-3.5 text-om-accent shrink-0" />
                <span>Load Mix</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMixMenuOpen(false);
                  handleSaveProject();
                }}
                className="w-full px-3 py-2 text-left text-xs font-medium text-om-text hover:bg-om-control inline-flex items-center gap-2.5 transition-colors cursor-pointer"
              >
                <Save className="w-3.5 h-3.5 text-om-positive shrink-0" />
                <span>Save Mix</span>
              </button>
              <div className="my-1 border-t border-white/[0.08]" />
              <button
                type="button"
                role="menuitem"
                disabled={tracks.length === 0}
                onClick={() => {
                  setMixMenuOpen(false);
                  handleExportPlaylistText();
                }}
                title={
                  tracks.length === 0
                    ? 'Add tracks to your playlist before exporting'
                    : 'Download current playlist tracklist as a .txt file'
                }
                className="w-full px-3 py-2 text-left text-xs font-medium text-om-text hover:bg-om-control disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed inline-flex items-center gap-2.5 transition-colors cursor-pointer"
              >
                <FileText className="w-3.5 h-3.5 text-om-secondary shrink-0" />
                <span>Export Playlist (.txt)</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMixMenuOpen(false);
                  setExportModalOpen(true);
                }}
                className="w-full px-3 py-2 text-left text-xs font-semibold text-om-accent hover:bg-om-control inline-flex items-center gap-2.5 transition-colors cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 shrink-0" />
                <span>Export Mix</span>
              </button>
            </div>
          )}
          </div>

          <button
            type="button"
            onClick={() => {
              setThemeMenuOpen(false);
              setMixMenuOpen(false);
              setAboutModalOpen(false);
              setHelpModalOpen(true);
            }}
            title="Help Center & Keyboard Shortcuts (? / F1)"
            className="px-3 py-2 rounded-md bg-om-control hover:bg-om-control-hover border border-white/[0.08] text-om-text text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <HelpCircle className="w-3.5 h-3.5 text-om-accent shrink-0" />
            <span>Help</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setThemeMenuOpen(false);
              setMixMenuOpen(false);
              setHelpModalOpen(false);
              setAboutModalOpen(true);
            }}
            title="About OpenMix Studio & Credits"
            className="px-3 py-2 rounded-md bg-om-control hover:bg-om-control-hover border border-white/[0.08] text-om-text text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Info className="w-3.5 h-3.5 text-om-accent shrink-0" />
            <span>About</span>
          </button>
        </div>
      </header>

      {/* Autosave Resume Prompt */}
      {showAutosaveBanner && pendingAutosave && (
        <div className="px-5 py-2 bg-om-elevated border-b border-om-accent/30 text-xs text-om-text flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 truncate">
            <RotateCcw className="w-3.5 h-3.5 text-om-accent shrink-0" />
            <span className="truncate">
              Previous session available: <strong>{pendingAutosave.projectName}</strong> (
              {pendingAutosave.trackRefs.length}{' '}
              {pendingAutosave.trackRefs.length === 1 ? 'track' : 'tracks'})
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                setPendingAutosave(null);
                void clearAutosaveManifest();
              }}
              className="px-2 py-1 text-[11px] text-om-text-dim hover:text-white cursor-pointer"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={() => void startProjectHydration(pendingAutosave)}
              className="px-3 py-1 rounded bg-om-accent hover:bg-om-accent-bright text-om-accent-ink text-[11px] font-semibold cursor-pointer"
            >
              Restore & Relink
            </button>
          </div>
        </div>
      )}

      {/* Status Notice Toast */}
      {statusNotice && (
        <div className="px-5 py-1.5 bg-om-positive/10 border-b border-om-positive/30 text-xs text-om-positive-soft flex items-center justify-between">
          <span>{statusNotice}</span>
          <button
            type="button"
            onClick={() => setStatusNotice(null)}
            className="text-xs font-medium underline cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Optional Error Toast */}
      {importError && (
        <div className="px-5 py-2 bg-om-danger/15 border-b border-om-danger/40 text-xs text-om-danger-soft flex items-center justify-between">
          <span>{importError}</span>
          <button
            type="button"
            onClick={() => setImportError(null)}
            className="text-xs font-medium underline cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Main Studio Vertical Split: Top (DJ Folder List | Current Playlist) + Bottom (NLE Tracks) */}
      <div ref={workspaceRef} className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* Top Library Row */}
        <div
          style={
            timelineCollapsed && !bothTopPanelsCollapsed
              ? undefined
              : { height: bothTopPanelsCollapsed ? 40 : topPaneHeightPx }
          }
          className={`${
            timelineCollapsed && !bothTopPanelsCollapsed
              ? 'flex-1 min-h-0'
              : `shrink-0 ${bothTopPanelsCollapsed ? 'min-h-0' : 'min-h-[180px]'} border-b border-white/[0.08]`
          } flex flex-row overflow-hidden`}
        >
          <DjFolderPanel
            djFolderName={djFolderName}
            djFolderFiles={djFolderFiles}
            playlistTracks={tracks}
            masterBpm={nleProject.masterBpm}
            canSyncDjFolder={djFolderHandle !== null}
            folderNeedsPermission={folderNeedsPermission}
            folderDiffSummary={folderDiffSummary}
            importingCount={importingCount}
            isAnalyzingFolder={isAnalyzingFolder}
            folderAnalysisProgress={folderAnalysisProgress}
            widthPx={djFolderWidthPx}
            isCollapsed={djFolderCollapsed}
            bothCollapsed={bothTopPanelsCollapsed}
            expandFullWidth={!djFolderCollapsed && playlistCollapsed}
            onToggleCollapse={() => {
              const nextCollapsed = !djFolderCollapsed;
              setDjFolderCollapsed(nextCollapsed);
              if (nextCollapsed && playlistCollapsed) {
                setTimelineCollapsed(false);
              }
            }}
            onLinkDjFolder={() => void triggerPickDjFolder('crate')}
            onReconnectDjFolder={() => void handleSyncDjFolder()}
            onDismissFolderDiff={() => setFolderDiffSummary(null)}
            onSyncDjFolder={() => void handleSyncDjFolder()}
            onStartFolderAnalysis={() => handleStartFolderAnalysis()}
            onRescanFolderAnalysis={() => handleStartFolderAnalysis(undefined, true)}
            onStopFolderAnalysis={handleStopFolderAnalysis}
            onAddFilesToPlaylist={(files, name) => void importFolderFilesIntoCrate(files, name)}
            onDropFolder={handleIndexDroppedDjFolder}
          />

          {!djFolderCollapsed && !playlistCollapsed && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize DJ Folder and Current Playlist widths"
              onPointerDown={handleStartHorizontalResize}
              title="Drag to resize DJ Folder and Current Playlist width"
              className="w-1.5 shrink-0 bg-om-well hover:bg-om-accent/40 border-r border-white/[0.08] cursor-col-resize transition-colors"
            />
          )}

          <TrackCrate
            tracks={tracks}
            timelineTrackCounts={timelineTrackCounts}
            timelineMixInfo={timelineMixInfo}
            activeMixTrackIds={activeMixTrackIds}
            onChangeMixPreset={handleChangeTrackMixPreset}
            playingTrackProgress={playingTrackProgress}
            importingCount={importingCount}
            isRescanning={isRescanningPlaylist}
            rescanProgress={playlistRescanProgress}
            onRescanPlaylist={handleRescanPlaylist}
            previewTrackId={previewTrackId}
            previewTimeSec={previewTimeSec}
            onTogglePreview={handleTogglePreview}
            onSeekPreview={handleSeekPreview}
            isCollapsed={playlistCollapsed}
            bothCollapsed={bothTopPanelsCollapsed}
            onToggleCollapse={() => {
              const nextCollapsed = !playlistCollapsed;
              setPlaylistCollapsed(nextCollapsed);
              if (nextCollapsed && djFolderCollapsed) {
                setTimelineCollapsed(false);
              }
            }}
            onImportFolderFiles={(files, name) => void importFolderFilesIntoCrate(files, name)}
            onReorderTracks={handleReorderTracks}
            onAddToTimeline={handleQuickAddToTimeline}
            onRemoveTrack={(trackId) =>
              setPendingDeleteTarget({ kind: 'playlist', trackId })
            }
            onUpdateTrackMeta={handleUpdateTrackMeta}
            onOpenBeatgridEditor={(track, draftBpm, draftKey) => {
              if (nleProjectRef.current.isPlaying) {
                nleEngine.stop();
                setNleProject((p) => (p.isPlaying ? { ...p, isPlaying: false } : p));
              }
              if (previewTrackIdRef.current) {
                nleEngine.stopPreview();
                setPreviewTrackId(null);
                setPreviewTimeSec(0);
              }
              setBeatgridEditorTarget({
                trackId: track.id,
                initialBpm: draftBpm,
                initialKey: draftKey,
              });
            }}
            autoOrderByTimeline={autoOrderPlaylist}
            onToggleAutoOrderByTimeline={() => setAutoOrderPlaylist((prev) => !prev)}
          />
        </div>

        {/* Horizontal Resize Divider */}
        {!bothTopPanelsCollapsed && !timelineCollapsed && (
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize library and timeline panes"
            onPointerDown={handleStartVerticalResize}
            title="Drag to resize library and timeline height"
            className="h-1.5 shrink-0 bg-om-well hover:bg-om-accent/40 border-b border-white/[0.08] cursor-row-resize transition-colors"
          />
        )}

        {/* Bottom NLE Timeline Tracks Workstation */}
        {!timelineCollapsed && (
          <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <NleTimeline
              project={nleProject}
              assetsMap={assetsMap}
              onUpdateProject={(patch) => {
                const liveProj = nleProjectRef.current;
                if (patch.masterVolume !== undefined && liveProj.isPlaying) {
                  nleEngine.setMasterVolumeLive(patch.masterVolume);
                }
                const needsLoopReschedule =
                  liveProj.isPlaying &&
                  (patch.loopEnabled === false ||
                    (patch.loopEndSec !== undefined && patch.loopEndSec > liveProj.loopEndSec));
                setNleProject((prev) => ({ ...prev, ...patch }));
                if (needsLoopReschedule) {
                  handleCommitTempoChange();
                }
              }}
              onTogglePlay={handleToggleNlePlay}
              onStop={handleNleStop}
              onSeek={handleNleSeek}
              onAddTrack={() =>
                setNleProject((prev) => ({
                  ...prev,
                  tracks: [...prev.tracks, createNleTrack(prev.tracks.length)],
                }))
              }
              onRemoveTrack={(trackId) =>
                setPendingDeleteTarget({ kind: 'timeline', trackId })
              }
              onUpdateTrack={handleUpdateNleTrack}
              onAddClipAt={handleAddNleClipAt}
              onUpdateClip={handleUpdateNleClip}
              onMoveClip={handleMoveNleClip}
              onUpdateClipTransition={handleUpdateClipTransition}
              onDeleteClip={handleDeleteNleClip}
              onDuplicateClip={handleDuplicateNleClip}
              onSplitAtPlayhead={handleSplitAtPlayhead}
              onCommitTempoChange={handleCommitTempoChange}
              onUpdateTrackBeatOffset={handleUpdateTrackBeatOffset}
            />
          </main>
        )}
      </div>

      <BeatgridEditorModal
        track={beatgridEditorTarget ? assetsMap.get(beatgridEditorTarget.trackId) ?? null : null}
        initialBpm={beatgridEditorTarget?.initialBpm}
        initialKey={beatgridEditorTarget?.initialKey}
        onClose={() => setBeatgridEditorTarget(null)}
        onSave={(trackId, bpm, musicalKey, beatOffsetSec) => {
          handleUpdateTrackMeta(trackId, bpm, musicalKey, beatOffsetSec);
          setStatusNotice(
            `Updated beatgrid (${bpm.toFixed(1)} BPM · ${musicalKey} · ${(beatOffsetSec * 1000).toFixed(1)} ms offset).`
          );
        }}
      />

      <ExportModal
        isOpen={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        project={nleProject}
        assetsMap={assetsMap}
      />

      <NewMixModal
        isOpen={newMixModalOpen}
        currentProjectName={projectName}
        trackCount={tracks.length}
        clipCount={totalClipCount}
        onSaveAndNew={handleSaveAndStartNewMix}
        onDiscardAndNew={handleDiscardAndStartNewMix}
        onClose={() => setNewMixModalOpen(false)}
      />

      <AboutModal
        isOpen={aboutModalOpen}
        onClose={() => setAboutModalOpen(false)}
      />

      <HelpModal
        isOpen={helpModalOpen}
        onClose={() => setHelpModalOpen(false)}
      />

      <ConfirmDeleteModal
        isOpen={isDeleteModalOpen}
        title={deleteModalConfig?.title ?? ''}
        subtitle={deleteModalConfig?.subtitle ?? ''}
        itemLabel={deleteModalConfig?.itemLabel ?? ''}
        warningText={deleteModalConfig?.warningText}
        confirmLabel={deleteModalConfig?.confirmLabel}
        onCancel={() => setPendingDeleteTarget(null)}
        onConfirm={handleConfirmDeleteTrack}
      />

      <RelinkTracksModal
        isOpen={relinkModalOpen}
        manifest={pendingManifest}
        pendingHandleName={pendingHandleForModal?.name ?? null}
        missingTracks={relinkMissingTracks}
        resolvedCount={relinkResolvedMap.size}
        isProcessing={relinkProcessing}
        progressText={relinkProgressText}
        onGrantFolderPermission={() => void handleGrantPendingFolderPermission()}
        onChooseFolder={() => void triggerPickDjFolder('relink')}
        onLocateSingleTrack={(ref, file) => void handleLocateSingleTrack(ref, file)}
        onContinueWithPartial={() => {
          if (pendingManifest) {
            commitLoadedProject(pendingManifest, Array.from(relinkResolvedMap.values()));
          }
        }}
        onClose={() => {
          setRelinkModalOpen(false);
          setPendingManifest(null);
          setPendingHandleForModal(null);
          setRelinkResolvedMap(new Map());
          setRelinkMissingTracks([]);
          setRelinkProgressText(null);
        }}
      />

      {showWelcome && (
        <WelcomeScreen
          pendingAutosaveName={showAutosaveBanner && pendingAutosave ? pendingAutosave.projectName : null}
          pendingAutosaveTrackCount={showAutosaveBanner && pendingAutosave ? pendingAutosave.trackRefs.length : 0}
          djFolderStatus={((): WelcomeDjFolderStatus => {
            if (!djFolderChecked && !djFolderVerified && !folderNeedsPermission) return 'checking';
            if (djFolderVerified && djFolderName) return 'ok';
            if (folderNeedsPermission && djFolderName) return 'needs-permission';
            return 'not-linked';
          })()}
          djFolderName={djFolderName}
          djFolderFileCount={djFolderFiles.length}
          onLinkDjFolder={() => void triggerPickDjFolder('crate')}
          onReconnectDjFolder={djFolderHandle ? () => void handleSyncDjFolder() : undefined}
          onEnterStudio={() => setShowWelcome(false)}
          onLoadMix={() => loadProjectInputRef.current?.click()}
          onResumeAutosave={
            showAutosaveBanner && pendingAutosave
              ? () => void startProjectHydration(pendingAutosave)
              : undefined
          }
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AppStudio />
    </ThemeProvider>
  );
}
