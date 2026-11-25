import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LIBRARY_DIR } from './config.js';
import { getLibrarySnapshot, type BookSummary } from './library-index.js';
import {
    buildGate,
    ensureSearchIndex,
    gateBooks,
    getSearchIndexStatusAsync
} from './search-index.js';
import { foldText } from './text-fold.js';
import { HttpError } from './http.js';
import { parseQuery, searchBook } from '../src/lib/search';
import type { BookSummary as SearchBookSummary, SearchBookResult, SearchOptions } from '../src/types';

/**
 * Server-side full-text search.
 *
 * The browser used to download every book in the library to search it (12 GB
 * in this case). Now the server uses the content-presence index to skip books
 * that cannot contain the query, verifies the survivors with a cheap substring
 * check, and only then runs the exact page/snippet search. Results are streamed
 * as newline-delimited JSON so hits appear while the search is still running.
 */

const SEND_INTERVAL_MS = 220;

const DEFAULT_OPTIONS: SearchOptions = {
    mode: 'phrase',
    fuzzy: 0,
    wholeWord: false,
    caseSensitive: false,
    includeHeadings: true,
    includeFootnotes: true,
    headingsOnly: false,
    sort: 'relevance'
};

function normalizeOptions(source: unknown): SearchOptions {
    const input = source && typeof source === 'object' ? (source as Record<string, unknown>) : {};
    const modes: SearchOptions['mode'][] = ['all', 'any', 'phrase', 'regex'];
    const sorts: SearchOptions['sort'][] = ['relevance', 'matches', 'title'];
    const mode = modes.includes(input.mode as SearchOptions['mode'])
        ? (input.mode as SearchOptions['mode'])
        : DEFAULT_OPTIONS.mode;
    const sort = sorts.includes(input.sort as SearchOptions['sort'])
        ? (input.sort as SearchOptions['sort'])
        : DEFAULT_OPTIONS.sort;
    const fuzzyValue = Number(input.fuzzy);
    return {
        mode,
        sort,
        fuzzy: Number.isFinite(fuzzyValue) ? Math.max(0, Math.min(2, Math.round(fuzzyValue))) : 0,
        wholeWord: input.wholeWord === true,
        caseSensitive: input.caseSensitive === true,
        includeHeadings: input.includeHeadings !== false,
        includeFootnotes: input.includeFootnotes !== false,
        headingsOnly: input.headingsOnly === true
    };
}

function foldedRegex(term: ReturnType<typeof parseQuery>['terms'][number]): RegExp | null {
    if (!term.pattern) return null;
    try {
        return new RegExp(term.pattern.source, term.pattern.flags.replace(/g/g, ''));
    } catch {
        return null;
    }
}

/**
 * Cheap whole-book gate that runs after the file is read. It is deliberately
 * permissive (a superset of the exact page search) so it can never hide a hit.
 */
function contentMayMatch(
    content: string,
    terms: ReturnType<typeof parseQuery>['terms'],
    requireAll: boolean,
    fuzzy: number
): boolean {
    if (!terms.length) return false;
    // Typo-tolerant matching and empty term text cannot be gated cheaply.
    if (fuzzy > 0) return true;

    // Most hits appear literally in the text, so a case-insensitive substring
    // test settles them without folding a single character. Only the terms that
    // were not found literally need the (more expensive) folded comparison.
    const lower = content.toLowerCase();
    const unresolved: typeof terms = [];
    let anyHit = false;
    for (const term of terms) {
        if (term.regex) {
            unresolved.push(term);
            continue;
        }
        const needle = term.text;
        if (!needle) continue;
        if (lower.includes(needle)) {
            anyHit = true;
            if (!requireAll) return true;
        } else {
            unresolved.push(term);
        }
    }
    if (!unresolved.length) return true;

    const folded = foldText(content);
    for (const term of unresolved) {
        if (term.regex) {
            const pattern = foldedRegex(term);
            if (!pattern || pattern.test(folded)) {
                anyHit = true;
                if (!requireAll) return true;
            } else if (requireAll) {
                return false;
            }
            continue;
        }
        if (folded.includes(term.text)) {
            anyHit = true;
            if (!requireAll) return true;
        } else if (requireAll) {
            return false;
        }
    }
    return requireAll ? true : anyHit;
}

