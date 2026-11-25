import { useMemo, useState, type ReactNode } from 'react';
import type { Facets } from '../../lib/filters';
import { activeFilterCount } from '../../lib/filters';
import { faNumber } from '../../lib/format';
import type { LibraryFilters } from '../../types';
import { Icon, type IconName } from '../icons';
import { Button } from '../ui/Controls';

interface FilterPanelProps {
    filters: LibraryFilters;
    facets: Facets;
    matchCount: number;
    onChange: (filters: LibraryFilters) => void;
    onApply: () => void;
}

interface AccordionProps {
    title: string;
    icon: IconName;
    count: number;
    open: boolean;
    onToggle: () => void;
    children: ReactNode;
}

function Accordion({ title, icon, count, open, onToggle, children }: AccordionProps) {
    return (
        <div className={`accordion ${open ? 'is-open' : ''}`}>
            <button type="button" className="accordion__head" onClick={onToggle} aria-expanded={open}>
                <span className="accordion__icon">
                    <Icon name={icon} size={15} />
                </span>
                <span className="accordion__title">{title}</span>
                {count ? <span className="accordion__count">{faNumber(count)}</span> : null}
                <Icon name="chevron" size={16} className="accordion__chevron" />
            </button>
            {open ? <div className="accordion__body">{children}</div> : null}
        </div>
    );
}

interface CheckListProps {
    items: { value: string; count: number }[];
    selected: string[];
    onToggle: (value: string) => void;
    searchable?: boolean;
    emptyLabel?: string;
}

function CheckList({ items, selected, onToggle, searchable = true, emptyLabel = 'موردی نیست' }: CheckListProps) {
    const [query, setQuery] = useState('');
    const filtered = useMemo(() => {
        const needle = query.trim().toLocaleLowerCase('fa');
        if (!needle) return items;
        return items.filter((item) => item.value.toLocaleLowerCase('fa').includes(needle));
    }, [items, query]);

    return (
        <div className="checklist">
            {searchable && items.length > 5 ? (
                <div className="checklist__search">
                    <Icon name="search" size={14} />
                    <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="جست‌وجو…"
                        aria-label="جست‌وجو در گزینه‌ها"
                    />
                </div>
            ) : null}
            <div className="checklist__items">
                {filtered.length ? (
                    filtered.map((item) => {
                        const active = selected.includes(item.value);
                        return (
                            <button
                                key={item.value || 'root'}
                                type="button"
                                className={`checklist__item ${active ? 'is-active' : ''}`}
                                onClick={() => onToggle(item.value)}
                                aria-pressed={active}
                            >
                                <span className="checklist__box">{active ? <Icon name="check" size={12} /> : null}</span>
                                <span className="checklist__label">{item.value || 'قفسهٔ اصلی'}</span>
                                <span className="checklist__count">{faNumber(item.count)}</span>
                            </button>
                        );
                    })
                ) : (
                    <p className="checklist__empty">{emptyLabel}</p>
                )}
            </div>
        </div>
    );
}

