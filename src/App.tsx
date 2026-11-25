import { useCallback, useEffect, useMemo, useState } from 'react';
import { AddBookDialog } from './components/dialogs/AddBookDialog';
import { EditBookDialog } from './components/dialogs/EditBookDialog';
import { TranslateDialog } from './components/dialogs/TranslateDialog';
import { Footer } from './components/layout/Footer';
import { Hero } from './components/layout/Hero';
import { TopBar } from './components/layout/TopBar';
import { LibraryView } from './components/library/LibraryView';
import { BackupsPanel } from './components/panels/BackupsPanel';
import { BatchPanel } from './components/panels/BatchPanel';
import { FilterPanel } from './components/panels/FilterPanel';
import { FloatingPanel } from './components/panels/FloatingPanel';
import { ReportPanel } from './components/panels/ReportPanel';
import { SearchPanel } from './components/panels/SearchPanel';
import { SettingsPanel } from './components/panels/SettingsPanel';
import { Reader } from './components/reader/Reader';
import { ToastStack } from './components/ui/Toasts';
import { Icon, type IconName } from './components/icons';
import { useHotkeys } from './hooks/useHotkeys';
import { useLibrary } from './hooks/useLibrary';
import { usePanels } from './hooks/usePanels';
import { useSettings } from './hooks/useSettings';
import { useToasts } from './hooks/useToasts';
import { api } from './lib/api';
import { activeFilterCount, applyFilters, buildFacets, emptyFilters, matchesQuery } from './lib/filters';
import { createEmptyOutcome, defaultSearchOptions, describeQuery, summarize } from './lib/search';
import type {
    BookMetadata,
    BookSummary,
    LibraryFilters,
    PanelId,
    SearchBookResult,
    SearchHitOpener,
    SearchIndexing,
    SearchOptions,
    SearchOutcome,
    SearchPageHit,
    SearchSnippet
} from './types';

const PANEL_META: Record<PanelId, { title: string; subtitle: string; icon: IconName }> = {
    filter: { title: 'فیلتر و جست‌وجو', subtitle: 'کتابخانهٔ شما', icon: 'filter' },
    search: { title: 'جست‌وجوی کتابخانه', subtitle: 'جست‌وجو و مدیریت نتیجه‌ها', icon: 'search' },
    settings: { title: 'تنظیمات مطالعه', subtitle: 'شخصی‌سازی کتابخانه', icon: 'settings' },
    report: { title: 'گزارش کتابخانه', subtitle: 'تحلیل و خروجی', icon: 'chart' },
    batch: { title: 'ابزارهای گروهی', subtitle: 'کارهای گروهی روی کتاب‌ها', icon: 'tools' },
    backups: { title: 'نسخه‌های پشتیبان', subtitle: 'ایمنی کتابخانه', icon: 'shield' }
};

interface ReaderTarget {
    pageIndex: number;
    matchIndex: number;
    text?: string;
    context?: string;
}

interface ReaderState {
    book: BookSummary;
    content: string;
    revision: string;
    initialQuery?: string;
    initialTarget?: ReaderTarget;
}

