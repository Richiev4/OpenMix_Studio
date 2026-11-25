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
  GripVertical,
  ListOrdered,
  Music,
  Pencil,
  Play,
  Search,
  SlidersHorizontal,
  Square,
  Trash2,
} from 'lucide-react';
import {
  ALL_MUSICAL_KEYS,
  formatFileSize,
  formatTimecode,
  getCamelotForKey,
} from '../audio/analysis';
import { MIX_PRESETS } from '../audio/mixTransitions';
import { extractDroppedAudioFiles } from '../storage/djFolder';
import type { FolderAudioFile, MixPresetId, TrackAsset } from '../types/audio';

type PlaylistSortKey = 'trackNo' | 'title' | 'bpm' | 'key' | 'length';
type SortDirection = 'asc' | 'desc';

/** Converts Camelot string (e.g. "8A", "12B") into a sortable numeric index. */
function camelotSortOrder(code: string): number {
  const match = code.trim().toUpperCase().match(/^(\d{1,2})([AB])$/);
  if (!match) return 999;
  return parseInt(match[1], 10) * 2 + (match[2] === 'B' ? 1 : 0);
}

/** Formats total playlist duration as H:MM:SS when >= 1 hour, otherwise MM:SS. */
function formatTotalDuration(seconds: number): string {
  const totalSec = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  return hrs > 0 ? `${hrs}:${mm}:${ss}` : `${mm}:${ss}`;
}

interface TrackCrateProps {
  tracks: TrackAsset[];
  timelineTrackCounts?: Map<string, number>;
  timelineMixInfo?: Map<
    string,
    { trackId: string; clipId: string; presetId: MixPresetId }
  >;
  onChangeMixPreset?: (
    trackId: string,
    clipId: string,
    presetId: Exclude<MixPresetId, 'custom'>
  ) => void;
  playingTrackProgress?: Map<string, number>;
  importingCount: number;
  onImportFolderFiles: (files: FolderAudioFile[], folderName?: string | null) => void;
  onReorderTracks: (fromIndex: number, toIndex: number) => void;
  onAddToTimeline: (trackId: string) => void;
  onRemoveTrack: (trackId: string) => void;
  onUpdateTrackMeta: (
    trackId: string,
    bpm: number,
    musicalKey: string,
    beatOffsetSec?: number
  ) => void;
  onOpenBeatgridEditor?: (track: TrackAsset, draftBpm: number, draftKey: string) => void;
  isRescanning?: boolean;
  rescanProgress?: { done: number; total: number } | null;
  onRescanPlaylist?: () => void;
  previewTrackId?: string | null;
  previewTimeSec?: number;
  onTogglePreview?: (trackId: string) => void;
  onSeekPreview?: (trackId: string, sec: number) => void;
  isCollapsed?: boolean;
  bothCollapsed?: boolean;
  onToggleCollapse?: () => void;
  autoOrderByTimeline?: boolean;
  onToggleAutoOrderByTimeline?: () => void;
}

