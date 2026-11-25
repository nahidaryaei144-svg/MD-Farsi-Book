import type { SearchOptions, SearchScope } from '../../types';
import { cn, faNumber } from '../../lib/format';
import { Icon } from '../icons';
import { Segmented } from '../ui/Controls';

interface HeroProps {
    total: number;
    sections: number;
    favorites: number;
    read: number;
    query: string;
    scope: SearchScope;
    inFiltered: boolean;
    loading: boolean;
    options: SearchOptions;
    onlySelected: boolean;
    selectionCount: number;
    onQuery: (value: string) => void;
    onScope: (value: SearchScope) => void;
    onInFiltered: (value: boolean) => void;
    onOnlySelected: (value: boolean) => void;
    onOptions: (options: SearchOptions) => void;
    onOpenFilters: () => void;
    onOpenSearch: () => void;
    onAdd: () => void;
}

import { useState } from 'react';

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

export function Hero({
    total,
    sections,
    favorites,
    read,
    query,
    scope,
    inFiltered,
    loading,
    options,
    onlySelected,
    selectionCount,
    onQuery,
    onScope,
    onInFiltered,
    onOnlySelected,
    onOptions,
    onOpenFilters,
    onOpenSearch,
    onAdd
}: HeroProps) {
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const activeOptions =
        (options.mode !== 'phrase' ? 1 : 0) +
        (options.fuzzy > 0 ? 1 : 0) +
        (options.wholeWord ? 1 : 0) +
        (options.caseSensitive ? 1 : 0) +
        (!options.includeHeadings ? 1 : 0) +
        (!options.includeFootnotes ? 1 : 0) +
        (options.sort !== 'relevance' ? 1 : 0);

    return (
        <section className="hero" id="library-top">
            <span className="orb orb--1" aria-hidden="true" />
            <span className="orb orb--2" aria-hidden="true" />
            <div className="hero__grid">
                <div className="hero__copy">
                    <span className="hero__badge">
                        <Icon name="sparkles" size={14} />
                        پناهگاهی برای دانایی
                    </span>
                    <h1 className="hero__title">
                        هر کتاب، دریچه‌ای تازه به
                        <span> جهان اندیشه</span>
                    </h1>
                    <p className="hero__description">
                        در میان کتاب‌ها بگردید، موضوع دلخواه‌تان را پیدا کنید و مطالعه را از همان‌جایی که دوست دارید
                        آغاز کنید. جست‌وجوی متن، پاورقی‌ها، گزارش و ابزارهای حرفه‌ای — همه در یک جا.
                    </p>

                    <div className="hero__stats">
                        <div className="hero-stat">
                            <span className="hero-stat__value">{loading ? '—' : faNumber(total)}</span>
                            <span className="hero-stat__label">کتاب در کتابخانه</span>
                        </div>
                        <div className="hero-stat">
                            <span className="hero-stat__value">{loading ? '—' : faNumber(sections)}</span>
                            <span className="hero-stat__label">موضوع برای کاوش</span>
                        </div>
                        <div className="hero-stat">
                            <span className="hero-stat__value">{loading ? '—' : faNumber(favorites)}</span>
                            <span className="hero-stat__label">کتاب محبوب</span>
                        </div>
                        <div className="hero-stat">
                            <span className="hero-stat__value">{loading ? '—' : faNumber(read)}</span>
                            <span className="hero-stat__label">خوانده‌شده</span>
                        </div>
                    </div>
                </div>

                <div className="hero__art" aria-hidden="true">
                    <div className="shelf">
                        <span className="shelf__book shelf__book--1" />
                        <span className="shelf__book shelf__book--2" />
                        <span className="shelf__book shelf__book--3" />
                        <span className="shelf__book shelf__book--4" />
                        <span className="shelf__line" />
                        <span className="shelf__glow" />
                    </div>
                    <div className="float-chip float-chip--1">
                        <Icon name="bolt" size={14} /> جست‌وجوی سریع
                    </div>
                    <div className="float-chip float-chip--3">
                        <Icon name="wifiOff" size={14} /> کامل آفلاین
                    </div>
                </div>
            </div>

            <div className="search-card">
                <div className="search-card__main">
                    <span className="search-card__icon">
                        <Icon name="search" size={20} />
                    </span>
                    <input
                        className="search-card__input"
                        value={query}
                        onChange={(event) => onQuery(event.target.value)}
                        placeholder="جست‌وجو در نام کتاب، نویسنده، مترجم، برچسب‌ها یا متن و پاورقی‌ها…"
                        aria-label="جست‌وجو در کتابخانه"
                        autoComplete="off"
                    />
                    {query ? (
                        <button type="button" className="search-card__clear" onClick={() => onQuery('')} aria-label="پاک‌کردن جست‌وجو">
                            <Icon name="close" size={16} />
                        </button>
                    ) : (
                        <kbd className="search-card__hint">/</kbd>
                    )}
                </div>
                <div className="search-card__bottom">
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
                    {scope !== 'books' ? (
                        <>
                            <label className="search-check">
                                <input
                                    type="checkbox"
                                    checked={inFiltered}
                                    onChange={(event) => onInFiltered(event.target.checked)}
                                />
                                <span>فقط در کتاب‌های فیلترشده</span>
                            </label>
                            {selectionCount > 0 ? (
                                <label className="search-check">
                                    <input
                                        type="checkbox"
                                        checked={onlySelected}
                                        onChange={(event) => onOnlySelected(event.target.checked)}
                                    />
                                    <span>فقط انتخاب‌شده‌ها ({faNumber(selectionCount)})</span>
                                </label>
                            ) : null}
                            <button
                                type="button"
                                className={cn('search-toggle', advancedOpen && 'is-active')}
                                onClick={() => setAdvancedOpen((value) => !value)}
                                aria-expanded={advancedOpen}
                            >
                                <Icon name="settings" size={14} />
                                جست‌وجوی پیشرفته
                                {activeOptions ? <em>{faNumber(activeOptions)}</em> : null}
                                <Icon name="chevron" size={14} className="search-toggle__chevron" />
                            </button>
                        </>
                    ) : null}
                    <div className="search-card__actions">
                        <button type="button" className="search-link" onClick={onOpenSearch}>
                            <Icon name="search" size={15} /> پنل جست‌وجو
                        </button>
                        <button type="button" className="search-link" onClick={onOpenFilters}>
                            <Icon name="filter" size={15} /> فیلتر پیشرفته
                        </button>
                        <button type="button" className="search-link" onClick={onAdd}>
                            <Icon name="plus" size={15} /> کتاب تازه
                        </button>
                    </div>
                </div>

                {scope !== 'books' && advancedOpen ? (
                    <div className="search-advanced">
                        <div className="search-advanced__row">
                            <span className="search-advanced__label">حالت تطبیق</span>
                            <Segmented
                                value={options.mode}
                                onChange={(mode) => onOptions({ ...options, mode })}
                                ariaLabel="حالت تطبیق"
                                options={MODE_OPTIONS}
                            />
                        </div>
                        <div className="search-advanced__row">
                            <span className="search-advanced__label">خطای تایپ</span>
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
                        </div>
                        <div className="search-advanced__row">
                            <span className="search-advanced__label">ترتیب نتیجه</span>
                            <Segmented
                                value={options.sort}
                                onChange={(sort) => onOptions({ ...options, sort })}
                                ariaLabel="ترتیب نتیجه‌ها"
                                options={SORT_OPTIONS}
                            />
                        </div>
                        <div className="search-advanced__checks">
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
                                <span>حساس به بزرگی و کوچکی حروف</span>
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
                        </div>
                        <div className="search-advanced__hints">
                            <span>
                                <code>&quot;عبارت دقیق&quot;</code> ترتیب واژه‌ها را قفل می‌کند
                            </span>
                            <span>
                                <code>-واژه</code> حذف از نتیجه
                            </span>
                            <span>
                                <code>واژه*</code> شروع واژه
                            </span>
                            <span>
                                <code>الف | ب</code> هر یک از دو واژه
                            </span>
                            <span>
                                <code>نویسنده:...</code>
                            </span>
                            <span>
                                <code>موضوع:...</code>
                            </span>
                            <span>
                                <code>برچسب:...</code>
                            </span>
                            <span>
                                <code>پوشه:...</code>
                            </span>
                        </div>
                        <div className="search-advanced__foot">
                            <button
                                type="button"
                                className="search-advanced__reset"
                                onClick={() => onOptions({ ...options, mode: 'phrase', fuzzy: 0, wholeWord: false, caseSensitive: false, includeHeadings: true, includeFootnotes: true, sort: 'relevance' })}
                            >
                                بازنشانی گزینه‌ها
                            </button>
                            <span>
                                حروف «ي/ك»، اعراب، نیم‌فاصله و ارقام فارسی/عربی خودکار یکسان می‌شوند.
                            </span>
                        </div>
                    </div>
                ) : null}
            </div>
        </section>
    );
}
