import fs from 'node:fs';
import path from 'node:path';
import { LIBRARY_DIR, STORAGE_DIR } from './config.js';
import {
    listLibraryFolders,
    listMarkdownFiles,
    normalizeBookMetadata,
    readFrontmatterOnly
} from './library.js';
import { mapLimit } from './concurrency.js';

/**
 * Persistent metadata index.
 *
 * Listing the library used to open every book and read up to 64 KB of it on
 * every refresh. With thousands of large books that is hundreds of megabytes of
 * disk work per page load. Here a book's frontmatter is read once and then
 * reused as long as its size and modification time stay the same, and the whole
 * index is kept on disk so a restart does not rescan anything.
 */

const INDEX_FILE = path.join(STORAGE_DIR, 'library-index.json');
const INDEX_VERSION = 2;
const SCAN_CONCURRENCY = 48;
const SAVE_DELAY_MS = 1200;

export interface BookSummary {
    filename: string;
    frontmatter: Record<string, unknown>;
    size: number;
    modifiedAt: string;
    url: string;
}

export interface LibrarySnapshot {
    books: BookSummary[];
    folders: string[];
    libraryDir: string;
    etag: string;
    scannedAt: string;
}

interface CachedBook {
    size: number;
    mtimeMs: number;
    modifiedAt: string;
    frontmatter: Record<string, unknown>;
}

interface IndexFileShape {
    version: number;
    libraryDir: string;
    savedAt: string;
    books: Record<string, CachedBook>;
}

let cache: Map<string, CachedBook> | null = null;
let loadingCache: Promise<void> | null = null;
let dirty = false;
let saveTimer: NodeJS.Timeout | null = null;
let inFlight: Promise<LibrarySnapshot> | null = null;
let latest: LibrarySnapshot | null = null;

export function publicBookPath(filename: string): string {
    return '/' + filename.split('/').map(encodeURIComponent).join('/');
}

async function loadCache(): Promise<void> {
    if (cache) return;
    if (loadingCache) return loadingCache;
    loadingCache = (async () => {
        const map = new Map<string, CachedBook>();
        try {
            const raw = await fs.promises.readFile(INDEX_FILE, 'utf8');
            const parsed = JSON.parse(raw) as Partial<IndexFileShape>;
            if (
                parsed &&
                parsed.version === INDEX_VERSION &&
                parsed.libraryDir === LIBRARY_DIR &&
                parsed.books &&
                typeof parsed.books === 'object'
            ) {
                for (const [filename, entry] of Object.entries(parsed.books)) {
                    if (
                        entry &&
                        Number.isFinite(entry.size) &&
                        Number.isFinite(entry.mtimeMs) &&
                        entry.frontmatter &&
                        typeof entry.frontmatter === 'object'
                    ) {
                        map.set(filename, entry);
                    }
                }
            }
        } catch {
            // A missing or unreadable index simply means a fresh scan.
        }
        cache = map;
    })().finally(() => {
        loadingCache = null;
    });
    return loadingCache;
}

function scheduleSave(): void {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        void saveCache();
    }, SAVE_DELAY_MS);
    // A pending index write must never keep the process alive on its own.
    saveTimer.unref?.();
}

async function saveCache(): Promise<void> {
    if (!dirty || !cache) return;
    dirty = false;
    const payload: IndexFileShape = {
        version: INDEX_VERSION,
        libraryDir: LIBRARY_DIR,
        savedAt: new Date().toISOString(),
        books: Object.fromEntries(cache)
    };
    const tempPath = `${INDEX_FILE}.${process.pid}.tmp`;
    try {
        await fs.promises.mkdir(STORAGE_DIR, { recursive: true });
        await fs.promises.writeFile(tempPath, JSON.stringify(payload), 'utf8');
        await fs.promises.rename(tempPath, INDEX_FILE);
    } catch {
        dirty = true;
        await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    }
}

async function scan(): Promise<LibrarySnapshot> {
    await loadCache();
    const entries = cache as Map<string, CachedBook>;
    const files = await listMarkdownFiles();
    const known = new Set(files);
    for (const filename of entries.keys()) {
        if (!known.has(filename)) {
            entries.delete(filename);
            dirty = true;
        }
    }

    let freshReads = 0;
    const books = await mapLimit(files, SCAN_CONCURRENCY, async (filename): Promise<BookSummary | null> => {
        const filePath = path.resolve(LIBRARY_DIR, ...filename.split('/'));
        try {
            const stat = await fs.promises.stat(filePath);
            if (!stat.isFile()) return null;
            const mtimeMs = Math.floor(stat.mtimeMs);
            let entry = entries.get(filename);
            if (!entry || entry.size !== stat.size || entry.mtimeMs !== mtimeMs) {
                // Only the frontmatter block is read, and only a few kilobytes
                // of it in the common case (see readFrontmatterOnly).
                const frontmatter = normalizeBookMetadata(await readFrontmatterOnly(filePath), filename);
                entry = {
                    size: stat.size,
                    mtimeMs,
                    modifiedAt: stat.mtime.toISOString(),
                    frontmatter
                };
                entries.set(filename, entry);
                freshReads += 1;
                dirty = true;
            }
            return {
                filename,
                frontmatter: entry.frontmatter,
                size: entry.size,
                modifiedAt: entry.modifiedAt,
                url: publicBookPath(filename)
            };
        } catch {
            return null;
        }
    });

    const present = books.filter((book): book is BookSummary => book !== null);
    const folders = await listLibraryFolders().catch(() => []);

    // The validator changes whenever a book is added, removed, resized or
    // touched, so the browser can revalidate the listing with a cheap 304.
    let totalSize = 0;
    let newest = 0;
    for (const book of present) {
        totalSize += book.size;
        const stamp = Date.parse(book.modifiedAt) || 0;
        if (stamp > newest) newest = stamp;
    }
    const etag = `W/"lib-${INDEX_VERSION}-${present.length}-${totalSize}-${newest}"`;

    const snapshot: LibrarySnapshot = {
        books: present,
        folders,
        libraryDir: LIBRARY_DIR,
        etag,
        scannedAt: new Date().toISOString()
    };
    latest = snapshot;

    if (freshReads > 0) scheduleSave();
    else if (dirty) scheduleSave();
    return snapshot;
}

export function getLibrarySnapshot(): Promise<LibrarySnapshot> {
    if (inFlight) return inFlight;
    inFlight = scan()
        .catch((error) => {
            if (latest) return latest;
            throw error;
        })
        .finally(() => {
            inFlight = null;
        });
    return inFlight;
}

/** Cached snapshot without touching the disk; used by the search index. */
export function peekLibrarySnapshot(): LibrarySnapshot | null {
    return latest;
}

export function invalidateCachedBook(filename: string): void {
    if (!cache) return;
    if (cache.delete(filename)) dirty = true;
}

export function invalidateAllCachedBooks(): void {
    if (!cache) return;
    cache.clear();
    dirty = true;
}

export async function flushLibraryIndex(): Promise<void> {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    await saveCache();
}
