import { useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { faNumber } from '../../lib/format';
import type {
    BatchMetadataChanges,
    BatchMetadataResult,
    BatchReplaceOptions,
    BatchReplaceResult,
    BookSummary
} from '../../types';
import { Icon } from '../icons';
import { Button, Field, TagInput, TextInput } from '../ui/Controls';
import { Modal } from '../ui/Modal';

interface BatchPanelProps {
    books: BookSummary[];
    selection: Set<string>;
    onSelectionChange: (selection: Set<string>) => void;
    notify: (message: string, tone?: 'success' | 'error' | 'info') => void;
    onApplied: () => Promise<void> | void;
}

const FIELD_KEYS = ['نام کتاب', 'نویسنده', 'مترجم', 'بخش', 'جلد', 'تعداد جلدها'] as const;

export function BatchPanel({ books, selection, onSelectionChange, notify, onApplied }: BatchPanelProps) {
    const [bookQuery, setBookQuery] = useState('');
    const [fields, setFields] = useState<Record<string, { enabled: boolean; value: string }>>({
        'نام کتاب': { enabled: false, value: '' },
        نویسنده: { enabled: false, value: '' },
        مترجم: { enabled: false, value: '' },
        بخش: { enabled: false, value: '' },
        'جلد': { enabled: false, value: '' },
        'تعداد جلدها': { enabled: false, value: '' }
    });
    const [authorInfo, setAuthorInfo] = useState('');
    const [authorMode, setAuthorMode] = useState<'append' | 'replace'>('append');
    const [addTags, setAddTags] = useState<string[]>([]);
    const [removeTags, setRemoveTags] = useState<string[]>([]);
    const [readValue, setReadValue] = useState('');
    const [ratingValue, setRatingValue] = useState('');
    const [metaStatus, setMetaStatus] = useState('');
    const [metaBusy, setMetaBusy] = useState(false);
    const [metaPreview, setMetaPreview] = useState<BatchMetadataResult | null>(null);

    const [searchText, setSearchText] = useState('');
    const [replaceText, setReplaceText] = useState('');
    const [regex, setRegex] = useState(false);
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [scope, setScope] = useState<BatchReplaceOptions['scope']>('both');
    const [replaceStatus, setReplaceStatus] = useState('');
    const [replaceBusy, setReplaceBusy] = useState(false);
    const [replacePreview, setReplacePreview] = useState<BatchReplaceResult | null>(null);
    const [confirmReplace, setConfirmReplace] = useState(false);

    const visibleBooks = useMemo(() => {
        const needle = bookQuery.trim().toLocaleLowerCase('fa');
        if (!needle) return books;
        return books.filter((book) => {
            const title = book.frontmatter['نام کتاب'] || book.filename;
            return title.toLocaleLowerCase('fa').includes(needle) || book.filename.toLocaleLowerCase('fa').includes(needle);
        });
    }, [books, bookQuery]);

    const setSelected = (filename: string, selected: boolean) => {
        const next = new Set(selection);
        if (selected) next.add(filename);
        else next.delete(filename);
        onSelectionChange(next);
    };

    const buildChanges = (): BatchMetadataChanges | null => {
        const setFields: Record<string, string> = {};
        for (const key of FIELD_KEYS) {
            if (fields[key].enabled && fields[key].value.trim()) setFields[key] = fields[key].value.trim();
        }
        const changes: BatchMetadataChanges = {
            setFields,
            addTags,
            removeTags
        };
        const info = authorInfo.trim();
        if (info) {
            if (authorMode === 'replace') setFields['معلومات نویسنده'] = info;
            else changes.appendFields = { 'معلومات نویسنده': info };
        }
        if (readValue === 'true' || readValue === 'false') changes.read = readValue === 'true';
        if (ratingValue !== '') changes.rating = Number(ratingValue);
        const empty =
            !Object.keys(setFields).length &&
            !changes.appendFields &&
            !changes.addTags.length &&
            !changes.removeTags.length &&
            changes.read === undefined &&
            changes.rating === undefined;
        if (empty) {
            setMetaStatus('حداقل یک تغییر را مشخص کنید.');
            return null;
        }
        return changes;
    };

    const runMetadata = async (dryRun: boolean) => {
        if (!selection.size) {
            setMetaStatus('ابتدا کتاب‌های موردنظر را انتخاب کنید.');
            return;
        }
        const changes = buildChanges();
        if (!changes) return;
        setMetaBusy(true);
        setMetaStatus(dryRun ? 'در حال بررسی تغییرات…' : 'در حال اعمال تغییرات…');
        try {
            const result = await api.batchMetadata([...selection], changes, dryRun);
            setMetaPreview(result);
            if (dryRun) {
                setMetaStatus(
                    `روی ${faNumber(result.updated)} کتاب تغییر اعمال می‌شود${
                        result.unchanged ? ` و ${faNumber(result.unchanged)} کتاب بی‌تغییر می‌ماند` : ''
                    }${result.failed.length ? `؛ ${faNumber(result.failed.length)} فایل ناموفق` : ''}.`
                );
            } else {
                setMetaStatus(
                    `${faNumber(result.updated)} کتاب به‌روزرسانی شد${
                        result.unchanged ? ` (${faNumber(result.unchanged)} بی‌تغییر)` : ''
                    }.`
                );
                notify(`متادیتای ${faNumber(result.updated)} کتاب به‌روزرسانی شد.`);
                await onApplied();
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'ویرایش گروهی انجام نشد.';
            setMetaStatus(message);
            notify(message, 'error');
        } finally {
            setMetaBusy(false);
        }
    };

    const runReplace = async (dryRun: boolean) => {
        if (!selection.size) {
            setReplaceStatus('ابتدا کتاب‌های موردنظر را انتخاب کنید.');
            return;
        }
        if (!searchText) {
            setReplaceStatus('متن یا الگوی جست‌وجو را وارد کنید.');
            return;
        }
        setReplaceBusy(true);
        setReplaceStatus(dryRun ? 'در حال جست‌وجو…' : 'در حال جایگزینی…');
        try {
            const result = await api.batchReplace(
                [...selection],
                searchText,
                replaceText,
                { regex, caseSensitive, scope },
                dryRun
            );
            setReplacePreview(result);
            if (dryRun) {
                setReplaceStatus(
                    result.totalMatches
                        ? `${faNumber(result.totalMatches)} مورد در ${faNumber(result.results.length)} کتاب پیدا شد.`
                        : 'موردی برای جایگزینی پیدا نشد.'
                );
            } else {
                setReplaceStatus(
                    `${faNumber(result.totalMatches)} مورد در ${faNumber(result.updated)} کتاب جایگزین شد.`
                );
                notify(`${faNumber(result.totalMatches)} مورد جایگزین شد.`);
                await onApplied();
                setConfirmReplace(false);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'جایگزینی گروهی انجام نشد.';
            setReplaceStatus(message);
            notify(message, 'error');
        } finally {
            setReplaceBusy(false);
        }
    };

    return (
        <div className="batch-panel">
            <div className="batch-layout">
                <section className="batch-side">
                    <div className="batch-side__head">
                        <h3>
                            <Icon name="books" size={16} /> انتخاب کتاب‌ها
                        </h3>
                        <span className="batch-count">
                            {faNumber(selection.size)} از {faNumber(books.length)} انتخاب
                        </span>
                    </div>
                    <TextInput
                        icon="search"
                        placeholder="جست‌وجو در فهرست کتاب‌ها…"
                        value={bookQuery}
                        onChange={(event) => setBookQuery(event.target.value)}
                    />
                    <div className="batch-select-actions">
                        <button type="button" onClick={() => onSelectionChange(new Set(books.map((book) => book.filename)))}>
                            همه
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                const next = new Set(selection);
                                visibleBooks.forEach((book) => next.add(book.filename));
                                onSelectionChange(next);
                            }}
                        >
                            نتایج
                        </button>
                        <button type="button" onClick={() => onSelectionChange(new Set())}>
                            پاک‌کردن
                        </button>
                    </div>
                    <div className="batch-book-list">
                        {visibleBooks.length ? (
                            visibleBooks.map((book) => {
                                const checked = selection.has(book.filename);
                                return (
                                    <label key={book.filename} className={`batch-book ${checked ? 'is-checked' : ''}`}>
                                        <input
                                            type="checkbox"
                                            checked={checked}
                                            onChange={(event) => setSelected(book.filename, event.target.checked)}
                                        />
                                        <span className="batch-book__box">
                                            {checked ? <Icon name="check" size={11} /> : null}
                                        </span>
                                        <span className="batch-book__title">
                                            {book.frontmatter['نام کتاب'] || book.filename}
                                        </span>
                                    </label>
                                );
                            })
                        ) : (
                            <p className="batch-empty">کتابی برای نمایش نیست.</p>
                        )}
                    </div>
                </section>

                <div className="batch-main">
                    <section className="batch-block">
                        <h3>
                            <Icon name="edit" size={16} /> ویرایش گروهی متادیتا
                        </h3>
                        <div className="batch-fields">
                            {FIELD_KEYS.map((key) => (
                                <div key={key} className={`batch-field ${fields[key].enabled ? 'is-enabled' : ''}`}>
                                    <label className="batch-field__toggle">
                                        <input
                                            type="checkbox"
                                            checked={fields[key].enabled}
                                            onChange={(event) =>
                                                setFields((current) => ({
                                                    ...current,
                                                    [key]: { ...current[key], enabled: event.target.checked }
                                                }))
                                            }
                                        />
                                        <span>{key}</span>
                                    </label>
                                    <TextInput
                                        placeholder={`مقدار تازه برای ${key}`}
                                        value={fields[key].value}
                                        disabled={!fields[key].enabled}
                                        onChange={(event) =>
                                            setFields((current) => ({
                                                ...current,
                                                [key]: { ...current[key], value: event.target.value }
                                            }))
                                        }
                                    />
                                </div>
                            ))}
                            <div className={`batch-field batch-field--wide ${authorInfo.trim() ? 'is-enabled' : ''}`}>
                                <label className="batch-field__toggle">
                                    <Icon name="user" size={13} />
                                    <span>معلومات نویسنده</span>
                                </label>
                                <textarea
                                    className="input"
                                    dir="auto"
                                    rows={3}
                                    placeholder="زندگینامه، آثار، سال تولد و وفات، یا هر توضیحی دربارهٔ نویسنده…"
                                    value={authorInfo}
                                    onChange={(event) => setAuthorInfo(event.target.value)}
                                />
                                <div className="batch-options">
                                    <label>
                                        <input
                                            type="radio"
                                            name="author-info-mode"
                                            checked={authorMode === 'append'}
                                            onChange={() => setAuthorMode('append')}
                                        />
                                        <span>افزودن به معلومات موجود</span>
                                    </label>
                                    <label>
                                        <input
                                            type="radio"
                                            name="author-info-mode"
                                            checked={authorMode === 'replace'}
                                            onChange={() => setAuthorMode('replace')}
                                        />
                                        <span>جایگزینی معلومات</span>
                                    </label>
                                </div>
                            </div>
                            <Field label="افزودن برچسب‌ها" hint="هر برچسب را بنویسید و Enter بزنید.">
                                <TagInput
                                    tags={addTags}
                                    onChange={setAddTags}
                                    commitOnComma={false}
                                    placeholder="برچسب بنویسید و Enter بزنید"
                                />
                            </Field>
                            <Field label="حذف برچسب‌ها" hint="هر برچسب را بنویسید و Enter بزنید.">
                                <TagInput
                                    tags={removeTags}
                                    onChange={setRemoveTags}
                                    commitOnComma={false}
                                    placeholder="برچسب بنویسید و Enter بزنید"
                                />
                            </Field>
                            <Field label="وضعیت مطالعه">
                                <select className="input select" value={readValue} onChange={(event) => setReadValue(event.target.value)}>
                                    <option value="">بدون تغییر</option>
                                    <option value="true">خوانده‌شده</option>
                                    <option value="false">خوانده‌نشده</option>
                                </select>
                            </Field>
                            <Field label="امتیاز محبوبیت">
                                <select className="input select" value={ratingValue} onChange={(event) => setRatingValue(event.target.value)}>
                                    <option value="">بدون تغییر</option>
                                    <option value="0">بدون امتیاز</option>
                                    {[1, 2, 3, 4, 5].map((value) => (
                                        <option key={value} value={value}>
                                            {value} ستاره
                                        </option>
                                    ))}
                                </select>
                            </Field>
                        </div>
                        <div className="batch-footer">
                            <Button variant="soft" size="sm" icon="eye" disabled={metaBusy} onClick={() => void runMetadata(true)}>
                                پیش‌نمایش
                            </Button>
                            <Button variant="primary" size="sm" icon="save" disabled={metaBusy} onClick={() => void runMetadata(false)}>
                                اعمال روی انتخاب‌شده‌ها
                            </Button>
                        </div>
                        {metaPreview?.dryRun ? (
                            <p className="batch-result">
                                <Icon name="info" size={14} /> {faNumber(metaPreview.updated)} کتاب تغییر می‌کند،{' '}
                                {faNumber(metaPreview.unchanged)} بی‌تغییر می‌ماند
                                {metaPreview.failed.length ? `، ${faNumber(metaPreview.failed.length)} ناموفق` : ''}.
                            </p>
                        ) : null}
                        {metaStatus ? <p className="batch-status">{metaStatus}</p> : null}
                    </section>

                    <section className="batch-block">
                        <h3>
                            <Icon name="search" size={16} /> جست‌وجو و جایگزینی گروهی
                        </h3>
                        <div className="batch-replace-row">
                            <TextInput
                                placeholder="متن یا الگوی جست‌وجو"
                                value={searchText}
                                onChange={(event) => {
                                    setSearchText(event.target.value);
                                    setReplacePreview(null);
                                }}
                            />
                            <TextInput
                                placeholder="متن جایگزین (خالی = حذف)"
                                value={replaceText}
                                onChange={(event) => setReplaceText(event.target.value)}
                            />
                        </div>
                        <div className="batch-options">
                            <label>
                                <input type="checkbox" checked={regex} onChange={(event) => setRegex(event.target.checked)} />
                                <span>حالت regex (گروه‌ها با $1)</span>
                            </label>
                            <label>
                                <input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} />
                                <span>حساس به حروف</span>
                            </label>
                            <select className="input select" value={scope} onChange={(event) => setScope(event.target.value as BatchReplaceOptions['scope'])}>
                                <option value="body">فقط متن</option>
                                <option value="metadata">فقط متادیتا</option>
                                <option value="both">متن و متادیتا</option>
                            </select>
                        </div>
                        <div className="batch-footer">
                            <Button variant="soft" size="sm" icon="eye" disabled={replaceBusy} onClick={() => void runReplace(true)}>
                                پیش‌نمایش
                            </Button>
                            <Button
                                variant="danger"
                                size="sm"
                                icon="bolt"
                                disabled={replaceBusy || !replacePreview?.totalMatches}
                                onClick={() => setConfirmReplace(true)}
                            >
                                اعمال جایگزینی
                            </Button>
                        </div>
                        {replaceStatus ? <p className="batch-status">{replaceStatus}</p> : null}
                        {replacePreview?.results.length ? (
                            <div className="batch-preview">
                                {replacePreview.results.map((item) => (
                                    <div key={item.filename} className="batch-preview__item">
                                        <strong>
                                            <span dir="ltr">{item.filename}</span>
                                            <em>{faNumber(item.matches)} مورد</em>
                                        </strong>
                                        {item.samples.map((sample, index) => (
                                            <small key={index}>{sample}</small>
                                        ))}
                                    </div>
                                ))}
                            </div>
                        ) : null}
                        <p className="batch-note">
                            <Icon name="info" size={14} /> تغییرات گروهی بدون ساخت نسخهٔ پشتیبان خودکار اعمال می‌شود؛
                            پیش از اعمال، پیش‌نمایش را ببینید.
                        </p>
                    </section>
                </div>
            </div>

            <Modal
                open={confirmReplace}
                title="تأیید جایگزینی گروهی"
                kicker="عملیات بازگشت‌پذیر با نسخهٔ ایمنی"
                icon="alert"
                size="sm"
                onClose={() => setConfirmReplace(false)}
                footer={
                    <>
                        <Button variant="soft" size="sm" onClick={() => setConfirmReplace(false)}>
                            انصراف
                        </Button>
                        <Button variant="danger" size="sm" icon="bolt" disabled={replaceBusy} onClick={() => void runReplace(false)}>
                            جایگزین کن
                        </Button>
                    </>
                }
            >
                <p className="confirm-text">
                    همهٔ موارد «{searchText}» در {faNumber(selection.size)} کتاب انتخاب‌شده جایگزین می‌شود. این عملیات
                    نسخهٔ پشتیبان نمی‌سازد؛ در صورت نیاز پیش از اجرا از بخش نسخه‌ها یک نسخهٔ دستی بسازید.
                </p>
            </Modal>
        </div>
    );
}
