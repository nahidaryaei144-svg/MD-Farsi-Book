import { useEffect, useMemo, useRef, useState } from 'react';
import { activeFilterCount, sortBooks, type SortMode } from '../../lib/filters';
import { faNumber, cn } from '../../lib/format';
import type { BookSummary, LibraryFilters, SearchBookResult, SearchHitOpener, SearchOutcome } from '../../types';
import { Icon } from '../icons';
import { Button, EmptyState, Segmented } from '../ui/Controls';
import { BookCard } from './BookCard';
import { SearchResults } from './SearchResults';

interface LibraryViewProps {
    books: BookSummary[];
    totalBooks: number;
    filters: LibraryFilters;
    loading: boolean;
    selection: Set<string>;
    searchOutcome: SearchOutcome;
    searchLoading: boolean;
    searchActive: boolean;
    onOpen: (book: BookSummary) => void;
    onEdit: (book: BookSummary) => void;
    onToggleRead: (book: BookSummary) => void;
    onSelectionChange: (selection: Set<string>) => void;
    onOpenHit: SearchHitOpener;
    onOpenSearchBook: (result: SearchBookResult) => void;
    onOpenFilters: () => void;
    onFiltersChange: (filters: LibraryFilters) => void;
    onClearFilters: () => void;
    onAdd: () => void;
    onBatch: () => void;
}

/**
 * Only a window of cards is mounted. A library with thousands of books would
 * otherwise create tens of thousands of DOM nodes, which is what used to make
 * the page sluggish; more cards are added as the reader scrolls.
 */
const INITIAL_PAGE = 48;

