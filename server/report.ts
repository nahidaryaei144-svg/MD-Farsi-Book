import fs from 'node:fs';
import path from 'node:path';
import { LIBRARY_DIR } from './config.js';
import {
    cleanList,
    frontmatterEndOffset,
    listLibraryFolders,
    missingRequiredFields
} from './library.js';
import { getLibrarySnapshot } from './library-index.js';
import {
    getStoredTextStats,
    setStoredTextStats,
    type StoredTextStats
} from './search-index.js';
import { mapLimit } from './concurrency.js';
import { countPages, measureText } from './text-stats.js';

interface ReportRow {
    filename: string;
    title: string;
    author: string;
    section: string;
    translator: string;
    tags: string[];
    rating: number;
    read: boolean;
    hasFrontmatter: boolean;
    words: number;
    characters: number;
    pages: number;
    bytes: number;
    modifiedAt: string;
    missing: string[];
}

export interface LibraryReport {
    generatedAt: string;
    totals: {
        books: number;
        folders: number;
        sections: number;
        authors: number;
        read: number;
        unread: number;
        favorites: number;
        withoutMetadata: number;
        missingMetadata: number;
        duplicates: number;
        words: number;
        characters: number;
        pages: number;
        bytes: number;
    };
    sections: { name: string; books: number; words: number }[];
    authors: { name: string; books: number; words: number }[];
    duplicates: { files: string[] }[];
    largest: ReturnType<typeof reportRowSummary>[];
    longest: ReturnType<typeof reportRowSummary>[];
    incomplete: { filename: string; title: string; missing: string[] }[];
    files: ReportRow[];
}

function reportRowSummary(row: ReportRow) {
    return { filename: row.filename, title: row.title, words: row.words, pages: row.pages, bytes: row.bytes };
}

let reportCache: { signature: string; report: LibraryReport | null; at: number } = {
    signature: '',
    report: null,
    at: 0
};
const REPORT_CACHE_MS = 60 * 1000;

/** Word and page counts are computed once, while the content index is built. */
async function statsFor(
    filename: string,
    size: number,
    mtimeMs: number
): Promise<StoredTextStats> {
    const cached = getStoredTextStats(filename, size, mtimeMs);
    if (cached) return cached;

    const filePath = path.resolve(LIBRARY_DIR, ...filename.split('/'));
    const content = await fs.promises.readFile(filePath, 'utf8').catch(() => '');
    const bodyStart = frontmatterEndOffset(content);
    const measured = measureText(content, bodyStart);
    const stats: StoredTextStats = {
        words: measured.words,
        characters: measured.characters,
        pages: countPages(content, bodyStart),
        hasFrontmatter: /^---\r?\n/.test(content)
    };
    setStoredTextStats(filename, { ...stats, size, mtimeMs });
    return stats;
}

