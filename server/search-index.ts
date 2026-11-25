import fs from 'node:fs';
import path from 'node:path';
import { LIBRARY_DIR, STORAGE_DIR } from './config.js';
import { listMarkdownFiles } from './library.js';
import { getLibrarySnapshot } from './library-index.js';
import { mapLimit, yieldToEventLoop } from './concurrency.js';
import { countPages, measureText } from './text-stats.js';
import { distinctTokens, stripFrontmatterOffset, tokenizeFolded } from './text-fold.js';

/**
 * Content presence index.
 *
 * A query must not read 12 GB of books to show results. Every book gets a small
 * Bloom filter of the words it contains; a query term that is absent from the
 * filter cannot be in the book, so the file is skipped without being opened.
 * Only books that *may* contain the words are read, and a cheap in-memory
 * substring check removes the filter's false positives before the exact page
 * search runs.
 *
 * The index is incremental (validated by size + mtime) and persisted, so the
 * full library is read once, ever. During the first build searches use the
 * books indexed so far and report their progress.
 */

const MANIFEST_FILE = path.join(STORAGE_DIR, 'search-index.json');
const BITS_FILE = path.join(STORAGE_DIR, 'search-index.bin');
const INDEX_VERSION = 2;
const BUILD_CONCURRENCY = 2;
const MAX_BITS_PER_BOOK = 96 * 1024;
const MIN_BITS_PER_BOOK = 1024;
/** Above this the bitsets are no longer held in memory; the gate is disabled. */
const MAX_RESIDENT_BYTES = 512 * 1024 * 1024;

interface BookStat {
    size: number;
    mtimeMs: number;
    offset: number;
    bits: number;
    hashes: number;
    words: number;
    characters: number;
    pages: number;
    hasFrontmatter: boolean;
}

interface ManifestShape {
    version: number;
    libraryDir: string;
    bitFileSize: number;
    savedAt: string;
    books: Record<string, BookStat>;
}

interface IndexState {
    manifest: ManifestShape;
    buffer: Buffer | null;
    loaded: boolean;
    total: number;
    indexed: number;
    running: boolean;
    startedAt: number;
    lastError: string;
}

const state: IndexState = {
    manifest: {
        version: INDEX_VERSION,
        libraryDir: LIBRARY_DIR,
        bitFileSize: 0,
        savedAt: '',
        books: {}
    },
    buffer: null,
    loaded: false,
    total: 0,
    indexed: 0,
    running: false,
    startedAt: 0,
    lastError: ''
};

let loadPromise: Promise<void> | null = null;
let buildPromise: Promise<void> | null = null;
let saveTimer: NodeJS.Timeout | null = null;
let dirty = false;

/**
 * Indexing gives way to interactive work.
 *
 * Folding a book is CPU-heavy, and a library request arriving during the first
 * build must not wait behind it. While any regular API request is in flight the
 * builder parks between books and resumes as soon as the request finishes.
 */
let activeInteractive = 0;

export function beginInteractiveRequest(): void {
    activeInteractive += 1;
}

export function endInteractiveRequest(): void {
    activeInteractive = Math.max(0, activeInteractive - 1);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForInteractiveIdle(): Promise<void> {
    while (activeInteractive > 0) await delay(15);
}

export interface SearchIndexStatus {
    total: number;
    indexed: number;
    running: boolean;
    bytes: number;
}

export interface StoredTextStats {
    words: number;
    characters: number;
    pages: number;
    hasFrontmatter: boolean;
}

// ---------------------------------------------------------------------------
// Bloom filter primitives

function hashToken(token: string, seed: number): number {
    let hash = (2166136261 ^ Math.imul(seed + 1, 0x9e3779b1)) >>> 0;
    for (let index = 0; index < token.length; index += 1) {
        hash ^= token.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b);
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35);
    hash ^= hash >>> 16;
    return hash >>> 0;
}

