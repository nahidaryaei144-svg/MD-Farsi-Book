import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { faNumber } from '../../lib/format';
import type {
    BookSummary,
    TranslateConfigPublic,
    TranslateEngineInfo,
    TranslationEstimate,
    TranslationJob,
    TranslationMode
} from '../../types';
import { Icon } from '../icons';
import { Button, Field, Toggle } from '../ui/Controls';
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
    const [estimate, setEstimate] = useState<TranslationEstimate | null>(null);
    const [job, setJob] = useState<TranslationJob | null>(null);
    const [busy, setBusy] = useState(false);
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
        void (async () => {
            try {
                const status = await api.translateStatus();
                if (cancelled || !status.job) return;
                const current = status.job;
                const isActive = current.status === 'running' || current.status === 'paused';
                if (current.filename === book.filename) {
                    setJob(current);
                    setTarget(current.target);
                    setBilingual(Boolean(current.bilingual));
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
        if (!open || !book || running) return;
        let cancelled = false;
        const timer = setTimeout(async () => {
            try {
                const payload = await api.translateEstimate(book.filename, target, force, 'review');
                if (!cancelled) setEstimate(payload);
            } catch {
                if (!cancelled) setEstimate(null);
            }
        }, 220);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [open, book?.filename, target, force, running]);

    useEffect(() => {
        if (!open || !job) return;
        if (job.status !== 'running' && job.status !== 'paused') return;
        let stopped = false;
        const timer = setInterval(async () => {
            try {
                const status = await api.translateStatus();
                if (stopped) return;
                if (status.job) setJob(status.job);
            } catch {
                /* keep the last known progress */
            }
        }, 750);
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [open, job?.id, job?.status]);

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
        setBusy(true);
        setError('');
        try {
            const payload = await api.translateStart(book.filename, target, {
                force,
                markTranslator,
                mode,
                bilingual
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
                            کتاب «{foreignJob.title}» در حال ترجمه است. تا پایان یا لغو آن، ترجمهٔ این کتاب آغاز
                            نمی‌شود.
                        </span>
                        <Button variant="danger" size="sm" icon="close" onClick={() => void runControl('cancel')}>
                            لغو ترجمهٔ دیگر
                        </Button>
                    </div>
                ) : null}

                {ownJob && (ownJob.status === 'running' || ownJob.status === 'paused' || ownJob.status === 'done' || ownJob.status === 'cancelled' || ownJob.status === 'error') ? (
                    <section className="translate__progress" aria-live="polite">
                        <div className="translate__head">
                            <span className="translate__percent">{faNumber(percent)}٪</span>
                            <span className={`translate__status is-${ownJob.status}`}>
                                {STATUS_LABEL[ownJob.status]}
                            </span>
                        </div>
                        <div className="translate__bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
                            <span style={{ width: `${percent}%` }} />
                        </div>

                        <div className="translate__badges">
                            <span className="translate__badge">
                                {ownJob.mode === 'review' ? 'بازبینی و ترمیم' : 'ترجمهٔ کامل'}
                            </span>
                            {ownJob.bilingual ? <span className="translate__badge">دوزبانه</span> : null}
                            <span className="translate__badge">{ownJob.engineLabel}</span>
                            <span className="translate__badge">
                                {ownJob.engine === 'gemini'
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
                        <Field label="زبان مقصد">
                            <select className="input" value={target} onChange={(event) => setTarget(event.target.value)}>
                                {LANGUAGES.map((language) => (
                                    <option key={language.value} value={language.value}>
                                        {language.label}
                                    </option>
                                ))}
                            </select>
                        </Field>

                        <div className="translate__engine-card">
                            <span className="translate__engine-icon">
                                <Icon name="globe" size={17} />
                            </span>
                            <div className="translate__engine-body">
                                <strong>{activeEngine?.label ?? estimate?.engineLabel ?? 'گوگل ترنسلیت'}</strong>
                                <small>
                                    {config?.engine === 'gemini' ? (
                                        <>
                                            <bdi dir="ltr">{config.model || 'gemini-4-hydrogen'}</bdi> · کلید سرور و کنترل سرعت خودکار
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

                        {keyMissing ? (
                            <p className="translate__notice is-error" role="alert">
                                <Icon name="alert" size={15} />
                                <span>
                                    کلید این مترجم تنظیم نشده است. از تنظیمات ← «ترجمه و مترجم» کلید را وارد کنید یا
                                    یکی از مدل‌های آفلاین را انتخاب کنید.
                                </span>
                            </p>
                        ) : null}

                        <div className="translate__estimate">
                            <Icon name="sparkles" size={15} />
                            {estimate ? (
                                <span>
                                    {faNumber(estimate.segments)} رشته بررسی شد؛ <b>{faNumber(estimate.candidates)}</b> بخش
                                    باید ترجمه یا ترمیم شود
                                    {estimate.suspicious
                                        ? ` (${faNumber(estimate.suspicious)} بخش نیمه‌ترجمه یا ناسالم)`
                                        : ''}
                                    {estimate.cached ? ` و ${faNumber(estimate.cached)} بخش از حافظه می‌آید` : ''}
                                    {estimate.skipped ? `؛ ${faNumber(estimate.skipped)} بخش از قبل به زبان مقصد است` : ''}.
                                </span>
                            ) : (
                                <span>در حال بررسی متن کتاب…</span>
                            )}
                        </div>

                        <div className="translate__actions">
                            <Button
                                variant="primary"
                                size="md"
                                icon="globe"
                                disabled={busy || Boolean(foreignJob) || keyMissing}
                                onClick={() => void start('translate')}
                            >
                                {busy ? 'در حال آماده‌سازی…' : 'شروع ترجمهٔ موازی'}
                            </Button>
                            <Button
                                variant="soft"
                                size="md"
                                icon="refresh"
                                disabled={busy || Boolean(foreignJob) || keyMissing}
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
                                متن مستقیم به مترجم انتخابی شما فرستاده می‌شود؛ برای مدل‌های محلی هیچ داده‌ای از این
                                رایانه بیرون نمی‌رود. کلید API فقط در سرور برنامه ذخیره می‌شود و به مرورگر برنمی‌گردد.
                            </span>
                        </p>
                    </section>
                ) : null}

                <p className="translate__foot-note">
                    نشانه‌های Markdown، پیوندها، جدول‌ها و کد دست‌نخورده می‌مانند و پیش از شروع یک نسخهٔ پشتیبان کامل
                    از همین کتاب ساخته می‌شود. دکمهٔ بازبینی، تمام فایل را سریع می‌گردد و تنها جمله‌های ترجمه‌نشده یا
                    ناسالم را ترجمه می‌کند.
                </p>
            </div>
        </Modal>
    );
}
