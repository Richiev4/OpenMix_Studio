import { isSupportedAudioFile } from '../audio/analysis';
import type {
  DjFolderDiffSummary,
  DjFolderSnapshot,
  FolderAudioFile,
  FolderFileSnapshotEntry,
  TrackAnalysisMeta,
} from '../types/audio';

const DB_NAME = 'obsidian-deck-studio';
const DB_VERSION = 2;
const STORE_HANDLES = 'handles';
const STORE_PROJECTS = 'projects';
const STORE_ANALYSIS_CACHE = 'trackAnalysisCache';
const DJ_FOLDER_KEY = 'dj-folder-handle';
const DJ_FOLDER_SNAPSHOT_KEY = 'dj-folder-snapshot';

export type FolderPermissionState = 'granted' | 'prompt' | 'denied';

/** Narrow interface for File System Access API permission methods that vary across TS DOM libs. */
export interface DirectoryHandleLike extends FileSystemDirectoryHandle {
  queryPermission?: (desc?: { mode?: 'read' | 'readwrite' }) => Promise<FolderPermissionState>;
  requestPermission?: (desc?: { mode?: 'read' | 'readwrite' }) => Promise<FolderPermissionState>;
}

/** Error thrown when showDirectoryPicker is unavailable or blocked (e.g. iframe / Safari). */
export class DjFolderPickerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DjFolderPickerUnavailableError';
  }
}

export function isFileSystemAccessSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
  );
}

/** Opens the shared IndexedDB database used for persisted folder handles and autosave manifests. */
export function openStudioDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable in this browser context.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_HANDLES)) {
        db.createObjectStore(STORE_HANDLES);
      }
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS);
      }
      if (!db.objectStoreNames.contains(STORE_ANALYSIS_CACHE)) {
        db.createObjectStore(STORE_ANALYSIS_CACHE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB.'));
  });
}

/** Builds a stable cache key for an audio file based on its name, byte size, and modified timestamp. */
export function getFolderFileCacheKey(
  file: Pick<FolderAudioFile, 'fileName' | 'fileSize' | 'lastModified'>
): string {
  return `v4::${file.fileName.toLowerCase()}::${file.fileSize}::${file.lastModified}`;
}

function getLegacyV3CacheKey(
  file: Pick<FolderAudioFile, 'fileName' | 'fileSize' | 'lastModified'>
): string {
  return `v3::${file.fileName.toLowerCase()}::${file.fileSize}::${file.lastModified}`;
}

/** Loads all cached pre-analyzed track metadata entries from IndexedDB in a single read transaction. */
export async function loadCachedTrackAnalysisMap(): Promise<Map<string, TrackAnalysisMeta>> {
  const result = new Map<string, TrackAnalysisMeta>();
  try {
    const db = await openStudioDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_ANALYSIS_CACHE, 'readonly');
      const store = tx.objectStore(STORE_ANALYSIS_CACHE);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          if (typeof cursor.key === 'string' && cursor.value) {
            result.set(cursor.key, cursor.value as TrackAnalysisMeta);
          }
          cursor.continue();
        } else {
          resolve();
        }
      };
      req.onerror = () => reject(req.error);
    });
    db.close();
  } catch {
    // Non-fatal in private browsing or restricted contexts
  }
  return result;
}

/** Persists pre-analyzed BPM/Key/duration metadata for a single audio file in IndexedDB. */
export async function saveCachedTrackAnalysis(
  cacheKey: string,
  meta: TrackAnalysisMeta
): Promise<void> {
  try {
    const db = await openStudioDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_ANALYSIS_CACHE, 'readwrite');
      tx.objectStore(STORE_ANALYSIS_CACHE).put(meta, cacheKey);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore storage quota or private-mode failures
  }
}

/** Attaches any previously cached BPM/Key metadata onto scanned FolderAudioFile entries. */
export async function hydrateFolderFilesWithCache(
  files: FolderAudioFile[]
): Promise<FolderAudioFile[]> {
  if (files.length === 0) return files;
  const cache = await loadCachedTrackAnalysisMap();
  if (cache.size === 0) return files;

  return files.map((item) => {
    if (item.analysis) return item;
    const cachedV4 = cache.get(getFolderFileCacheKey(item));
    if (cachedV4) return { ...item, analysis: cachedV4 };
    const legacyV3 = cache.get(getLegacyV3CacheKey(item));
    if (legacyV3?.manualBeatgrid) {
      return { ...item, analysis: legacyV3 };
    }
    return item;
  });
}

export async function saveDjFolderHandle(handle: DirectoryHandleLike): Promise<void> {
  try {
    const db = await openStudioDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_HANDLES, 'readwrite');
      tx.objectStore(STORE_HANDLES).put(handle, DJ_FOLDER_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Could not save folder handle.'));
    });
    db.close();
  } catch {
    // Non-fatal in private browsing or restricted contexts
  }
}