/** Eight bits per distinct word keeps the false positive rate near 2%. */
function chooseBitsetSize(distinct: number): number {
    if (distinct <= 0) return MIN_BITS_PER_BOOK;
    const bytes = Math.ceil((distinct * 8) / 8);
    return Math.max(MIN_BITS_PER_BOOK, Math.min(MAX_BITS_PER_BOOK, bytes));
}

function chooseHashes(bits: number, distinct: number): number {
    if (distinct <= 0) return 2;
    const optimal = Math.round((bits / distinct) * Math.LN2);
    return Math.max(2, Math.min(10, optimal));
}

function buildBitset(tokens: Set<string>): { bytes: Buffer; distinct: number; hashes: number } {
    const size = chooseBitsetSize(tokens.size);
    const hashes = chooseHashes(size * 8, tokens.size);
    const bytes = Buffer.alloc(size);
    const bits = size * 8;
    for (const token of tokens) {
        for (let seed = 0; seed < hashes; seed += 1) {
            const index = hashToken(token, seed) % bits;
            bytes[index >> 3] |= 1 << (index & 7);
        }
    }
    return { bytes, distinct: tokens.size, hashes };
}

function mayContain(token: string, entry: BookStat, bitset: Buffer): boolean {
    const bits = entry.bits * 8;
    for (let seed = 0; seed < entry.hashes; seed += 1) {
        const index = hashToken(token, seed) % bits;
        if ((bitset[index >> 3] & (1 << (index & 7))) === 0) return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Persistence

function scheduleSave(): void {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        void saveManifest();
    }, 1500);
    saveTimer.unref?.();
}

async function saveManifest(): Promise<void> {
    if (!dirty) return;
    dirty = false;
    try {
        await fs.promises.mkdir(STORAGE_DIR, { recursive: true });
        const tempPath = `${MANIFEST_FILE}.${process.pid}.tmp`;
        await fs.promises.writeFile(
            tempPath,
            JSON.stringify({
                version: INDEX_VERSION,
                libraryDir: LIBRARY_DIR,
                bitFileSize: state.manifest.bitFileSize,
                savedAt: new Date().toISOString(),
                books: state.manifest.books
            }),
            'utf8'
        );
        await fs.promises.rename(tempPath, MANIFEST_FILE);
    } catch {
        dirty = true;
    }
}

async function loadIndex(): Promise<void> {
    if (state.loaded) return;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
        try {
            const raw = await fs.promises.readFile(MANIFEST_FILE, 'utf8');
            const parsed = JSON.parse(raw) as Partial<ManifestShape>;
            if (
                parsed &&
                parsed.version === INDEX_VERSION &&
                parsed.libraryDir === LIBRARY_DIR &&
                parsed.books &&
                typeof parsed.books === 'object'
            ) {
                state.manifest = {
                    version: INDEX_VERSION,
                    libraryDir: LIBRARY_DIR,
                    bitFileSize: Number(parsed.bitFileSize) || 0,
                    savedAt: String(parsed.savedAt || ''),
                    books: parsed.books
                };
            }
        } catch {
            // First run: an empty index is built below.
        }

        try {
            const stat = await fs.promises.stat(BITS_FILE);
            if (stat.size > 0 && stat.size <= MAX_RESIDENT_BYTES) {
                state.buffer = await fs.promises.readFile(BITS_FILE);
                state.manifest.bitFileSize = stat.size;
            } else if (stat.size > MAX_RESIDENT_BYTES) {
                console.warn('نمایهٔ متن بزرگ‌تر از حافظهٔ مجاز است؛ پرش سریع غیرفعال شد.');
            }
        } catch {
            state.buffer = null;
        }

        // Drop entries that point outside the bitset file (a truncated index).
        const limit = state.buffer ? state.buffer.length : state.manifest.bitFileSize;
        for (const [filename, entry] of Object.entries(state.manifest.books)) {
            if (!entry || entry.offset + entry.bits > limit) delete state.manifest.books[filename];
        }

        state.loaded = true;
    })().finally(() => {
        loadPromise = null;
    });
    return loadPromise;
}