function toggleInList(list: string[], value: string): string[] {
    return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function FilterPanel({ filters, facets, matchCount, onChange, onApply }: FilterPanelProps) {
    const [open, setOpen] = useState<Record<string, boolean>>({
        sections: true,
        folders: false,
        authors: false,
        tags: false,
        status: false
    });
    const active = activeFilterCount(filters);

    const patch = (changes: Partial<LibraryFilters>) => onChange({ ...filters, ...changes });

    return (
        <div className="filter-panel">
            <div className="filter-intro">
                <span className="filter-intro__icon">
                    <Icon name="sparkles" size={18} />
                </span>
                <div>
                    <strong>کتاب موردنظرتان را پیدا کنید</strong>
                    <p>ترکیبی از موضوع، پوشه، نویسنده یا وضعیت مطالعه بسازید.</p>
                </div>
                {active ? <span className="filter-intro__badge">{faNumber(active)} فیلتر</span> : null}
            </div>

            <div className="filter-scroll">
                <Accordion
                    title="موضوع و بخش"
                    icon="layers"
                    count={filters.sections.length}
                    open={open.sections}
                    onToggle={() => setOpen((value) => ({ ...value, sections: !value.sections }))}
                >
                    <CheckList
                        items={facets.sections}
                        selected={filters.sections}
                        onToggle={(value) => patch({ sections: toggleInList(filters.sections, value) })}
                    />
                </Accordion>

                <Accordion
                    title="پوشهٔ کتاب‌ها"
                    icon="folder"
                    count={filters.folders.length}
                    open={open.folders}
                    onToggle={() => setOpen((value) => ({ ...value, folders: !value.folders }))}
                >
                    <CheckList
                        items={facets.folders}
                        selected={filters.folders}
                        onToggle={(value) => patch({ folders: toggleInList(filters.folders, value) })}
                    />
                </Accordion>

                <Accordion
                    title="نویسنده"
                    icon="user"
                    count={filters.authors.length}
                    open={open.authors}
                    onToggle={() => setOpen((value) => ({ ...value, authors: !value.authors }))}
                >
                    <CheckList
                        items={facets.authors}
                        selected={filters.authors}
                        onToggle={(value) => patch({ authors: toggleInList(filters.authors, value) })}
                    />
                </Accordion>

                <Accordion
                    title="برچسب‌ها"
                    icon="tag"
                    count={filters.tags.length}
                    open={open.tags}
                    onToggle={() => setOpen((value) => ({ ...value, tags: !value.tags }))}
                >
                    <div className="tag-cloud">
                        {facets.tags.length ? (
                            facets.tags.map((tag) => {
                                const selected = filters.tags.includes(tag.value);
                                return (
                                    <button
                                        key={tag.value}
                                        type="button"
                                        className={`tag-chip ${selected ? 'is-active' : ''}`}
                                        onClick={() => patch({ tags: toggleInList(filters.tags, tag.value) })}
                                        aria-pressed={selected}
                                    >
                                        <span>{tag.value}</span>
                                        <em>{faNumber(tag.count)}</em>
                                    </button>
                                );
                            })
                        ) : (
                            <p className="checklist__empty">برچسبی ثبت نشده است.</p>
                        )}
                    </div>
                </Accordion>

                <Accordion
                    title="وضعیت مطالعه"
                    icon="clock"
                    count={(filters.favoritesOnly ? 1 : 0) + (filters.readOnly ? 1 : 0)}
                    open={open.status}
                    onToggle={() => setOpen((value) => ({ ...value, status: !value.status }))}
                >
                    <div className="status-options">
                        <button
                            type="button"
                            className={`status-option ${filters.favoritesOnly ? 'is-active' : ''}`}
                            onClick={() => patch({ favoritesOnly: !filters.favoritesOnly })}
                            aria-pressed={filters.favoritesOnly}
                        >
                            <span className="status-option__icon">
                                <Icon name="star" size={15} />
                            </span>
                            <span>
                                <strong>فقط کتاب‌های محبوب</strong>
                                <small>کتاب‌هایی که به آن‌ها امتیاز داده‌اید</small>
                            </span>
                        </button>
                        <button
                            type="button"
                            className={`status-option ${filters.readOnly ? 'is-active' : ''}`}
                            onClick={() => patch({ readOnly: !filters.readOnly })}
                            aria-pressed={filters.readOnly}
                        >
                            <span className="status-option__icon">
                                <Icon name="check" size={15} />
                            </span>
                            <span>
                                <strong>فقط خوانده‌شده‌ها</strong>
                                <small>کتاب‌هایی که مطالعه کرده‌اید</small>
                            </span>
                        </button>
                    </div>
                </Accordion>
            </div>

            <footer className="filter-footer">
                <Button variant="ghost" size="sm" icon="refresh" onClick={() => onChange({ ...filters, sections: [], folders: [], authors: [], tags: [], favoritesOnly: false, readOnly: false })}>
                    پاک‌کردن
                </Button>
                <div className="filter-footer__spacer" />
                <span className="filter-footer__count">
                    <strong>{faNumber(matchCount)}</strong> کتاب منطبق
                </span>
                <Button variant="primary" size="sm" trailingIcon="arrowLeft" onClick={onApply}>
                    نمایش کتاب‌ها
                </Button>
            </footer>
        </div>
    );
}