export async function buildLibraryReport(): Promise<LibraryReport> {
    const snapshot = await getLibrarySnapshot();
    const signature = snapshot.etag;

    if (reportCache.signature === signature && Date.now() - reportCache.at < REPORT_CACHE_MS && reportCache.report) {
        return reportCache.report;
    }

    const rows = await mapLimit(snapshot.books, 16, async (book): Promise<ReportRow> => {
        const frontmatter = book.frontmatter;
        const mtimeMs = Math.floor(Date.parse(book.modifiedAt) || 0);
        const stats = await statsFor(book.filename, book.size, mtimeMs);
        return {
            filename: book.filename,
            title: String(frontmatter['نام کتاب'] || ''),
            author: String(frontmatter['نویسنده'] || ''),
            section: String(frontmatter['بخش'] || ''),
            translator: String(frontmatter['مترجم'] || ''),
            tags: cleanList(frontmatter['برچسب ها']),
            rating: Number(frontmatter['امتیاز']) || 0,
            read: frontmatter['خوانده شده'] === true,
            hasFrontmatter: stats.hasFrontmatter,
            words: stats.words,
            characters: stats.characters,
            pages: stats.pages,
            bytes: book.size,
            modifiedAt: book.modifiedAt,
            missing: missingRequiredFields(frontmatter as never)
        };
    });

    const sections = new Map<string, { name: string; books: number; words: number }>();
    const authors = new Map<string, { name: string; books: number; words: number }>();
    for (const row of rows) {
        const sectionKey = row.section || 'نامشخص';
        const sectionEntry = sections.get(sectionKey) || { name: sectionKey, books: 0, words: 0 };
        sectionEntry.books += 1;
        sectionEntry.words += row.words;
        sections.set(sectionKey, sectionEntry);

        const authorKey = row.author || 'نامشخص';
        const authorEntry = authors.get(authorKey) || { name: authorKey, books: 0, words: 0 };
        authorEntry.books += 1;
        authorEntry.words += row.words;
        authors.set(authorKey, authorEntry);
    }

    const duplicateGroups = new Map<string, string[]>();
    for (const row of rows) {
        const key = row.title.trim().toLowerCase().replace(/\s+/g, ' ');
        if (!key) continue;
        const list = duplicateGroups.get(key) || [];
        list.push(row.filename);
        duplicateGroups.set(key, list);
    }
    const duplicates = [...duplicateGroups.values()]
        .filter((list) => list.length > 1)
        .map((files) => ({ files }));
    const libraryFolders = snapshot.folders.length ? snapshot.folders : await listLibraryFolders().catch(() => []);

    const report: LibraryReport = {
        generatedAt: new Date().toISOString(),
        totals: {
            books: rows.length,
            folders: libraryFolders.length,
            sections: sections.size,
            authors: authors.size,
            read: rows.filter((row) => row.read).length,
            unread: rows.filter((row) => !row.read).length,
            favorites: rows.filter((row) => row.rating > 0).length,
            withoutMetadata: rows.filter((row) => !row.hasFrontmatter).length,
            missingMetadata: rows.filter((row) => row.missing.length > 0).length,
            duplicates: duplicates.length,
            words: rows.reduce((sum, row) => sum + row.words, 0),
            characters: rows.reduce((sum, row) => sum + row.characters, 0),
            pages: rows.reduce((sum, row) => sum + row.pages, 0),
            bytes: rows.reduce((sum, row) => sum + row.bytes, 0)
        },
        sections: [...sections.values()].sort((a, b) => b.books - a.books || a.name.localeCompare(b.name, 'fa')),
        authors: [...authors.values()]
            .sort((a, b) => b.books - a.books || a.name.localeCompare(b.name, 'fa'))
            .slice(0, 20),
        duplicates,
        largest: [...rows].sort((a, b) => b.bytes - a.bytes).slice(0, 10).map(reportRowSummary),
        longest: [...rows].sort((a, b) => b.words - a.words).slice(0, 10).map(reportRowSummary),
        incomplete: rows
            .filter((row) => row.missing.length > 0)
            .map((row) => ({ filename: row.filename, title: row.title, missing: row.missing })),
        files: rows
    };

    reportCache = { signature, report, at: Date.now() };
    return report;
}

const REPORT_COLUMNS: [string, (row: ReportRow) => string | number][] = [
    ['نام فایل', (row) => row.filename],
    ['نام کتاب', (row) => row.title],
    ['نویسنده', (row) => row.author],
    ['مترجم', (row) => row.translator],
    ['بخش', (row) => row.section],
    ['برچسب ها', (row) => row.tags.join('، ')],
    ['امتیاز', (row) => row.rating],
    ['خوانده شده', (row) => (row.read ? 'بله' : 'خیر')],
    ['تعداد کلمات', (row) => row.words],
    ['تعداد کاراکتر', (row) => row.characters],
    ['تعداد بخش و صفحه', (row) => row.pages],
    ['حجم (بایت)', (row) => row.bytes],
    ['فیلدهای ناموجود', (row) => row.missing.join('، ')],
    ['آخرین تغییر', (row) => row.modifiedAt]
];

function csvValue(value: unknown): string {
    return '"' + String(value == null ? '' : value).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
}

export function reportToCsv(report: LibraryReport): string {
    const lines = [REPORT_COLUMNS.map(([label]) => csvValue(label)).join(',')];
    for (const row of report.files) {
        lines.push(REPORT_COLUMNS.map(([, getter]) => csvValue(getter(row))).join(','));
    }
    return lines.join('\r\n') + '\r\n';
}