// ---------------------------------------------------------------------------
// Build

async function appendBits(bytes: Buffer): Promise<number> {
    await fs.promises.mkdir(STORAGE_DIR, { recursive: true });
    const offset = state.manifest.bitFileSize;
    await fs.promises.appendFile(BITS_FILE, bytes);
    state.manifest.bitFileSize = offset + bytes.length;
    // The resident bitset is reloaded once the build finishes. Growing it on
    // every append would copy the whole index each time (quadratic).
    state.buffer = null;
    return offset;
}

let appendChain: Promise<unknown> = Promise.resolve();

function enqueueAppend(bytes: Buffer): Promise<number> {
    const task = appendChain.then(() => appendBits(bytes));
    appendChain = task.catch(() => {});
    return task;
}

async function indexOne(filename: string, size: number, mtimeMs: number): Promise<void> {
    const filePath = path.resolve(LIBRARY_DIR, ...filename.split('/'));
    const content = await fs.promises.readFile(filePath, 'utf8');
    const bodyStart = stripFrontmatterOffset(content);
    const { bytes, hashes } = buildBitset(distinctTokens(content));
    const measured = measureText(content, bodyStart);
    const offset = await enqueueAppend(bytes);
    state.manifest.books[filename] = {
        size,
        mtimeMs,
        offset,
        bits: bytes.length,
        hashes,
        words: measured.words,
        characters: measured.characters,
        pages: countPages(content, bodyStart),
        hasFrontmatter: /^---\r?\n/.test(content)
    };
}

async function compactIfNeeded(): Promise<void> {
    const entries = Object.values(state.manifest.books);
    const live = entries.reduce((sum, entry) => sum + entry.bits, 0);
    const size = state.manifest.bitFileSize;
    if (!size || live === 0) return;
    if (size < 64 * 1024 * 1024 || size < live * 1.5) return;

    const source = state.buffer ?? (await fs.promises.readFile(BITS_FILE).catch(() => null));
    if (!source) return;
    const tempPath = `${BITS_FILE}.${process.pid}.tmp`;
    const chunks: Buffer[] = [];
    let offset = 0;
    for (const [filename, entry] of Object.entries(state.manifest.books)) {
        const slice = source.subarray(entry.offset, entry.offset + entry.bits);
        if (slice.length !== entry.bits) {
            delete state.manifest.books[filename];
            continue;
        }
        entry.offset = offset;
        offset += entry.bits;
        chunks.push(slice);
    }
    const buffer = Buffer.concat(chunks);
    await fs.promises.writeFile(tempPath, buffer);
    await fs.promises.rename(tempPath, BITS_FILE);
    state.manifest.bitFileSize = buffer.length;
    state.buffer = buffer;
    scheduleSave();
}

