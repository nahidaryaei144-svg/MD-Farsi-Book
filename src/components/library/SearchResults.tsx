import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { SearchBookResult, SearchHitOpener, SearchOutcome, SearchPageHit, SearchSnippet } from '../../types';
import { cn, faNumber } from '../../lib/format';
import { Icon } from '../icons';
import { Button, EmptyState, Segmented } from '../ui/Controls';

interface SearchResultsProps {
    outcome: SearchOutcome;
    query: string;
    loading: boolean;
    onOpen: SearchHitOpener;
    onOpenBook: (result: SearchBookResult) => void;
    onOpenFilters: () => void;
    onClear: () => void;
}

type GroupMode = 'section' | 'folder' | 'book';

const GROUP_OPTIONS: { value: GroupMode; label: string; icon: 'layers' | 'folder' | 'book' }[] = [
    { value: 'section', label: 'بخش', icon: 'layers' },
    { value: 'folder', label: 'پوشه', icon: 'folder' },
    { value: 'book', label: 'کتاب', icon: 'book' }
];

const KIND_LABEL: Record<SearchSnippet['kind'], string> = {
    text: 'متن',
    heading: 'عنوان',
    footnote: 'پاورقی'
};

const VISIBLE_SNIPPETS = 3;
// A broad query can match hundreds of books; only the best few stay open
// so the list does not turn into an endless wall of hits.
const AUTO_EXPANDED_BOOKS = 3;
// A single book can match on hundreds of pages; only the first few are listed
// until the reader asks for the rest.
const VISIBLE_PAGES = 8;

interface ResultGroup {
    key: string;
    label: string;
    results: SearchBookResult[];
    matches: number;
    pages: number;
}

function SnippetText({ text, ranges }: { text: string; ranges: SearchSnippet['ranges'] }) {
    const parts: ReactNode[] = [];
    let cursor = 0;
    ranges.forEach((range, index) => {
        if (range.start > cursor) parts.push(text.slice(cursor, range.start));
        parts.push(<mark key={index}>{text.slice(range.start, range.end)}</mark>);
        cursor = range.end;
    });
    if (cursor < text.length) parts.push(text.slice(cursor));
    return <>{parts}</>;
}

function TIPS() {
    return (
        <div className="search-tips">
            <span>
                <code>جست‌وجوی پیش‌فرض</code> دقیق است؛ فقط همان حروفی که می‌نویسید
            </span>
            <span>
                <code>&quot;عبارت دقیق&quot;</code> فقط همان ترتیب واژه‌ها
            </span>
            <span>
                <code>-واژه</code> حذف یک واژه از نتیجه
            </span>
            <span>
                <code>واژه*</code> هر واژه‌ای که با آن شروع شود
            </span>
            <span>
                <code>واژه۱ | واژه۲</code> هر یک از دو واژه
            </span>
            <span>
                <code>نویسنده:...</code> محدود کردن به یک نویسنده
            </span>
            <span>
                <code>موضوع:...</code>، <code>برچسب:...</code>، <code>پوشه:...</code>
            </span>
        </div>
    );
}