export async function loadDjFolderHandle(): Promise<DirectoryHandleLike | null> {
  try {
    const db = await openStudioDb();
    const handle = await new Promise<DirectoryHandleLike | null>((resolve, reject) => {
      const tx = db.transaction(STORE_HANDLES, 'readonly');
      const req = tx.objectStore(STORE_HANDLES).get(DJ_FOLDER_KEY);
      req.onsuccess = () => resolve((req.result as DirectoryHandleLike | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle;
  } catch {
    return null;
  }
}

export async function clearDjFolderHandle(): Promise<void> {
  try {
    const db = await openStudioDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_HANDLES, 'readwrite');
      tx.objectStore(STORE_HANDLES).delete(DJ_FOLDER_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore cleanup errors
  }
}

/** Saves a lightweight snapshot of the indexed DJ folder contents to detect changes on next startup. */
export async function saveDjFolderSnapshot(
  folderName: string,
  files: FolderAudioFile[]
): Promise<void> {
  const entries: FolderFileSnapshotEntry[] = files.map((f) => ({
    relativePath: f.relativePath,
    fileName: f.fileName,
    fileSize: f.fileSize,
    lastModified: f.lastModified,
  }));
  const snapshot: DjFolderSnapshot = {
    folderName,
    scannedAt: Date.now(),
    files: entries,
  };
  try {
    const db = await openStudioDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_HANDLES, 'readwrite');
      tx.objectStore(STORE_HANDLES).put(snapshot, DJ_FOLDER_SNAPSHOT_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Could not save folder snapshot.'));
    });
    db.close();
  } catch {
    // Non-fatal in private browsing or restricted contexts
  }
}

/** Loads the previously persisted DJ folder index snapshot from IndexedDB. */
export async function loadDjFolderSnapshot(): Promise<DjFolderSnapshot | null> {
  try {
    const db = await openStudioDb();
    const snapshot = await new Promise<DjFolderSnapshot | null>((resolve, reject) => {
      const tx = db.transaction(STORE_HANDLES, 'readonly');
      const req = tx.objectStore(STORE_HANDLES).get(DJ_FOLDER_SNAPSHOT_KEY);
      req.onsuccess = () => resolve((req.result as DjFolderSnapshot | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return snapshot;
  } catch {
    return null;
  }
}

/** Compares a newly scanned file list against a previously stored folder snapshot. */
export function diffFolderSnapshots(
  previous: DjFolderSnapshot | null,
  currentFolderName: string,
  currentFiles: FolderAudioFile[]
): DjFolderDiffSummary {
  const scannedAt = Date.now();
  if (!previous || previous.folderName !== currentFolderName) {
    return {
      hasBaseline: false,
      addedPaths: [],
      modifiedPaths: [],
      removedPaths: [],
      scannedAt,
    };
  }

  const prevByPath = new Map<string, FolderFileSnapshotEntry>();
  for (const entry of previous.files) {
    prevByPath.set(entry.relativePath.toLowerCase(), entry);
  }

  const currByPath = new Map<string, FolderAudioFile>();
  const addedPaths: string[] = [];
  const modifiedPaths: string[] = [];
  const removedPaths: string[] = [];

  for (const file of currentFiles) {
    const key = file.relativePath.toLowerCase();
    currByPath.set(key, file);
    const prev = prevByPath.get(key);
    if (!prev) {
      addedPaths.push(file.relativePath);
    } else if (prev.fileSize !== file.fileSize || prev.lastModified !== file.lastModified) {
      modifiedPaths.push(file.relativePath);
    }
  }

  for (const [key, prev] of prevByPath) {
    if (!currByPath.has(key)) {
      removedPaths.push(prev.relativePath);
    }
  }

  return {
    hasBaseline: true,
    addedPaths,
    modifiedPaths,
    removedPaths,
    scannedAt,
  };
}

/**
 * Prompts the user to pick a persistent "DJ Folder" via the File System Access API.
 * Throws DjFolderPickerUnavailableError if the browser or iframe blocks showDirectoryPicker,
 * allowing callers to fall back seamlessly to <input webkitdirectory>.
 */
export async function pickDjFolderHandle(): Promise<DirectoryHandleLike | null> {
  if (!isFileSystemAccessSupported()) {
    throw new DjFolderPickerUnavailableError(
      'File System Access API is not supported in this browser.'
    );
  }

  const showPicker = (
    window as unknown as {
      showDirectoryPicker: (opts?: {
        id?: string;
        mode?: 'read' | 'readwrite';
      }) => Promise<DirectoryHandleLike>;
    }
  ).showDirectoryPicker;

  try {
    const handle = await showPicker({ id: 'obsidian-dj-folder', mode: 'read' });
    await saveDjFolderHandle(handle);
    return handle;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return null;
    }
    if (
      err instanceof DOMException &&
      (err.name === 'SecurityError' || err.name === 'NotAllowedError')
    ) {
      throw new DjFolderPickerUnavailableError(
        'Folder handle picker is blocked in this embedded context; falling back to local folder selection.'
      );
    }
    throw err;
  }
}

export async function verifyFolderPermission(
  handle: DirectoryHandleLike,
  requestIfNeeded: boolean
): Promise<FolderPermissionState> {
  try {
    const query = handle.queryPermission
      ? await handle.queryPermission({ mode: 'read' })
      : 'granted';
    if (query === 'granted') return 'granted';
    if (requestIfNeeded && handle.requestPermission) {
      return await handle.requestPermission({ mode: 'read' });
    }
    return query;
  } catch {
    return 'denied';
  }
}

/** Recursively indexes all supported audio files inside a DirectoryHandle. */
export async function scanDirectoryHandle(
  rootHandle: DirectoryHandleLike
): Promise<FolderAudioFile[]> {
  const results: FolderAudioFile[] = [];

  const walk = async (dir: DirectoryHandleLike, prefix: string) => {
    if (!dir.entries) return;
    for await (const [name, entry] of dir.entries()) {
      // Skip hidden OS/tool directories & dot-files
      if (name.startsWith('.')) continue;

      const relPath = prefix ? `${prefix}/${name}` : name;
      if (entry.kind === 'directory') {
        await walk(entry as DirectoryHandleLike, relPath);
      } else if (entry.kind === 'file') {
        const fileHandle = entry as FileSystemFileHandle;
        const file = await fileHandle.getFile();
        if (isSupportedAudioFile(file.name, file.type)) {
          results.push({
            file,
            fileName: file.name,
            relativePath: relPath,
            fileSize: file.size,
            lastModified: file.lastModified ?? 0,
          });
        }
      }
    }
  };

  await walk(rootHandle, '');
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return results;
}

/**
 * Normalizes files selected via <input type="file" webkitdirectory> into FolderAudioFile[],
 * stripping the outer folder name so relative paths match scanDirectoryHandle output.
 */
export function scanFileListFromDirectoryInput(
  fileList: FileList | File[]
): { folderName: string; files: FolderAudioFile[] } {
  const arr = Array.from(fileList);
  let detectedRoot = 'DJ Folder';
  const results: FolderAudioFile[] = [];

  for (const file of arr) {
    if (!isSupportedAudioFile(file.name, file.type)) continue;
    const rawRel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || '';
    let relativePath = file.name;

    if (rawRel.includes('/')) {
      const firstSlash = rawRel.indexOf('/');
      const root = rawRel.slice(0, firstSlash);
      if (root) detectedRoot = root;
      relativePath = rawRel.slice(firstSlash + 1) || file.name;
    }

    results.push({
      file,
      fileName: file.name,
      relativePath,
      fileSize: file.size,
      lastModified: file.lastModified ?? 0,
    });
  }

  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { folderName: detectedRoot, files: results };
}

/** Extracts audio files (including nested directories) from a drag-and-drop DataTransfer. */
export async function extractDroppedAudioFiles(
  dataTransfer: DataTransfer
): Promise<{ folderName: string | null; files: FolderAudioFile[] }> {
  const items = Array.from(dataTransfer.items ?? []);
  const entries: FileSystemEntry[] = [];
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }

  if (entries.length === 0) {
    const plain = Array.from(dataTransfer.files ?? [])
      .filter((f) => isSupportedAudioFile(f.name, f.type))
      .map((f) => ({
        file: f,
        fileName: f.name,
        relativePath: f.name,
        fileSize: f.size,
        lastModified: f.lastModified ?? 0,
      }));
    return { folderName: null, files: plain };
  }

  let droppedFolderName: string | null = null;
  if (entries.length === 1 && entries[0].isDirectory) {
    droppedFolderName = entries[0].name;
  }

  const collected: FolderAudioFile[] = [];

  const readEntry = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.name.startsWith('.')) return;

    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      const file = await new Promise<File>((resolve, reject) => {
        fileEntry.file(resolve, reject);
      });
      if (isSupportedAudioFile(file.name, file.type)) {
        const relPath = prefix ? `${prefix}/${file.name}` : file.name;
        collected.push({
          file,
          fileName: file.name,
          relativePath: relPath,
          fileSize: file.size,
          lastModified: file.lastModified ?? 0,
        });
      }
    } else if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry;
      const reader = dirEntry.createReader();
      // readEntries returns batches (often max 100 per call) until an empty array
      const allChildren: FileSystemEntry[] = [];
      while (true) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
          reader.readEntries(resolve, reject);
        });
        if (batch.length === 0) break;
        allChildren.push(...batch);
      }
      // If a single top-level folder was dropped, strip its root name to keep relativePath clean
      const nextPrefix =
        droppedFolderName && prefix === '' && entry.name === droppedFolderName
          ? ''
          : prefix
          ? `${prefix}/${entry.name}`
          : entry.name;

      for (const child of allChildren) {
        await readEntry(child, nextPrefix);
      }
    }
  };

  for (const entry of entries) {
    await readEntry(entry, '');
  }

  collected.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { folderName: droppedFolderName, files: collected };
}
