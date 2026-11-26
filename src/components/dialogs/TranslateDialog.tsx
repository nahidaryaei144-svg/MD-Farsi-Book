import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { faNumber } from '../../lib/format';
import type {
    BookSummary,
    QueuedBookJob,
    TranslateConfigPublic,
    TranslateEngineInfo,
    TranslationEstimate,
    TranslationJob,
    TranslationMode,
    TranslationPreviewResult
} from '../../types';
import { Icon } from '../icons';
import { Button, Field, TextInput, Toggle } from '../ui/Controls';
import { Modal } from '../ui/Modal';

const LANGUAGES = [
    { value: 'fa', label: 'فارسی' },
    { value: 'en', label: 'انگلیسی' },
    { value: 'ar', label: 'عربی' },
    { value: 'ur', label: 'اردو' },
    { value: 'tr', label: 'ترکی استانبولی' },
    { value: 'az', label: 'ترکی آذربایجانی' },
    { value: 'ru', label: 'روسی' },
    { value: 'fr', label: 'فرانسوی' },
    { value: 'de', label: 'آلمانی' },
    { value: 'es', label: 'اسپانیایی' },
    { value: 'id', label: 'اندونزیایی' },
    { value: 'hi', label: 'هندی' },
    { value: 'zh', label: 'چینی' },
    { value: 'ja', label: 'ژاپنی' }
];

const DEEPL_SUPPORTED = new Set(['en', 'ar', 'tr', 'ru', 'fr', 'de', 'es', 'id', 'zh', 'ja']);

const STATUS_LABEL: Record<TranslationJob['status'], string> = {
    idle: 'آماده',
    running: 'در حال ترجمه',
    paused: 'موقتاً متوقف',
    done: 'پایان یافت',
    cancelled: 'لغو شد',
    error: 'خطا'
};

interface TranslateDialogProps {
    open: boolean;
    book: BookSummary | null;
    notify: (message: string, tone?: 'success' | 'error' | 'info') => void;
    onClose: () => void;
    onTranslated: (job: TranslationJob) => void | Promise<void>;
}

