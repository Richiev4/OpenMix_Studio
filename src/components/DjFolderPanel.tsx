import React, { useMemo, useState } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderOpen,
  Pause,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import {
  formatFileSize,
  formatTimecode,
  scoreTrackCompatibility,
} from '../audio/analysis';
import { extractDroppedAudioFiles } from '../storage/djFolder';
import type {
  CompatibilityTier,
  DjFolderDiffSummary,
  FolderAudioFile,
  TrackAsset,
  TrackCompatibility,
} from '../types/audio';

interface DjFolderPanelProps {
  /** Display name of the currently linked DJ folder */
  djFolderName: string | null;
  /** Indexed audio files discovered inside the linked DJ folder */
  djFolderFiles: FolderAudioFile[];
  /** Current tracks already loaded in the playlist (used to show added state & reference matching) */
  playlistTracks: TrackAsset[];
  /** Current project master BPM used as fallback reference when playlist is empty or selected */
  masterBpm: number;
  /** Whether a persisted DirectoryHandle is available for one-click rescan */
  canSyncDjFolder: boolean;
  /** True when a persisted folder handle requires a user gesture to grant read permission */
  folderNeedsPermission?: boolean;
  /** Change summary detected when scanning the assigned folder against its previous snapshot */
  folderDiffSummary?: DjFolderDiffSummary | null;
  /** Number of tracks currently decoding/analyzing for playlist import */
  importingCount: number;
  /** Whether background pre-analysis is currently scanning the DJ folder */
  isAnalyzingFolder: boolean;
  /** Progress counter for the current background scan batch */
  folderAnalysisProgress: { done: number; total: number } | null;
  /** Opens folder picker to link/change the DJ folder */
  onLinkDjFolder: () => void;
  /** Requests read permission on the persisted folder handle and scans it for changes */
  onReconnectDjFolder?: () => void;
  /** Dismisses the folder change summary banner */
  onDismissFolderDiff?: () => void;
  /** Rescans the linked DirectoryHandle for newly added files */
  onSyncDjFolder: () => void;
  /** Starts background BPM & Key pre-analysis across uncached DJ folder files */
  onStartFolderAnalysis: () => void;
  /** Forces fresh BPM, beat phase & Key re-analysis across all DJ folder files */
  onRescanFolderAnalysis?: () => void;
  /** Stops/pauses an active background DJ folder scan */
  onStopFolderAnalysis: () => void;
  /** Adds selected folder audio files into the right-hand playlist */
  onAddFilesToPlaylist: (files: FolderAudioFile[], folderName?: string | null) => void;
  /** Indexes a folder dropped directly from the OS file manager */
  onDropFolder: (files: FolderAudioFile[], folderName?: string | null) => void;
  /** Dynamic width in pixels when expanded alongside the playlist */
  widthPx?: number;
  /** Whether the DJ Folder panel is currently collapsed */
  isCollapsed?: boolean;
  /** True when both top library panels are collapsed into a compact top bar */
  bothCollapsed?: boolean;
  /** Expands DJ Folder to fill available width when the playlist panel is collapsed */
  expandFullWidth?: boolean;
  /** Toggles collapsed state of the DJ Folder panel */
  onToggleCollapse?: () => void;
}

const ALL_FOLDERS_KEY = '__ALL__';
const ROOT_FOLDER_KEY = '__ROOT__';
const REF_LAST_PLAYLIST = '__LAST_TRACK__';
const REF_MASTER_BPM = '__MASTER_BPM__';

type FolderSortKey = 'trackNo' | 'title' | 'bpm' | 'key' | 'length' | 'fit';
type SortDirection = 'asc' | 'desc';

/** Extracts the directory path portion of a relative file path. */
function getParentFolderPath(relativePath: string): string {
  const lastSlash = relativePath.lastIndexOf('/');
  if (lastSlash <= 0) return ROOT_FOLDER_KEY;
  return relativePath.slice(0, lastSlash);
}

/** Formats a folder key into a human-readable label. */
function formatFolderLabel(folderKey: string, rootName: string | null): string {
  if (folderKey === ALL_FOLDERS_KEY) return 'All Tracks';
  if (folderKey === ROOT_FOLDER_KEY) return rootName ? `${rootName} (Root)` : 'Root Folder';
  return folderKey;
}

/** Converts Camelot string (e.g. "8A", "12B") into a sortable numeric index. */
function camelotSortOrder(code: string): number {
  const match = code.trim().toUpperCase().match(/^(\d{1,2})([AB])$/);
  if (!match) return 999;
  return parseInt(match[1], 10) * 2 + (match[2] === 'B' ? 1 : 0);
}

/** Returns subtle hardware-toned styling for each compatibility tier. */
function getCompatibilityBadgeStyle(tier: CompatibilityTier): string {
  switch (tier) {
    case 'perfect':
      return 'bg-om-positive/15 text-om-positive-bright border border-om-positive/30';
    case 'great':
      return 'bg-om-secondary/15 text-om-secondary-bright border border-om-secondary/30';
    case 'good':
      return 'bg-om-accent/15 text-om-accent-bright border border-om-accent/30';
    case 'stretch':
      return 'bg-om-text-muted/10 text-om-text-muted border border-white/[0.08]';
    case 'clash':
    default:
      return 'bg-om-danger/10 text-om-danger-bright/80 border border-om-danger/20';
  }
}