export function SearchResults({ outcome, query, loading, onOpen, onOpenBook, onOpenFilters, onClear }: SearchResultsProps) {
    const [expandedOverrides, setExpandedOverrides] = useState<Map<string, boolean>>(new Map());
    const [bulkMode, setBulkMode] = useState<'auto' | 'all' | 'none'>('auto');
    const [collapsedPages, setCollapsedPages] = useState<Set<string>>(new Set());
    const [expandedPages, setExpandedPages] = useState<Set<string>>(new Set());
    const [groupBy, setGroupBy] = useState<GroupMode>('section');
    const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
    const [expandedBooks, setExpandedBooks] = useState<Set<string>>(new Set());
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        setExpandedOverrides(new Map());
        setBulkMode('auto');
        setCollapsedPages(new Set());
        setExpandedPages(new Set());
        setCollapsedGroups(new Set());
        setExpandedBooks(new Set());
    }, [query]);

    useEffect(() => {
        setCollapsedGroups(new Set());
    }, [groupBy]);

    const groups = useMemo<ResultGroup[]>(() => {
        if (groupBy === 'book') {
            return outcome.results.map((result) => ({
                key: result.filename,
                label: result.title,
                results: [result],
                matches: result.matches,
                pages: result.pagesCount
            }));
        }

        const buckets = new Map<string, SearchBookResult[]>();
        for (const result of outcome.results) {
            const key = groupBy === 'section' ? result.section || 'بدون موضوع' : result.folder || 'قفسهٔ اصلی';
            const bucket = buckets.get(key);
            if (bucket) bucket.push(result);
            else buckets.set(key, [result]);
        }

        return [...buckets.entries()]
            .map(([label, results]) => ({
                key: label,
                label,
                results,
                matches: results.reduce((sum, result) => sum + result.matches, 0),
                pages: results.reduce((sum, result) => sum + result.pagesCount, 0)
            }))
            .sort((a, b) => b.matches - a.matches || a.label.localeCompare(b.label, 'fa'));
    }, [outcome.results, groupBy]);

    const isBookCollapsed = useCallback(
        (filename: string, index: number) => {
            const override = expandedOverrides.get(filename);
            if (override !== undefined) return !override;
            if (bulkMode === 'all') return false;
            if (bulkMode === 'none') return true;
            return index >= AUTO_EXPANDED_BOOKS;
        },
        [expandedOverrides, bulkMode, groupBy]
    );

    const toggleBook = (filename: string, index: number) => {
        setExpandedOverrides((current) => {
            const next = new Map(current);
            next.set(filename, isBookCollapsed(filename, index));
            return next;
        });
    };

    const pagesOf = useCallback(
        (result: SearchBookResult) =>
            expandedBooks.has(result.filename) ? result.pages : result.pages.slice(0, VISIBLE_PAGES),
        [expandedBooks]
    );

    const toggleInSet = (set: Set<string>, value: string) => {
        const next = new Set(set);
        if (next.has(value)) next.delete(value);
        else next.add(value);
        return next;
    };

    const allCollapsed =
        groups.length > 0 &&
        groups.every(
            (group, index) =>
                (groupBy !== 'book' && collapsedGroups.has(group.key)) ||
                group.results.every((result, bookIndex) => isBookCollapsed(result.filename, bookIndex))
        );

    const flat = useMemo(() => {
        const items: { key: string; result: SearchBookResult; page: SearchPageHit; snippet: SearchSnippet }[] = [];
        groups.forEach((group, groupIndex) => {
            if (groupBy !== 'book' && collapsedGroups.has(group.key)) return;
            for (const [bookIndex, result] of group.results.entries()) {
                if (isBookCollapsed(result.filename, bookIndex)) continue;
                for (const page of pagesOf(result)) {
                    const pageKey = `${result.filename}#${page.pageIndex}`;
                    if (collapsedPages.has(pageKey)) continue;
                    const visible = expandedPages.has(pageKey)
                        ? page.snippets
                        : page.snippets.slice(0, VISIBLE_SNIPPETS);
                    for (const snippet of visible) {
                        items.push({
                            key: `${pageKey}#${snippet.line}#${snippet.occurrence}`,
                            result,
                            page,
                            snippet
                        });
                    }
                }
            }
        });
        return items;
    }, [groups, groupBy, collapsedGroups, isBookCollapsed, pagesOf, collapsedPages, expandedPages]);

    const flatIndex = useMemo(() => new Map(flat.map((item, index) => [item.key, index])), [flat]);

    const focusHit = (index: number) => {
        const node = listRef.current?.querySelector<HTMLButtonElement>(`[data-flat-index="${index}"]`);
        node?.focus();
        node?.scrollIntoView({ block: 'nearest' });
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
        const key = event.key;
        if (key === 'ArrowDown' || key === 'j') {
            event.preventDefault();
            focusHit(Math.min(flat.length - 1, index + 1));
        } else if (key === 'ArrowUp' || key === 'k') {
            event.preventDefault();
            focusHit(Math.max(0, index - 1));
        } else if (key === 'Home') {
            event.preventDefault();
            focusHit(0);
        } else if (key === 'End') {
            event.preventDefault();
            focusHit(flat.length - 1);
        }
    };

    if (outcome.error) {
        return (
            <div className="search-results">
                <div className="search-results__head">
                    <span>
                        <Icon name="alert" size={15} /> جست‌وجو انجام نشد
                    </span>
                </div>
                <div className="search-error">
                    <p>{outcome.error}</p>
                    <TIPS />
                </div>
            </div>
        );
    }

    if (!loading && !outcome.results.length) {
        return (
            <EmptyState
                icon="search"
                title="نتیجه‌ای پیدا نشد"
                description={`برای «${query}» در متن کتاب‌ها چیزی پیدا نشد. املا، حالت تطبیق یا حوزهٔ جست‌وجو را تغییر دهید.`}
                action={
                    <div className="empty-state__actions">
                        <Button variant="soft" size="sm" icon="filter" onClick={onOpenFilters}>
                            فیلترهای کتاب
                        </Button>
                        <Button variant="ghost" size="sm" icon="close" onClick={onClear}>
                            پاک‌کردن جست‌وجو
                        </Button>
                    </div>
                }
            />
        );
    }

    const showSkeleton = loading && !outcome.results.length;

    const openAll = () => {
        setExpandedOverrides(new Map());
        setBulkMode('all');
        setCollapsedGroups(new Set());
        setExpandedBooks(new Set(outcome.results.map((result) => result.filename)));
    };

    const closeAll = () => {
        setExpandedOverrides(new Map());
        setBulkMode('none');
        setCollapsedGroups(new Set(groups.map((group) => group.key)));
    };

    const renderBook = (result: SearchBookResult, groupIndex: number, nested: boolean) => {
        const collapsed = isBookCollapsed(result.filename, groupIndex);
        const pages = pagesOf(result);
        const hiddenPages = result.pages.length - pages.length;
        return (
            <section
                key={result.filename}
                className={cn('search-group', nested && 'search-group--nested', collapsed && 'is-collapsed')}
            >
                <header className="search-group__head">
                    <button
                        type="button"
                        className="search-group__toggle"
                        aria-expanded={!collapsed}
                        onClick={() => toggleBook(result.filename, groupIndex)}
                    >
                        <Icon name="chevron" size={16} className="search-group__chevron" />
                        <span className="search-group__icon">
                            <Icon name="book" size={16} />
                        </span>
                        <span className="search-group__meta">
                            <h3>{result.title}</h3>
                            <small>
                                {result.author || 'نویسندهٔ نامشخص'}
                                {result.section ? ` — ${result.section}` : ''}
                                {result.folder ? ` · ${result.folder}` : ''}
                            </small>
                        </span>
                    </button>
                    <span className="search-group__count">
                        {faNumber(result.matches)} مورد · {faNumber(result.pagesCount)} صفحه
                    </span>
                    <button
                        type="button"
                        className="search-group__open"
                        onClick={() => onOpenBook(result)}
                        title="باز کردن کتاب"
                        aria-label={`باز کردن ${result.title}`}
                    >
                        <Icon name="external" size={15} />
                    </button>
                </header>

                {collapsed ? null : (
                    <div className="search-group__hits">
                        {pages.map((page) => {
                            const pageKey = `${result.filename}#${page.pageIndex}`;
                            const pageCollapsed = collapsedPages.has(pageKey);
                            const expanded = expandedPages.has(pageKey);
                            const visible = expanded ? page.snippets : page.snippets.slice(0, VISIBLE_SNIPPETS);
                            const hidden = page.snippets.length - visible.length;
                            return (
                                <div key={pageKey} className={cn('search-page', pageCollapsed && 'is-collapsed')}>
                                    <button
                                        type="button"
                                        className="search-page__head"
                                        aria-expanded={!pageCollapsed}
                                        onClick={() => setCollapsedPages((current) => toggleInSet(current, pageKey))}
                                    >
                                        <Icon name="chevron" size={13} className="search-page__chevron" />
                                        <span className="search-page__label">
                                            <Icon name="file" size={12} /> {page.pageLabel}
                                        </span>
                                        {page.heading ? <span className="search-page__heading">{page.heading}</span> : null}
                                        <em>{faNumber(page.matches)}</em>
                                    </button>

                                    {pageCollapsed ? null : (
                                        <div className="search-page__snippets">
                                            {visible.map((snippet) => {
                                                const key = `${pageKey}#${snippet.line}#${snippet.occurrence}`;
                                                const index = flatIndex.get(key) ?? 0;
                                                return (
                                                    <button
                                                        key={key}
                                                        type="button"
                                                        className="search-snippet"
                                                        data-flat-index={index}
                                                        onClick={() => onOpen(result, page, snippet)}
                                                        onKeyDown={(event) => handleKeyDown(event, index)}
                                                        title="پرش به همین بخش از کتاب"
                                                    >
                                                        <span className={cn('search-snippet__kind', `is-${snippet.kind}`)}>
                                                            {KIND_LABEL[snippet.kind]}
                                                        </span>
                                                        <span className="search-snippet__text">
                                                            <SnippetText text={snippet.text} ranges={snippet.ranges} />
                                                        </span>
                                                        <Icon name="arrowLeft" size={14} className="search-snippet__arrow" />
                                                    </button>
                                                );
                                            })}
                                            {hidden > 0 ? (
                                                <button
                                                    type="button"
                                                    className="search-page__more"
                                                    onClick={() => setExpandedPages((current) => toggleInSet(current, pageKey))}
                                                >
                                                    {faNumber(hidden)} مورد دیگر در این صفحه
                                                </button>
                                            ) : null}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                        {hiddenPages > 0 ? (
                            <button
                                type="button"
                                className="search-page__more search-group__more"
                                onClick={() => setExpandedBooks((current) => new Set(current).add(result.filename))}
                            >
                                نمایش {faNumber(hiddenPages)} صفحهٔ دیگر از این کتاب
                            </button>
                        ) : null}
                    </div>
                )}
            </section>
        );
    };

    return (
        <div className="search-results">
            <div className="search-results__head">
                <div className="search-results__summary">
                    <span>
                        <Icon name="search" size={15} />
                        {showSkeleton
                            ? `در حال بررسی ${faNumber(outcome.scanned)} از ${faNumber(outcome.candidates)} کتاب…`
                            : `${faNumber(outcome.matches)} مورد در ${faNumber(outcome.pages)} صفحه از ${faNumber(outcome.books)} کتاب`}
                    </span>
                    {!showSkeleton ? (
                        <small>
                            <Icon name="clock" size={12} /> {faNumber(outcome.tookMs)} میلی‌ثانیه
                            {outcome.running
                                ? ` · بررسی ${faNumber(outcome.scanned)} از ${faNumber(outcome.candidates)} کتاب`
                                : ` · ${faNumber(outcome.scanned)} کتاب بررسی شد`}
                        </small>
                    ) : null}
                    {outcome.indexing && outcome.indexing.running ? (
                        <small className="search-results__indexing">
                            <Icon name="layers" size={12} /> ساخت نمایهٔ متن: {faNumber(outcome.indexing.indexed)} از{' '}
                            {faNumber(outcome.indexing.total)} کتاب — نتیجه‌ها پس از آماده‌شدن کامل می‌شوند
                        </small>
                    ) : null}
                </div>
                <div className="search-results__groupby">
                    <span>
                        <Icon name="layers" size={13} /> بخش‌بندی
                    </span>
                    <Segmented
                        value={groupBy}
                        onChange={setGroupBy}
                        ariaLabel="بخش‌بندی نتایج جست‌وجو"
                        options={GROUP_OPTIONS}
                    />
                </div>
                <div className="search-results__tools">
                    <button type="button" className="search-tool" onClick={openAll}>
                        <Icon name="expand" size={13} /> باز کردن همه
                    </button>
                    <button type="button" className="search-tool" onClick={closeAll}>
                        <Icon name="minus" size={13} /> بستن همه
                    </button>
                </div>
                {outcome.running ? <span className="search-results__pulse" aria-hidden="true" /> : null}
            </div>

            {outcome.terms.length || outcome.fields.length ? (
                <div className="search-results__chips">
                    {outcome.terms.map((term) => (
                        <span key={`term-${term}`} className={cn('search-term', term.startsWith('−') && 'is-negative')}>
                            {term.startsWith('−') ? <Icon name="minus" size={11} /> : <Icon name="check" size={11} />}
                            {term.replace(/^−/, '')}
                        </span>
                    ))}
                    {outcome.fields.map((field) => (
                        <span key={`field-${field.field}-${field.value}`} className={cn('search-term', 'is-field', field.negative && 'is-negative')}>
                            <Icon name="filter" size={11} />
                            {FIELD_TITLES[field.field]}: {field.value}
                        </span>
                    ))}
                </div>
            ) : null}

            {showSkeleton ? (
                <div className="search-results__loading">
                    <span className="spinner" />
                    <p>در حال جست‌وجو در متن کتاب‌ها…</p>
                    <TIPS />
                </div>
            ) : (
                <>
                    <div className="search-results__list" ref={listRef}>
                        {groupBy === 'book'
                            ? groups.map((group, index) => renderBook(group.results[0], index, false))
                            : groups.map((group) => {
                                  const collapsed = collapsedGroups.has(group.key);
                                  return (
                                      <section
                                          key={group.key}
                                          className={cn('search-group', 'search-group--outer', collapsed && 'is-collapsed')}
                                      >
                                          <header className="search-group__head search-group__head--group">
                                              <button
                                                  type="button"
                                                  className="search-group__toggle"
                                                  aria-expanded={!collapsed}
                                                  onClick={() =>
                                                      setCollapsedGroups((current) => toggleInSet(current, group.key))
                                                  }
                                              >
                                                  <Icon name="chevron" size={17} className="search-group__chevron" />
                                                  <span className="search-group__icon">
                                                      <Icon name={groupBy === 'section' ? 'layers' : 'folder'} size={16} />
                                                  </span>
                                                  <span className="search-group__meta">
                                                      <h3>{group.label}</h3>
                                                      <small>
                                                          {faNumber(group.results.length)} کتاب · {faNumber(group.pages)} صفحه
                                                      </small>
                                                  </span>
                                              </button>
                                              <span className="search-group__count">{faNumber(group.matches)} مورد</span>
                                          </header>
                                          {collapsed ? null : (
                                              <div className="search-group__list">
                                                  {group.results.map((result, index) => renderBook(result, index, true))}
                                              </div>
                                          )}
                                      </section>
                                  );
                              })}
                    </div>
                    <div className="search-results__foot">
                        <span>
                            {allCollapsed ? 'همهٔ گروه‌ها بسته‌اند؛ برای دیدن نتایج یکی را باز کنید.' : 'با کلیدهای ↑ و ↓ بین نتایج جابه‌جا شوید.'}
                        </span>
                        <button type="button" className="search-tool" onClick={onOpenFilters}>
                            <Icon name="filter" size={13} /> محدود کردن کتاب‌ها
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}

const FIELD_TITLES: Record<SearchOutcome['fields'][number]['field'], string> = {
    title: 'نام',
    author: 'نویسنده',
    translator: 'مترجم',
    section: 'موضوع',
    tag: 'برچسب',
    folder: 'پوشه'
};
