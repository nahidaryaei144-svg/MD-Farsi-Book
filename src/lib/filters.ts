import type { BookSummary, LibraryFilters } from '../types';
import { relativeFolder } from './format';

export const emptyFilters: LibraryFilters = {
    query: '',
    scope: 'books',
    sections: [],
    folders: [],
    authors: [],
    tags: [],
    favoritesOnly: false,
    readOnly: false,
    inFiltered: false
};

export function normalizeText(value: string): string {
    return String(value || '')
        .toLocaleLowerCase('fa')
        .replace(/[\u064B-\u0652\u0640]/g, '')
        .replace(/\u200c/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const haystackCache = new WeakMap<BookSummary, string>();
const tagCache = new WeakMap<BookSummary, string[]>();

/** Normalized metadata text, computed once per book instead of per keystroke. */
function haystackOf(book: BookSummary): string {
    const cached = haystackCache.get(book);
    if (cached !== undefined) return cached;
    const meta = book.frontmatter;
    const haystack = [
        meta['نام کتاب'],
        meta['نویسنده'],
        meta['مترجم'],
        meta['بخش'],
        ...(Array.isArray(meta['برچسب ها']) ? meta['برچسب ها'] : []),
        book.filename
    ]
        .map((value) => normalizeText(String(value ?? '')))
        .join(' \u0000 ');
    haystackCache.set(book, haystack);
    return haystack;
}

function normalizedTagsOf(book: BookSummary): string[] {
    const cached = tagCache.get(book);
    if (cached) return cached;
    const tags = (book.frontmatter['برچسب ها'] || []).map((tag) => normalizeText(tag));
    tagCache.set(book, tags);
    return tags;
}

export function matchesQuery(book: BookSummary, query: string): boolean {
    const needle = normalizeText(query);
    if (!needle) return true;
    return haystackOf(book).includes(needle);
}

export function applyFilters(books: BookSummary[], filters: LibraryFilters): BookSummary[] {
    return books.filter((book) => {
        const meta = book.frontmatter;
        if (filters.sections.length && !filters.sections.includes(meta['بخش'] || 'نامشخص')) return false;
        if (filters.authors.length && !filters.authors.includes(meta['نویسنده'] || 'نامشخص')) return false;
        if (filters.folders.length && !filters.folders.includes(relativeFolder(book.filename))) return false;
        if (filters.tags.length) {
            const bookTags = normalizedTagsOf(book);
            if (!filters.tags.some((tag) => bookTags.includes(normalizeText(tag)))) return false;
        }
        if (filters.favoritesOnly && !(Number(meta['امتیاز']) > 0)) return false;
        if (filters.readOnly && meta['خوانده شده'] !== true) return false;
        return true;
    });
}

export interface Facets {
    sections: { value: string; count: number }[];
    authors: { value: string; count: number }[];
    tags: { value: string; count: number }[];
    folders: { value: string; count: number }[];
}

export function buildFacets(books: BookSummary[]): Facets {
    const sections = new Map<string, number>();
    const authors = new Map<string, number>();
    const tags = new Map<string, number>();
    const folders = new Map<string, number>();

    for (const book of books) {
        const meta = book.frontmatter;
        const section = meta['بخش'] || 'نامشخص';
        sections.set(section, (sections.get(section) || 0) + 1);
        const author = meta['نویسنده'] || 'نامشخص';
        authors.set(author, (authors.get(author) || 0) + 1);
        for (const tag of meta['برچسب ها'] || []) tags.set(tag, (tags.get(tag) || 0) + 1);
        const folder = relativeFolder(book.filename);
        folders.set(folder, (folders.get(folder) || 0) + 1);
    }

    const toList = (map: Map<string, number>) =>
        [...map.entries()]
            .map(([value, count]) => ({ value, count }))
            .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'fa'));

    return {
        sections: toList(sections),
        authors: toList(authors),
        tags: toList(tags),
        folders: toList(folders)
    };
}

export function activeFilterCount(filters: LibraryFilters): number {
    return (
        filters.sections.length +
        filters.authors.length +
        filters.tags.length +
        filters.folders.length +
        (filters.favoritesOnly ? 1 : 0) +
        (filters.readOnly ? 1 : 0)
    );
}

export type SortMode = 'recent' | 'title' | 'author' | 'rating' | 'size';

export function sortBooks(books: BookSummary[], mode: SortMode): BookSummary[] {
    // Timestamps are parsed once; creating a Date per comparison is costly on a
    // library with thousands of books.
    const items = books.map((book, index) => ({
        book,
        index,
        title: book.frontmatter['نام کتاب'],
        author: book.frontmatter['نویسنده'] || '',
        rating: Number(book.frontmatter['امتیاز']) || 0,
        size: book.size,
        time: Date.parse(book.modifiedAt) || 0
    }));

    items.sort((a, b) => {
        switch (mode) {
            case 'title':
                return a.title.localeCompare(b.title, 'fa') || a.index - b.index;
            case 'author':
                return a.author.localeCompare(b.author, 'fa') || a.index - b.index;
            case 'rating':
                return b.rating - a.rating || a.index - b.index;
            case 'size':
                return b.size - a.size || a.index - b.index;
            case 'recent':
            default:
                return b.time - a.time || a.index - b.index;
        }
    });
    return items.map((item) => item.book);
}
