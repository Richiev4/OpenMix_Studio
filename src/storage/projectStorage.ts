import { formatTimecode } from '../audio/analysis';
import { triggerBlobDownload } from '../audio/exportUtils';
import { resolveAutoMixDefaults } from '../audio/mixTransitions';
import type {
  FolderAudioFile,
  NleProjectState,
  SavedProjectManifest,
  SerializedTrackRef,
  TrackAsset,
} from '../types/audio';
import { openStudioDb } from './djFolder';

const AUTOSAVE_KEY = 'latest-project';
const STORE_PROJECTS = 'projects';

export const PROJECT_FILE_EXTENSION = '.openmix.json';

/** Converts in-memory TrackAssets and NleProjectState into a lightweight JSON manifest (~10-50 KB). */
export function serializeProjectManifest(
  projectName: string,
  project: NleProjectState,
  tracks: TrackAsset[],
  djFolderName?: string
): SavedProjectManifest {
  const { isPlaying: _discarded, ...serializableProject } = project;

  const trackRefs: SerializedTrackRef[] = tracks.map((t, idx) => ({
    id: t.id,
    name: t.name,
    fileName: t.fileName,
    relativePath: t.relativePath,
    fileSize: t.fileSize,
    duration: t.duration,
    bpm: t.bpm,
    beatOffsetSec: t.beatOffsetSec,
    manualBeatgrid: t.manualBeatgrid ? true : undefined,
    musicalKey: t.musicalKey,
    camelotCode: t.camelotCode,
    orderIndex: idx,
  }));

  return {
    version: 1,
    projectName: projectName.trim() || 'Untitled Mix',
    savedAt: new Date().toISOString(),
    djFolderName,
    trackRefs,
    project: serializableProject,
  };
}

function toSafeFilenameSlug(name: string, fallback = 'openmix'): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || fallback
  );
}

export function downloadProjectManifest(manifest: SavedProjectManifest): void {
  const json = JSON.stringify(manifest, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const safeSlug = toSafeFilenameSlug(manifest.projectName);
  triggerBlobDownload(blob, `${safeSlug}${PROJECT_FILE_EXTENSION}`);
}

/** Formats the current playlist tracks into a clean plain-text tracklist. */
export function formatPlaylistText(
  projectName: string,
  tracks: TrackAsset[],
  _masterBpm?: number
): string {
  const title = projectName.trim() || 'Untitled Mix';
  const sorted = [...tracks].sort((a, b) => a.orderIndex - b.orderIndex);
  const totalSec = sorted.reduce((sum, t) => sum + (Number.isFinite(t.duration) ? t.duration : 0), 0);
  const validBpms = sorted.map((t) => t.bpm).filter((b) => Number.isFinite(b) && b > 0);
  let bpmSummary = '';
  if (validBpms.length > 0) {
    const minBpm = Math.min(...validBpms);
    const maxBpm = Math.max(...validBpms);
    bpmSummary =
      Math.abs(maxBpm - minBpm) >= 0.05
        ? ` | BPM: ${minBpm.toFixed(1)}–${maxBpm.toFixed(1)}`
        : ` | BPM: ${minBpm.toFixed(1)}`;
  }

  const lines: string[] = [
    `${title} — Playlist`,
    `Exported: ${new Date().toLocaleString()}`,
    `Tracks: ${sorted.length} | Total Runtime: ${formatTimecode(totalSec)}${bpmSummary}`,
    '------------------------------------------------------------',
  ];

  if (sorted.length === 0) {
    lines.push('(No tracks in playlist)');
  } else {
    sorted.forEach((track, idx) => {
      const num = String(idx + 1).padStart(2, '0');
      const bpmLabel = `${track.bpm.toFixed(1)} BPM`;
      const keyLabel = `${track.musicalKey} (${track.camelotCode})`;
      const durLabel = formatTimecode(track.duration);
      const sourceLabel = track.relativePath ?? track.fileName;
      lines.push(
        `${num}. ${track.name}  [${bpmLabel} | ${keyLabel} | ${durLabel}]  (${sourceLabel})`
      );
    });
  }

  return `${lines.join('\n')}\n`;
}

/** Downloads the current playlist as a UTF-8 .txt file and returns the downloaded filename. */
export function downloadPlaylistText(
  projectName: string,
  tracks: TrackAsset[],
  masterBpm?: number
): string {
  const content = formatPlaylistText(projectName, tracks, masterBpm);
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const safeSlug = toSafeFilenameSlug(projectName);
  const filename = `${safeSlug}-playlist.txt`;
  triggerBlobDownload(blob, filename);
  return filename;
}

function hydrateManifestMixDefaults(manifest: SavedProjectManifest): SavedProjectManifest {
  return {
    ...manifest,
    project: {
      ...manifest.project,
      masterVolume:
        typeof manifest.project.masterVolume === 'number' &&
        Number.isFinite(manifest.project.masterVolume)
          ? Math.max(0, Math.min(1.25, manifest.project.masterVolume))
          : 0.92,
      defaultMixOptions: resolveAutoMixDefaults(manifest.project.defaultMixOptions),
    },
  };
}

export async function parseProjectManifestFile(file: File): Promise<SavedProjectManifest> {
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Selected file is not valid JSON.');
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as SavedProjectManifest).version !== 1 ||
    !Array.isArray((parsed as SavedProjectManifest).trackRefs) ||
    !(parsed as SavedProjectManifest).project ||
    !Array.isArray((parsed as SavedProjectManifest).project.tracks)
  ) {
    throw new Error('Unrecognized OpenMix Studio project file format.');
  }

  return hydrateManifestMixDefaults(parsed as SavedProjectManifest);
}

