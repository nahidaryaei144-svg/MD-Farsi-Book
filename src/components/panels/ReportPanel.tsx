import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { faBytes, faDateTime, faNumber } from '../../lib/format';
import type { LibraryReport } from '../../types';
import { Icon } from '../icons';
import { Button, EmptyState } from '../ui/Controls';

interface ReportPanelProps {
    notify: (message: string, tone?: 'success' | 'error' | 'info') => void;
}

type ReportTab = 'overview' | 'insights' | 'quality';

/** A report over thousands of books must not mount thousands of rows at once. */
const QUALITY_ROW_LIMIT = 60;

export function ReportPanel({ notify }: ReportPanelProps) {
    const [report, setReport] = useState<LibraryReport | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [tab, setTab] = useState<ReportTab>('overview');

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            setReport(await api.report());
        } catch (loadError) {
            const message = loadError instanceof Error ? loadError.message : 'ساخت گزارش ممکن نشد.';
            setError(message);
            notify(message, 'error');
        } finally {
            setLoading(false);
        }
    }, [notify]);

    useEffect(() => {
        void load();
    }, [load]);

    if (loading && !report) {
        return (
            <div className="panel-loading">
                <span className="spinner" />
                <p>در حال ساخت گزارش کتابخانه…</p>
            </div>
        );
    }

    if (error && !report) {
        return (
            <EmptyState
                icon="alert"
                title="گزارش ساخته نشد"
                description={error}
                action={<Button variant="primary" size="sm" icon="refresh" onClick={() => void load()}>تلاش دوباره</Button>}
            />
        );
    }

    if (!report) return null;

    const maxSection = Math.max(1, ...report.sections.map((item) => item.books));
    const maxAuthor = Math.max(1, ...report.authors.map((item) => item.books));
    const readPercent = report.totals.books
        ? Math.round((report.totals.read / report.totals.books) * 100)
        : 0;

    return (
        <div className="report-panel">
            <div className="report-toolbar">
                <div className="report-tabs" role="tablist">
                    {(
                        [
                            ['overview', 'نمای کلی'],
                            ['insights', 'موضوع و نویسنده'],
                            ['quality', 'کیفیت داده']
                        ] as [ReportTab, string][]
                    ).map(([value, label]) => (
                        <button
                            key={value}
                            type="button"
                            role="tab"
                            aria-selected={tab === value}
                            className={`report-tab ${tab === value ? 'is-active' : ''}`}
                            onClick={() => setTab(value)}
                        >
                            {label}
                        </button>
                    ))}
                </div>
                <span className="report-generated">
                    <Icon name="clock" size={13} /> {faDateTime(report.generatedAt)}
                </span>
                <Button variant="ghost" size="sm" icon="refresh" onClick={() => void load()}>
                    بازسازی
                </Button>
            </div>

            {tab === 'overview' ? (
                <div className="report-view">
                    <div className="report-stats">
                        <div className="report-stat">
                            <span className="report-stat__icon"><Icon name="books" size={18} /></span>
                            <strong>{faNumber(report.totals.books)}</strong>
                            <span>کتاب</span>
                        </div>
                        <div className="report-stat">
                            <span className="report-stat__icon"><Icon name="layers" size={18} /></span>
                            <strong>{faNumber(report.totals.sections)}</strong>
                            <span>موضوع</span>
                        </div>
                        <div className="report-stat">
                            <span className="report-stat__icon"><Icon name="user" size={18} /></span>
                            <strong>{faNumber(report.totals.authors)}</strong>
                            <span>نویسنده</span>
                        </div>
                        <div className="report-stat">
                            <span className="report-stat__icon"><Icon name="type" size={18} /></span>
                            <strong>{faNumber(report.totals.words)}</strong>
                            <span>کلمه</span>
                        </div>
                        <div className="report-stat">
                            <span className="report-stat__icon"><Icon name="file" size={18} /></span>
                            <strong>{faBytes(report.totals.bytes)}</strong>
                            <span>حجم کل</span>
                        </div>
                        <div className="report-stat">
                            <span className="report-stat__icon"><Icon name="check" size={18} /></span>
                            <strong>{faNumber(report.totals.read)}</strong>
                            <span>خوانده‌شده</span>
                        </div>
                    </div>

                    <div className="report-progress-card">
                        <div className="report-progress-card__head">
                            <span>
                                <Icon name="chart" size={16} /> پیشرفت مطالعه
                            </span>
                            <strong>{faNumber(readPercent)}٪</strong>
                        </div>
                        <div className="progress">
                            <span style={{ width: `${readPercent}%` }} />
                        </div>
                        <p>
                            {faNumber(report.totals.read)} کتاب خوانده شده و {faNumber(report.totals.unread)} کتاب در
                            انتظار مطالعه — {faNumber(report.totals.favorites)} کتاب محبوب.
                        </p>
                    </div>

                    <div className="report-columns">
                        <div className="report-card">
                            <h4><Icon name="layers" size={15} /> بزرگ‌ترین موضوع‌ها</h4>
                            <div className="report-bars">
                                {report.sections.slice(0, 6).map((section) => (
                                    <div key={section.name} className="report-bar">
                                        <span className="report-bar__label">{section.name}</span>
                                        <span className="report-bar__track">
                                            <span style={{ width: `${(section.books / maxSection) * 100}%` }} />
                                        </span>
                                        <em>{faNumber(section.books)}</em>
                                    </div>
                                ))}
                            </div>
                        </div>
                        <div className="report-card">
                            <h4><Icon name="user" size={15} /> پرکارترین نویسندگان</h4>
                            <div className="report-bars">
                                {report.authors.slice(0, 6).map((author) => (
                                    <div key={author.name} className="report-bar">
                                        <span className="report-bar__label">{author.name}</span>
                                        <span className="report-bar__track">
                                            <span style={{ width: `${(author.books / maxAuthor) * 100}%` }} />
                                        </span>
                                        <em>{faNumber(author.books)}</em>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    <div className="report-downloads">
                        <a className="btn btn--soft btn--sm" href="/api/report/download?format=csv" download>
                            <Icon name="download" size={15} /> خروجی CSV
                        </a>
                        <a className="btn btn--soft btn--sm" href="/api/report/download?format=json" download>
                            <Icon name="download" size={15} /> خروجی JSON
                        </a>
                        <span>گزارش شامل همهٔ کتاب‌ها، متادیتا و شاخص‌های محتواست.</span>
                    </div>
                </div>
            ) : null}

            {tab === 'insights' ? (
                <div className="report-view">
                    <div className="report-columns">
                        <div className="report-card">
                            <h4><Icon name="layers" size={15} /> توزیع موضوع‌ها</h4>
                            <div className="report-bars report-bars--dense">
                                {report.sections.map((section) => (
                                    <div key={section.name} className="report-bar">
                                        <span className="report-bar__label">{section.name}</span>
                                        <span className="report-bar__track">
                                            <span style={{ width: `${(section.books / maxSection) * 100}%` }} />
                                        </span>
                                        <em>{faNumber(section.books)} کتاب</em>
                                    </div>
                                ))}
                            </div>
                        </div>
                        <div className="report-card">
                            <h4><Icon name="user" size={15} /> نویسندگان</h4>
                            <div className="report-bars report-bars--dense">
                                {report.authors.slice(0, 12).map((author) => (
                                    <div key={author.name} className="report-bar">
                                        <span className="report-bar__label">{author.name}</span>
                                        <span className="report-bar__track">
                                            <span style={{ width: `${(author.books / maxAuthor) * 100}%` }} />
                                        </span>
                                        <em>{faNumber(author.books)} کتاب</em>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                    <div className="report-card">
                        <h4><Icon name="books" size={15} /> کتاب‌های شاخص</h4>
                        <div className="report-table">
                            <div className="report-table__head">
                                <span>کتاب</span>
                                <span>کلمه</span>
                                <span>صفحه</span>
                                <span>حجم</span>
                            </div>
                            {report.longest.map((row) => (
                                <div key={row.filename} className="report-table__row">
                                    <span title={row.filename}>{row.title}</span>
                                    <span>{faNumber(row.words)}</span>
                                    <span>{faNumber(row.pages)}</span>
                                    <span>{faBytes(row.bytes)}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            ) : null}

            {tab === 'quality' ? (
                <div className="report-view">
                    <div className="quality-grid">
                        <div className="quality-card quality-card--warn">
                            <strong>{faNumber(report.totals.missingMetadata)}</strong>
                            <span>کتاب با فیلد ناموجود</span>
                        </div>
                        <div className="quality-card quality-card--info">
                            <strong>{faNumber(report.totals.withoutMetadata)}</strong>
                            <span>کتاب بدون frontmatter</span>
                        </div>
                        <div className="quality-card quality-card--danger">
                            <strong>{faNumber(report.totals.duplicates)}</strong>
                            <span>گروه با عنوان تکراری</span>
                        </div>
                    </div>

                    <div className="report-card">
                        <h4><Icon name="alert" size={15} /> متادیتای ناقص</h4>
                        {report.incomplete.length ? (
                            <div className="quality-list">
                                {report.incomplete.slice(0, QUALITY_ROW_LIMIT).map((item) => (
                                    <div key={item.filename} className="quality-item">
                                        <span title={item.filename}>{item.title}</span>
                                        <em>بدون {item.missing.join('، ')}</em>
                                    </div>
                                ))}
                                {report.incomplete.length > QUALITY_ROW_LIMIT ? (
                                    <p className="report-empty">
                                        و {faNumber(report.incomplete.length - QUALITY_ROW_LIMIT)} کتاب دیگر؛ خروجی CSV
                                        فهرست کامل را دارد.
                                    </p>
                                ) : null}
                            </div>
                        ) : (
                            <p className="report-empty">همهٔ کتاب‌ها متادیتای ضروری دارند. عالی است.</p>
                        )}
                    </div>

                    <div className="report-card">
                        <h4><Icon name="copy" size={15} /> عنوان‌های تکراری</h4>
                        {report.duplicates.length ? (
                            <div className="quality-list">
                                {report.duplicates.slice(0, QUALITY_ROW_LIMIT).map((group, index) => (
                                    <div key={index} className="quality-item quality-item--stack">
                                        <em>گروه {faNumber(index + 1)}</em>
                                        {group.files.map((file) => (
                                            <span key={file} dir="ltr">{file}</span>
                                        ))}
                                    </div>
                                ))}
                                {report.duplicates.length > QUALITY_ROW_LIMIT ? (
                                    <p className="report-empty">
                                        و {faNumber(report.duplicates.length - QUALITY_ROW_LIMIT)} گروه دیگر؛ خروجی CSV
                                        فهرست کامل را دارد.
                                    </p>
                                ) : null}
                            </div>
                        ) : (
                            <p className="report-empty">عنوان تکراری پیدا نشد.</p>
                        )}
                    </div>

                    <div className="report-card">
                        <h4><Icon name="download" size={15} /> خروجی کامل</h4>
                        <div className="report-downloads">
                            <a className="btn btn--primary btn--sm" href="/api/report/download?format=csv" download>
                                <Icon name="download" size={15} /> دریافت CSV
                            </a>
                            <a className="btn btn--soft btn--sm" href="/api/report/download?format=json" download>
                                <Icon name="download" size={15} /> دریافت JSON
                            </a>
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
