import { useMemo } from 'react';
import { faNumber } from '../../lib/format';
import type {
    SearchBookResult,
    SearchHitOpener,
    SearchOptions,
    SearchOutcome,
    SearchScope
} from '../../types';
import { Icon } from '../icons';
import { SearchResults } from '../library/SearchResults';
import { Button, Field, Segmented, TextInput } from '../ui/Controls';

interface SearchPanelProps {
    query: string;
    scope: SearchScope;
    inFiltered: boolean;
    onlySelected: boolean;
    selectionCount: number;
    options: SearchOptions;
    outcome: SearchOutcome;
    loading: boolean;
    onQuery: (value: string) => void;
    onScope: (value: SearchScope) => void;
    onInFiltered: (value: boolean) => void;
    onOnlySelected: (value: boolean) => void;
    onOptions: (options: SearchOptions) => void;
    onOpenHit: SearchHitOpener;
    onOpenBook: (result: SearchBookResult) => void;
    onOpenFilters: () => void;
    onClear: () => void;
    onSelectBooks: (filenames: string[]) => void;
    notify: (message: string, tone?: 'success' | 'error' | 'info') => void;
}

const MODE_OPTIONS: { value: SearchOptions['mode']; label: string; icon: 'check' | 'layers' | 'quote' | 'bolt' }[] = [
    { value: 'all', label: 'همهٔ واژه‌ها', icon: 'check' },
    { value: 'any', label: 'هر واژه', icon: 'layers' },
    { value: 'phrase', label: 'عبارت دقیق', icon: 'quote' },
    { value: 'regex', label: 'الگوی منظم', icon: 'bolt' }
];

const SORT_OPTIONS: { value: SearchOptions['sort']; label: string }[] = [
    { value: 'relevance', label: 'مرتبط‌ترین' },
    { value: 'matches', label: 'بیشترین نتیجه' },
    { value: 'title', label: 'عنوان' }
];

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

function download(filename: string, content: string, type: string) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

function csvCell(value: string): string {
    return `"${String(value).replace(/"/g, '""')}"`;
}