export interface SearchInput {
    query: string;
    options: SearchOptions;
    filenames?: string[];
}

function writeLine(res: ServerResponse, payload: unknown): void {
    if (res.writableEnded) return;
    res.write(`${JSON.stringify(payload)}\n`);
}

export async function streamLibrarySearch(
    req: IncomingMessage,
    res: ServerResponse,
    input: SearchInput
): Promise<void> {
    const query = String(input.query || '').trim();
    const options = normalizeOptions(input.options);
    const parsed = parseQuery(query, options);
    if (parsed.error) throw new HttpError(parsed.error);
    const positive = parsed.terms.filter((term) => !term.negative);
    if (!positive.length) throw new HttpError('عبارت جست‌وجو خالی است.');

    const requireAll = options.mode === 'all' && !parsed.anyMode;
    const snapshot = await getLibrarySnapshot();
    let books: BookSummary[] = snapshot.books;
    if (Array.isArray(input.filenames) && input.filenames.length) {
        const allowed = new Set(input.filenames);
        books = books.filter((book) => allowed.has(book.filename));
    }

    void ensureSearchIndex();
    const gate = buildGate(positive, requireAll);
    const { candidates, unknown } = await gateBooks(
        books.map((book) => ({
            filename: book.filename,
            size: book.size,
            mtimeMs: Math.floor(Date.parse(book.modifiedAt) || 0)
        })),
        gate
    );
    if (res.writableEnded) return;

    const byFilename = new Map(books.map((book) => [book.filename, book]));
    const queue = candidates
        .map((entry) => byFilename.get(entry.filename))
        .filter((book): book is BookSummary => Boolean(book))
        // Small books are checked first, so hits start streaming immediately
        // instead of waiting for the largest volumes in the library.
        .sort((a, b) => a.size - b.size);

    const indexing = await getSearchIndexStatusAsync();
    res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no'
    });

    const started = Date.now();
    let scanned = 0;
    // `req` closes as soon as its body has been read; only the response tells
    // us the client is really gone.
    let closed = false;
    res.on('close', () => {
        closed = true;
    });

    writeLine(res, {
        type: 'meta',
        query,
        candidates: queue.length,
        totalBooks: books.length,
        skipped: books.length - queue.length,
        notIndexed: unknown,
        indexing,
        tookMs: Date.now() - started
    });

    const pending: SearchBookResult[] = [];
    let lastSent = Date.now();

    const flush = (running: boolean): void => {
        if (!pending.length && running) {
            if (Date.now() - lastSent >= SEND_INTERVAL_MS) {
                lastSent = Date.now();
                writeLine(res, {
                    type: 'progress',
                    scanned,
                    candidates: queue.length,
                    totalBooks: books.length,
                    tookMs: Date.now() - started
                });
            }
            return;
        }
        if (!pending.length) return;
        const results = pending.splice(0, pending.length);
        lastSent = Date.now();
        writeLine(res, {
            type: 'results',
            results,
            scanned,
            candidates: queue.length,
            totalBooks: books.length,
            tookMs: Date.now() - started,
            running
        });
    };

    for (const book of queue) {
        if (closed || res.writableEnded || res.destroyed) return;
        scanned += 1;
        try {
            const filePath = path.resolve(LIBRARY_DIR, ...book.filename.split('/'));
            const content = await fs.promises.readFile(filePath, 'utf8');
            if (contentMayMatch(content, positive, requireAll, options.fuzzy)) {
                const result = searchBook(
                    book as unknown as SearchBookSummary,
                    content,
                    query,
                    options
                );
                if (result) pending.push(result);
            }
        } catch {
            // A book that vanished or cannot be read is simply skipped.
        }

        if (pending.length >= 4 || Date.now() - lastSent >= SEND_INTERVAL_MS) flush(true);
        // Give other requests (and the UI's library refreshes) a turn.
        await new Promise((resolve) => setImmediate(resolve));
    }

    flush(false);
    writeLine(res, {
        type: 'done',
        scanned,
        candidates: queue.length,
        totalBooks: books.length,
        tookMs: Date.now() - started,
        indexing: await getSearchIndexStatusAsync()
    });
    res.end();
}
