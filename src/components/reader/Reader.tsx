import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { cn, faNumber } from '../../lib/format';
import { buildHighlightPattern, normalizeTerm } from '../../lib/search';
import { parseBookPages } from '../../lib/markdown';
import type { BookMetadata, BookSummary, ExportFormat } from '../../types';
import { Icon } from '../icons';
import { Button, IconButton } from '../ui/Controls';
import { Modal } from '../ui/Modal';

interface ReaderProps {
    book: BookSummary;
    content: string;
    initialQuery?: string;
    initialTarget?: { pageIndex: number; matchIndex: number; text?: string; context?: string };
    onClose: () => void;
    onSaveMeta: (book: BookSummary, metadata: BookMetadata) => Promise<void>;
    onSaveContent: (content: string) => Promise<void>;
    onEdit: () => void;
    onTranslate: () => void;
    notify: (message: string, tone?: 'success' | 'error' | 'info') => void;
}

interface TocItem {
    id: string;
    level: number;
    text: string;
}

interface TocNode extends TocItem {
    index: number;
    children: TocNode[];
}

/** Turns the flat heading list into a tree so deeper headings can be folded
    under their parent chapter. */
function buildTocTree(items: TocItem[]): TocNode[] {
    const roots: TocNode[] = [];
    const stack: TocNode[] = [];
    items.forEach((item, index) => {
        const node: TocNode = { ...item, index, children: [] };
        while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
        if (stack.length) stack[stack.length - 1].children.push(node);
        else roots.push(node);
        stack.push(node);
    });
    return roots;
}

function collapseDeeperLevels(nodes: TocNode[], collapsed = new Set<string>()): Set<string> {
    for (const node of nodes) {
        if (node.level >= 3 && node.children.length) collapsed.add(node.id);
        collapseDeeperLevels(node.children, collapsed);
    }
    return collapsed;
}

interface TocBranchProps {
    nodes: TocNode[];
    activeIndex: number;
    collapsed: Set<string>;
    onToggle: (id: string) => void;
    onGo: (index: number) => void;
}

function TocBranch({ nodes, activeIndex, collapsed, onToggle, onGo }: TocBranchProps) {
    return (
        <>
            {nodes.map((node) => {
                const open = !collapsed.has(node.id);
                const hasChildren = node.children.length > 0;
                return (
                    <div className="toc-node" key={node.id}>
                        <div
                            className={cn(
                                'toc-row',
                                `toc-row--${Math.min(node.level, 4)}`,
                                activeIndex === node.index && 'is-active'
                            )}
                        >
                            {hasChildren ? (
                                <button
                                    type="button"
                                    className={cn('toc-toggle', open && 'is-open')}
                                    aria-expanded={open}
                                    aria-label={open ? `بستن زیربخش‌های ${node.text}` : `باز کردن زیربخش‌های ${node.text}`}
                                    title={open ? 'بستن زیربخش‌ها' : 'باز کردن زیربخش‌ها'}
                                    onClick={() => onToggle(node.id)}
                                >
                                    <Icon name="chevron" size={13} />
                                </button>
                            ) : (
                                <span className="toc-toggle toc-toggle--blank" aria-hidden="true" />
                            )}
                            <button
                                type="button"
                                className="toc-label"
                                onClick={() => onGo(node.index)}
                                title={node.text}
                            >
                                {node.text}
                            </button>
                        </div>
                        {hasChildren && open ? (
                            <div className="toc-children">
                                <TocBranch
                                    nodes={node.children}
                                    activeIndex={activeIndex}
                                    collapsed={collapsed}
                                    onToggle={onToggle}
                                    onGo={onGo}
                                />
                            </div>
                        ) : null}
                    </div>
                );
            })}
        </>
    );
}

const FONT_KEY = 'md-library:reader-font';

const EXPORT_FORMATS: { format: ExportFormat; label: string; hint: string }[] = [
    { format: 'md', label: 'MD', hint: 'خروجی Markdown' },
    { format: 'docx', label: 'DOCX', hint: 'خروجی Word' },
    { format: 'html', label: 'HTML', hint: 'خروجی HTML' },
    { format: 'pdf', label: 'PDF', hint: 'خروجی PDF' }
];

