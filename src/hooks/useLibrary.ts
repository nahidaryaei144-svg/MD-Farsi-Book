import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { BookContentPayload, BookMetadata, BookSummary } from '../types';

export interface LibraryState {
    books: BookSummary[];
    folders: string[];
    libraryDir: string;
    loading: boolean;
    error: string;
    refresh: () => Promise<void>;
    ensureContent: (book: BookSummary) => Promise<BookContentPayload>;
    saveMetadata: (book: BookSummary, frontmatter: BookMetadata) => Promise<BookMetadata>;
    createFolder: (parent: string, name: string) => Promise<string>;
    addBook: (folder: string, filename: string, content: string) => Promise<void>;
    invalidateContent: (filename?: string) => void;
}

/**
 * A book can be over a megabyte, so only the most recently used ones stay in
 * memory. Opening a book still uses the same request and returns the same
 * payload; only the cache is bounded.
 */
const MAX_CACHED_BOOKS = 8;

export function useLibrary(): LibraryState {
    const [books, setBooks] = useState<BookSummary[]>([]);
    const [folders, setFolders] = useState<string[]>([]);
    const [libraryDir, setLibraryDir] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const contentCache = useRef(new Map<string, BookContentPayload>());

    const load = useCallback(async (showSpinner = true) => {
        if (showSpinner) setLoading(true);
        try {
            const payload = await api.library();
            setBooks(payload.books);
            setFolders(payload.folders);
            setLibraryDir(payload.libraryDir);
            setError('');
            const filenames = new Set(payload.books.map((book) => book.filename));
            for (const key of contentCache.current.keys()) {
                if (!filenames.has(key)) contentCache.current.delete(key);
            }
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : 'بارگذاری کتابخانه انجام نشد.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const ensureContent = useCallback(async (book: BookSummary) => {
        const cached = contentCache.current.get(book.filename);
        if (cached) {
            // Refresh its place in the LRU order.
            contentCache.current.delete(book.filename);
            contentCache.current.set(book.filename, cached);
            return cached;
        }
        const payload = await api.content(book.filename);
        contentCache.current.set(book.filename, payload);
        while (contentCache.current.size > MAX_CACHED_BOOKS) {
            const oldest = contentCache.current.keys().next().value;
            if (!oldest) break;
            contentCache.current.delete(oldest);
        }
        return payload;
    }, []);

    const invalidateContent = useCallback((filename?: string) => {
        if (filename) contentCache.current.delete(filename);
        else contentCache.current.clear();
    }, []);

    const saveMetadata = useCallback(async (book: BookSummary, frontmatter: BookMetadata) => {
        const result = await api.saveBook(book.filename, frontmatter);
        setBooks((current) =>
            current.map((item) =>
                item.filename === book.filename ? { ...item, frontmatter: result.frontmatter } : item
            )
        );
        contentCache.current.delete(book.filename);
        return result.frontmatter;
    }, []);

    const createFolder = useCallback(async (parent: string, name: string) => {
        const result = await api.createFolder(parent, name);
        const payload = await api.library();
        setFolders(payload.folders);
        return result.path;
    }, []);

    const addBook = useCallback(async (folder: string, filename: string, content: string) => {
        await api.addBook(folder, filename, content);
        await load(false);
    }, [load]);

    const refresh = useCallback(async () => {
        contentCache.current.clear();
        await load();
    }, [load]);

    return {
        books,
        folders,
        libraryDir,
        loading,
        error,
        refresh,
        ensureContent,
        saveMetadata,
        createFolder,
        addBook,
        invalidateContent
    };
}