export async function saveAutosaveManifest(manifest: SavedProjectManifest): Promise<void> {
  try {
    const db = await openStudioDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_PROJECTS, 'readwrite');
      tx.objectStore(STORE_PROJECTS).put(manifest, AUTOSAVE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Non-fatal in private windows or quota-restricted environments
  }
}

export async function loadAutosaveManifest(): Promise<SavedProjectManifest | null> {
  try {
    const db = await openStudioDb();
    const manifest = await new Promise<SavedProjectManifest | null>((resolve, reject) => {
      const tx = db.transaction(STORE_PROJECTS, 'readonly');
      const req = tx.objectStore(STORE_PROJECTS).get(AUTOSAVE_KEY);
      req.onsuccess = () => resolve((req.result as SavedProjectManifest | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return manifest ? hydrateManifestMixDefaults(manifest) : null;
  } catch {
    return null;
  }
}

export async function clearAutosaveManifest(): Promise<void> {
  try {
    const db = await openStudioDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_PROJECTS, 'readwrite');
      tx.objectStore(STORE_PROJECTS).delete(AUTOSAVE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore
  }
}

export interface TrackMatchResult {
  matched: Array<{ trackRef: SerializedTrackRef; folderFile: FolderAudioFile }>;
  missing: SerializedTrackRef[];
}

/**
 * Matches serialized project track references against files found in a DJ Folder.
 * Priority:
 *  1. Exact relativePath (case-insensitive)
 *  2. Exact fileName + fileSize
 *  3. Unique fileName match (handles minor ID3/metadata tag edits changing byte size)
 */
export function matchTrackRefsToFolderFiles(
  trackRefs: SerializedTrackRef[],
  folderFiles: FolderAudioFile[]
): TrackMatchResult {
  const byRelPath = new Map<string, FolderAudioFile>();
  const byNameAndSize = new Map<string, FolderAudioFile>();
  const byNameAll = new Map<string, FolderAudioFile[]>();

  for (const ff of folderFiles) {
    byRelPath.set(ff.relativePath.toLowerCase(), ff);
    byNameAndSize.set(`${ff.fileName.toLowerCase()}::${ff.fileSize}`, ff);
    const key = ff.fileName.toLowerCase();
    const list = byNameAll.get(key) ?? [];
    list.push(ff);
    byNameAll.set(key, list);
  }

  const matched: Array<{ trackRef: SerializedTrackRef; folderFile: FolderAudioFile }> = [];
  const missing: SerializedTrackRef[] = [];

  for (const ref of trackRefs) {
    let found: FolderAudioFile | undefined;

    if (ref.relativePath) {
      found = byRelPath.get(ref.relativePath.toLowerCase());
    }
    if (!found) {
      found = byNameAndSize.get(`${ref.fileName.toLowerCase()}::${ref.fileSize}`);
    }
    if (!found) {
      const sameName = byNameAll.get(ref.fileName.toLowerCase());
      if (sameName && sameName.length === 1) {
        found = sameName[0];
      }
    }

    if (found) {
      matched.push({ trackRef: ref, folderFile: found });
    } else {
      missing.push(ref);
    }
  }

  return { matched, missing };
}