export function LibraryView({
    books,
    totalBooks,
    filters,
    loading,
    selection,
    searchOutcome,
    searchLoading,
    searchActive,
    onOpen,
    onEdit,
    onToggleRead,
    onSelectionChange,
    onOpenHit,
    onOpenSearchBook,
    onOpenFilters,
    onFiltersChange,
    onClearFilters,
    onAdd,
    onBatch
}: LibraryViewProps) {
    const [view, setView] = useState<'grid' | 'list'>('grid');
    const [sort, setSort] = useState<SortMode>('recent');
    const sorted = useMemo(() => sortBooks(books, sort), [books, sort]);
    const [visibleCount, setVisibleCount] = useState(INITIAL_PAGE);
    const shown = useMemo(() => sorted.slice(0, visibleCount), [sorted, visibleCount]);
    const sentinelRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        setVisibleCount(INITIAL_PAGE);
    }, [books, sort, view]);

    useEffect(() => {
        const node = sentinelRef.current;
        if (!node || shown.length >= sorted.length) return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setVisibleCount((current) => Math.min(sorted.length, current + INITIAL_PAGE));
                }
            },
            { rootMargin: '800px' }
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [shown.length, sorted.length]);

    const active = activeFilterCount(filters);
    const allSelected = sorted.length > 0 && sorted.every((book) => selection.has(book.filename));

    const chips: { label: string; onRemove: () => void }[] = [
        ...filters.sections.map((value) => ({
            label: `موضوع: ${value}`,
            onRemove: () => onFiltersChange({ ...filters, sections: filters.sections.filter((item) => item !== value) })
        })),
        ...filters.authors.map((value) => ({
            label: `نویسنده: ${value}`,
            onRemove: () => onFiltersChange({ ...filters, authors: filters.authors.filter((item) => item !== value) })
        })),
        ...filters.folders.map((value) => ({
            label: `پوشه: ${value || 'قفسهٔ اصلی'}`,
            onRemove: () => onFiltersChange({ ...filters, folders: filters.folders.filter((item) => item !== value) })
        })),
        ...filters.tags.map((value) => ({
            label: `برچسب: ${value}`,
            onRemove: () => onFiltersChange({ ...filters, tags: filters.tags.filter((item) => item !== value) })
        })),
        ...(filters.favoritesOnly
            ? [{ label: 'فقط محبوب‌ها', onRemove: () => onFiltersChange({ ...filters, favoritesOnly: false }) }]
            : []),
        ...(filters.readOnly
            ? [{ label: 'فقط خوانده‌شده‌ها', onRemove: () => onFiltersChange({ ...filters, readOnly: false }) }]
            : [])
    ];

    const toggleAll = () => {
        const next = new Set(selection);
        if (allSelected) sorted.forEach((book) => next.delete(book.filename));
        else sorted.forEach((book) => next.add(book.filename));
        onSelectionChange(next);
    };

    return (
        <section className="library" id="library">
            <div className="library__head">
                <div>
                    <span className="library__eyebrow">کتابخانهٔ شما</span>
                    <h2 className="library__title">قفسهٔ کتاب‌ها</h2>
                    <p className="library__count">
                        {loading
                            ? 'در حال آماده‌سازی کتابخانه…'
                            : searchActive
                                ? `${faNumber(searchOutcome.matches)} مورد در متن کتاب‌ها`
                                : `${faNumber(books.length)} کتاب از ${faNumber(totalBooks)} کتاب`}
                    </p>
                </div>
                <div className="library__tools">
                    {sorted.length ? (
                        <label className="select-all">
                            <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                            <span>انتخاب همه</span>
                        </label>
                    ) : null}
                    <select
                        className="input select select--compact"
                        value={sort}
                        onChange={(event) => setSort(event.target.value as SortMode)}
                        aria-label="مرتب‌سازی"
                    >
                        <option value="recent">تازه‌ترین</option>
                        <option value="title">عنوان</option>
                        <option value="author">نویسنده</option>
                        <option value="rating">امتیاز</option>
                        <option value="size">حجم</option>
                    </select>
                    <Segmented
                        value={view}
                        onChange={setView}
                        ariaLabel="نمای کتاب‌ها"
                        options={[
                            { value: 'grid', label: 'شبکه‌ای', icon: 'grid' },
                            { value: 'list', label: 'فهرست', icon: 'list' }
                        ]}
                    />
                </div>
            </div>

            {active ? (
                <div className="filter-chips">
                    <span className="filter-chips__label">
                        <Icon name="filter" size={14} /> {faNumber(active)} فیلتر فعال
                    </span>
                    {chips.map((chip) => (
                        <button key={chip.label} type="button" className="filter-chip" onClick={chip.onRemove}>
                            {chip.label}
                            <span aria-hidden="true">×</span>
                        </button>
                    ))}
                    <button type="button" className="filter-chips__clear" onClick={onClearFilters}>
                        پاک‌کردن همه
                    </button>
                </div>
            ) : null}

            {searchActive ? (
                <SearchResults
                    outcome={searchOutcome}
                    query={filters.query}
                    loading={searchLoading}
                    onOpen={onOpenHit}
                    onOpenBook={onOpenSearchBook}
                    onOpenFilters={onOpenFilters}
                    onClear={onClearFilters}
                />
            ) : loading ? (
                <div className="book-skeleton-grid">
                    {Array.from({ length: 6 }).map((_, index) => (
                        <div key={index} className="book-skeleton" />
                    ))}
                </div>
            ) : sorted.length ? (
                <>
                    <div className={cn('book-grid', view === 'list' && 'book-grid--list')}>
                        {shown.map((book) => (
                            <BookCard
                                key={book.filename}
                                book={book}
                                view={view}
                                selected={selection.has(book.filename)}
                                onOpen={() => onOpen(book)}
                                onSelect={(selected) => {
                                    const next = new Set(selection);
                                    if (selected) next.add(book.filename);
                                    else next.delete(book.filename);
                                    onSelectionChange(next);
                                }}
                                onEdit={() => onEdit(book)}
                                onToggleRead={() => onToggleRead(book)}
                            />
                        ))}
                    </div>
                    {shown.length < sorted.length ? (
                        <div className="book-grid__more" ref={sentinelRef}>
                            <Button
                                variant="soft"
                                size="sm"
                                icon="layers"
                                onClick={() =>
                                    setVisibleCount((current) => Math.min(sorted.length, current + INITIAL_PAGE))
                                }
                            >
                                نمایش کتاب‌های بیشتر ({faNumber(shown.length)} از {faNumber(sorted.length)})
                            </Button>
                        </div>
                    ) : null}
                </>
            ) : (
                <EmptyState
                    icon={filters.query ? 'search' : 'books'}
                    title={filters.query ? 'کتابی با این مشخصات پیدا نشد' : 'کتابخانه هنوز خالی است'}
                    description={
                        filters.query
                            ? 'عبارت جست‌وجو یا فیلترها را تغییر دهید؛ شاید کتاب موردنظر در موضوع دیگری باشد.'
                            : 'اولین کتاب Markdown خود را اضافه کنید یا پوشه‌ای برای سازمان‌دهی بسازید.'
                    }
                    action={
                        <div className="empty-state__actions">
                            {active ? (
                                <Button variant="soft" size="sm" icon="refresh" onClick={onClearFilters}>
                                    پاک‌کردن فیلترها
                                </Button>
                            ) : null}
                            <Button variant="primary" size="sm" icon="plus" onClick={onAdd}>
                                افزودن کتاب
                            </Button>
                        </div>
                    }
                />
            )}

            {selection.size ? (
                <div className="batch-bar">
                    <span className="batch-bar__count">
                        <strong>{faNumber(selection.size)}</strong> کتاب انتخاب شده
                    </span>
                    <div className="batch-bar__actions">
                        <Button variant="ghost" size="sm" icon="close" onClick={() => onSelectionChange(new Set())}>
                            لغو انتخاب
                        </Button>
                        <Button variant="primary" size="sm" icon="tools" onClick={onBatch}>
                            ابزارهای گروهی
                        </Button>
                    </div>
                </div>
            ) : null}

            <button type="button" className="library__filter-fab" onClick={onOpenFilters} aria-label="باز کردن فیلترها">
                <Icon name="filter" size={18} />
            </button>
        </section>
    );
}