export const DjFolderPanel: React.FC<DjFolderPanelProps> = ({
  djFolderName,
  djFolderFiles,
  playlistTracks,
  masterBpm,
  canSyncDjFolder,
  folderNeedsPermission = false,
  folderDiffSummary = null,
  importingCount,
  isAnalyzingFolder,
  folderAnalysisProgress,
  onLinkDjFolder,
  onReconnectDjFolder,
  onDismissFolderDiff,
  onSyncDjFolder,
  onStartFolderAnalysis,
  onRescanFolderAnalysis,
  onStopFolderAnalysis,
  onAddFilesToPlaylist,
  onDropFolder,
  widthPx,
  isCollapsed = false,
  bothCollapsed = false,
  expandFullWidth = false,
  onToggleCollapse,
}) => {
  const [selectedFolder, setSelectedFolder] = useState<string>(ALL_FOLDERS_KEY);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortKey, setSortKey] = useState<FolderSortKey>('trackNo');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [compatibleOnly, setCompatibleOnly] = useState(false);
  const [referenceSelection, setReferenceSelection] = useState<string>(REF_LAST_PLAYLIST);
  const [isDragOver, setIsDragOver] = useState(false);

  const handleSortHeaderClick = (column: Exclude<FolderSortKey, 'fit'>) => {
    if (sortKey === column) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(column);
      setSortDirection('asc');
    }
  };

  const addedPathSet = useMemo(
    () => new Set((folderDiffSummary?.addedPaths ?? []).map((p) => p.toLowerCase())),
    [folderDiffSummary]
  );
  const modifiedPathSet = useMemo(
    () => new Set((folderDiffSummary?.modifiedPaths ?? []).map((p) => p.toLowerCase())),
    [folderDiffSummary]
  );
  const folderDiffParts = useMemo(() => {
    if (!folderDiffSummary || !folderDiffSummary.hasBaseline) return [];
    const parts: string[] = [];
    if (folderDiffSummary.addedPaths.length > 0) {
      parts.push(`+${folderDiffSummary.addedPaths.length} added`);
    }
    if (folderDiffSummary.modifiedPaths.length > 0) {
      parts.push(`${folderDiffSummary.modifiedPaths.length} modified`);
    }
    if (folderDiffSummary.removedPaths.length > 0) {
      parts.push(`${folderDiffSummary.removedPaths.length} removed`);
    }
    return parts;
  }, [folderDiffSummary]);

  // Build fast lookup sets to indicate which DJ folder files are already in the playlist
  const playlistMap = useMemo(() => {
    const byRel = new Map<string, TrackAsset>();
    const byNameSize = new Map<string, TrackAsset>();
    for (const track of playlistTracks) {
      if (track.relativePath) {
        byRel.set(track.relativePath.toLowerCase(), track);
      }
      byNameSize.set(`${track.fileName.toLowerCase()}::${track.fileSize}`, track);
    }
    return { byRel, byNameSize };
  }, [playlistTracks]);

  const findPlaylistMatch = (file: FolderAudioFile): TrackAsset | undefined => {
    return (
      playlistMap.byRel.get(file.relativePath.toLowerCase()) ??
      playlistMap.byNameSize.get(`${file.fileName.toLowerCase()}::${file.fileSize}`)
    );
  };

  // Resolve the active reference track (or timeline BPM) to score compatibility against
  const activeReference = useMemo(() => {
    if (referenceSelection === REF_MASTER_BPM || playlistTracks.length === 0) {
      return {
        label: `Timeline ${masterBpm.toFixed(1)} BPM`,
        bpm: masterBpm,
        camelotCode: null as string | null,
      };
    }

    const chosenTrack =
      referenceSelection === REF_LAST_PLAYLIST
        ? playlistTracks[playlistTracks.length - 1]
        : playlistTracks.find((t) => t.id === referenceSelection) ??
          playlistTracks[playlistTracks.length - 1];

    return {
      label: `${chosenTrack.name} (${chosenTrack.bpm.toFixed(0)} · ${chosenTrack.camelotCode})`,
      bpm: chosenTrack.bpm,
      camelotCode: chosenTrack.camelotCode,
    };
  }, [masterBpm, playlistTracks, referenceSelection]);

  // Count analyzed vs unanalyzed files across the linked DJ folder
  const analysisStats = useMemo(() => {
    let analyzed = 0;
    let pending = 0;
    for (const file of djFolderFiles) {
      const playlistTrack = findPlaylistMatch(file);
      if (file.analysis || playlistTrack) {
        analyzed += 1;
      } else if (!file.analysisError) {
        pending += 1;
      }
    }
    return { analyzed, pending, total: djFolderFiles.length };
  }, [djFolderFiles, playlistMap]);

  // Group file counts by subfolder path so the user can browse folders cleanly
  const folderEntries = useMemo(() => {
    const counts = new Map<string, number>();
    for (const file of djFolderFiles) {
      const folder = getParentFolderPath(file.relativePath);
      counts.set(folder, (counts.get(folder) ?? 0) + 1);
    }

    const sortedKeys = Array.from(counts.keys()).sort((a, b) => {
      if (a === ROOT_FOLDER_KEY) return -1;
      if (b === ROOT_FOLDER_KEY) return 1;
      return a.localeCompare(b);
    });

    return [
      { key: ALL_FOLDERS_KEY, label: 'All Tracks', count: djFolderFiles.length },
      ...sortedKeys.map((key) => ({
        key,
        label: key === ROOT_FOLDER_KEY ? 'Root' : key,
        count: counts.get(key) ?? 0,
      })),
    ];
  }, [djFolderFiles]);

  // Keep selectedFolder valid when folder contents change
  const activeFolderKey = folderEntries.some((f) => f.key === selectedFolder)
    ? selectedFolder
    : ALL_FOLDERS_KEY;

  const hasSubfolders = folderEntries.length > 2;

  // Enrich visible files with stable track numbers, effective metadata & compatibility score
  const visibleRows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    interface EnrichedRow {
      trackNo: number;
      displayName: string;
      file: FolderAudioFile;
      inPlaylist: boolean;
      meta: {
        bpm: number;
        musicalKey: string;
        camelotCode: string;
        duration: number;
      } | null;
      compat: TrackCompatibility | null;
    }

    const folderScopedFiles = djFolderFiles
      .filter(
        (file) =>
          activeFolderKey === ALL_FOLDERS_KEY ||
          getParentFolderPath(file.relativePath) === activeFolderKey
      )
      .slice()
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    const rows: EnrichedRow[] = [];

    folderScopedFiles.forEach((file, idx) => {
      const playlistTrack = findPlaylistMatch(file);
      const inPlaylist = Boolean(playlistTrack);
      const meta = playlistTrack
        ? {
            bpm: playlistTrack.bpm,
            musicalKey: playlistTrack.musicalKey,
            camelotCode: playlistTrack.camelotCode,
            duration: playlistTrack.duration,
          }
        : file.analysis
        ? {
            bpm: file.analysis.bpm,
            musicalKey: file.analysis.musicalKey,
            camelotCode: file.analysis.camelotCode,
            duration: file.analysis.duration,
          }
        : null;

      if (query) {
        const matchesText =
          file.fileName.toLowerCase().includes(query) ||
          file.relativePath.toLowerCase().includes(query) ||
          (meta
            ? meta.musicalKey.toLowerCase().includes(query) ||
              meta.camelotCode.toLowerCase().includes(query) ||
              meta.bpm.toFixed(1).includes(query)
            : false);
        if (!matchesText) return;
      }

      const compat = meta
        ? scoreTrackCompatibility(
            { bpm: meta.bpm, camelotCode: meta.camelotCode },
            { bpm: activeReference.bpm, camelotCode: activeReference.camelotCode }
          )
        : null;

      if (compatibleOnly) {
        if (!compat || (compat.tier !== 'perfect' && compat.tier !== 'great' && compat.tier !== 'good')) {
          return;
        }
      }

      rows.push({
        trackNo: idx + 1,
        displayName: file.fileName.replace(/\.[^/.]+$/, ''),
        file,
        inPlaylist,
        meta,
        compat,
      });
    });

    const dir = sortDirection === 'asc' ? 1 : -1;

    // Apply selected column sort ordering (unscanned rows always stay at bottom for metadata sorts)
    rows.sort((a, b) => {
      if (sortKey === 'trackNo') {
        if (a.trackNo !== b.trackNo) return (a.trackNo - b.trackNo) * dir;
      } else if (sortKey === 'title') {
        const cmp = a.displayName.localeCompare(b.displayName, undefined, {
          numeric: true,
          sensitivity: 'base',
        });
        if (cmp !== 0) return cmp * dir;
      } else if (sortKey === 'bpm') {
        const hasA = a.meta !== null;
        const hasB = b.meta !== null;
        if (hasA !== hasB) return hasA ? -1 : 1;
        if (hasA && hasB && a.meta!.bpm !== b.meta!.bpm) {
          return (a.meta!.bpm - b.meta!.bpm) * dir;
        }
      } else if (sortKey === 'key') {
        const hasA = a.meta !== null;
        const hasB = b.meta !== null;
        if (hasA !== hasB) return hasA ? -1 : 1;
        if (hasA && hasB) {
          const ca = camelotSortOrder(a.meta!.camelotCode);
          const cb = camelotSortOrder(b.meta!.camelotCode);
          if (ca !== cb) return (ca - cb) * dir;
          const kcmp = a.meta!.musicalKey.localeCompare(b.meta!.musicalKey);
          if (kcmp !== 0) return kcmp * dir;
        }
      } else if (sortKey === 'length') {
        const hasA = a.meta !== null;
        const hasB = b.meta !== null;
        if (hasA !== hasB) return hasA ? -1 : 1;
        if (hasA && hasB && a.meta!.duration !== b.meta!.duration) {
          return (a.meta!.duration - b.meta!.duration) * dir;
        }
      } else if (sortKey === 'fit') {
        const hasA = a.compat !== null;
        const hasB = b.compat !== null;
        if (hasA !== hasB) return hasA ? -1 : 1;
        if (hasA && hasB && a.compat!.score !== b.compat!.score) {
          return (a.compat!.score - b.compat!.score) * dir;
        }
      }
      return a.trackNo - b.trackNo;
    });

    return rows;
  }, [
    djFolderFiles,
    activeFolderKey,
    searchQuery,
    playlistMap,
    activeReference,
    compatibleOnly,
    sortKey,
    sortDirection,
  ]);

  // Count visible files not yet loaded into the current playlist
  const pendingInView = useMemo(
    () => visibleRows.filter((row) => !row.inPlaylist).map((row) => row.file),
    [visibleRows]
  );

  const handleDrop = async (e: React.DragEvent<HTMLElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const { folderName, files } = await extractDroppedAudioFiles(e.dataTransfer);
    if (files.length > 0) {
      onDropFolder(files, folderName ?? 'Dropped Folder');
    }
  };

  if (isCollapsed && bothCollapsed) {
    return (
      <section
        aria-label="DJ Folder List (Collapsed)"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setIsDragOver(true);
          }
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        className={`flex-1 min-w-0 h-10 bg-om-panel border-r border-white/[0.08] px-3 flex items-center justify-between gap-2 select-none transition-colors ${
          isDragOver ? 'bg-om-elevated ring-1 ring-inset ring-om-accent/60' : ''
        }`}
      >
        <button
          type="button"
          onClick={onToggleCollapse}
          title="Expand DJ Folder"
          className="min-w-0 flex-1 flex items-center gap-2 text-left cursor-pointer group"
        >
          <FolderOpen
            className={`w-3.5 h-3.5 shrink-0 ${
              djFolderName ? 'text-om-accent' : 'text-om-text-faint'
            }`}
          />
          <span className="font-display text-xs font-semibold text-om-text group-hover:text-om-accent transition-colors truncate">
            {djFolderName ? `DJ Folder · ${djFolderName}` : 'DJ Folder'}
          </span>
          {djFolderFiles.length > 0 && (
            <span className="text-[10px] font-mono tabular-nums text-om-text-faint shrink-0">
              ({djFolderFiles.length})
            </span>
          )}
        </button>
        {onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            title="Expand DJ Folder"
            aria-label="Expand DJ Folder"
            className="p-1 rounded bg-om-control hover:bg-om-control-hover text-om-text-muted hover:text-om-text border border-white/[0.08] transition-colors shrink-0 cursor-pointer"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        )}
      </section>
    );
  }

  if (isCollapsed) {
    return (
      <section
        aria-label="DJ Folder List (Collapsed)"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setIsDragOver(true);
          }
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        className={`w-10 shrink-0 h-full bg-om-panel border-r border-white/[0.08] py-2.5 flex flex-col items-center gap-3 select-none transition-colors ${
          isDragOver ? 'bg-om-elevated ring-1 ring-inset ring-om-accent/60' : ''
        }`}
      >
        <button
          type="button"
          onClick={onToggleCollapse}
          title="Expand DJ Folder"
          aria-label="Expand DJ Folder"
          className="p-1 rounded bg-om-control hover:bg-om-control-hover text-om-text-muted hover:text-om-text border border-white/[0.08] transition-colors cursor-pointer"
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={onToggleCollapse}
          title="Expand DJ Folder"
          className="flex-1 w-full flex flex-col items-center justify-start gap-2 pt-1 cursor-pointer group overflow-hidden"
        >
          <FolderOpen
            className={`w-3.5 h-3.5 shrink-0 ${
              djFolderName ? 'text-om-accent' : 'text-om-text-faint'
            }`}
          />
          <span
            style={{ writingMode: 'vertical-rl' }}
            className="rotate-180 text-[11px] font-display font-semibold tracking-wide text-om-text-muted group-hover:text-om-text transition-colors whitespace-nowrap"
          >
            DJ Folder{djFolderFiles.length > 0 ? ` (${djFolderFiles.length})` : ''}
          </span>
        </button>
      </section>
    );
  }

  const renderSortIcon = (column: Exclude<FolderSortKey, 'fit'>) => {
    if (sortKey !== column) {
      return <ArrowUpDown className="w-2.5 h-2.5 opacity-35 group-hover/col:opacity-80 shrink-0" />;
    }
    return sortDirection === 'asc' ? (
      <ArrowUp className="w-2.5 h-2.5 text-om-accent-bright shrink-0" />
    ) : (
      <ArrowDown className="w-2.5 h-2.5 text-om-accent-bright shrink-0" />
    );
  };

  return (
    <section
      aria-label="DJ Folder List"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setIsDragOver(true);
        }
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
      style={
        !expandFullWidth && widthPx !== undefined
          ? { width: widthPx, maxWidth: 'calc(100% - 260px)' }
          : undefined
      }
      className={`${
        expandFullWidth
          ? 'flex-1 min-w-0'
          : widthPx !== undefined
          ? 'min-w-[260px] shrink-0'
          : 'w-[380px] lg:w-[460px] xl:w-[510px] shrink-0'
      } h-full bg-om-panel border-r border-white/[0.08] flex flex-col select-none transition-colors ${
        isDragOver ? 'bg-om-elevated ring-1 ring-inset ring-om-accent/60' : ''
      }`}
    >
      {/* DJ Folder Header */}
      <div className="px-4 py-2.5 border-b border-white/[0.08] flex items-center justify-between gap-2 shrink-0">
        <div className="min-w-0 flex items-center gap-2">
          <FolderOpen
            className={`w-4 h-4 shrink-0 ${
              djFolderName ? 'text-om-accent' : 'text-om-text-faint'
            }`}
          />
          <div className="min-w-0">
            <h2 className="font-display text-sm font-semibold text-om-text tracking-tight truncate">
              {djFolderName ? `DJ Folder · ${djFolderName}` : 'DJ Folder'}
            </h2>
            <p className="text-[11px] text-om-text-faint font-mono tabular-nums truncate">
              {djFolderFiles.length > 0
                ? `${analysisStats.analyzed}/${analysisStats.total} BPM/Key scanned`
                : 'No folder linked'}
              {importingCount > 0 ? ` · Importing ${importingCount}...` : ''}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {djFolderFiles.length > 0 &&
            (isAnalyzingFolder || analysisStats.pending > 0 || onRescanFolderAnalysis) && (
              <button
                type="button"
                onClick={
                  isAnalyzingFolder
                    ? onStopFolderAnalysis
                    : analysisStats.pending > 0
                    ? onStartFolderAnalysis
                    : onRescanFolderAnalysis
                }
                title={
                  isAnalyzingFolder
                    ? 'Pause background BPM & Key analysis'
                    : analysisStats.pending > 0
                    ? `Pre-analyze BPM & Key for ${analysisStats.pending} uncached folder tracks`
                    : `Re-scan BPM, beat grid & Key for all ${djFolderFiles.length} folder tracks`
                }
                className={`px-2.5 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer border ${
                  isAnalyzingFolder
                    ? 'bg-om-accent/15 border-om-accent/40 text-om-accent-bright hover:bg-om-accent/25'
                    : 'bg-om-control hover:bg-om-control-hover border-white/[0.08] text-om-text'
                }`}
              >
                {isAnalyzingFolder ? (
                  <>
                    <Pause className="w-3 h-3" />
                    {folderAnalysisProgress
                      ? `${folderAnalysisProgress.done}/${folderAnalysisProgress.total}`
                      : 'Pause'}
                  </>
                ) : analysisStats.pending > 0 ? (
                  <>
                    <Activity className="w-3.5 h-3.5 text-om-accent" />
                    Scan BPM/Key
                  </>
                ) : (
                  <>
                    <Activity className="w-3.5 h-3.5 text-om-accent" />
                    Re-scan BPM/Key
                  </>
                )}
              </button>
            )}
          {canSyncDjFolder && djFolderFiles.length > 0 && (
            <button
              type="button"
              onClick={onSyncDjFolder}
              title="Rescan linked DJ Folder for changes"
              className="p-1.5 rounded-md bg-om-control hover:bg-om-control-hover text-om-text-muted hover:text-om-text border border-white/[0.08] transition-colors cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          )}
          {djFolderFiles.length > 0 && (
            <button
              type="button"
              onClick={onLinkDjFolder}
              title={`Change linked DJ Folder. Your browser may say "Upload" on the next screen. Please be assured that this only "Uploads/Indexes" data to this app's local database — everything stays local.`}
              className="px-3 py-1.5 rounded-md bg-om-control hover:bg-om-control-hover border border-white/[0.08] text-om-text text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Change
            </button>
          )}
          {onToggleCollapse && (
            <button
              type="button"
              onClick={onToggleCollapse}
              title="Collapse DJ Folder"
              aria-label="Collapse DJ Folder"
              className="p-1.5 rounded-md bg-om-control hover:bg-om-control-hover text-om-text-muted hover:text-om-text border border-white/[0.08] transition-colors cursor-pointer"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Filter, Match Reference, Sort & Bulk Add Toolbar */}
      {djFolderFiles.length > 0 && (
        <div className="px-3 py-2 border-b border-white/[0.06] bg-om-sub space-y-1.5 shrink-0">
          <div className="flex items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <Search className="w-3.5 h-3.5 text-om-text-icon absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search title, BPM, key (e.g. 8A, Am)..."
                className="w-full bg-om-base border border-white/[0.08] rounded pl-8 pr-2.5 py-1 text-xs text-om-text placeholder-om-text-icon focus:outline-none focus:border-om-accent/60"
              />
            </div>
            <button
              type="button"
              disabled={pendingInView.length === 0}
              onClick={() => onAddFilesToPlaylist(pendingInView, djFolderName)}
              title={
                pendingInView.length > 0
                  ? `Add ${pendingInView.length} tracks from "${formatFolderLabel(activeFolderKey, djFolderName)}" to playlist`
                  : 'All tracks in this view are already in the playlist'
              }
              className="px-2.5 py-1 rounded bg-om-control-alt hover:bg-om-accent text-om-text hover:text-om-accent-ink disabled:opacity-40 disabled:hover:bg-om-control-alt disabled:hover:text-om-text text-[11px] font-medium inline-flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-3 h-3" />
              Add All ({pendingInView.length})
            </button>
          </div>

          {/* Match Reference & Sort Controls (shown once any track is analyzed) */}
          {analysisStats.analyzed > 0 && (
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                <span className="text-om-text-faint shrink-0">Fit vs:</span>
                <select
                  aria-label="Compatibility reference track"
                  value={
                    referenceSelection !== REF_LAST_PLAYLIST &&
                    referenceSelection !== REF_MASTER_BPM &&
                    !playlistTracks.some((t) => t.id === referenceSelection)
                      ? REF_LAST_PLAYLIST
                      : referenceSelection
                  }
                  onChange={(e) => setReferenceSelection(e.target.value)}
                  className="min-w-0 max-w-[180px] bg-om-base border border-white/[0.08] rounded px-1.5 py-0.5 text-[11px] font-mono text-om-text-secondary focus:outline-none focus:border-om-accent/60 truncate"
                >
                  {playlistTracks.length > 0 && (
                    <option value={REF_LAST_PLAYLIST}>
                      Last Playlist ({playlistTracks[playlistTracks.length - 1].bpm.toFixed(0)} ·{' '}
                      {playlistTracks[playlistTracks.length - 1].camelotCode})
                    </option>
                  )}
                  <option value={REF_MASTER_BPM}>
                    Timeline BPM ({masterBpm.toFixed(1)})
                  </option>
                  {playlistTracks.map((t, idx) => (
                    <option key={t.id} value={t.id}>
                      #{idx + 1} {t.name} ({t.bpm.toFixed(0)} · {t.camelotCode})
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setCompatibleOnly((v) => !v)}
                  title="Show only harmonically & tempo compatible tracks"
                  className={`px-2 py-0.5 rounded text-[10px] font-mono inline-flex items-center gap-1 border transition-colors cursor-pointer ${
                    compatibleOnly
                      ? 'bg-om-positive/15 text-om-positive-bright border-om-positive/40'
                      : 'bg-om-base text-om-text-dim border-white/[0.08] hover:text-om-text'
                  }`}
                >
                  <Sparkles className="w-2.5 h-2.5" />
                  Fit Only
                </button>
                <select
                  aria-label="Sort folder tracks"
                  value={sortKey}
                  onChange={(e) => {
                    const nextKey = e.target.value as FolderSortKey;
                    setSortKey(nextKey);
                    setSortDirection(nextKey === 'fit' ? 'desc' : 'asc');
                  }}
                  className="bg-om-base border border-white/[0.08] rounded px-1.5 py-0.5 text-[10px] font-mono text-om-text-secondary focus:outline-none focus:border-om-accent/60"
                >
                  <option value="trackNo">Sort: Track No</option>
                  <option value="title">Sort: Title</option>
                  <option value="fit">Sort: Best Fit</option>
                  <option value="bpm">Sort: BPM</option>
                  <option value="key">Sort: Key</option>
                  <option value="length">Sort: Length</option>
                </select>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Startup / Resync Folder Change Indicator */}
      {djFolderFiles.length > 0 && folderDiffSummary?.hasBaseline && (
        <div
          className={`px-3 py-1.5 border-b text-[11px] flex items-center justify-between gap-2 shrink-0 ${
            folderDiffParts.length > 0
              ? 'bg-om-accent/10 border-om-accent/25 text-om-accent-soft'
              : 'bg-om-positive/10 border-om-positive/20 text-om-positive-soft'
          }`}
        >
          <span className="truncate font-mono">
            {folderDiffParts.length > 0
              ? `Folder updated: ${folderDiffParts.join(' · ')}`
              : 'Folder scanned: up to date'}
          </span>
          {onDismissFolderDiff && (
            <button
              type="button"
              onClick={onDismissFolderDiff}
              aria-label="Dismiss folder scan notice"
              className="p-0.5 rounded hover:bg-white/10 text-current opacity-80 hover:opacity-100 shrink-0 cursor-pointer"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      )}

      {/* Main DJ Folder Body: Empty State or Subfolder + File Browser */}
      {djFolderFiles.length === 0 ? (
        <div className="flex-1 min-h-0 flex flex-col items-center p-3 text-center overflow-y-auto">
          <div
            onClick={
              folderNeedsPermission && onReconnectDjFolder
                ? onReconnectDjFolder
                : onLinkDjFolder
            }
            className="w-full my-auto rounded-lg border border-dashed border-white/[0.16] hover:border-om-accent/60 bg-om-well px-3.5 py-3 flex flex-col items-center justify-center gap-2 cursor-pointer transition-colors"
          >
            <div className="w-8 h-8 rounded-md bg-om-card border border-white/[0.08] flex items-center justify-center text-om-accent shrink-0">
              <FolderOpen className="w-4 h-4" />
            </div>
            {/* Expand text container width to reduce line wrapping inside the panel */}
            <div className="w-full max-w-[520px] space-y-1">
              <p className="text-xs font-medium text-om-text">
                {folderNeedsPermission && djFolderName
                  ? `Scan "${djFolderName}" for changes`
                  : djFolderName
                  ? `Reconnect "${djFolderName}" or drop folder here`
                  : 'Link or drop your DJ Folder here'}
              </p>
              <p className="text-[11px] text-om-text-subtle leading-snug">
                {folderNeedsPermission && djFolderName
                  ? 'Grant read access to rescan your assigned folder on startup and update track info.'
                  : 'Pre-scan BPM & Key across local crates to find harmonic matches. Files stay 100% local in your browser and are never sent anywhere.'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="px-3 py-1 rounded bg-om-accent text-om-accent-ink text-xs font-semibold">
                {folderNeedsPermission && djFolderName
                  ? 'Reconnect & Scan'
                  : djFolderName
                  ? 'Select Folder'
                  : 'Link DJ Folder'}
              </span>
              {folderNeedsPermission && djFolderName && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onLinkDjFolder();
                  }}
                  title={`Select a different DJ Folder. Your browser may say "Upload" on the next screen. Please be assured that this only "Uploads/Indexes" data to this app's local database — everything stays local.`}
                  className="px-2.5 py-1 rounded bg-om-control hover:bg-om-control-hover border border-white/[0.08] text-om-text-secondary text-xs font-medium cursor-pointer"
                >
                  Change Folder
                </button>
              )}
            </div>
            {/* Clarify browser native webkitdirectory "Upload" dialog wording */}
            <p className="w-full max-w-[540px] text-[10px] text-om-text-faint leading-snug">
              Your browser may say{' '}
              <span className="font-medium text-om-text-secondary">&ldquo;Upload&rdquo;</span> on
              the next screen. Please be assured that this only{' '}
              <span className="font-medium text-om-text-secondary">
                &ldquo;Uploads/Indexes&rdquo;
              </span>{' '}
              data to this app&rsquo;s local database &mdash; everything stays local.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* Subfolder List (shown when nested folders exist) */}
          {hasSubfolders && (
            <div className="w-[136px] lg:w-[152px] shrink-0 border-r border-white/[0.06] bg-om-sub overflow-y-auto divide-y divide-white/[0.04]">
              {folderEntries.map((entry) => {
                const isSelected = activeFolderKey === entry.key;
                return (
                  <button
                    key={entry.key}
                    type="button"
                    onClick={() => setSelectedFolder(entry.key)}
                    title={entry.label}
                    className={`w-full px-2.5 py-2 text-left flex items-center justify-between gap-1.5 transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-om-control text-om-accent'
                        : 'text-om-text-muted hover:bg-om-elevated hover:text-om-text'
                    }`}
                  >
                    <span className="inline-flex items-center gap-1.5 min-w-0 text-[11px] font-medium truncate">
                      <Folder className="w-3 h-3 shrink-0" />
                      <span className="truncate">{entry.label}</span>
                    </span>
                    <span className="text-[10px] font-mono tabular-nums text-om-text-faint shrink-0">
                      {entry.count}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Audio Files Table inside Selected DJ Folder */}
          <div className="flex-1 min-w-0 overflow-auto">
            <div className="min-w-[390px]">
              {/* Sticky Highlighted Sortable Column Headers */}
              <div
                role="row"
                className="sticky top-0 z-10 grid grid-cols-[44px_minmax(130px,1fr)_56px_74px_54px_56px] items-stretch bg-om-elevated/95 backdrop-blur-sm border-b border-white/[0.1] text-[10px] font-mono uppercase tracking-wider"
              >
                <button
                  type="button"
                  onClick={() => handleSortHeaderClick('trackNo')}
                  title="Sort by Track No"
                  aria-sort={
                    sortKey === 'trackNo'
                      ? sortDirection === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                  className={`group/col px-2 py-1.5 flex items-center justify-center gap-0.5 border-r border-white/[0.06] transition-colors cursor-pointer ${
                    sortKey === 'trackNo'
                      ? 'bg-om-accent/15 text-om-accent-bright border-b-2 border-b-om-accent'
                      : 'bg-white/[0.02] text-om-text-secondary hover:bg-white/[0.06] hover:text-om-text'
                  }`}
                >
                  <span>#</span>
                  {renderSortIcon('trackNo')}
                </button>

                <button
                  type="button"
                  onClick={() => handleSortHeaderClick('title')}
                  title="Sort by Title"
                  aria-sort={
                    sortKey === 'title'
                      ? sortDirection === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                  className={`group/col px-2.5 py-1.5 flex items-center gap-1 text-left border-r border-white/[0.06] transition-colors cursor-pointer ${
                    sortKey === 'title'
                      ? 'bg-om-accent/15 text-om-accent-bright border-b-2 border-b-om-accent'
                      : 'bg-white/[0.02] text-om-text-secondary hover:bg-white/[0.06] hover:text-om-text'
                  }`}
                >
                  <span className="truncate">Title</span>
                  {renderSortIcon('title')}
                </button>

                <button
                  type="button"
                  onClick={() => handleSortHeaderClick('bpm')}
                  title="Sort by BPM"
                  aria-sort={
                    sortKey === 'bpm'
                      ? sortDirection === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                  className={`group/col px-1.5 py-1.5 flex items-center justify-end gap-0.5 border-r border-white/[0.06] transition-colors cursor-pointer ${
                    sortKey === 'bpm'
                      ? 'bg-om-accent/15 text-om-accent-bright border-b-2 border-b-om-accent'
                      : 'bg-om-accent/[0.05] text-om-accent-soft hover:bg-om-accent/10'
                  }`}
                >
                  <span>BPM</span>
                  {renderSortIcon('bpm')}
                </button>

                <button
                  type="button"
                  onClick={() => handleSortHeaderClick('key')}
                  title="Sort by Key (Camelot)"
                  aria-sort={
                    sortKey === 'key'
                      ? sortDirection === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                  className={`group/col px-1.5 py-1.5 flex items-center justify-center gap-0.5 border-r border-white/[0.06] transition-colors cursor-pointer ${
                    sortKey === 'key'
                      ? 'bg-om-accent/15 text-om-accent-bright border-b-2 border-b-om-accent'
                      : 'bg-om-secondary/[0.05] text-om-secondary-bright hover:bg-om-secondary/10'
                  }`}
                >
                  <span>Key</span>
                  {renderSortIcon('key')}
                </button>

                <button
                  type="button"
                  onClick={() => handleSortHeaderClick('length')}
                  title="Sort by Length"
                  aria-sort={
                    sortKey === 'length'
                      ? sortDirection === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                  className={`group/col px-1.5 py-1.5 flex items-center justify-end gap-0.5 border-r border-white/[0.06] transition-colors cursor-pointer ${
                    sortKey === 'length'
                      ? 'bg-om-accent/15 text-om-accent-bright border-b-2 border-b-om-accent'
                      : 'bg-white/[0.03] text-om-text-secondary hover:bg-white/[0.06] hover:text-om-text'
                  }`}
                >
                  <span>Len</span>
                  {renderSortIcon('length')}
                </button>

                <div className="px-1.5 py-1.5 flex items-center justify-center text-om-text-faint">
                  Add
                </div>
              </div>

              {visibleRows.length === 0 ? (
                <div className="h-36 flex items-center justify-center p-4 text-center text-xs text-om-text-faint">
                  {compatibleOnly
                    ? 'No scanned tracks in this folder match the current reference key/BPM.'
                    : `No audio files match "${searchQuery}".`}
                </div>
              ) : (
                <div className="divide-y divide-white/[0.05]">
                  {visibleRows.map(({ trackNo, displayName, file, inPlaylist, meta, compat }) => {
                    const parentDir = getParentFolderPath(file.relativePath);
                    const relLower = file.relativePath.toLowerCase();
                    const isAdded = addedPathSet.has(relLower);
                    const isModified = modifiedPathSet.has(relLower);

                    return (
                      <div
                        key={file.relativePath}
                        onDoubleClick={() => {
                          if (!inPlaylist) {
                            onAddFilesToPlaylist([file], djFolderName);
                          }
                        }}
                        className="group grid grid-cols-[44px_minmax(130px,1fr)_56px_74px_54px_56px] items-stretch hover:bg-om-hover transition-colors"
                      >
                        {/* Track No */}
                        <div
                          className={`px-2 py-2 flex items-center justify-center text-[11px] font-mono tabular-nums border-r border-white/[0.04] ${
                            sortKey === 'trackNo'
                              ? 'bg-om-accent/[0.06] text-om-accent-bright font-semibold'
                              : 'text-om-text-dim'
                          }`}
                        >
                          {String(trackNo).padStart(2, '0')}
                        </div>

                        {/* Title + Badges */}
                        <div
                          className={`min-w-0 px-2.5 py-2 flex flex-col justify-center border-r border-white/[0.04] ${
                            sortKey === 'title' ? 'bg-om-accent/[0.05]' : ''
                          }`}
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            <p
                              className="text-xs font-medium text-om-text truncate"
                              title={file.relativePath}
                            >
                              {displayName}
                            </p>
                            {isAdded && (
                              <span className="px-1 py-0.2 rounded text-[9px] font-mono font-semibold bg-om-accent/15 text-om-accent-bright border border-om-accent/30 shrink-0">
                                NEW
                              </span>
                            )}
                            {isModified && (
                              <span className="px-1 py-0.2 rounded text-[9px] font-mono font-semibold bg-om-secondary/15 text-om-secondary-bright border border-om-secondary/30 shrink-0">
                                UPDATED
                              </span>
                            )}
                            {compat && (
                              <span
                                title={`Fit vs ${activeReference.label}: ${compat.score}% (${compat.keyRelation}, ${
                                  compat.bpmDiffPct >= 0 ? '+' : ''
                                }${compat.bpmDiffPct}% BPM${
                                  compat.isHalfOrDoubleTime ? ' via ½×/2×' : ''
                                })`}
                                className={`px-1 py-0.2 rounded text-[9px] font-mono tabular-nums shrink-0 ${getCompatibilityBadgeStyle(
                                  compat.tier
                                )}`}
                              >
                                {compat.score}%
                              </span>
                            )}
                          </div>
                          {(file.analysisError ||
                            (!meta && file.fileSize > 0) ||
                            (activeFolderKey === ALL_FOLDERS_KEY &&
                              parentDir !== ROOT_FOLDER_KEY)) && (
                            <div className="flex items-center gap-1.5 text-[10px] font-mono text-om-text-faint truncate mt-0.5">
                              {file.analysisError ? (
                                <span className="text-om-danger-bright/80">Could not decode</span>
                              ) : !meta ? (
                                <span>{formatFileSize(file.fileSize)}</span>
                              ) : null}
                              {activeFolderKey === ALL_FOLDERS_KEY &&
                                parentDir !== ROOT_FOLDER_KEY && (
                                  <span className="truncate">{parentDir}</span>
                                )}
                            </div>
                          )}
                        </div>

                        {/* BPM */}
                        <div
                          className={`px-1.5 py-2 flex items-center justify-end text-[11px] font-mono tabular-nums border-r border-white/[0.04] ${
                            sortKey === 'bpm'
                              ? 'bg-om-accent/[0.1] text-om-accent-bright font-semibold'
                              : 'bg-om-accent/[0.03] text-om-accent-soft'
                          }`}
                        >
                          {meta ? meta.bpm.toFixed(1) : '—'}
                        </div>

                        {/* Key */}
                        <div
                          className={`px-1.5 py-2 flex items-center justify-center text-[10px] font-mono tabular-nums border-r border-white/[0.04] truncate ${
                            sortKey === 'key'
                              ? 'bg-om-accent/[0.1] text-om-accent-bright font-semibold'
                              : 'bg-om-secondary/[0.03] text-om-secondary-bright'
                          }`}
                          title={meta ? `${meta.musicalKey} (${meta.camelotCode})` : undefined}
                        >
                          {meta ? `${meta.camelotCode} · ${meta.musicalKey}` : '—'}
                        </div>

                        {/* Length */}
                        <div
                          className={`px-1.5 py-2 flex items-center justify-end text-[11px] font-mono tabular-nums border-r border-white/[0.04] ${
                            sortKey === 'length'
                              ? 'bg-om-accent/[0.08] text-om-accent-bright font-semibold'
                              : 'bg-white/[0.015] text-om-text-secondary'
                          }`}
                        >
                          {meta ? formatTimecode(meta.duration) : '—'}
                        </div>

                        {/* Add to Playlist Action */}
                        <div className="px-1.5 py-1.5 flex items-center justify-center">
                          <button
                            type="button"
                            disabled={inPlaylist}
                            onClick={() => onAddFilesToPlaylist([file], djFolderName)}
                            title={
                              inPlaylist
                                ? 'Already in current playlist'
                                : 'Decode and add track to current playlist'
                            }
                            className={`px-1.5 py-1 rounded text-[10px] font-mono font-medium inline-flex items-center justify-center gap-0.5 transition-colors whitespace-nowrap shrink-0 ${
                              inPlaylist
                                ? 'bg-om-positive/10 text-om-positive cursor-default'
                                : 'bg-om-control-alt text-om-text-secondary hover:bg-om-accent hover:text-om-accent-ink cursor-pointer'
                            }`}
                          >
                            {inPlaylist ? (
                              <Check className="w-3 h-3" />
                            ) : (
                              <>
                                <Plus className="w-3 h-3" />
                                <span>Add</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