export function SearchPanel({
    query,
    scope,
    inFiltered,
    onlySelected,
    selectionCount,
    options,
    outcome,
    loading,
    onQuery,
    onScope,
    onInFiltered,
    onOnlySelected,
    onOptions,
    onOpenHit,
    onOpenBook,
    onOpenFilters,
    onClear,
    onSelectBooks,
    notify
}: SearchPanelProps) {
    const active = scope !== 'books' && query.trim().length >= 2;
    const filenames = useMemo(() => outcome.results.map((result) => result.filename), [outcome.results]);

    const exportRows = () => {
        const rows = [['نام کتاب', 'نویسنده', 'موضوع', 'پوشه', 'صفحه', 'عنوان صفحه', 'تعداد مورد']];
        outcome.results.forEach((result) => {
            result.pages.forEach((page) => {
                rows.push([
                    result.title,
                    result.author,
                    result.section,
                    result.folder,
                    page.pageLabel,
                    page.heading,
                    String(page.matches)
                ]);
            });
        });
        return rows;
    };

    const exportCsv = () => {
        if (!outcome.results.length) {
            notify('نتیجه‌ای برای خروجی گرفتن نیست.', 'info');
            return;
        }
        const text = exportRows()
            .map((row) => row.map(csvCell).join(','))
            .join('\r\n');
        download(`search-${Date.now()}.csv`, `\uFEFF${text}`, 'text/csv;charset=utf-8');
        notify('خروجی CSV جست‌وجو ساخته شد.', 'success');
    };

    const exportJson = () => {
        if (!outcome.results.length) {
            notify('نتیجه‌ای برای خروجی گرفتن نیست.', 'info');
            return;
        }
        download(
            `search-${Date.now()}.json`,
            JSON.stringify({ query, matches: outcome.matches, results: outcome.results }, null, 2),
            'application/json;charset=utf-8'
        );
        notify('خروجی JSON جست‌وجو ساخته شد.', 'success');
    };

    const selectResults = () => {
        if (!filenames.length) {
            notify('نتیجه‌ای برای انتخاب نیست.', 'info');
            return;
        }
        onSelectBooks(filenames);
        notify(`${faNumber(filenames.length)} کتاب از نتیجه‌های جست‌وجو انتخاب شد.`, 'success');
    };

    return (
        <div className="search-panel">
            <div className="search-panel__bar">
                <div className="search-panel__input">
                    <TextInput
                        icon="search"
                        value={query}
                        placeholder="جست‌وجو در نام، نویسنده، موضوع، برچسب یا متن و پاورقی‌ها…"
                        aria-label="جست‌وجو در کتابخانه"
                        onChange={(event) => onQuery(event.target.value)}
                    />
                    {query ? (
                        <button type="button" className="search-panel__clear" onClick={onClear} aria-label="پاک‌کردن جست‌وجو">
                            <Icon name="close" size={15} />
                        </button>
                    ) : null}
                </div>
                <Segmented
                    value={scope}
                    onChange={onScope}
                    ariaLabel="حوزهٔ جست‌وجو"
                    options={[
                        { value: 'books', label: 'کتاب‌ها', icon: 'books' },
                        { value: 'content', label: 'محتوا و صفحات', icon: 'file' },
                        { value: 'toc', label: 'فهرست مطالب', icon: 'list' }
                    ]}
                />
            </div>

            <div className="search-panel__grid">
                <Field label="حالت تطبیق">
                    <Segmented
                        value={options.mode}
                        onChange={(mode) => onOptions({ ...options, mode })}
                        ariaLabel="حالت تطبیق"
                        options={MODE_OPTIONS}
                    />
                </Field>
                <Field label="خطای تایپ">
                    <Segmented
                        value={String(options.fuzzy)}
                        onChange={(value) => onOptions({ ...options, fuzzy: Number(value) })}
                        ariaLabel="میزان تحمل خطای تایپ"
                        options={[
                            { value: '0', label: 'دقیق' },
                            { value: '1', label: 'یک حرف' },
                            { value: '2', label: 'دو حرف' }
                        ]}
                    />
                </Field>
                <Field label="ترتیب نتیجه">
                    <Segmented
                        value={options.sort}
                        onChange={(sort) => onOptions({ ...options, sort })}
                        ariaLabel="ترتیب نتیجه‌ها"
                        options={SORT_OPTIONS}
                    />
                </Field>
                <div className="search-panel__checks">
                    <label className="search-adv-check">
                        <input
                            type="checkbox"
                            checked={options.wholeWord}
                            onChange={(event) => onOptions({ ...options, wholeWord: event.target.checked })}
                        />
                        <span>فقط واژهٔ کامل</span>
                    </label>
                    <label className="search-adv-check">
                        <input
                            type="checkbox"
                            checked={options.caseSensitive}
                            onChange={(event) => onOptions({ ...options, caseSensitive: event.target.checked })}
                        />
                        <span>حساس به حروف</span>
                    </label>
                    <label className="search-adv-check">
                        <input
                            type="checkbox"
                            checked={options.includeHeadings}
                            onChange={(event) => onOptions({ ...options, includeHeadings: event.target.checked })}
                        />
                        <span>جست‌وجو در عنوان‌ها</span>
                    </label>
                    <label className="search-adv-check">
                        <input
                            type="checkbox"
                            checked={options.includeFootnotes}
                            onChange={(event) => onOptions({ ...options, includeFootnotes: event.target.checked })}
                        />
                        <span>جست‌وجو در پاورقی‌ها</span>
                    </label>
                    <label className="search-adv-check">
                        <input
                            type="checkbox"
                            checked={inFiltered}
                            onChange={(event) => onInFiltered(event.target.checked)}
                        />
                        <span>فقط در کتاب‌های فیلترشده</span>
                    </label>
                    {selectionCount > 0 ? (
                        <label className="search-adv-check">
                            <input
                                type="checkbox"
                                checked={onlySelected}
                                onChange={(event) => onOnlySelected(event.target.checked)}
                            />
                            <span>فقط انتخاب‌شده‌ها ({faNumber(selectionCount)})</span>
                        </label>
                    ) : null}
                </div>
            </div>

            <div className="search-panel__tools">
                <Button variant="soft" size="sm" icon="download" onClick={exportCsv}>
                    خروجی CSV
                </Button>
                <Button variant="soft" size="sm" icon="download" onClick={exportJson}>
                    خروجی JSON
                </Button>
                <Button variant="soft" size="sm" icon="check" onClick={selectResults} disabled={!filenames.length}>
                    انتخاب کتاب‌های نتیجه
                </Button>
                <Button variant="ghost" size="sm" icon="filter" onClick={onOpenFilters}>
                    محدود کردن کتاب‌ها
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    icon="refresh"
                    onClick={() => onOptions({ ...DEFAULT_OPTIONS, headingsOnly: options.headingsOnly })}
                >
                    بازنشانی گزینه‌ها
                </Button>
            </div>

            <div className="search-panel__results">
                {scope === 'books' ? (
                    <p className="search-panel__hint">
                        <Icon name="info" size={14} />
                        <span>
                            برای جست‌وجو در متن کتاب‌ها و فهرست مطالب، حوزهٔ «محتوا و صفحات» یا «فهرست مطالب» را
                            انتخاب کنید. جست‌وجوی نام و مشخصات کتاب‌ها در همین صفحه، فهرست پایین را فیلتر می‌کند.
                        </span>
                    </p>
                ) : active ? (
                    <SearchResults
                        outcome={outcome}
                        query={query}
                        loading={loading}
                        onOpen={onOpenHit}
                        onOpenBook={onOpenBook}
                        onOpenFilters={onOpenFilters}
                        onClear={onClear}
                    />
                ) : (
                    <p className="search-panel__hint">
                        <Icon name="search" size={14} />
                        <span>دست‌کم دو حرف بنویسید تا جست‌وجو در متن کتاب‌ها آغاز شود.</span>
                    </p>
                )}
            </div>
        </div>
    );
}