export default function App() {
    const library = useLibrary();
    const settings = useSettings();
    const panels = usePanels();
    const { toasts, notify, removeToast } = useToasts();

    const [filters, setFilters] = useState<LibraryFilters>(emptyFilters);
    const [selection, setSelection] = useState<Set<string>>(new Set());
    const [reader, setReader] = useState<ReaderState | null>(null);
    const [editing, setEditing] = useState<BookSummary | null>(null);
    const [addOpen, setAddOpen] = useState(false);
    const [translating, setTranslating] = useState(false);
    const [searchOptions, setSearchOptions] = useState<SearchOptions>(defaultSearchOptions);
    const [searchOutcome, setSearchOutcome] = useState<SearchOutcome>(createEmptyOutcome);
    const [searchLoading, setSearchLoading] = useState(false);
    const [settledQuery, setSettledQuery] = useState('');
    const [onlySelected, setOnlySelected] = useState(false);
    const [searchRefresh, setSearchRefresh] = useState(0);

    const facets = useMemo(() => buildFacets(library.books), [library.books]);
    const sectionCount = facets.sections.length;
    const favoriteCount = library.books.filter((book) => Number(book.frontmatter['امتیاز']) > 0).length;
    const readCount = library.books.filter((book) => book.frontmatter['خوانده شده'] === true).length;
    const libraryBytes = library.books.reduce((sum, book) => sum + book.size, 0);

    const filteredByFacets = useMemo(() => applyFilters(library.books, filters), [library.books, filters]);
    const visibleBooks = useMemo(() => {
        if (filters.scope === 'books' && settledQuery.trim()) {
            return filteredByFacets.filter((book) => matchesQuery(book, settledQuery));
        }
        return filteredByFacets;
    }, [filteredByFacets, filters.scope, settledQuery]);

    // The query only settles once typing pauses, so neither the book list nor
    // the full-text search reacts to a half-written word.
    useEffect(() => {
        if (filters.query === settledQuery) return;
        // Clearing the box takes effect at once; a typed query waits for the
        // pause so half-written words never trigger a search.
        const delay = filters.query.trim() ? 700 : 0;
        const timer = setTimeout(() => setSettledQuery(filters.query), delay);
        return () => clearTimeout(timer);
    }, [filters.query, settledQuery]);

    useEffect(() => {
        setSelection((current) => {
            const valid = new Set(library.books.map((book) => book.filename));
            const next = new Set([...current].filter((filename) => valid.has(filename)));
            return next.size === current.size ? current : next;
        });
    }, [library.books]);

    useEffect(() => {
        if (filters.scope === 'books') {
            setSearchOutcome(createEmptyOutcome());
            setSearchLoading(false);
            return;
        }
        const query = settledQuery.trim();
        if (filters.query.trim() !== query) return;
        if (query.length < 2) {
            setSearchOutcome(createEmptyOutcome());
            setSearchLoading(false);
            return;
        }

        const options: SearchOptions =
            filters.scope === 'toc' ? { ...searchOptions, headingsOnly: true } : searchOptions;
        const description = describeQuery(query, options);
        if (description.error) {
            setSearchOutcome({
                ...createEmptyOutcome(),
                error: description.error,
                terms: description.terms,
                fields: description.fields
            });
            setSearchLoading(false);
            return;
        }

        const candidates =
            onlySelected && selection.size
                ? library.books.filter((book) => selection.has(book.filename))
                : filters.inFiltered
                    ? applyFilters(library.books, filters)
                    : null;

        const controller = new AbortController();
        let cancelled = false;
        let refreshTimer: ReturnType<typeof setTimeout> | null = null;
        const collected = new Map<string, SearchBookResult>();
        let scanned = 0;
        let candidateCount = 0;
        let indexing: SearchIndexing | undefined;
        const started = performance.now();
        const totalBooks = library.books.length;

        const publish = (running: boolean) => {
            setSearchOutcome(
                summarize([...collected.values()], {
                    options,
                    scanned,
                    candidates: candidateCount,
                    totalBooks,
                    tookMs: performance.now() - started,
                    terms: description.terms,
                    fields: description.fields,
                    running,
                    indexing
                })
            );
        };

        setSearchLoading(true);
        setSearchOutcome({
            ...createEmptyOutcome(),
            terms: description.terms,
            fields: description.fields,
            running: true,
            totalBooks
        });

        // The server skips every book its content index rules out and streams
        // each hit as soon as it is found, so nothing is downloaded in bulk.
        void api
            .searchLibrary(
                {
                    query,
                    options,
                    filenames: candidates ? candidates.map((book) => book.filename) : undefined
                },
                (event) => {
                    if (cancelled) return;
                    if (event.type === 'meta') {
                        candidateCount = event.candidates;
                        indexing = event.indexing;
                        publish(true);
                    } else if (event.type === 'progress') {
                        scanned = event.scanned;
                        candidateCount = event.candidates;
                        publish(true);
                    } else if (event.type === 'results') {
                        scanned = event.scanned;
                        candidateCount = event.candidates;
                        for (const result of event.results) collected.set(result.filename, result);
                        publish(event.running);
                    } else if (event.type === 'done') {
                        scanned = event.scanned;
                        candidateCount = event.candidates;
                        indexing = event.indexing;
                        // While the index is still being built the answer is
                        // partial, so keep the spinner and search again shortly.
                        publish(Boolean(indexing?.running));
                        setSearchLoading(false);
                        if (indexing?.running) {
                            // The answer is only complete once the background
                            // index has caught up, so run the search again —
                            // slowly enough not to keep the server busy.
                            refreshTimer = setTimeout(() => setSearchRefresh((value) => value + 1), 15000);
                        }
                    } else if (event.type === 'error') {
                        setSearchOutcome((current) => ({ ...current, error: event.error, running: false }));
                        setSearchLoading(false);
                    }
                },
                controller.signal
            )
            .catch((error) => {
                if (cancelled || controller.signal.aborted) return;
                setSearchOutcome((current) => ({
                    ...current,
                    error: error instanceof Error ? error.message : 'جست‌وجو انجام نشد.',
                    running: false
                }));
            })
            .finally(() => {
                if (cancelled) return;
                setSearchLoading(false);
            });

        return () => {
            cancelled = true;
            controller.abort();
            if (refreshTimer) clearTimeout(refreshTimer);
        };
    }, [filters, settledQuery, searchOptions, onlySelected, selection, library.books, searchRefresh]);

    const openBook = useCallback(
        async (
            book: BookSummary,
            initialQuery?: string,
            initialTarget?: ReaderTarget
        ) => {
            try {
                const payload = await library.ensureContent(book);
                const fresh = library.books.find((item) => item.filename === book.filename) || book;
                setReader({
                    book: fresh,
                    content: payload.content,
                    revision: payload.revision,
                    initialQuery,
                    initialTarget
                });
                panels.closePanel('filter');
            } catch (error) {
                notify(error instanceof Error ? error.message : 'بارگذاری کتاب انجام نشد.', 'error');
            }
        },
        [library, notify, panels]
    );

    const jumpToResult = useCallback(
        (result: SearchBookResult, page: SearchPageHit, snippet?: SearchSnippet) => {
            const book = library.books.find((item) => item.filename === result.filename);
            if (!book) return;
            const target = snippet ?? page.snippets[0];
            const range = target?.ranges[0];
            // The reader highlights every occurrence on the page, while a hit is
            // counted only inside the searched blocks (headings, body or a
            // single footnote). Sending the surrounding text lets the reader
            // pick the mark that actually matches this hit.
            const context =
                target && range
                    ? target.text.slice(
                          Math.max(0, range.start - 48),
                          Math.min(target.text.length, range.end + 48)
                      )
                    : '';
            void openBook(book, target?.highlight || undefined, {
                pageIndex: page.pageIndex,
                matchIndex: target?.occurrence ?? 0,
                text: target && range ? target.text.slice(range.start, range.end) : '',
                context
            });
        },
        [library.books, openBook]
    );

    const openHit = useCallback<SearchHitOpener>(
        (result, page, snippet) => jumpToResult(result, page, snippet),
        [jumpToResult]
    );

    const openSearchBook = useCallback(
        (result: SearchBookResult) => {
            const page = result.pages[0];
            if (page) jumpToResult(result, page);
        },
        [jumpToResult]
    );

    const saveReaderMeta = useCallback(
        async (book: BookSummary, metadata: BookMetadata) => {
            const saved = await library.saveMetadata(book, metadata);
            setReader((current) =>
                current && current.book.filename === book.filename
                    ? { ...current, book: { ...current.book, frontmatter: saved } }
                    : current
            );
        },
        [library]
    );

    const saveReaderContent = useCallback(
        async (content: string) => {
            const current = reader;
            if (!current) throw new Error('کتابی برای ذخیره باز نیست.');
            const result = await api.saveContent(current.book.filename, content, current.revision);
            library.invalidateContent(current.book.filename);
            setReader((state) =>
                state && state.book.filename === current.book.filename
                    ? {
                          ...state,
                          content,
                          revision: result.revision,
                          book: { ...state.book, frontmatter: result.frontmatter }
                      }
                    : state
            );
            void library.refresh();
        },
        [reader, library]
    );

    const toggleRead = useCallback(
        async (book: BookSummary) => {
            const read = book.frontmatter['خوانده شده'] === true;
            try {
                await library.saveMetadata(book, { ...book.frontmatter, 'خوانده شده': !read });
                notify(read ? 'کتاب به خوانده‌نشده برگشت.' : 'کتاب خوانده‌شده علامت‌گذاری شد.');
            } catch (error) {
                notify(error instanceof Error ? error.message : 'ذخیرهٔ وضعیت انجام نشد.', 'error');
            }
        },
        [library, notify]
    );

    const saveEditedBook = useCallback(
        async (book: BookSummary, metadata: BookMetadata) => {
            const saved = await library.saveMetadata(book, metadata);
            setReader((current) =>
                current && current.book.filename === book.filename
                    ? { ...current, book: { ...current.book, frontmatter: saved } }
                    : current
            );
        },
        [library]
    );

    const openFilters = useCallback(() => panels.openPanel('filter'), [panels]);
    const openSearchPanel = useCallback(() => panels.openPanel('search'), [panels]);
    const applyFiltersPanel = useCallback(() => panels.closePanel('filter'), [panels]);
    const clearFilters = useCallback(() => setFilters({ ...emptyFilters, query: filters.query, scope: filters.scope }), [filters.query, filters.scope]);

    const isBlocked = useCallback(
        () => Boolean(reader) || addOpen || Boolean(editing) || Boolean(document.querySelector('.modal-layer')),
        [reader, addOpen, editing]
    );

    const hotkeys = useMemo(
        () => ({
            onSearch: () => {
                const input = document.querySelector<HTMLInputElement>('.search-card__input');
                input?.focus();
                input?.select();
            },
            onSearchPanel: () => panels.togglePanel('search'),
            onFilter: () => panels.togglePanel('filter'),
            onSettings: () => panels.togglePanel('settings'),
            onReport: () => panels.togglePanel('report'),
            onBatch: () => panels.togglePanel('batch'),
            onRefresh: () => {
                void library.refresh();
                notify('کتابخانه تازه‌سازی شد.', 'info');
            },
            isBlocked
        }),
        [panels, library, notify, isBlocked]
    );
    useHotkeys(hotkeys);

    const zIndexFor = (id: PanelId) => {
        const index = panels.order.indexOf(id);
        return 1200 + (index < 0 ? 0 : index * 10);
    };

    const minimized = (Object.keys(PANEL_META) as PanelId[]).filter(
        (id) => panels.panels[id].open && panels.panels[id].minimized
    );

    return (
        <div className="app">
            <span className="app__orb app__orb--1" aria-hidden="true" />
            <span className="app__orb app__orb--2" aria-hidden="true" />

            <TopBar
                theme={settings.theme}
                filterCount={activeFilterCount(filters)}
                loading={library.loading}
                onCycleTheme={settings.cycleTheme}
                onFilter={openFilters}
                onSettings={() => panels.togglePanel('settings')}
                onReport={() => panels.togglePanel('report')}
                onBatch={() => panels.togglePanel('batch')}
                onBackups={() => panels.togglePanel('backups')}
                onAdd={() => setAddOpen(true)}
                onRefresh={() => void library.refresh()}
                onHome={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            />

            <main className="app__main">
                <Hero
                    total={library.books.length}
                    sections={sectionCount}
                    favorites={favoriteCount}
                    read={readCount}
                    query={filters.query}
                    scope={filters.scope}
                    inFiltered={filters.inFiltered}
                    loading={library.loading}
                    options={searchOptions}
                    onlySelected={onlySelected}
                    selectionCount={selection.size}
                    onOptions={setSearchOptions}
                    onOnlySelected={setOnlySelected}
                    onQuery={(query) => setFilters((current) => ({ ...current, query }))}
                    onScope={(scope) => setFilters((current) => ({ ...current, scope }))}
                    onInFiltered={(inFiltered) => setFilters((current) => ({ ...current, inFiltered }))}
                    onOpenFilters={openFilters}
                    onOpenSearch={openSearchPanel}
                    onAdd={() => setAddOpen(true)}
                />

                {library.error ? (
                    <div className="error-banner" role="alert">
                        <Icon name="alert" size={18} />
                        <span>{library.error}</span>
                        <button type="button" onClick={() => void library.refresh()}>
                            تلاش دوباره
                        </button>
                    </div>
                ) : null}

                <LibraryView
                    books={visibleBooks}
                    totalBooks={library.books.length}
                    filters={filters}
                    loading={library.loading}
                    selection={selection}
                    searchOutcome={searchOutcome}
                    searchLoading={searchLoading}
                    searchActive={filters.scope !== 'books' && filters.query.trim().length >= 2}
                    onOpen={(book) => void openBook(book)}
                    onEdit={setEditing}
                    onToggleRead={(book) => void toggleRead(book)}
                    onSelectionChange={setSelection}
                    onOpenHit={openHit}
                    onOpenSearchBook={openSearchBook}
                    onOpenFilters={openFilters}
                    onFiltersChange={setFilters}
                    onClearFilters={clearFilters}
                    onAdd={() => setAddOpen(true)}
                    onBatch={() => panels.openPanel('batch')}
                />
            </main>

            <Footer
                onReport={() => panels.openPanel('report')}
                onBatch={() => panels.openPanel('batch')}
                onBackups={() => panels.openPanel('backups')}
                onTop={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            />

            {panels.panels.filter.open && !panels.panels.filter.minimized ? (
                <FloatingPanel
                    {...PANEL_META.filter}
                    layout={panels.panels.filter.layout}
                    zIndex={zIndexFor('filter')}
                    onFocus={() => panels.focusPanel('filter')}
                    onClose={() => panels.closePanel('filter')}
                    onMinimize={() => panels.minimizePanel('filter')}
                    onToggleMaximize={() => panels.toggleMaximize('filter')}
                    onLayoutChange={(layout) => panels.updateLayout('filter', layout)}
                >
                    <FilterPanel
                        filters={filters}
                        facets={facets}
                        matchCount={filteredByFacets.length}
                        onChange={setFilters}
                        onApply={applyFiltersPanel}
                    />
                </FloatingPanel>
            ) : null}

            {panels.panels.search.open && !panels.panels.search.minimized ? (
                <FloatingPanel
                    {...PANEL_META.search}
                    layout={panels.panels.search.layout}
                    zIndex={zIndexFor('search')}
                    onFocus={() => panels.focusPanel('search')}
                    onClose={() => panels.closePanel('search')}
                    onMinimize={() => panels.minimizePanel('search')}
                    onToggleMaximize={() => panels.toggleMaximize('search')}
                    onLayoutChange={(layout) => panels.updateLayout('search', layout)}
                >
                    <SearchPanel
                        query={filters.query}
                        scope={filters.scope}
                        inFiltered={filters.inFiltered}
                        onlySelected={onlySelected}
                        selectionCount={selection.size}
                        options={searchOptions}
                        outcome={searchOutcome}
                        loading={searchLoading}
                        onQuery={(query) => setFilters((current) => ({ ...current, query }))}
                        onScope={(scope) => setFilters((current) => ({ ...current, scope }))}
                        onInFiltered={(inFiltered) => setFilters((current) => ({ ...current, inFiltered }))}
                        onOnlySelected={setOnlySelected}
                        onOptions={setSearchOptions}
                        onOpenHit={openHit}
                        onOpenBook={openSearchBook}
                        onOpenFilters={openFilters}
                        onClear={() => setFilters((current) => ({ ...current, query: '' }))}
                        onSelectBooks={(filenames) => setSelection(new Set(filenames))}
                        notify={notify}
                    />
                </FloatingPanel>
            ) : null}

            {panels.panels.settings.open && !panels.panels.settings.minimized ? (
                <FloatingPanel
                    {...PANEL_META.settings}
                    layout={panels.panels.settings.layout}
                    zIndex={zIndexFor('settings')}
                    onFocus={() => panels.focusPanel('settings')}
                    onClose={() => panels.closePanel('settings')}
                    onMinimize={() => panels.minimizePanel('settings')}
                    onToggleMaximize={() => panels.toggleMaximize('settings')}
                    onLayoutChange={(layout) => panels.updateLayout('settings', layout)}
                >
                    <SettingsPanel
                        theme={settings.theme}
                        font={settings.font}
                        zoom={settings.zoom}
                        cornerRadius={settings.cornerRadius}
                        libraryDir={library.libraryDir}
                        folders={library.folders}
                        bookCount={library.books.length}
                        libraryBytes={libraryBytes}
                        onTheme={settings.setTheme}
                        onFont={settings.setFont}
                        onZoom={settings.setZoom}
                        onCornerRadius={settings.setCornerRadius}
                        onAddBook={() => setAddOpen(true)}
                        onCreateFolder={library.createFolder}
                        notify={notify}
                    />
                </FloatingPanel>
            ) : null}

            {panels.panels.report.open && !panels.panels.report.minimized ? (
                <FloatingPanel
                    {...PANEL_META.report}
                    layout={panels.panels.report.layout}
                    zIndex={zIndexFor('report')}
                    onFocus={() => panels.focusPanel('report')}
                    onClose={() => panels.closePanel('report')}
                    onMinimize={() => panels.minimizePanel('report')}
                    onToggleMaximize={() => panels.toggleMaximize('report')}
                    onLayoutChange={(layout) => panels.updateLayout('report', layout)}
                >
                    <ReportPanel notify={notify} />
                </FloatingPanel>
            ) : null}

            {panels.panels.batch.open && !panels.panels.batch.minimized ? (
                <FloatingPanel
                    {...PANEL_META.batch}
                    layout={panels.panels.batch.layout}
                    zIndex={zIndexFor('batch')}
                    onFocus={() => panels.focusPanel('batch')}
                    onClose={() => panels.closePanel('batch')}
                    onMinimize={() => panels.minimizePanel('batch')}
                    onToggleMaximize={() => panels.toggleMaximize('batch')}
                    onLayoutChange={(layout) => panels.updateLayout('batch', layout)}
                >
                    <BatchPanel
                        books={visibleBooks}
                        selection={selection}
                        onSelectionChange={setSelection}
                        notify={notify}
                        onApplied={library.refresh}
                    />
                </FloatingPanel>
            ) : null}

            {panels.panels.backups.open && !panels.panels.backups.minimized ? (
                <FloatingPanel
                    {...PANEL_META.backups}
                    layout={panels.panels.backups.layout}
                    zIndex={zIndexFor('backups')}
                    onFocus={() => panels.focusPanel('backups')}
                    onClose={() => panels.closePanel('backups')}
                    onMinimize={() => panels.minimizePanel('backups')}
                    onToggleMaximize={() => panels.toggleMaximize('backups')}
                    onLayoutChange={(layout) => panels.updateLayout('backups', layout)}
                >
                    <BackupsPanel notify={notify} onRestored={library.refresh} />
                </FloatingPanel>
            ) : null}

            {minimized.length ? (
                <div className="panel-tray" role="toolbar" aria-label="پنل‌های کوچک‌شده">
                    {minimized.map((id) => (
                        <div key={id} className="tray-item">
                            <button type="button" className="tray-item__restore" onClick={() => panels.restorePanel(id)}>
                                <Icon name={PANEL_META[id].icon} size={15} />
                                <span>{PANEL_META[id].title}</span>
                            </button>
                            <button
                                type="button"
                                className="tray-item__close"
                                onClick={() => panels.closePanel(id)}
                                aria-label={`بستن ${PANEL_META[id].title}`}
                            >
                                ×
                            </button>
                        </div>
                    ))}
                </div>
            ) : null}

            <AddBookDialog
                open={addOpen}
                folders={library.folders}
                onClose={() => setAddOpen(false)}
                onAddBook={library.addBook}
                onCreateFolder={library.createFolder}
                notify={notify}
            />

            <EditBookDialog
                book={editing}
                onClose={() => setEditing(null)}
                onSave={saveEditedBook}
                notify={notify}
            />

            {reader ? (
                <Reader
                    key={`${reader.book.filename}-${reader.initialQuery || ''}-${reader.initialTarget?.pageIndex ?? ''}-${reader.initialTarget?.matchIndex ?? ''}`}
                    book={reader.book}
                    content={reader.content}
                    initialQuery={reader.initialQuery}
                    initialTarget={reader.initialTarget}
                    onClose={() => setReader(null)}
                    onSaveMeta={saveReaderMeta}
                    onSaveContent={saveReaderContent}
                    onEdit={() => setEditing(reader.book)}
                    onTranslate={() => setTranslating(true)}
                    notify={notify}
                />
            ) : null}

            <TranslateDialog
                open={translating && Boolean(reader)}
                book={reader?.book ?? null}
                notify={notify}
                onClose={() => setTranslating(false)}
                onTranslated={async (job) => {
                    const current = reader;
                    if (!current || job.filename !== current.book.filename) return;
                    library.invalidateContent(job.filename);
                    try {
                        const payload = await library.ensureContent(current.book);
                        setReader((state) =>
                            state && state.book.filename === job.filename
                                ? { ...state, content: payload.content, revision: payload.revision }
                                : state
                        );
                        void library.refresh();
                        if (job.status === 'done') {
                            notify('ترجمهٔ کتاب کامل شد؛ نسخهٔ ترجمه‌شده نمایش داده شد.', 'success');
                        }
                    } catch {
                        notify('کتاب ترجمه شد اما بازخوانی متن انجام نشد؛ دوباره باز کنید.', 'error');
                    }
                }}
            />

            <ToastStack toasts={toasts} onDismiss={removeToast} />
        </div>
    );
}