export const TrackCrate: React.FC<TrackCrateProps> = ({
  tracks,
  timelineTrackCounts,
  timelineMixInfo,
  onChangeMixPreset,
  playingTrackProgress,
  importingCount,
  onImportFolderFiles,
  onReorderTracks,
  onAddToTimeline,
  onRemoveTrack,
  onUpdateTrackMeta,
  onOpenBeatgridEditor,
  isRescanning = false,
  rescanProgress = null,
  onRescanPlaylist,
  previewTrackId = null,
  previewTimeSec = 0,
  onTogglePreview,
  onSeekPreview,
  isCollapsed = false,
  bothCollapsed = false,
  onToggleCollapse,
  autoOrderByTimeline = true,
  onToggleAutoOrderByTimeline,
}) => {
  const [isDragOverDropzone, setIsDragOverDropzone] = useState(false);
  const [dragRowIndex, setDragRowIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBpm, setEditBpm] = useState<string>('120');
  const [editKey, setEditKey] = useState<string>('Am');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortKey, setSortKey] = useState<PlaylistSortKey>('trackNo');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const isDefaultTrackOrder = sortKey === 'trackNo' && sortDirection === 'asc';

  const handleSortHeaderClick = (column: PlaylistSortKey) => {
    if (sortKey === column) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(column);
      setSortDirection('asc');
    }
  };

  const handleExternalDrop = async (e: React.DragEvent<HTMLElement>) => {
    // Only handle OS folder drops here; internal drag events are handled by row/timeline handlers
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setIsDragOverDropzone(false);
    const { folderName, files } = await extractDroppedAudioFiles(e.dataTransfer);
    // Restrict drops to folders so tracks are always sourced from a DJ Folder
    if (files.length > 0 && (folderName || files.some((f) => f.relativePath.includes('/')))) {
      onImportFolderFiles(files, folderName);
    }
  };

  const startEdit = (track: TrackAsset) => {
    setEditingId(track.id);
    setEditBpm(String(track.bpm));
    setEditKey(track.musicalKey);
  };

  const commitEdit = (trackId: string) => {
    const parsed = parseFloat(editBpm);
    const validBpm =
      Number.isFinite(parsed) && parsed >= 40 && parsed <= 240
        ? Math.round(parsed * 10) / 10
        : 120;
    onUpdateTrackMeta(trackId, validBpm, editKey);
    setEditingId(null);
  };

  const visibleEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const indexed = tracks
      .map((track, realIndex) => ({ track, realIndex }))
      .filter(({ track }) =>
        query
          ? track.name.toLowerCase().includes(query) ||
            track.musicalKey.toLowerCase().includes(query) ||
            track.camelotCode.toLowerCase().includes(query) ||
            String(track.bpm).includes(query)
          : true
      );

    const dir = sortDirection === 'asc' ? 1 : -1;
    indexed.sort((a, b) => {
      if (sortKey === 'trackNo') {
        return (a.realIndex - b.realIndex) * dir;
      }
      if (sortKey === 'title') {
        const cmp = a.track.name.localeCompare(b.track.name, undefined, {
          numeric: true,
          sensitivity: 'base',
        });
        if (cmp !== 0) return cmp * dir;
      } else if (sortKey === 'bpm') {
        if (a.track.bpm !== b.track.bpm) return (a.track.bpm - b.track.bpm) * dir;
      } else if (sortKey === 'key') {
        const ca = camelotSortOrder(a.track.camelotCode);
        const cb = camelotSortOrder(b.track.camelotCode);
        if (ca !== cb) return (ca - cb) * dir;
        const kcmp = a.track.musicalKey.localeCompare(b.track.musicalKey);
        if (kcmp !== 0) return kcmp * dir;
      } else if (sortKey === 'length') {
        if (a.track.duration !== b.track.duration) {
          return (a.track.duration - b.track.duration) * dir;
        }
      }
      return a.realIndex - b.realIndex;
    });

    return indexed;
  }, [tracks, searchQuery, sortKey, sortDirection]);

  const totalDurationSec = useMemo(
    () => tracks.reduce((sum, track) => sum + (Number.isFinite(track.duration) ? track.duration : 0), 0),
    [tracks]
  );

  if (isCollapsed && bothCollapsed) {
    return (
      <section
        aria-label="Current Playlist (Collapsed)"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setIsDragOverDropzone(true);
          }
        }}
        onDragLeave={() => setIsDragOverDropzone(false)}
        onDrop={handleExternalDrop}
        className={`flex-1 min-w-0 h-10 bg-om-panel px-3 flex items-center justify-between gap-2 select-none transition-colors ${
          isDragOverDropzone ? 'bg-om-elevated ring-1 ring-inset ring-om-accent/60' : ''
        }`}
      >
        <button
          type="button"
          onClick={onToggleCollapse}
          title="Expand Current Playlist"
          className="min-w-0 flex-1 flex items-center gap-2 text-left cursor-pointer group"
        >
          <Music className="w-3.5 h-3.5 shrink-0 text-om-accent" />
          <span className="font-display text-xs font-semibold text-om-text group-hover:text-om-accent transition-colors truncate">
            Current Playlist
          </span>
          <span className="text-[10px] font-mono tabular-nums text-om-text-faint shrink-0">
            ({tracks.length} {tracks.length === 1 ? 'track' : 'tracks'})
          </span>
        </button>
        {onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            title="Expand Current Playlist"
            aria-label="Expand Current Playlist"
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
        aria-label="Current Playlist (Collapsed)"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setIsDragOverDropzone(true);
          }
        }}
        onDragLeave={() => setIsDragOverDropzone(false)}
        onDrop={handleExternalDrop}
        className={`w-10 shrink-0 h-full bg-om-panel border-l border-white/[0.08] py-2.5 flex flex-col items-center gap-3 select-none transition-colors ${
          isDragOverDropzone ? 'bg-om-elevated ring-1 ring-inset ring-om-accent/60' : ''
        }`}
      >
        <button
          type="button"
          onClick={onToggleCollapse}
          title="Expand Current Playlist"
          aria-label="Expand Current Playlist"
          className="p-1 rounded bg-om-control hover:bg-om-control-hover text-om-text-muted hover:text-om-text border border-white/[0.08] transition-colors cursor-pointer"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={onToggleCollapse}
          title="Expand Current Playlist"
          className="flex-1 w-full flex flex-col items-center justify-start gap-2 pt-1 cursor-pointer group overflow-hidden"
        >
          <Music className="w-3.5 h-3.5 shrink-0 text-om-accent" />
          <span
            style={{ writingMode: 'vertical-rl' }}
            className="text-[11px] font-display font-semibold tracking-wide text-om-text-muted group-hover:text-om-text transition-colors whitespace-nowrap"
          >
            Current Playlist ({tracks.length})
          </span>
        </button>
      </section>
    );
  }

  const renderSortIcon = (column: PlaylistSortKey) => {
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
      aria-label="Current Playlist"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setIsDragOverDropzone(true);
        }
      }}
      onDragLeave={() => setIsDragOverDropzone(false)}
      onDrop={handleExternalDrop}
      className={`flex-1 min-w-0 h-full bg-om-panel flex flex-col select-none transition-colors ${
        isDragOverDropzone ? 'bg-om-elevated ring-1 ring-inset ring-om-accent/60' : ''
      }`}
    >

      {/* Playlist Header & Search */}
      <div className="px-4 py-2.5 border-b border-white/[0.08] flex items-center justify-between gap-3 shrink-0">
        <div className="min-w-0">
          <h2 className="font-display text-sm font-semibold text-om-text tracking-tight truncate">
            Current Playlist
          </h2>
          <p className="text-[11px] text-om-text-faint font-mono tabular-nums truncate">
            {tracks.length} {tracks.length === 1 ? 'Track' : 'Tracks'} - Total Time{' '}
            {formatTotalDuration(totalDurationSec)}
            {importingCount > 0 ? ` · Analyzing ${importingCount}...` : ''}
          </p>
        </div>

        {/* Playlist auto-order, rescan, filter & collapse toggle */}
        <div className="flex items-center gap-2 shrink-0">
          {onToggleAutoOrderByTimeline && (
            <button
              type="button"
              aria-pressed={autoOrderByTimeline}
              onClick={() => {
                if (!autoOrderByTimeline) {
                  setSortKey('trackNo');
                  setSortDirection('asc');
                }
                onToggleAutoOrderByTimeline();
              }}
              title={
                autoOrderByTimeline
                  ? 'Auto-ordering playlist to match timeline clip order (click for manual order)'
                  : 'Manual playlist order (click to auto-order playlist as tracks are dropped on the timeline)'
              }
              className={`px-2.5 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 border cursor-pointer ${
                autoOrderByTimeline
                  ? 'bg-om-accent/15 border-om-accent/40 text-om-accent-bright hover:bg-om-accent/20'
                  : 'bg-om-control hover:bg-om-control-hover border-white/[0.08] text-om-text-muted hover:text-om-text'
              }`}
            >
              <ListOrdered className="w-3.5 h-3.5 shrink-0" />
              <span>Timeline Order</span>
            </button>
          )}
          {tracks.length > 0 && onRescanPlaylist && (
            <button
              type="button"
              disabled={isRescanning}
              onClick={onRescanPlaylist}
              title="Re-scan BPM, beat grid & Key for all playlist tracks"
              className={`px-2.5 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 border ${
                isRescanning
                  ? 'bg-om-accent/15 border-om-accent/40 text-om-accent-bright cursor-wait'
                  : 'bg-om-control hover:bg-om-control-hover border-white/[0.08] text-om-text cursor-pointer'
              }`}
            >
              <Activity className={`w-3.5 h-3.5 text-om-accent ${isRescanning ? 'animate-pulse' : ''}`} />
              {isRescanning && rescanProgress
                ? `Scanning ${rescanProgress.done}/${rescanProgress.total}`
                : 'Re-scan'}
            </button>
          )}
          {tracks.length > 0 && (
            <div className="relative w-44 sm:w-52">
              <Search className="w-3.5 h-3.5 text-om-text-icon absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter by title, BPM, or key..."
                className="w-full bg-om-base border border-white/[0.08] rounded pl-8 pr-2.5 py-1.5 text-xs text-om-text placeholder-om-text-icon focus:outline-none focus:border-om-accent/60"
              />
            </div>
          )}
          {onToggleCollapse && (
            <button
              type="button"
              onClick={onToggleCollapse}
              title="Collapse Current Playlist"
              aria-label="Collapse Current Playlist"
              className="p-1.5 rounded-md bg-om-control hover:bg-om-control-hover text-om-text-muted hover:text-om-text border border-white/[0.08] transition-colors cursor-pointer"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Track List or Empty State */}
      <div className="flex-1 min-h-0 overflow-auto">
        {tracks.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center p-5 text-center">
            <div className="w-full max-w-lg h-full max-h-[190px] rounded-lg border border-dashed border-white/[0.16] bg-om-well p-5 flex flex-col items-center justify-center gap-2.5">
              <div className="w-9 h-9 rounded-md bg-om-card border border-white/[0.08] flex items-center justify-center text-om-accent">
                <Music className="w-4 h-4" />
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium text-om-text">
                  Your current playlist is empty
                </p>
                <p className="text-[11px] text-om-text-subtle leading-relaxed">
                  Add tracks from the DJ Folder list on the left to analyze BPM &amp; Key and arrange them on the timeline.
                </p>
              </div>
            </div>
            {importingCount > 0 && (
              <p className="mt-3 text-xs font-mono text-om-accent">
                Decoding &amp; analyzing {importingCount} file(s)...
              </p>
            )}
          </div>
        ) : (
          <div className="min-w-[660px]">
            {/* Sticky Highlighted Sortable Column Headers */}
            <div
              role="row"
              className="sticky top-0 z-10 grid grid-cols-[26px_54px_minmax(150px,1fr)_68px_86px_64px_124px_112px] items-stretch bg-om-elevated/95 backdrop-blur-sm border-b border-white/[0.1] text-[10px] font-mono uppercase tracking-wider"
            >
              <div className="border-r border-white/[0.04]" aria-hidden="true" />

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
                <span>No.</span>
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
                className={`group/col px-2 py-1.5 flex items-center justify-end gap-0.5 border-r border-white/[0.06] transition-colors cursor-pointer ${
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
                className={`group/col px-2 py-1.5 flex items-center justify-center gap-0.5 border-r border-white/[0.06] transition-colors cursor-pointer ${
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
                className={`group/col px-2 py-1.5 flex items-center justify-end gap-0.5 border-r border-white/[0.06] transition-colors cursor-pointer ${
                  sortKey === 'length'
                    ? 'bg-om-accent/15 text-om-accent-bright border-b-2 border-b-om-accent'
                    : 'bg-white/[0.03] text-om-text-secondary hover:bg-white/[0.06] hover:text-om-text'
                }`}
              >
                <span>Length</span>
                {renderSortIcon('length')}
              </button>

              <div className="px-2 py-1.5 flex items-center justify-center border-r border-white/[0.06] text-om-text-secondary">
                Mix Preset
              </div>

              <div className="px-2 py-1.5 flex items-center justify-end text-om-text-faint">
                Actions
              </div>
            </div>

            {visibleEntries.length === 0 ? (
              <div className="h-36 flex items-center justify-center p-6 text-xs text-om-text-faint">
                No playlist tracks match "{searchQuery}".
              </div>
            ) : (
              <div className="divide-y divide-white/[0.05]">
                {visibleEntries.map(({ track, realIndex }) => {
                  const isDropTarget = isDefaultTrackOrder && dropTargetIndex === realIndex;
                  const isEditing = editingId === track.id;
                  const timelineCount = timelineTrackCounts?.get(track.id) ?? 0;
                  const isOnTimeline = timelineCount > 0;
                  const mixInfo = timelineMixInfo?.get(track.id);
                  const timelineProgress = playingTrackProgress?.get(track.id);
                  const isTimelinePlaying = timelineProgress !== undefined;
                  const isPreviewing = previewTrackId === track.id;
                  const previewProgressPct =
                    isPreviewing && track.duration > 0
                      ? Math.max(0, Math.min(100, (previewTimeSec / track.duration) * 100))
                      : 0;
                  const activeProgressPct = isPreviewing
                    ? previewProgressPct
                    : isTimelinePlaying
                      ? timelineProgress * 100
                      : 0;
                  const isPlayingRow = isPreviewing || isTimelinePlaying;

                  return (
                    <div
                      key={track.id}
                      draggable={!isEditing}
                      onDragStart={(e) => {
                        setDragRowIndex(realIndex);
                        e.dataTransfer.effectAllowed = 'copyMove';
                        e.dataTransfer.setData('application/x-obsidian-track', track.id);
                        e.dataTransfer.setData('text/plain', track.id);
                      }}
                      onDragOver={(e) => {
                        if (isDefaultTrackOrder && dragRowIndex !== null && dragRowIndex !== realIndex) {
                          e.preventDefault();
                          setDropTargetIndex(realIndex);
                        }
                      }}
                      onDragLeave={() => {
                        if (dropTargetIndex === realIndex) setDropTargetIndex(null);
                      }}
                      onDrop={(e) => {
                        if (isDefaultTrackOrder && dragRowIndex !== null && dragRowIndex !== realIndex) {
                          e.preventDefault();
                          e.stopPropagation();
                          onReorderTracks(dragRowIndex, realIndex);
                        }
                        setDragRowIndex(null);
                        setDropTargetIndex(null);
                      }}
                      onDragEnd={() => {
                        setDragRowIndex(null);
                        setDropTargetIndex(null);
                      }}
                      className={`group relative transition-colors ${
                        isPlayingRow ? 'bg-om-accent/[0.08]' : 'hover:bg-om-hover'
                      } ${isDropTarget ? 'border-t-2 border-t-om-accent' : ''} ${
                        dragRowIndex === realIndex ? 'opacity-50' : ''
                      }`}
                    >
                      {/* Active playback progress bar fill + bottom indicator */}
                      {isPlayingRow && (
                        <>
                          <div
                            aria-hidden="true"
                            className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-om-accent z-[2]"
                          />
                          <div
                            aria-hidden="true"
                            className="pointer-events-none absolute inset-y-0 left-0 bg-om-accent/[0.14]"
                            style={{ width: `${activeProgressPct}%` }}
                          />
                          <div
                            role="progressbar"
                            aria-label={`${track.name} playback progress`}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.round(activeProgressPct)}
                            className="pointer-events-none absolute bottom-0 left-0 right-0 h-[2px] bg-white/[0.08] z-[2]"
                          >
                            <div
                              className="h-full bg-om-accent"
                              style={{ width: `${activeProgressPct}%` }}
                            />
                          </div>
                        </>
                      )}

                      <div className="relative z-[1] grid grid-cols-[26px_54px_minmax(150px,1fr)_68px_86px_64px_124px_112px] items-stretch">
                        {/* Drag Handle */}
                        <div
                          className="pl-2 pr-0.5 py-2 flex items-center justify-center text-om-text-icon group-hover:text-om-text-muted cursor-grab active:cursor-grabbing border-r border-white/[0.04]"
                          title={
                            isDefaultTrackOrder
                              ? 'Drag onto timeline lane below or reorder playlist'
                              : 'Drag onto timeline lane below (sort by No. ascending to reorder)'
                          }
                        >
                          <GripVertical className="w-3.5 h-3.5" />
                        </div>

                        {/* Track No */}
                        <div
                          className={`px-2 py-2 flex items-center justify-center text-[11px] font-mono tabular-nums border-r border-white/[0.04] ${
                            isPlayingRow || sortKey === 'trackNo'
                              ? 'bg-om-accent/[0.06] text-om-accent-bright font-semibold'
                              : 'text-om-text-dim'
                          }`}
                        >
                          {String(realIndex + 1).padStart(2, '0')}
                        </div>

                        {/* Title + Clean Preview Button + Timeline Badge */}
                        <div
                          className={`min-w-0 px-2.5 py-2 flex items-center gap-2 border-r border-white/[0.04] ${
                            sortKey === 'title' ? 'bg-om-accent/[0.05]' : ''
                          }`}
                        >
                          {onTogglePreview && (
                            <button
                              type="button"
                              draggable={false}
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                onTogglePreview(track.id);
                              }}
                              title={
                                isPreviewing
                                  ? 'Stop clean preview'
                                  : 'Play clean, unfiltered track'
                              }
                              aria-label={
                                isPreviewing
                                  ? `Stop ${track.name}`
                                  : `Play ${track.name} unfiltered`
                              }
                              className={`w-6 h-6 rounded flex items-center justify-center shrink-0 transition-colors cursor-pointer ${
                                isPreviewing
                                  ? 'bg-om-accent text-om-accent-ink'
                                  : 'bg-om-control text-om-text-muted hover:text-om-text hover:bg-om-control-hover border border-white/[0.06]'
                              }`}
                            >
                              {isPreviewing ? (
                                <Square className="w-2.5 h-2.5 fill-current" />
                              ) : (
                                <Play className="w-3 h-3 fill-current ml-0.5" />
                              )}
                            </button>
                          )}

                          <span
                            className={`text-[13px] truncate ${
                              isPlayingRow
                                ? 'font-semibold text-om-accent-bright'
                                : 'font-medium text-om-text'
                            }`}
                            title={track.name}
                          >
                            {track.name}
                          </span>
                          {isOnTimeline && (
                            <span
                              title={`On timeline (${timelineCount} ${
                                timelineCount === 1 ? 'clip' : 'clips'
                              })`}
                              aria-label={`On timeline (${timelineCount} ${
                                timelineCount === 1 ? 'clip' : 'clips'
                              })`}
                              className="px-1.5 py-0.5 rounded text-[10px] font-mono tabular-nums font-medium bg-om-positive/12 text-om-positive-bright border border-om-positive/25 inline-flex items-center gap-0.5 shrink-0"
                            >
                              <Check className="w-3 h-3" />
                              {timelineCount > 1 && (
                                <span className="font-semibold leading-none">{timelineCount}</span>
                              )}
                            </span>
                          )}
                        </div>

                        {/* BPM */}
                        <div
                          className={`px-2 py-2 flex items-center justify-end text-[11px] font-mono tabular-nums border-r border-white/[0.04] ${
                            sortKey === 'bpm'
                              ? 'bg-om-accent/[0.1] text-om-accent-bright font-semibold'
                              : 'bg-om-accent/[0.03] text-om-accent-soft'
                          }`}
                        >
                          {track.bpm.toFixed(1)}
                        </div>

                        {/* Key */}
                        <div
                          className={`px-2 py-2 flex items-center justify-center text-[11px] font-mono tabular-nums border-r border-white/[0.04] truncate ${
                            sortKey === 'key'
                              ? 'bg-om-accent/[0.1] text-om-accent-bright font-semibold'
                              : 'bg-om-secondary/[0.03] text-om-secondary-bright'
                          }`}
                          title={`${track.musicalKey} (${track.camelotCode})`}
                        >
                          {track.camelotCode} · {track.musicalKey}
                        </div>

                        {/* Length */}
                        <div
                          className={`px-2 py-2 flex items-center justify-end text-[11px] font-mono tabular-nums border-r border-white/[0.04] ${
                            sortKey === 'length'
                              ? 'bg-om-accent/[0.08] text-om-accent-bright font-semibold'
                              : 'bg-white/[0.015] text-om-text-secondary'
                          }`}
                        >
                          {formatTimecode(track.duration)}
                        </div>

                        {/* Mix Preset */}
                        <div
                          className="px-1.5 py-1.5 flex items-center justify-center border-r border-white/[0.04]"
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {mixInfo ? (
                            <select
                              aria-label={`Mix preset for ${track.name}`}
                              value={mixInfo.presetId}
                              disabled={!onChangeMixPreset}
                              onChange={(e) => {
                                const val = e.target.value;
                                if (val !== 'custom' && onChangeMixPreset) {
                                  onChangeMixPreset(
                                    mixInfo.trackId,
                                    mixInfo.clipId,
                                    val as Exclude<MixPresetId, 'custom'>
                                  );
                                }
                              }}
                              title={
                                mixInfo.presetId === 'custom'
                                  ? 'Mix transition has been manually edited (select a preset to reset)'
                                  : 'Active mix preset with previous track (change preset)'
                              }
                              className={`w-full rounded px-1.5 py-1 text-[10px] font-mono border focus:outline-none focus:border-om-accent/70 cursor-pointer truncate transition-colors ${
                                mixInfo.presetId === 'custom'
                                  ? 'bg-om-secondary/12 border-om-secondary/35 text-om-secondary-bright'
                                  : 'bg-om-accent/10 border-om-accent/30 text-om-accent-bright hover:bg-om-accent/15'
                              }`}
                            >
                              {mixInfo.presetId === 'custom' && (
                                <option value="custom" disabled>
                                  Custom
                                </option>
                              )}
                              {MIX_PRESETS.map((preset) => (
                                <option
                                  key={preset.id}
                                  value={preset.id}
                                  className="bg-om-panel text-om-text"
                                >
                                  {preset.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className="text-[11px] font-mono text-om-text-icon">—</span>
                          )}
                        </div>

                        {/* Row Actions */}
                        <div className="px-2 py-1.5 flex items-center justify-end gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => (isEditing ? setEditingId(null) : startEdit(track))}
                            title="Edit BPM & Key"
                            className="p-1 text-om-text-subtle hover:text-om-text opacity-70 group-hover:opacity-100 transition-opacity cursor-pointer"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onRemoveTrack(track.id)}
                            title="Remove from Playlist"
                            className="p-1 text-om-text-subtle hover:text-om-danger opacity-70 group-hover:opacity-100 transition-opacity cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onAddToTimeline(track.id)}
                            title="Add track to NLE Timeline"
                            className="px-2 py-1 rounded text-[10px] font-mono font-medium bg-om-control-alt text-om-text-secondary hover:text-om-accent-ink hover:bg-om-accent transition-colors cursor-pointer whitespace-nowrap"
                          >
                            + Lane
                          </button>
                        </div>
                      </div>

                      {/* Clean unfiltered preview scrub bar for active track */}
                      {isPreviewing && onSeekPreview && (
                        <div
                          className="relative z-[1] pb-2 pt-0.5 pl-20 pr-3 flex items-center gap-2.5"
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          <span className="text-[10px] font-mono tabular-nums text-om-accent shrink-0">
                            {formatTimecode(previewTimeSec)}
                          </span>
                          <div
                            role="slider"
                            tabIndex={0}
                            aria-label={`Seek ${track.name}`}
                            aria-valuemin={0}
                            aria-valuemax={Math.round(track.duration)}
                            aria-valuenow={Math.round(previewTimeSec)}
                            onClick={(e) => {
                              e.stopPropagation();
                              const rect = e.currentTarget.getBoundingClientRect();
                              const ratio = Math.max(
                                0,
                                Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width))
                              );
                              onSeekPreview(track.id, ratio * track.duration);
                            }}
                            className="flex-1 h-3 flex items-center cursor-pointer group/seek"
                          >
                            <div className="w-full h-1 rounded-full bg-white/[0.1] overflow-hidden">
                              <div
                                className="h-full bg-om-accent transition-[width] duration-75"
                                style={{ width: `${previewProgressPct}%` }}
                              />
                            </div>
                          </div>
                          <span className="text-[10px] font-mono tabular-nums text-om-text-faint shrink-0">
                            {formatTimecode(track.duration)}
                          </span>
                        </div>
                      )}

                      {isEditing && (
                        <div className="relative z-[1] mb-2 ml-20 mr-3 p-2 rounded bg-om-well border border-white/[0.08] flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <input
                              type="number"
                              step="0.1"
                              min="40"
                              max="240"
                              value={editBpm}
                              onChange={(e) => setEditBpm(e.target.value)}
                              className="w-16 bg-om-elevated border border-white/[0.1] rounded px-1.5 py-1 text-[11px] font-mono tabular-nums text-om-text"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                setEditBpm((v) => String(Math.round(parseFloat(v || '120') * 5) / 10))
                              }
                              className="px-1.5 py-1 rounded bg-om-control-alt text-[10px] font-mono text-om-text-muted hover:text-white cursor-pointer"
                              title="Halve BPM"
                            >
                              ÷2
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setEditBpm((v) => String(Math.round(parseFloat(v || '120') * 20) / 10))
                              }
                              className="px-1.5 py-1 rounded bg-om-control-alt text-[10px] font-mono text-om-text-muted hover:text-white cursor-pointer"
                              title="Double BPM"
                            >
                              ×2
                            </button>
                            <select
                              value={editKey}
                              onChange={(e) => setEditKey(e.target.value)}
                              className="bg-om-elevated border border-white/[0.1] rounded px-1.5 py-1 text-[11px] font-mono text-om-text"
                            >
                              {ALL_MUSICAL_KEYS.map((k) => (
                                <option key={k} value={k}>
                                  {k} ({getCamelotForKey(k)})
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="flex items-center gap-1.5">
                            {onOpenBeatgridEditor && (
                              <button
                                type="button"
                                onClick={() => {
                                  const parsed = parseFloat(editBpm);
                                  const validBpm =
                                    Number.isFinite(parsed) && parsed >= 40 && parsed <= 240
                                      ? Math.round(parsed * 100) / 100
                                      : track.bpm;
                                  setEditingId(null);
                                  onOpenBeatgridEditor(track, validBpm, editKey);
                                }}
                                title="Open waveform & beat marker editor"
                                className="px-2 py-1 rounded bg-om-control hover:bg-om-control-hover border border-om-accent/35 text-[11px] font-medium text-om-accent-bright inline-flex items-center gap-1 cursor-pointer transition-colors"
                              >
                                <SlidersHorizontal className="w-3 h-3" />
                                <span>Advanced</span>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => setEditingId(null)}
                              className="px-2 py-1 text-[11px] text-om-text-dim hover:text-white cursor-pointer"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => commitEdit(track.id)}
                              className="px-2.5 py-1 rounded bg-om-accent text-om-accent-ink text-[11px] font-semibold cursor-pointer"
                            >
                              Save
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {tracks.length > 0 && (
        <div className="px-4 py-1.5 border-t border-white/[0.08] bg-om-footer flex items-center justify-end text-[11px] text-om-text-faint shrink-0">
          <span className="font-mono tabular-nums shrink-0">
            {formatFileSize(tracks.reduce((a, b) => a + b.fileSize, 0))}
          </span>
        </div>
      )}
    </section>
  );
};