export function Reader({
    book,
    content,
    initialQuery,
    initialTarget,
    onClose,
    onSaveMeta,
    onSaveContent,
    onEdit,
    onTranslate,
    notify
}: ReaderProps) {
    const pages = useMemo(() => parseBookPages(content), [content]);
    const title = book.frontmatter['نام کتاب'] || book.filename;
    const meta = book.frontmatter;
    const read = meta['خوانده شده'] === true;

    const overlayRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const marksRef = useRef<HTMLElement[]>([]);
    const scrollRef = useRef(0);
    const positionKey = `md-library:position:${book.filename}`;
    const bookmarkKey = `md-library:bookmark:${book.filename}`;

    const [toc, setToc] = useState<TocItem[]>([]);
    const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
    const [activeSection, setActiveSection] = useState(-1);
    const [tocOpen, setTocOpen] = useState(() => window.innerWidth > 1100);
    const [fontSize, setFontSize] = useState(() => {
        const saved = Number(localStorage.getItem(FONT_KEY));
        return Number.isFinite(saved) && saved >= 70 ? saved : 100;
    });
    const [focusMode, setFocusMode] = useState(false);
    const [fullscreen, setFullscreen] = useState(false);
    const [searchInput, setSearchInput] = useState(initialQuery || '');
    const [searchState, setSearchState] = useState({ index: -1, total: 0 });
    const [progress, setProgress] = useState(0);
    const [bookmark, setBookmark] = useState<number | null>(() => {
        const saved = localStorage.getItem(bookmarkKey);
        return saved === null ? null : Number(saved);
    });
    const [exporting, setExporting] = useState(false);
    const [editorOpen, setEditorOpen] = useState(false);
    const [draft, setDraft] = useState('');
    const [savingContent, setSavingContent] = useState(false);

    useEffect(() => {
        const previousTitle = document.title;
        document.title = `${title} — مطالعه`;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.title = previousTitle;
            document.body.style.overflow = previousOverflow;
            localStorage.setItem(positionKey, String(scrollRef.current));
        };
    }, [title, positionKey]);

    useLayoutEffect(() => {
        const container = contentRef.current;
        if (!container) return;
        const headings = Array.from(
            container.querySelectorAll<HTMLElement>('.book-page__body h1, .book-page__body h2, .book-page__body h3, .book-page__body h4, .book-page__body h5, .book-page__body h6')
        );
        const items: TocItem[] = headings.map((heading, index) => {
            const id = `reader-sec-${index}`;
            heading.id = id;
            return {
                id,
                level: Number(heading.tagName[1]) || 2,
                text: (heading.textContent || '').trim() || `بخش ${index + 1}`
            };
        });
        setToc(items);
        setCollapsed(collapseDeeperLevels(buildTocTree(items)));
        setActiveSection(-1);

        const frame = requestAnimationFrame(() => {
            const saved = Number(localStorage.getItem(positionKey) || 0);
            if (container && saved > 0) container.scrollTop = saved;
            scrollRef.current = container?.scrollTop || 0;
        });
        return () => cancelAnimationFrame(frame);
    }, [pages, positionKey]);

    const updateScroll = useCallback(() => {
        const container = contentRef.current;
        if (!container) return;
        scrollRef.current = container.scrollTop;
        const max = container.scrollHeight - container.clientHeight;
        setProgress(max > 0 ? Math.min(100, Math.max(0, (container.scrollTop / max) * 100)) : 0);
        const containerTop = container.getBoundingClientRect().top;
        let current = -1;
        toc.forEach((item, index) => {
            const element = document.getElementById(item.id);
            if (element && element.getBoundingClientRect().top - containerTop <= 100) current = index;
        });
        setActiveSection((previous) => (current === -1 ? previous : current));
    }, [toc]);

    useEffect(() => {
        const container = contentRef.current;
        if (!container) return;
        let frame = 0;
        const handler = () => {
            if (frame) return;
            frame = requestAnimationFrame(() => {
                frame = 0;
                updateScroll();
            });
        };
        container.addEventListener('scroll', handler, { passive: true });
        return () => {
            container.removeEventListener('scroll', handler);
            if (frame) cancelAnimationFrame(frame);
        };
    }, [updateScroll]);

    useEffect(() => {
        const handler = () => setFullscreen(document.fullscreenElement === overlayRef.current);
        document.addEventListener('fullscreenchange', handler);
        return () => document.removeEventListener('fullscreenchange', handler);
    }, []);

    const clearSearchMarks = useCallback(() => {
        const container = contentRef.current;
        if (container) {
            container.querySelectorAll('mark.reader-hit').forEach((mark) => {
                const parent = mark.parentNode;
                if (!parent) return;
                while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
                parent.removeChild(mark);
                parent.normalize();
            });
        }
        marksRef.current = [];
        setSearchState({ index: -1, total: 0 });
    }, []);

    const goToMark = useCallback((index: number, marks = marksRef.current) => {
        if (!marks.length) return;
        const normalized = ((index % marks.length) + marks.length) % marks.length;
        marks.forEach((mark, position) => mark.classList.toggle('is-active', position === normalized));
        marks[normalized].scrollIntoView({ block: 'center', behavior: 'smooth' });
        setSearchState({ index: normalized, total: marks.length });
    }, []);

    const runSearch = useCallback(
        (raw: string) => {
            const container = contentRef.current;
            if (!container) return;
            clearSearchMarks();
            const pattern = buildHighlightPattern(raw);
            if (!pattern) return;

            const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
                acceptNode(node) {
                    const parent = (node as Text).parentElement;
                    if (!parent) return NodeFilter.FILTER_REJECT;
                    if (parent.closest('mark.reader-hit') || parent.closest('script')) return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                }
            });
            const textNodes: Text[] = [];
            while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

            const marks: HTMLElement[] = [];
            for (const node of textNodes) {
                const text = node.textContent || '';
                if (!text.trim()) continue;
                pattern.lastIndex = 0;
                const fragment = document.createDocumentFragment();
                let lastIndex = 0;
                let matched = false;
                let match: RegExpExecArray | null;
                while ((match = pattern.exec(text))) {
                    if (!match[0].length) {
                        pattern.lastIndex += 1;
                        continue;
                    }
                    matched = true;
                    if (match.index > lastIndex) {
                        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
                    }
                    const mark = document.createElement('mark');
                    mark.className = 'reader-hit';
                    mark.textContent = match[0];
                    fragment.appendChild(mark);
                    marks.push(mark);
                    lastIndex = match.index + match[0].length;
                }
                if (!matched) continue;
                if (lastIndex < text.length) fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
                node.parentNode?.replaceChild(fragment, node);
            }

            marksRef.current = marks;
            if (!marks.length) {
                setSearchState({ index: -1, total: 0 });
                return;
            }
            if (initialTarget) {
                setSearchState({ index: 0, total: marks.length });
            } else {
                goToMark(0, marks);
            }
        },
        [clearSearchMarks, goToMark, initialTarget]
    );

    useEffect(() => {
        const timer = setTimeout(() => {
            if (searchInput.trim()) runSearch(searchInput);
            else clearSearchMarks();
        }, 200);
        return () => clearTimeout(timer);
    }, [searchInput, runSearch, clearSearchMarks]);

    useEffect(() => {
        if (!initialTarget) return;
        const timer = setTimeout(() => {
            const container = contentRef.current;
            if (!container) return;
            const pageEl = container.querySelector<HTMLElement>(`.book-page[data-index="${initialTarget.pageIndex}"]`);
            const pageMarks = marksRef.current.filter(
                (mark) => Number(mark.closest('.book-page')?.getAttribute('data-index')) === initialTarget.pageIndex
            );

            let chosen: HTMLElement | undefined;
            const context = normalizeTerm((initialTarget.context || '').replace(/…/g, ' '));
            if (pageEl && context) {
                const at = normalizeTerm(pageEl.textContent || '').indexOf(context);
                if (at >= 0) {
                    let bestDistance = Number.POSITIVE_INFINITY;
                    for (const mark of pageMarks) {
                        const range = document.createRange();
                        range.setStart(pageEl, 0);
                        range.setEndBefore(mark);
                        const distance = Math.abs(normalizeTerm(range.toString()).length - at);
                        if (distance < bestDistance) {
                            bestDistance = distance;
                            chosen = mark;
                        }
                    }
                }
            }

            const hint = (initialTarget.text || '').replace(/[\u064B-\u0652\u0640]/g, '').trim();
            if (!chosen && hint) {
                chosen = pageMarks.find((mark) =>
                    (mark.textContent || '').replace(/[\u064B-\u0652\u0640]/g, '').includes(hint)
                );
            }
            if (!chosen && pageMarks.length) {
                chosen = pageMarks[Math.min(Math.max(0, initialTarget.matchIndex), pageMarks.length - 1)];
            }

            if (chosen) {
                goToMark(marksRef.current.indexOf(chosen));
                const flashTarget = chosen;
                flashTarget.classList.add('is-flash');
                setTimeout(() => flashTarget.classList.remove('is-flash'), 2400);
                return;
            }

            if (!pageEl) return;
            const containerRect = container.getBoundingClientRect();
            const pageRect = pageEl.getBoundingClientRect();
            container.scrollTo({
                top: Math.max(0, container.scrollTop + pageRect.top - containerRect.top - 16),
                behavior: 'smooth'
            });
            pageEl.classList.add('flash');
            setTimeout(() => pageEl.classList.remove('flash'), 2400);
        }, 420);
        return () => clearTimeout(timer);
    }, [initialTarget, goToMark]);

    const tocTree = useMemo(() => buildTocTree(toc), [toc]);

    const collapsibleIds = useMemo(() => {
        const ids: string[] = [];
        const walk = (nodes: TocNode[]) => {
            nodes.forEach((node) => {
                if (node.children.length) ids.push(node.id);
                walk(node.children);
            });
        };
        walk(tocTree);
        return ids;
    }, [tocTree]);

    const allCollapsed =
        collapsibleIds.length > 0 && collapsibleIds.every((id) => collapsed.has(id));

    const toggleTocNode = useCallback((id: string) => {
        setCollapsed((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const toggleAllToc = useCallback(() => {
        setCollapsed(allCollapsed ? new Set() : new Set(collapsibleIds));
    }, [allCollapsed, collapsibleIds]);

    const scrollToSection = useCallback(
        (index: number) => {
            const item = toc[index];
            const container = contentRef.current;
            if (!item || !container) return;
            const target = document.getElementById(item.id);
            if (!target) return;
            const containerRect = container.getBoundingClientRect();
            const targetRect = target.getBoundingClientRect();
            container.scrollTo({
                top: Math.max(0, container.scrollTop + targetRect.top - containerRect.top - 24),
                behavior: 'smooth'
            });
            setActiveSection(index);
        },
        [toc]
    );

    const changeFont = (delta: number) => {
        const next = Math.min(180, Math.max(70, fontSize + delta));
        setFontSize(next);
        localStorage.setItem(FONT_KEY, String(next));
    };

    const saveBookmark = () => {
        const position = contentRef.current?.scrollTop || 0;
        localStorage.setItem(bookmarkKey, String(position));
        setBookmark(position);
        notify('جای مطالعه ذخیره شد.');
    };

    const goToBookmark = () => {
        if (bookmark === null) return;
        contentRef.current?.scrollTo({ top: bookmark, behavior: 'smooth' });
    };

    const toggleRead = async () => {
        try {
            await onSaveMeta(book, { ...book.frontmatter, 'خوانده شده': !read });
            notify(read ? 'کتاب به خوانده‌نشده برگشت.' : 'کتاب خوانده‌شده علامت‌گذاری شد.');
        } catch (error) {
            notify(error instanceof Error ? error.message : 'ذخیرهٔ وضعیت انجام نشد.', 'error');
        }
    };

    const copyCitation = async () => {
        const selection = window.getSelection();
        const container = contentRef.current;
        let selectedText = '';
        let pageLabel = '';

        if (selection && container && selection.rangeCount > 0 && !selection.isCollapsed) {
            const range = selection.getRangeAt(0);
            if (container.contains(range.commonAncestorContainer)) {
                selectedText = selection.toString().replace(/\s+$/, '');
                const node =
                    range.startContainer.nodeType === Node.ELEMENT_NODE
                        ? (range.startContainer as Element)
                        : range.startContainer.parentElement;
                const page = node?.closest('.book-page') as HTMLElement | null;
                pageLabel = page?.dataset.label || '';
            }
        }

        const lines = ['──────────────', `📚 نام کتاب: ${title}`];
        if (pageLabel) lines.push(`📄 صفحه: ${pageLabel}`);
        if (meta['نویسنده']) lines.push(`✍ نویسنده: ${meta['نویسنده']}`);
        if (meta['مترجم']) lines.push(`🔁 مترجم: ${meta['مترجم']}`);
        lines.push(`📍 آدرس فایل: ${book.filename}`);
        const payload = `${selectedText ? `${selectedText}\n\n` : ''}${lines.join('\n')}\n`;

        try {
            await navigator.clipboard.writeText(payload);
            notify(selectedText ? 'متن همراه با آدرس کتاب کپی شد.' : 'آدرس کتاب کپی شد.');
        } catch {
            notify('کپی انجام نشد؛ دسترسی حافظهٔ موقت را بررسی کنید.', 'error');
        }
    };

    const openContentEditor = () => {
        setDraft(content);
        setEditorOpen(true);
    };

    const saveContentEdit = async () => {
        if (savingContent) return;
        if (draft === content) {
            setEditorOpen(false);
            return;
        }
        setSavingContent(true);
        try {
            await onSaveContent(draft);
            notify('متن کتاب ذخیره شد.', 'success');
            setEditorOpen(false);
        } catch (error) {
            notify(error instanceof Error ? error.message : 'ذخیرهٔ متن کتاب انجام نشد.', 'error');
        } finally {
            setSavingContent(false);
        }
    };

    const toggleFullscreen = async () => {
        try {
            if (document.fullscreenElement === overlayRef.current) await document.exitFullscreen();
            else await overlayRef.current?.requestFullscreen();
        } catch {
            notify('نمایش تمام‌صفحه در این مرورگر در دسترس نیست.', 'info');
        }
    };

    const handleContentClick = (event: React.MouseEvent) => {
        const link = (event.target as HTMLElement).closest('a[href^="#"]') as HTMLAnchorElement | null;
        if (!link) return;
        const href = link.getAttribute('href') || '';
        if (!href.startsWith('#')) return;
        const target = document.getElementById(href.slice(1));
        const container = contentRef.current;
        if (!target || !container) return;
        event.preventDefault();
        const containerRect = container.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        container.scrollTo({
            top: Math.max(0, container.scrollTop + targetRect.top - containerRect.top - container.clientHeight / 3),
            behavior: 'smooth'
        });
        target.classList.add('flash');
        setTimeout(() => target.classList.remove('flash'), 2200);
    };

    useEffect(() => {
        const handler = (event: KeyboardEvent) => {
            if (document.querySelector('.modal-layer')) return;
            const active = document.activeElement as HTMLElement | null;
            const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
            if (event.key === 'Escape') {
                onClose();
            } else if (event.key === 'ArrowDown' && !typing) {
                event.preventDefault();
                if (activeSection < toc.length - 1) scrollToSection(activeSection + 1);
            } else if (event.key === 'ArrowUp' && !typing) {
                event.preventDefault();
                if (activeSection > 0) scrollToSection(activeSection - 1);
            } else if (event.key === '/' && !typing) {
                event.preventDefault();
                searchInputRef.current?.focus();
            } else if (event.key.toLowerCase() === 'f' && !typing) {
                event.preventDefault();
                void toggleFullscreen();
            } else if (event.key.toLowerCase() === 'b' && !typing) {
                event.preventDefault();
                saveBookmark();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [activeSection, toc.length, onClose, scrollToSection, fontSize]);

    const exportBook = async (format: ExportFormat) => {
        if (exporting) return;
        setExporting(true);
        try {
            const response = await fetch(api.exportUrl(book.filename, format), { cache: 'no-store' });
            const type = response.headers.get('content-type') || '';
            if (!response.ok) {
                const payload = await response.json().catch(() => null);
                throw new Error(
                    payload && typeof payload.error === 'string'
                        ? payload.error
                        : 'خروجی گرفتن انجام نشد.'
                );
            }
            if (type.includes('text/html')) {
                window.open(api.exportUrl(book.filename, format), '_blank', 'noopener');
                notify('پنجرهٔ چاپ باز شد؛ برای ذخیرهٔ PDF گزینهٔ «Save as PDF» را انتخاب کنید.', 'info');
                return;
            }

            const blob = await response.blob();
            const objectUrl = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = objectUrl;
            link.download = `${(book.frontmatter['نام کتاب'] || 'book').replace(/[\\/:*?"<>|]+/g, '-')}.${format}`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
            notify(`خروجی ${format.toUpperCase()} ذخیره شد.`, 'success');
        } catch (error) {
            notify(error instanceof Error ? error.message : 'خروجی گرفتن انجام نشد.', 'error');
        } finally {
            setExporting(false);
        }
    };

    return (
        <div
            className={cn('reader', focusMode && 'is-focus', fullscreen && 'is-fullscreen')}
            ref={overlayRef}
            role="document"
            aria-label={`مطالعهٔ ${title}`}
        >
            <div className="reader__progress">
                <span style={{ width: `${progress}%` }} />
            </div>

            <header className="reader__bar">
                <div className="reader__identity">
                    <IconButton icon="close" label="بستن کتاب (Esc)" onClick={onClose} />
                    <div className="reader__titles">
                        <span>اکنون می‌خوانید</span>
                        <h1>{title}</h1>
                        {meta['نویسنده'] ? <small>{meta['نویسنده']}</small> : null}
                    </div>
                </div>

                <div className="reader__controls">
                    <div className="reader__group">
                        <IconButton
                            icon="list"
                            label={tocOpen ? 'بستن فهرست مطالب' : 'فهرست مطالب'}
                            active={tocOpen}
                            onClick={() => setTocOpen((value) => !value)}
                        />
                        <IconButton
                            icon="check"
                            label={read ? 'خوانده‌نشده' : 'خوانده‌شده'}
                            active={read}
                            onClick={() => void toggleRead()}
                        />
                        <IconButton icon="edit" label="ویرایش مشخصات" onClick={onEdit} />
                        <IconButton icon="type" label="ویرایش متن کتاب" onClick={openContentEditor} />
                        <IconButton icon="copy" label="کپی متن با آدرس کتاب" onClick={() => void copyCitation()} />
                        <IconButton icon="globe" label="ترجمهٔ خودکار کتاب" onClick={onTranslate} />
                    </div>

                    <span className="reader__divider" />

                    <div className="reader__group reader__export" role="group" aria-label="خروجی گرفتن از کتاب">
                        {EXPORT_FORMATS.map((item) => (
                            <button
                                key={item.format}
                                type="button"
                                className="reader__export-btn"
                                title={item.hint}
                                disabled={exporting}
                                onClick={() => void exportBook(item.format)}
                            >
                                {item.label}
                            </button>
                        ))}
                    </div>

                    <span className="reader__divider" />

                    <div className="reader__group reader__group--type">
                        <button type="button" className="reader__type" onClick={() => changeFont(-10)} title="کوچک‌تر">
                            A−
                        </button>
                        <span className="reader__font">{faNumber(fontSize)}٪</span>
                        <button type="button" className="reader__type" onClick={() => changeFont(10)} title="بزرگ‌تر">
                            A+
                        </button>
                    </div>

                    <span className="reader__divider" />

                    <div className="reader__group">
                        <IconButton
                            icon="arrowUp"
                            label="بخش قبلی"
                            onClick={() => scrollToSection(Math.max(0, activeSection - 1))}
                        />
                        <IconButton
                            icon="arrowDown"
                            label="بخش بعدی"
                            onClick={() => scrollToSection(Math.min(toc.length - 1, activeSection + 1))}
                        />
                    </div>

                    <div className="reader__search">
                        <Icon name="search" size={16} />
                        <input
                            ref={searchInputRef}
                            value={searchInput}
                            onChange={(event) => setSearchInput(event.target.value)}
                            placeholder="جست‌وجو در کتاب"
                            aria-label="جست‌وجو در متن کتاب"
                        />
                        <span className="reader__search-count">
                            {searchState.total
                                ? `${faNumber(searchState.index + 1)} / ${faNumber(searchState.total)}`
                                : searchInput
                                    ? 'یافت نشد'
                                    : ''}
                        </span>
                        <IconButton
                            icon="arrowUp"
                            label="نتیجهٔ قبلی"
                            size={15}
                            onClick={() => goToMark(searchState.index - 1)}
                            disabled={!searchState.total}
                        />
                        <IconButton
                            icon="arrowDown"
                            label="نتیجهٔ بعدی"
                            size={15}
                            onClick={() => goToMark(searchState.index + 1)}
                            disabled={!searchState.total}
                        />
                    </div>

                    <span className="reader__divider" />

                    <div className="reader__group">
                        <IconButton
                            icon="bookmark"
                            label={bookmark === null ? 'ذخیرهٔ جای مطالعه' : 'به‌روزرسانی نشان مطالعه'}
                            active={bookmark !== null}
                            onClick={saveBookmark}
                        />
                        <IconButton
                            icon="restore"
                            label="رفتن به جای ذخیره‌شده"
                            disabled={bookmark === null}
                            onClick={goToBookmark}
                        />
                        <IconButton
                            icon="eye"
                            label="حالت تمرکز"
                            active={focusMode}
                            onClick={() => setFocusMode((value) => !value)}
                        />
                        <IconButton
                            icon="expand"
                            label="تمام‌صفحه"
                            active={fullscreen}
                            onClick={() => void toggleFullscreen()}
                        />
                    </div>
                </div>
            </header>

            {focusMode ? (
                <button type="button" className="reader__focus-exit" onClick={() => setFocusMode(false)} title="نمایش نوار ابزار">
                    <Icon name="menu" size={18} />
                </button>
            ) : null}

            <div className="reader__body">
                <aside className={cn('reader__toc', !tocOpen && 'is-collapsed')} aria-label="فهرست مطالب">
                    <div className="reader__toc-head">
                        <span>
                            <Icon name="list" size={15} /> فهرست مطالب
                        </span>
                        <div className="reader__toc-actions">
                            {collapsibleIds.length ? (
                                <button
                                    type="button"
                                    className="reader__toc-toggle-all"
                                    onClick={toggleAllToc}
                                >
                                    {allCollapsed ? 'باز کردن همه' : 'بستن همه'}
                                </button>
                            ) : null}
                            <IconButton icon="close" label="بستن فهرست" size={15} onClick={() => setTocOpen(false)} />
                        </div>
                    </div>
                    <div className="reader__toc-list">
                        {toc.length ? (
                            <TocBranch
                                nodes={tocTree}
                                activeIndex={activeSection}
                                collapsed={collapsed}
                                onToggle={toggleTocNode}
                                onGo={scrollToSection}
                            />
                        ) : (
                            <p className="reader__toc-empty">فهرستی برای این کتاب پیدا نشد.</p>
                        )}
                    </div>
                </aside>

                <div
                    className="reader__scroll"
                    ref={contentRef}
                    onScroll={() => updateScroll()}
                    onClick={handleContentClick}
                    style={{ ['--reader-font' as string]: `${fontSize}%` }}
                >
                    <div className="reader__pages">
                        {pages.map((page) => {
                            const label = page.marker || `صفحهٔ ${faNumber(page.index + 1)}`;
                            return (
                                <section
                                    className="book-page"
                                    key={page.index}
                                    data-index={page.index}
                                    data-label={label}
                                >
                                    <header className="book-page__head">
                                        <span>{title}</span>
                                        <em>{label}</em>
                                    </header>
                                    <div className="book-page__body" dangerouslySetInnerHTML={{ __html: page.html }} />
                                    {page.marker ? (
                                        <footer className="book-page__foot">
                                            <Icon name="book" size={13} /> {page.marker}
                                        </footer>
                                    ) : null}
                                </section>
                            );
                        })}
                    </div>
                    <div className="reader__end">
                        <span className="reader__end-mark">
                            <Icon name="books" size={20} />
                        </span>
                        <strong>پایان کتاب</strong>
                        <p>امید است این مطالعه برایتان سودمند بوده باشد.</p>
                        <button type="button" onClick={onClose}>
                            بازگشت به کتابخانه
                        </button>
                    </div>
                </div>
            </div>

            <Modal
                open={editorOpen}
                title="ویرایش متن کتاب"
                kicker={book.filename}
                icon="type"
                size="xl"
                onClose={() => !savingContent && setEditorOpen(false)}
                footer={
                    <>
                        <Button variant="soft" size="sm" disabled={savingContent} onClick={() => setEditorOpen(false)}>
                            انصراف
                        </Button>
                        <Button
                            variant="primary"
                            size="sm"
                            icon="save"
                            disabled={savingContent}
                            onClick={() => void saveContentEdit()}
                        >
                            {savingContent ? 'در حال ذخیره…' : 'ذخیرهٔ متن'}
                        </Button>
                    </>
                }
            >
                <div className="book-editor">
                    <textarea
                        className="input textarea book-editor__area"
                        value={draft}
                        spellCheck={false}
                        dir="auto"
                        aria-label="متن Markdown کتاب"
                        onChange={(event) => setDraft(event.target.value)}
                    />
                    <div className="book-editor__meta">
                        <span>{faNumber(draft.length)} نویسه</span>
                        <span>متادیتا در ابتدای فایل بین دو خط --- نوشته می‌شود.</span>
                    </div>
                </div>
            </Modal>
        </div>
    );
}