async function build(): Promise<void> {
    if (state.running) return;
    state.running = true;
    state.startedAt = Date.now();
    state.lastError = '';
    try {
        await loadIndex();
        const snapshot = await getLibrarySnapshot();
        const files = snapshot.books.map((book) => ({
            filename: book.filename,
            size: book.size,
            mtimeMs: Math.floor(Date.parse(book.modifiedAt) || 0)
        }));
        const filesOnDisk = new Set(files.map((item) => item.filename));
        for (const filename of Object.keys(state.manifest.books)) {
            if (!filesOnDisk.has(filename)) delete state.manifest.books[filename];
        }

        // The metadata snapshot already carries a fresh size and modification
        // time for every book, so revalidation does not touch the filesystem.
        const stale = files.filter((item) => {
            const entry = state.manifest.books[item.filename];
            return !entry || entry.size !== item.size || entry.mtimeMs !== item.mtimeMs;
        });

        state.total = files.length;
        state.indexed = files.length - stale.length;

        if (!stale.length) {
            // Nothing changed: make sure the bitsets are queryable and stop.
            if (!state.buffer && state.manifest.bitFileSize) {
                try {
                    const stat = await fs.promises.stat(BITS_FILE);
                    if (stat.size <= MAX_RESIDENT_BYTES) state.buffer = await fs.promises.readFile(BITS_FILE);
                } catch {
                    state.buffer = null;
                }
            }
            return;
        }

        await mapLimit(stale, BUILD_CONCURRENCY, async (item) => {
            await waitForInteractiveIdle();
            try {
                await indexOne(item.filename, item.size, item.mtimeMs);
            } catch {
                // An unreadable book is skipped; it is retried on the next run.
            } finally {
                state.indexed += 1;
                if (state.indexed % 200 === 0) scheduleSave();
                // Give pending requests (library scans, open books, searches) a
                // turn between every file, so indexing never freezes the app.
                await yieldToEventLoop();
            }
        });

        state.indexed = files.length;
        await compactIfNeeded();
        scheduleSave();
        await saveManifest();

        // The index is queryable from here on: load the freshly written bitsets
        // back into memory so queries stop reporting "unknown".
        try {
            const stat = await fs.promises.stat(BITS_FILE);
            if (stat.size <= MAX_RESIDENT_BYTES) state.buffer = await fs.promises.readFile(BITS_FILE);
        } catch {
            state.buffer = null;
        }
        console.log(`نمایهٔ جست‌وجوی متن آماده شد: ${files.length} کتاب در ${Math.round((Date.now() - state.startedAt) / 1000)} ثانیه.`);
    } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        console.warn('ساخت نمایهٔ جست‌وجو ناموفق بود:', state.lastError);
    } finally {
        state.running = false;
    }
}

/** Starts (or joins) the background build. Safe to call on every request. */
export function ensureSearchIndex(): Promise<void> {
    if (buildPromise) return buildPromise;
    buildPromise = build().finally(() => {
        buildPromise = null;
    });
    return buildPromise;
}

export function getSearchIndexStatus(): SearchIndexStatus {
    return {
        total: state.total,
        indexed: state.indexed,
        running: state.running,
        bytes: state.manifest.bitFileSize
    };
}

export async function getSearchIndexStatusAsync(): Promise<SearchIndexStatus> {
    await loadIndex();
    return getSearchIndexStatus();
}

// ---------------------------------------------------------------------------
// Query gating

export type GateVerdict = 'yes' | 'no' | 'unknown';

export interface Gate {
    /** Every word of each group must be present for the group to match. */
    groups: string[][];
    requireAll: boolean;
}

export function buildGate(terms: { text: string; wildcard: boolean; regex: boolean }[], requireAll: boolean): Gate {
    const groups: string[][] = [];
    for (const term of terms) {
        if (term.regex || term.wildcard || !term.text.trim()) continue;
        const tokens = Array.from(new Set(tokenizeFolded(term.text)));
        if (tokens.length) groups.push(tokens);
    }
    return { groups, requireAll };
}

function verdictFor(entry: BookStat, bitset: Buffer, gate: Gate): GateVerdict {
    let matchedGroups = 0;
    for (const group of gate.groups) {
        let present = true;
        for (const token of group) {
            if (!mayContain(token, entry, bitset)) {
                present = false;
                break;
            }
        }
        if (present) {
            matchedGroups += 1;
            if (!gate.requireAll) return 'yes';
        } else if (gate.requireAll) {
            return 'no';
        }
    }
    return matchedGroups > 0 ? 'yes' : 'no';
}

async function readBitset(handle: fs.promises.FileHandle, entry: BookStat): Promise<Buffer | null> {
    if (!entry.bits) return null;
    const buffer = Buffer.allocUnsafe(entry.bits);
    const { bytesRead } = await handle.read(buffer, 0, entry.bits, entry.offset);
    return bytesRead === entry.bits ? buffer : null;
}