function faDuration(seconds: number | null): string {
    if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—';
    if (seconds < 60) return `${faNumber(Math.max(1, Math.round(seconds)))} ثانیه`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${faNumber(minutes)} دقیقه`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `${faNumber(hours)} ساعت${rest ? ` و ${faNumber(rest)} دقیقه` : ''}`;
}

export function TranslateDialog({ open, book, notify, onClose, onTranslated }: TranslateDialogProps) {
    const [target, setTarget] = useState('fa');
    const [bilingual, setBilingual] = useState(false);
    const [force, setForce] = useState(false);
    const [markTranslator, setMarkTranslator] = useState(true);
    const [pageRange, setPageRange] = useState('');
    const [autoGlossary, setAutoGlossary] = useState(false);
    const [estimate, setEstimate] = useState<TranslationEstimate | null>(null);
    const [estimateError, setEstimateError] = useState('');
    const [job, setJob] = useState<TranslationJob | null>(null);
    const [queue, setQueue] = useState<QueuedBookJob[]>([]);
    const [busy, setBusy] = useState(false);
    const [previewBusy, setPreviewBusy] = useState(false);
    const [preview, setPreview] = useState<TranslationPreviewResult | null>(null);
    const [glossaryBusy, setGlossaryBusy] = useState(false);
    const [error, setError] = useState('');
    const handledRef = useRef('');

    const [config, setConfig] = useState<TranslateConfigPublic | null>(null);
    const [engines, setEngines] = useState<TranslateEngineInfo[]>([]);

    const active = job && (job.status === 'running' || job.status === 'paused') ? job : null;
    const ownJob = job && book && job.filename === book.filename ? job : null;
    const foreignJob = active && book && active.filename !== book.filename ? active : null;
    const running = Boolean(active);

    const activeEngine = useMemo(
        () => (config ? engines.find((item) => item.id === config.engine) ?? null : null),
        [config, engines]
    );
    const keyMissing = Boolean(activeEngine?.needsKey && config && !config.hasApiKey);
    const deeplUnsupported = config?.engine === 'deepl' && !DEEPL_SUPPORTED.has(target.toLowerCase());

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        void (async () => {
            try {
                const payload = await api.translateConfig();
                if (cancelled) return;
                setConfig(payload.config);
                setEngines(payload.engines);
                setBilingual(Boolean(payload.config.bilingual));
            } catch {
                /* the dialog still works with the saved defaults */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open]);

    useEffect(() => {
        if (!open || !book) return;
        let cancelled = false;
        setError('');
        setPreview(null);
        void (async () => {
            try {
                const status = await api.translateStatus();
                if (cancelled) return;
                if (Array.isArray(status.queue)) setQueue(status.queue);
                if (!status.job) return;
                const current = status.job;
                const isActive = current.status === 'running' || current.status === 'paused';
                if (current.filename === book.filename) {
                    setJob(current);
                    setTarget(current.target);
                    setBilingual(Boolean(current.bilingual));
                    if (current.pageRange) setPageRange(current.pageRange);
                } else if (isActive) {
                    setJob(current);
                }
            } catch {
                /* the dialog still works when the status call fails */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, book?.filename]);

    useEffect(() => {
        if (!open || !book || running || deeplUnsupported) {
            if (deeplUnsupported) setEstimate(null);
            return;
        }
        let cancelled = false;
        setEstimateError('');
        const timer = setTimeout(async () => {
            try {
                const payload = await api.translateEstimate(
                    book.filename,
                    target,
                    force,
                    'translate',
                    pageRange.trim() || undefined
                );
                if (!cancelled) {
                    setEstimate(payload);
                    setEstimateError('');
                }
            } catch (estErr) {
                if (!cancelled) {
                    setEstimate(null);
                    setEstimateError(
                        estErr instanceof Error ? estErr.message : ''
                    );
                }
            }
        }, 250);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [open, book?.filename, target, force, pageRange, running, deeplUnsupported]);

    /* Live Server-Sent Events subscription with polling fallback */
    useEffect(() => {
        if (!open) return;
        let closed = false;
        let source: EventSource | null = null;
        let fallbackTimer: ReturnType<typeof setInterval> | null = null;

        const startFallbackPolling = () => {
            if (fallbackTimer) return;
            fallbackTimer = setInterval(async () => {
                if (closed) return;
                try {
                    const status = await api.translateStatus();
                    if (closed) return;
                    if (status.job) setJob(status.job);
                    if (Array.isArray(status.queue)) setQueue(status.queue);
                } catch {
                    /* keep last state */
                }
            }, 900);
        };

        try {
            source = new EventSource('/api/translate/events');
            source.onmessage = (event) => {
                if (closed) return;
                try {
                    const parsed = JSON.parse(event.data) as {
                        job?: TranslationJob | null;
                        queue?: QueuedBookJob[];
                    };
                    if (parsed.job !== undefined) setJob(parsed.job);
                    if (Array.isArray(parsed.queue)) setQueue(parsed.queue);
                } catch {
                    /* ignore malformed frame */
                }
            };
            source.onerror = () => {
                source?.close();
                source = null;
                startFallbackPolling();
            };
        } catch {
            startFallbackPolling();
        }

        return () => {
            closed = true;
            source?.close();
            if (fallbackTimer) clearInterval(fallbackTimer);
        };
    }, [open]);

    useEffect(() => {
        if (!open || !job || !book) return;
        if (job.filename !== book.filename) return;
        if (job.status !== 'done' && job.status !== 'cancelled') return;
        const key = `${job.id}:${job.status}`;
        if (handledRef.current === key) return;
        handledRef.current = key;
        setEstimate(null);
        void onTranslated(job);
    }, [open, job?.id, job?.status, book?.filename, onTranslated]);

    if (!book) return null;

    const percent = ownJob && ownJob.total ? Math.round((ownJob.done / ownJob.total) * 100) : 0;

    const start = async (mode: TranslationMode) => {
        if (keyMissing) {
            setError('کلید این مترجم تنظیم نشده است؛ از تنظیمات ← ترجمه و مترجم آن را وارد کنید.');
            return;
        }
        if (deeplUnsupported) {
            setError('موتور DeepL از این زبان مقصد پشتیبانی نمی‌کند.');
            return;
        }
        setBusy(true);
        setError('');
        try {
            const payload = await api.translateStart(book.filename, target, {
                force,
                markTranslator,
                mode,
                bilingual,
                pageRange: pageRange.trim() || undefined,
                autoGlossary
            });
            setJob(payload.job);
            handledRef.current = '';
            notify(
                mode === 'review'
                    ? 'بازبینی آغاز شد؛ بخش‌های ناقص خودکار ترجمه می‌شوند.'
                    : 'ترجمهٔ موازی آغاز شد؛ همه‌چیز خودکار پیش می‌رود.',
                'success'
            );
        } catch (startError) {
            const message = startError instanceof Error ? startError.message : 'آغاز ترجمه انجام نشد.';
            setError(message);
            notify(message, 'error');
        } finally {
            setBusy(false);
        }
    };

    const enqueueCurrent = async () => {
        setBusy(true);
        try {
            const result = await api.translateQueueAdd([
                {
                    filename: book.filename,
                    target,
                    mode: 'translate',
                    bilingual,
                    force,
                    markTranslator,
                    pageRange: pageRange.trim() || undefined,
                    autoGlossary
                }
            ]);
            setQueue(result.queue);
            notify('کتاب به صف ترجمه اضافه شد.', 'success');
        } catch (err) {
            notify(err instanceof Error ? err.message : 'افزودن به صف انجام نشد.', 'error');
        } finally {
            setBusy(false);
        }
    };

    const runPreview = async (page = 1) => {
        if (keyMissing) {
            setError('کلید این مترجم تنظیم نشده است.');
            return;
        }
        if (deeplUnsupported) {
            setError('موتور DeepL از این زبان مقصد پشتیبانی نمی‌کند.');
            return;
        }
        setPreviewBusy(true);
        setError('');
        try {
            const result = await api.translatePreview(book.filename, target, page);
            setPreview(result);
        } catch (prevErr) {
            const msg = prevErr instanceof Error ? prevErr.message : 'پیش‌نمایش انجام نشد.';
            setError(msg);
            notify(msg, 'error');
        } finally {
            setPreviewBusy(false);
        }
    };

    const runDiscoverGlossary = async () => {
        setGlossaryBusy(true);
        setError('');
        try {
            const res = await api.translateDiscoverGlossary(book.filename, target, true);
            if (res.terms.length) {
                notify(
                    `${faNumber(res.terms.length)} اصطلاح استخراج و ${faNumber(res.mergedCount)} مورد تازه به واژه‌نامه اضافه شد.`,
                    'success'
                );
                const cfg = await api.translateConfig();
                setConfig(cfg.config);
            } else {
                notify('اصطلاح تازه‌ای در نمونهٔ متن پیدا نشد.', 'info');
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'استخراج واژه‌نامه انجام نشد.';
            setError(msg);
            notify(msg, 'error');
        } finally {
            setGlossaryBusy(false);
        }
    };

    const runControl = async (action: 'pause' | 'resume' | 'cancel') => {
        setBusy(true);
        try {
            const payload =
                action === 'pause'
                    ? await api.translatePause()
                    : action === 'resume'
                      ? await api.translateResume()
                      : await api.translateCancel();
            if (payload.job) setJob(payload.job);
        } catch (controlError) {
            notify(controlError instanceof Error ? controlError.message : 'عملیات انجام نشد.', 'error');
        } finally {
            setBusy(false);
        }
    };

    const alreadyQueued = queue.some((q) => q.filename === book.filename);

    return (
        <Modal
            open={open}
            title={book.frontmatter['نام کتاب'] || book.filename}
            kicker="ترجمهٔ موازی و بازبینی خودکار"
            icon="globe"
            size="md"
            onClose={onClose}
            footer={
                <>
                    <span className="translate__foot-note">
                        با بستن این پنجره ترجمه در سرور ادامه می‌یابد و کتاب به‌روز می‌شود.
                    </span>
                    <Button variant="soft" size="sm" onClick={onClose}>
                        بستن
                    </Button>
                    {ownJob?.status === 'done' ? (
                        <Button
                            variant="primary"
                            size="sm"
                            icon="books"
                            onClick={() => {
                                void onTranslated(ownJob);
                                onClose();
                            }}
                        >
                            نمایش کتاب ترجمه‌شده
                        </Button>
                    ) : null}
                </>
            }
        >
            <div className="translate">
                <p className="translate__meta">
                    <Icon name="file" size={14} />
                    <bdi dir="ltr">{book.filename}</bdi>
                </p>

                {foreignJob ? (
                    <div className="translate__notice" role="status">
                        <Icon name="info" size={15} />
                        <span>
                            کتاب «{foreignJob.title}» در حال ترجمه است. می‌توانید این کتاب را به صف ترجمه بیفزایید تا
                            بلافاصله پس از پایان آن آغاز شود.
                        </span>
                        <div className="settings-actions">
                            <Button
                                variant="primary"
                                size="sm"
                                icon="plus"
                                disabled={busy || alreadyQueued || keyMissing || deeplUnsupported}
                                onClick={() => void enqueueCurrent()}
                            >
                                {alreadyQueued ? 'در صف است' : 'افزودن به صف ترجمه'}
                            </Button>
                            <Button variant="danger" size="sm" icon="close" onClick={() => void runControl('cancel')}>
                                لغو ترجمهٔ دیگر
                            </Button>
                        </div>
                    </div>
                ) : null}

                {ownJob &&
                (ownJob.status === 'running' ||
                    ownJob.status === 'paused' ||
                    ownJob.status === 'done' ||
                    ownJob.status === 'cancelled' ||
                    ownJob.status === 'error') ? (
                    <section className="translate__progress" aria-live="polite">
                        <div className="translate__head">
                            <span className="translate__percent">{faNumber(percent)}٪</span>
                            <span className={`translate__status is-${ownJob.status}`}>
                                {STATUS_LABEL[ownJob.status]}
                            </span>
                        </div>
                        <div
                            className="translate__bar"
                            role="progressbar"
                            aria-valuenow={percent}
                            aria-valuemin={0}
                            aria-valuemax={100}
                        >
                            <span style={{ width: `${percent}%` }} />
                        </div>

                        <div className="translate__badges">
                            <span className="translate__badge">
                                {ownJob.mode === 'review' ? 'بازبینی و ترمیم' : 'ترجمهٔ کامل'}
                            </span>
                            {ownJob.bilingual ? <span className="translate__badge">دوزبانه</span> : null}
                            {ownJob.pageRange ? (
                                <span className="translate__badge">صفحات: {ownJob.pageRange}</span>
                            ) : null}
                            <span className="translate__badge">{ownJob.engineLabel}</span>
                            <span className="translate__badge">
                                {ownJob.engine === 'gemini' && config?.geminiPlan !== 'paid'
                                    ? 'ارسال ترتیبی امن (مکث خودکار)'
                                    : `${faNumber(ownJob.parallel)} درخواست هم‌زمان`}
                            </span>
                            <span className="translate__badge">به {ownJob.targetLabel}</span>
                        </div>

                        <p className="translate__message">{ownJob.message}</p>

                        <div className="translate__stats">
                            <div className="translate__stat">
                                <span>ترجمه‌شده</span>
                                <strong>{faNumber(ownJob.translated)}</strong>
                            </div>
                            <div className="translate__stat">
                                <span>از حافظه</span>
                                <strong>{faNumber(ownJob.cached)}</strong>
                            </div>
                            <div className="translate__stat">
                                <span>{ownJob.mode === 'review' ? 'بررسی‌شده' : 'رد شده'}</span>
                                <strong>{faNumber(ownJob.mode === 'review' ? ownJob.inspected : ownJob.skipped)}</strong>
                            </div>
                            <div className="translate__stat">
                                <span>{ownJob.mode === 'review' ? 'ترمیم‌شده' : 'ناموفق'}</span>
                                <strong>{faNumber(ownJob.mode === 'review' ? ownJob.repaired : ownJob.failed)}</strong>
                            </div>
                            {ownJob.mode === 'review' ? (
                                <div className="translate__stat">
                                    <span>ناموفق</span>
                                    <strong>{faNumber(ownJob.failed)}</strong>
                                </div>
                            ) : null}
                            <div className="translate__stat">
                                <span>زمان باقی‌مانده</span>
                                <strong>{ownJob.status === 'running' ? faDuration(ownJob.etaSeconds) : '—'}</strong>
                            </div>
                            <div className="translate__stat">
                                <span>سرعت</span>
                                <strong>
                                    {ownJob.speed > 0 ? `${faNumber(Math.round(ownJob.speed * 60))} رشته/دقیقه` : '—'}
                                </strong>
                            </div>
                            {ownJob.usage && ownJob.usage.requests > 0 ? (
                                <>
                                    <div className="translate__stat">
                                        <span>توکن ورودی</span>
                                        <strong>{faNumber(ownJob.usage.inputTokens)}</strong>
                                    </div>
                                    <div className="translate__stat">
                                        <span>توکن خروجی</span>
                                        <strong>{faNumber(ownJob.usage.outputTokens)}</strong>
                                    </div>
                                </>
                            ) : null}
                        </div>

                        {ownJob.samples.length ? (
                            <div className="translate__samples">
                                {ownJob.samples.map((sample, index) => (
                                    <div className="translate__sample" key={`${sample.source.slice(0, 24)}-${index}`}>
                                        <small dir="auto">{sample.source}</small>
                                        <span dir="auto">{sample.translated}</span>
                                    </div>
                                ))}
                            </div>
                        ) : null}

                        {ownJob.snapshotId ? (
                            <p className="translate__foot-note">
                                نسخهٔ پشتیبان پیش از ترجمه ساخته شد: <bdi dir="ltr">{ownJob.snapshotId}</bdi>
                            </p>
                        ) : null}

                        <div className="settings-actions">
                            {ownJob.status === 'running' ? (
                                <Button variant="soft" size="sm" icon="clock" disabled={busy} onClick={() => void runControl('pause')}>
                                    توقف موقت
                                </Button>
                            ) : null}
                            {ownJob.status === 'paused' ? (
                                <Button variant="primary" size="sm" icon="bolt" disabled={busy} onClick={() => void runControl('resume')}>
                                    ادامهٔ ترجمه
                                </Button>
                            ) : null}
                            {ownJob.status === 'running' || ownJob.status === 'paused' ? (
                                <Button variant="danger" size="sm" icon="close" disabled={busy} onClick={() => void runControl('cancel')}>
                                    لغو
                                </Button>
                            ) : null}
                            {ownJob.status === 'done' || ownJob.status === 'cancelled' || ownJob.status === 'error' ? (
                                <Button
                                    variant="soft"
                                    size="sm"
                                    icon="refresh"
                                    disabled={busy || running}
                                    onClick={() => {
                                        setJob(null);
                                        setEstimate(null);
                                    }}
                                >
                                    ترجمهٔ دوباره
                                </Button>
                            ) : null}
                        </div>
                    </section>
                ) : null}

                {!ownJob || ownJob.status === 'idle' ? (
                    <section className="translate__settings">
                        <div className="translate__row">
                            <Field label="زبان مقصد">
                                <select className="input" value={target} onChange={(event) => setTarget(event.target.value)}>
                                    {LANGUAGES.map((language) => (
                                        <option key={language.value} value={language.value}>
                                            {language.label}
                                        </option>
                                    ))}
                                </select>
                            </Field>
                            <Field label="بازهٔ صفحات (اختیاری)" hint="مثال: ۱-۱۰، ۱۵ (خالی = کل کتاب)">
                                <TextInput
                                    value={pageRange}
                                    placeholder="کل کتاب"
                                    onChange={(event) => setPageRange(event.target.value)}
                                />
                            </Field>
                        </div>

                        <div className="translate__engine-card">
                            <span className="translate__engine-icon">
                                <Icon name="globe" size={17} />
                            </span>
                            <div className="translate__engine-body">
                                <strong>{activeEngine?.label ?? estimate?.engineLabel ?? 'گوگل ترنسلیت'}</strong>
                                <small>
                                    {config?.engine === 'gemini' ? (
                                        <>
                                            <bdi dir="ltr">{config.model || 'gemini-4-hydrogen'}</bdi> ·{' '}
                                            {config.geminiPlan === 'paid' ? 'پلن پولی (هم‌زمان)' : 'پلن رایگان (ترتیبی امن)'}
                                        </>
                                    ) : (
                                        <>
                                            {config?.model ? <bdi dir="ltr">{config.model}</bdi> : 'بدون کلید و تنظیم'}
                                            {config?.hasApiKey ? ' · کلید ذخیره شده' : ''}
                                        </>
                                    )}
                                </small>
                            </div>
                            <span className="translate__engine-hint">تغییر از تنظیمات ← ترجمه و مترجم</span>
                        </div>

                        {deeplUnsupported ? (
                            <p className="translate__notice is-error" role="alert">
                                <Icon name="alert" size={15} />
                                <span>
                                    موتور DeepL از زبان مقصد انتخاب‌شده پشتیبانی نمی‌کند؛ برای ترجمه به فارسی یا اردو از
                                    جمنای، OpenAI، Claude یا گوگل ترنسلیت استفاده کنید.
                                </span>
                            </p>
                        ) : null}

                        <Toggle
                            checked={bilingual}
                            onChange={setBilingual}
                            label="ترجمهٔ دوزبانه (حفظ متن اصلی همراه با ترجمه)"
                            hint="هر بند، عنوان، جدول و پاورقی به‌صورت دو‌زبانه ذخیره می‌شود؛ ظاهر و رنگ هر دو زبان از تنظیمات قابل تغییر است."
                        />
                        <Toggle
                            checked={force}
                            onChange={setForce}
                            label="نادیده‌گرفتن حافظهٔ ترجمه"
                            hint="با روشن‌بودن، حتی بخش‌های سالم دوباره ترجمه می‌شوند."
                        />
                        <Toggle
                            checked={markTranslator}
                            onChange={setMarkTranslator}
                            label="ثبت «مترجم» در مشخصات کتاب"
                            hint="اگر فیلد مترجم خالی باشد، «ترجمهٔ ماشینی» نوشته می‌شود."
                        />
                        {activeEngine?.kind === 'ai' ? (
                            <Toggle
                                checked={autoGlossary}
                                onChange={setAutoGlossary}
                                label="استخراج خودکار واژه‌نامه پیش از ترجمه"
                                hint="نام‌های خاص و اصطلاحات کلیدی ابتدای کتاب یکبار استخراج می‌شوند تا همهٔ بخش‌ها یکدست ترجمه شوند."
                            />
                        ) : null}

                        {keyMissing ? (
                            <p className="translate__notice is-error" role="alert">
                                <Icon name="alert" size={15} />
                                <span>
                                    کلید این مترجم تنظیم نشده است. از تنظیمات ← «ترجمه و مترجم» کلید را وارد کنید یا یکی از
                                    مدل‌های آفلاین را انتخاب کنید.
                                </span>
                            </p>
                        ) : null}

                        <div className="translate__estimate">
                            <Icon name="sparkles" size={15} />
                            {estimateError ? (
                                <span>{estimateError}</span>
                            ) : estimate ? (
                                <span>
                                    {faNumber(estimate.segments)} رشته بررسی شد؛ <b>{faNumber(estimate.candidates)}</b> بخش
                                    باید ترجمه یا ترمیم شود
                                    {estimate.suspicious
                                        ? ` (${faNumber(estimate.suspicious)} بخش نیمه‌ترجمه یا ناسالم)`
                                        : ''}
                                    {estimate.cached ? ` و ${faNumber(estimate.cached)} بخش از حافظه می‌آید` : ''}
                                    {estimate.skipped
                                        ? `؛ ${faNumber(estimate.skipped)} بخش غیرمتنی، خارج از بازه یا از قبل ترجمه‌شده است`
                                        : ''}
                                    .
                                </span>
                            ) : (
                                <span>در حال بررسی متن کتاب…</span>
                            )}
                        </div>

                        <div className="translate__tools-row">
                            <Button
                                variant="soft"
                                size="sm"
                                icon="eye"
                                disabled={previewBusy || busy || keyMissing || deeplUnsupported}
                                onClick={() => void runPreview(preview?.page ?? 1)}
                            >
                                {previewBusy ? 'در حال ترجمهٔ نمونه…' : 'پیش‌نمایش یک صفحه (آزمایشی)'}
                            </Button>
                            {activeEngine?.kind === 'ai' ? (
                                <Button
                                    variant="soft"
                                    size="sm"
                                    icon="sparkles"
                                    disabled={glossaryBusy || busy || keyMissing}
                                    onClick={() => void runDiscoverGlossary()}
                                >
                                    {glossaryBusy ? 'در حال استخراج…' : 'استخراج واژه‌نامه به تنظیمات'}
                                </Button>
                            ) : null}
                        </div>

                        {preview ? (
                            <div className="translate__preview">
                                <div className="translate__preview-head">
                                    <strong>
                                        پیش‌نمایش صفحهٔ {faNumber(preview.page)} از {faNumber(preview.totalPages)}
                                    </strong>
                                    <div className="settings-actions">
                                        <Button
                                            variant="soft"
                                            size="sm"
                                            disabled={previewBusy || preview.page <= 1}
                                            onClick={() => void runPreview(preview.page - 1)}
                                        >
                                            صفحهٔ قبل
                                        </Button>
                                        <Button
                                            variant="soft"
                                            size="sm"
                                            disabled={previewBusy || preview.page >= preview.totalPages}
                                            onClick={() => void runPreview(preview.page + 1)}
                                        >
                                            صفحهٔ بعد
                                        </Button>
                                    </div>
                                </div>
                                {preview.items.length ? (
                                    <div className="translate__samples">
                                        {preview.items.map((item, idx) => (
                                            <div className="translate__sample" key={idx}>
                                                <small dir="auto">{item.source}</small>
                                                <span dir="auto">{item.translated}</span>
                                                <em className={item.qaOk ? 'is-ok' : 'is-warn'}>
                                                    {item.qaOk ? 'کیفیت: سالم' : `هشدار کیفیت: ${item.qaIssue || 'بررسی شود'}`}
                                                </em>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <p className="translate__message">در این صفحه متن قابل ترجمه‌ای پیدا نشد.</p>
                                )}
                            </div>
                        ) : null}

                        <div className="translate__actions">
                            <Button
                                variant="primary"
                                size="md"
                                icon="globe"
                                disabled={busy || Boolean(foreignJob) || keyMissing || deeplUnsupported || Boolean(estimateError)}
                                onClick={() => void start('translate')}
                            >
                                {busy ? 'در حال آماده‌سازی…' : 'شروع ترجمهٔ موازی'}
                            </Button>
                            <Button
                                variant="soft"
                                size="md"
                                icon="refresh"
                                disabled={busy || Boolean(foreignJob) || keyMissing || deeplUnsupported || Boolean(estimateError)}
                                onClick={() => void start('review')}
                            >
                                بازبینی و ترمیم ترجمهٔ موجود
                            </Button>
                        </div>

                        {error ? (
                            <p className="translate__notice is-error" role="alert">
                                <Icon name="alert" size={15} />
                                <span>{error}</span>
                            </p>
                        ) : null}

                        <p className="translate__engine-note">
                            <Icon name="shield" size={14} />
                            <span>
                                متن مستقیم به مترجم انتخابی شما فرستاده می‌شود؛ برای مدل‌های محلی هیچ داده‌ای از این رایانه
                                بیرون نمی‌رود. کلید API فقط در سرور برنامه ذخیره می‌شود و به مرورگر برنمی‌گردد.
                            </span>
                        </p>
                    </section>
                ) : null}

                {queue.length ? (
                    <div className="translate__queue">
                        <div className="translate__queue-head">
                            <strong>صف ترجمه ({faNumber(queue.length)} کتاب)</strong>
                            <button
                                type="button"
                                className="settings-inline-link"
                                onClick={() => void api.translateQueueClear().then((r) => setQueue(r.queue))}
                            >
                                پاک‌کردن صف
                            </button>
                        </div>
                        {queue.map((item) => (
                            <div key={item.id} className="translate__queue-item">
                                <span>
                                    {item.title} <small>({item.targetLabel})</small>
                                </span>
                                <button
                                    type="button"
                                    className="settings-inline-link"
                                    onClick={() =>
                                        void api.translateQueueRemove(item.id).then((r) => setQueue(r.queue))
                                    }
                                >
                                    حذف
                                </button>
                            </div>
                        ))}
                    </div>
                ) : null}

                <p className="translate__foot-note">
                    نشانه‌های Markdown، پیوندها، جدول‌ها و کد دست‌نخورده می‌مانند و پیش از شروع یک نسخهٔ پشتیبان کامل از همین
                    کتاب ساخته می‌شود. دکمهٔ بازبینی، تمام فایل را سریع می‌گردد و تنها جمله‌های ترجمه‌نشده یا ناسالم را ترجمه
                    می‌کند.
                </p>
            </div>
        </Modal>
    );
}
