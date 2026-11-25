import { cn, faBytes, faDate, faNumber, hashString, initials, relativeFolder } from '../../lib/format';
import type { BookSummary } from '../../types';
import { Icon } from '../icons';
import { Rating } from '../ui/Controls';

const COVERS: [string, string][] = [
    ['#6366f1', '#22d3ee'],
    ['#8b5cf6', '#ec4899'],
    ['#0ea5e9', '#6366f1'],
    ['#10b981', '#22d3ee'],
    ['#f59e0b', '#ef4444'],
    ['#14b8a6', '#8b5cf6'],
    ['#f43f5e', '#f59e0b'],
    ['#3b82f6', '#14b8a6']
];

interface BookCardProps {
    book: BookSummary;
    view: 'grid' | 'list';
    selected: boolean;
    onOpen: () => void;
    onSelect: (selected: boolean) => void;
    onEdit: () => void;
    onToggleRead: () => void;
}

export function BookCard({ book, view, selected, onOpen, onSelect, onEdit, onToggleRead }: BookCardProps) {
    const meta = book.frontmatter;
    const title = meta['نام کتاب'] || book.filename;
    const cover = COVERS[hashString(title) % COVERS.length];
    const read = meta['خوانده شده'] === true;
    const rating = Number(meta['امتیاز']) || 0;
    const tags = (meta['برچسب ها'] || []).slice(0, 3);
    const folder = relativeFolder(book.filename);
    const volume = String(meta['جلد'] ?? '').trim();
    const volumeCount = Number(meta['تعداد جلدها']) || 0;

    return (
        <article
            className={cn('book-card', `book-card--${view}`, selected && 'is-selected')}
            style={{ ['--cover-a' as string]: cover[0], ['--cover-b' as string]: cover[1] }}
        >
            <div className="book-card__cover" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(event) => event.key === 'Enter' && onOpen()}>
                <span className="book-card__pattern" aria-hidden="true" />
                <span className="book-card__section">{meta['بخش'] || 'بدون موضوع'}</span>
                <span className="book-card__initial">{initials(title)}</span>
                <span className="book-card__cover-bottom">
                    <span className="book-card__cover-title">{title}</span>
                    <span className="book-card__cover-mark">
                        <Icon name="book" size={15} />
                    </span>
                </span>
                {read ? (
                    <span className="book-card__read">
                        <Icon name="check" size={12} /> خوانده‌شده
                    </span>
                ) : null}
                <label className="book-card__select" onClick={(event) => event.stopPropagation()}>
                    <input
                        type="checkbox"
                        checked={selected}
                        onChange={(event) => onSelect(event.target.checked)}
                        aria-label={`انتخاب ${title}`}
                    />
                    <span>{selected ? <Icon name="check" size={12} /> : null}</span>
                </label>
            </div>

            <div className="book-card__body">
                <div className="book-card__heading">
                    <h3 onClick={onOpen} title={title}>
                        {title}
                    </h3>
                    <Rating value={rating} readOnly size={13} />
                </div>
                <div className="book-card__meta">
                    <span>
                        <Icon name="user" size={13} />
                        {meta['نویسنده'] || 'نویسندهٔ نامشخص'}
                    </span>
                    {meta['مترجم'] ? (
                        <span>
                            <Icon name="edit" size={13} />
                            ترجمهٔ {meta['مترجم']}
                        </span>
                    ) : null}
                </div>
                {volume || volumeCount ? (
                    <div className="book-card__volumes">
                        {volume ? (
                            <span className="book-card__volume">
                                <Icon name="book" size={13} />
                                جلد {volume}
                            </span>
                        ) : null}
                        {volumeCount > 0 ? (
                            <span className="book-card__volume book-card__volume--count">
                                <Icon name="layers" size={13} />
                                {faNumber(volumeCount)} جلد
                            </span>
                        ) : null}
                    </div>
                ) : null}
                {tags.length ? (
                    <div className="book-card__tags">
                        {tags.map((tag) => (
                            <span key={tag} className="chip chip--tiny">
                                {tag}
                            </span>
                        ))}
                    </div>
                ) : null}
                <div className="book-card__footer">
                    <span className="book-card__folder" title={folder || 'قفسهٔ اصلی'}>
                        <Icon name="folder" size={13} />
                        {folder || 'قفسهٔ اصلی'}
                    </span>
                    <span className="book-card__size">{faBytes(book.size)}</span>
                </div>
                <div className="book-card__actions">
                    <button type="button" className="book-action book-action--primary" onClick={onOpen}>
                        <Icon name="book" size={14} /> مطالعه
                    </button>
                    <button type="button" className="book-action" onClick={onEdit} title="ویرایش مشخصات">
                        <Icon name="edit" size={14} />
                    </button>
                    <button
                        type="button"
                        className={cn('book-action', read && 'is-on')}
                        onClick={onToggleRead}
                        title={read ? 'علامت‌گذاری به‌عنوان خوانده‌نشده' : 'علامت‌گذاری به‌عنوان خوانده‌شده'}
                    >
                        <Icon name="check" size={14} />
                    </button>
                    <span className="book-card__date">{faDate(book.modifiedAt)}</span>
                </div>
            </div>
        </article>
    );
}