export async function gateBook(filename: string, size: number, mtimeMs: number, gate: Gate): Promise<GateVerdict> {
    if (!gate.groups.length) return 'yes';
    const entry = state.manifest.books[filename];
    if (!entry || entry.size !== size || entry.mtimeMs !== mtimeMs) return 'unknown';
    const buffer = state.buffer;
    if (!buffer || entry.offset + entry.bits > buffer.length) return 'unknown';
    return verdictFor(entry, buffer.subarray(entry.offset, entry.offset + entry.bits), gate);
}

export async function gateBooks(
    books: { filename: string; size: number; mtimeMs: number }[],
    gate: Gate
): Promise<{ candidates: typeof books; unknown: number }> {
    if (!gate.groups.length) return { candidates: books, unknown: 0 };
    await loadIndex();
    const candidates: typeof books = [];
    let unknown = 0;

    const entryFor = (book: (typeof books)[number]): BookStat | null => {
        const entry = state.manifest.books[book.filename];
        if (!entry || entry.size !== book.size || entry.mtimeMs !== book.mtimeMs || !entry.bits) return null;
        return entry;
    };

    const resident = state.buffer;
    if (resident) {
        for (const book of books) {
            const entry = entryFor(book);
            if (!entry || entry.offset + entry.bits > resident.length) {
                unknown += 1;
                continue;
            }
            if (verdictFor(entry, resident.subarray(entry.offset, entry.offset + entry.bits), gate) === 'yes') {
                candidates.push(book);
            }
        }
        return { candidates, unknown };
    }

    // The index is still being written, so its bitsets live only on disk.
    // Reading them keeps partial results available during the first build.
    const handle = await fs.promises.open(BITS_FILE, 'r').catch(() => null);
    if (!handle) return { candidates: [], unknown: books.length };
    try {
        for (const book of books) {
            const entry = entryFor(book);
            const bitset = entry ? await readBitset(handle, entry) : null;
            if (!entry || !bitset) {
                unknown += 1;
                continue;
            }
            if (verdictFor(entry, bitset, gate) === 'yes') candidates.push(book);
        }
    } finally {
        await handle.close();
    }
    return { candidates, unknown };
}

export function getStoredTextStats(
    filename: string,
    size?: number,
    mtimeMs?: number
): StoredTextStats | null {
    const entry = state.manifest.books[filename];
    if (!entry) return null;
    if (size !== undefined && entry.size !== size) return null;
    if (mtimeMs !== undefined && entry.mtimeMs !== Math.floor(mtimeMs)) return null;
    return {
        words: entry.words,
        characters: entry.characters,
        pages: entry.pages,
        hasFrontmatter: entry.hasFrontmatter
    };
}

/** Records statistics measured elsewhere (the report's fallback path). */
export function setStoredTextStats(filename: string, stats: StoredTextStats & { size: number; mtimeMs: number }): void {
    const entry = state.manifest.books[filename];
    if (entry && entry.size === stats.size && entry.mtimeMs === stats.mtimeMs) {
        entry.words = stats.words;
        entry.characters = stats.characters;
        entry.pages = stats.pages;
        entry.hasFrontmatter = stats.hasFrontmatter;
        scheduleSave();
        return;
    }
    // Without a bitset the entry cannot be used for gating, but the statistics
    // are still useful for the report. Offset 0 with 0 bits is ignored by the
    // gate (it reports "unknown" and the book is simply not gated).
    state.manifest.books[filename] = {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        offset: state.manifest.bitFileSize,
        bits: 0,
        hashes: 0,
        words: stats.words,
        characters: stats.characters,
        pages: stats.pages,
        hasFrontmatter: stats.hasFrontmatter
    };
    scheduleSave();
}

export async function flushSearchIndex(): Promise<void> {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    await saveManifest();
}
