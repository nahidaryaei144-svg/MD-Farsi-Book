import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { faNumber } from '../../lib/format';
import type {
    GeminiPlan,
    TranslateEngineId,
    TranslateEngineInfo,
    TranslationPreset,
    TranslationPresetId
} from '../../types';
import { Icon } from '../icons';
import { Button, Field, TextInput, Toggle } from '../ui/Controls';

interface TranslationSettingsSectionProps {
    notify: (message: string, tone?: 'success' | 'error' | 'info') => void;
}

const INSTRUCTION_FIELDS: {
    key: 'prompt' | 'rules' | 'fmRules' | 'glossary';
    label: string;
    hint: string;
    rows: number;
}[] = [
    {
        key: 'prompt',
        label: 'دستور ترجمه (پرامت)',
        hint: 'همان پرامت اصلی نمونه‌های مترجم: لحن، امانت‌داری و شیوهٔ برگردان. هر چه بنویسید بی‌کم‌وکاست به مدل می‌رسد.',
        rows: 9
    },
    {
        key: 'rules',
        label: 'قواعد ساختار مارک‌داون',
        hint: 'قواعد نگه‌داشتن عنوان‌ها، پیوندها، جدول‌ها، پاورقی‌ها، آیات و ارجاع‌ها.',
        rows: 14
    },
    {
        key: 'fmRules',
        label: 'قواعد پراپرتی‌ها (Front matter)',
        hint: 'دستور ترجمهٔ بلوک YAML ابتدای فایل: کلیدها دست‌نخورده، مقدارها ترجمه.',
        rows: 9
    },
    {
        key: 'glossary',
        label: 'واژه‌نامهٔ اصطلاحات',
        hint: 'هر سطر یک جفت: عربی = فارسی. برای یکدستی اصطلاح‌ها؛ خالی بگذارید تا واژه‌نامه‌ای فرستاده نشود.',
        rows: 7
    }
];

export function TranslationSettingsSection({ notify }: TranslationSettingsSectionProps) {
    const [engines, setEngines] = useState<TranslateEngineInfo[]>([]);
    const [engineId, setEngineId] = useState<TranslateEngineId>('google');
    const [endpoint, setEndpoint] = useState('');
    const [model, setModel] = useState('');
    const [apiKey, setApiKey] = useState('');
    const [savedKey, setSavedKey] = useState(false);
    const [savedEngine, setSavedEngine] = useState<TranslateEngineId>('google');
    const [geminiPlan, setGeminiPlan] = useState<GeminiPlan>('free');
    const [concurrency, setConcurrency] = useState(8);
    const [order, setOrder] = useState<'page' | 'structured'>('page');
    const [bilingual, setBilingual] = useState(false);
    const [presets, setPresets] = useState<TranslationPreset[]>([]);
    const [presetId, setPresetId] = useState<TranslationPresetId>('islamic-ar-fa');
    const [texts, setTexts] = useState({
        prompt: '',
        rules: '',
        fmRules: '',
        glossary: ''
    });
    const [busy, setBusy] = useState(false);
    const [testing, setTesting] = useState(false);
    const [result, setResult] = useState('');
    const [error, setError] = useState('');

    const engine = engines.find((item) => item.id === engineId);
    const activePreset = presets.find((item) => item.id === presetId);
    const hasKey = savedKey && engineId === savedEngine;

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const payload = await api.translateConfig();
                if (cancelled) return;
                setEngines(payload.engines);
                setPresets(payload.presets ?? []);
                setEngineId(payload.config.engine);
                setSavedEngine(payload.config.engine);
                setEndpoint(payload.config.endpoint);
                setModel(payload.config.model);
                setSavedKey(payload.config.hasApiKey);
                setGeminiPlan(payload.config.geminiPlan ?? 'free');
                setConcurrency(payload.config.concurrency);
                setOrder(payload.config.order);
                setBilingual(Boolean(payload.config.bilingual));
                setPresetId(payload.config.preset ?? 'islamic-ar-fa');
                setTexts({
                    prompt: payload.config.prompt,
                    rules: payload.config.rules,
                    fmRules: payload.config.fmRules,
                    glossary: payload.config.glossary
                });
            } catch {
                if (!cancelled) setError('خواندن تنظیمات مترجم انجام نشد.');
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const applyPreset = (id: TranslationPresetId) => {
        setPresetId(id);
        const found = presets.find((item) => item.id === id);
        if (!found || id === 'custom') return;
        setTexts({
            prompt: found.prompt,
            rules: found.rules,
            fmRules: found.fmRules,
            glossary: found.glossary
        });
    };

    const pickEngine = (id: TranslateEngineId) => {
        setEngineId(id);
        setApiKey('');
        setResult('');
        setError('');
        if (id === 'gemini' && !/^gemini-/i.test(model.trim())) {
            setModel('gemini-4-hydrogen');
        } else if (id !== 'gemini' && /^gemini-/i.test(model.trim())) {
            setModel('');
        }
    };

    const persist = async (announce: boolean) => {
        if (engine?.needsKey && !apiKey.trim() && !hasKey) {
            throw new Error('برای این مترجم کلید API لازم است.');
        }
        if (engine?.needsEndpoint && !endpoint.trim()) {
            throw new Error('نشانی سرویس را بنویسید.');
        }
        if (engine?.needsModel && !model.trim()) {
            throw new Error('نام مدل را بنویسید.');
        }
        const payload = await api.saveTranslateConfig({
            engine: engineId,
            endpoint: endpoint.trim(),
            model: model.trim(),
            geminiPlan,
            preset: presetId,
            prompt: texts.prompt,
            rules: texts.rules,
            fmRules: texts.fmRules,
            glossary: texts.glossary,
            concurrency,
            order,
            bilingual,
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            ...(engineId !== savedEngine && !apiKey.trim() ? { clearApiKey: true } : {})
        });
        setSavedEngine(engineId);
        setSavedKey(payload.config.hasApiKey);
        setApiKey('');
        setResult('');
        if (announce) notify('تنظیمات مترجم ذخیره شد.', 'success');
    };

    const save = async () => {
        setBusy(true);
        setError('');
        setResult('');
        try {
            await persist(true);
        } catch (saveError) {
            setError(saveError instanceof Error ? saveError.message : 'ذخیرهٔ تنظیمات انجام نشد.');
        } finally {
            setBusy(false);
        }
    };

    const test = async () => {
        setTesting(true);
        setError('');
        setResult('');
        try {
            await persist(false);
            const outcome = await api.translateTest();
            setResult(
                `اتصال برقرار شد · ${outcome.engineLabel}${outcome.model ? ` (${outcome.model})` : ''} · «${outcome.sample}» · ${faNumber(outcome.milliseconds)} میلی‌ثانیه`
            );
        } catch (testError) {
            setError(testError instanceof Error ? testError.message : 'آزمایش اتصال انجام نشد.');
        } finally {
            setTesting(false);
        }
    };

    const endpointLabel =
        engineId === 'libretranslate'
            ? 'آدرس سرویس LibreTranslate'
            : engineId === 'deepl'
              ? 'آدرس DeepL'
              : engineId === 'anthropic'
                ? 'آدرس سرویس Claude'
                : 'آدرس سرویس (OpenAI-Compatible)';

    return (
        <section className="settings-section">
            <h3 className="settings-section__title">
                <Icon name="globe" size={16} /> ترجمه و مترجم
            </h3>

            {engines.length === 0 ? (
                <p className="settings-block__label">در حال خواندن تنظیمات مترجم…</p>
            ) : (
                <>
                    <Field
                        label="نوع سرویس"
                        hint={
                            (engine?.hint ?? '') +
                            (engine?.kind === 'machine'
                                ? ' این سرویس‌ها پرامت نمی‌پذیرند؛ متن دعوتی که نوشته‌اید فقط برای مدل‌های هوش مصنوعی فرستاده می‌شود.'
                                : '')
                        }
                    >
                        <select
                            className="input select"
                            value={engineId}
                            onChange={(event) => pickEngine(event.target.value as TranslateEngineId)}
                        >
                            {engines.map((item) => (
                                <option key={item.id} value={item.id}>
                                    {item.label}
                                </option>
                            ))}
                        </select>
                    </Field>

                    {engine?.needsModel ? (
                        engineId === 'gemini' ? (
                            <>
                                <Field
                                    label="مدل جمنای"
                                    hint="مدل‌های جمنای متصل به کلید سرور."
                                >
                                    <select
                                        className="input select"
                                        dir="ltr"
                                        value={model || 'gemini-4-hydrogen'}
                                        onChange={(event) => setModel(event.target.value)}
                                    >
                                        <option value="gemini-4-hydrogen">gemini-4-hydrogen (پیشنهادی — متعادل و دقیق)</option>
                                        <option value="gemini-3.1-flash-lite">gemini-3.1-flash-lite (سبک و سریع‌تر)</option>
                                    </select>
                                </Field>
                                <Field
                                    label="نوع پلن جمنای"
                                    hint={
                                        geminiPlan === 'paid'
                                            ? 'در پلن پولی (Pay-as-you-go)، مکث اجباری ۴.۵ ثانیه‌ای برداشته می‌شود و درخواست‌ها با هم‌زمانی تنظیم‌شده ارسال می‌شوند.'
                                            : 'در پلن رایگان، درخواست‌ها به‌صورت ترتیبی با مکث خودکار ارسال می‌شوند تا سهمیهٔ دقیقه پر نشود.'
                                    }
                                >
                                    <select
                                        className="input select"
                                        value={geminiPlan}
                                        onChange={(event) => setGeminiPlan(event.target.value as GeminiPlan)}
                                        aria-label="نوع پلن جمنای"
                                    >
                                        <option value="free">رایگان (ارسال ترتیبی با مکث خودکار)</option>
                                        <option value="paid">پولی (هم‌زمان و بدون مکث اجباری)</option>
                                    </select>
                                </Field>
                            </>
                        ) : (
                            <Field
                                label="نام مدل"
                                hint="نام دقیق مدل در آن سرویس؛ هر نامی که سرویس شما می‌شناسد. فهرست از پیش تعیین‌شده‌ای در کار نیست."
                            >
                                <TextInput
                                    dir="ltr"
                                    value={model}
                                    placeholder="مثلاً gpt-4o-mini یا qwen2.5:7b"
                                    onChange={(event) => setModel(event.target.value)}
                                />
                            </Field>
                        )
                    ) : null}

                    {engine?.needsEndpoint ? (
                        <Field
                            label={endpointLabel}
                            hint="نشانی پایهٔ سرویس؛ مسیر تکمیل خودکار است. برای سرویس محلی، آدرس همین رایانه را بنویسید."
                        >
                            <TextInput
                                dir="ltr"
                                value={endpoint}
                                placeholder={
                                    engineId === 'libretranslate'
                                        ? 'http://127.0.0.1:5000'
                                        : engineId === 'deepl'
                                          ? 'https://api-free.deepl.com'
                                          : engineId === 'anthropic'
                                            ? 'https://api.anthropic.com'
                                            : 'https://api.openai.com/v1'
                                }
                                onChange={(event) => setEndpoint(event.target.value)}
                            />
                        </Field>
                    ) : null}

                    {engine && (engine.needsKey || engineId === 'libretranslate') ? (
                        <Field
                            label="کلید API"
                            hint={
                                hasKey
                                    ? 'کلید در سرور ذخیره شده است؛ برای تغییر، کلید تازه را بنویسید.'
                                    : engine.needsKey
                                      ? 'کلید فقط در همین رایانه و در سرور برنامه ذخیره می‌شود.'
                                      : 'برای سرویس‌های عمومی لازم نیست؛ خالی بگذارید.'
                            }
                        >
                            <TextInput
                                dir="ltr"
                                type="password"
                                autoComplete="off"
                                value={apiKey}
                                placeholder={hasKey ? '•••••••• (ذخیره شده)' : engine.needsKey ? 'کلید API' : 'اختیاری'}
                                onChange={(event) => setApiKey(event.target.value)}
                            />
                        </Field>
                    ) : null}

                    <Field
                        label="روند ترجمه"
                        hint="صفحه‌به‌صفحه: هر صفحهٔ کتاب (متن میان دو خط ---) یک‌جا فرستاده می‌شود و اندازهٔ دسته‌ای در کار نیست. ساختاری: نخست معلومات کتاب (پیشانی فایل)، سپس فهرست مطالب و در پایان پاراگراف‌ها؛ اندازهٔ هر دسته خودکار و در همان روند انتخاب می‌شود."
                    >
                        <select
                            className="input select"
                            value={order}
                            onChange={(event) => setOrder(event.target.value as 'page' | 'structured')}
                            aria-label="روند ترجمه"
                        >
                            <option value="page">صفحه‌به‌صفحه (هر صفحه یک درخواست)</option>
                            <option value="structured">
                                ساختاری: معلومات کتاب ← فهرست مطالب ← پاراگراف‌ها
                            </option>
                        </select>
                    </Field>

                    <Toggle
                        checked={bilingual}
                        onChange={setBilingual}
                        label="ترجمهٔ دوزبانه (پیش‌فرض)"
                        hint="با فعال‌بودن، متن زبان اصلی کنار ترجمه حفظ می‌شود و در کتاب‌خوان می‌توانید رنگ و ظاهر هر دو را جداگانه تنظیم کنید."
                    />

                    <div className="translate__row">
                        <Field
                            label="موازی‌سازی (درخواست هم‌زمان)"
                            hint={
                                engineId === 'gemini' && geminiPlan !== 'paid'
                                    ? 'برای پلن رایگان جمنای به‌صورت خودکار ۱ (ارسال ترتیبی با مکث ۴.۵ ثانیه‌ای) اعمال می‌شود؛ با انتخاب پلن پولی عدد زیر فعال می‌شود.'
                                    : 'در صورت دریافت خطای محدودیت نرخ (429)، کنترل‌گر تطبیقی به‌طور خودکار هم‌زمانی را کاهش و پس از پایداری دوباره افزایش می‌دهد.'
                            }
                        >
                            {engineId === 'gemini' && geminiPlan !== 'paid' ? (
                                <input
                                    type="text"
                                    className="input"
                                    value="۱ (ارسال ترتیبی امن برای جمنای رایگان)"
                                    readOnly
                                    disabled
                                    aria-label="تعداد درخواست‌های هم‌زمان برای جمنای"
                                />
                            ) : (
                                <input
                                    type="number"
                                    className="input ltr"
                                    min={1}
                                    step={1}
                                    value={concurrency}
                                    onChange={(event) => setConcurrency(Number(event.target.value))}
                                    aria-label="تعداد درخواست‌های هم‌زمان"
                                />
                            )}
                        </Field>
                        <Field
                            label="اندازهٔ هر دسته"
                            hint="دیگر تنظیمی ندارد: در روند ساختاری هر درخواست تا ظرفیت مترجم پر می‌شود و در روند صفحه‌به‌صفحه هر صفحه یک‌جا می‌رود."
                        >
                            <input
                                className="input ltr"
                                type="text"
                                value="خودکار"
                                readOnly
                                aria-label="اندازهٔ هر دسته"
                            />
                        </Field>
                    </div>

                    {presets.length ? (
                        <Field
                            label="پروفایل آمادهٔ پرامپت"
                            hint={
                                activePreset?.description ||
                                'با انتخاب پروفایل، دستورها و قواعد متناسب با نوع کتاب پر می‌شوند؛ سپس می‌توانید هر بخش را دلخواه ویرایش کنید.'
                            }
                        >
                            <select
                                className="input select"
                                value={presetId}
                                onChange={(event) => applyPreset(event.target.value as TranslationPresetId)}
                                aria-label="پروفایل آمادهٔ پرامپت"
                            >
                                {presets.map((preset) => (
                                    <option key={preset.id} value={preset.id}>
                                        {preset.label}
                                    </option>
                                ))}
                            </select>
                        </Field>
                    ) : null}

                    {INSTRUCTION_FIELDS.map((field) => (
                        <Field key={field.key} label={field.label} hint={field.hint}>
                            <textarea
                                className="input prompt-input"
                                dir="auto"
                                rows={field.rows}
                                value={texts[field.key]}
                                placeholder="خالی بگذارید تا هیچ دستوری فرستاده نشود…"
                                onChange={(event) => {
                                    setPresetId('custom');
                                    setTexts((current) => ({ ...current, [field.key]: event.target.value }));
                                }}
                            />
                        </Field>
                    ))}

                    <p className="settings-block__label">
                        در ترجمه به فارسی، یکسان‌سازی خودکار حروف («ي/ك» ← «ی/ک»)، اصلاح نیم‌فاصله‌های استاندارد
                        («می‌»، «‌ها») و نشانه‌گذاری فارسی پس از ترجمه روی متن پیاده‌سازی می‌شود؛ کدها، نشانی‌ها و آیات داخل
                        آکولاد {'{…}'} دست‌نخورده می‌مانند.
                    </p>

                    <div className="settings-actions">
                        <Button
                            variant="primary"
                            size="sm"
                            icon="check"
                            disabled={busy || testing}
                            onClick={() => void save()}
                        >
                            {busy ? 'در حال ذخیره…' : 'ذخیرهٔ تنظیمات مترجم'}
                        </Button>
                        <Button
                            variant="soft"
                            size="sm"
                            icon="bolt"
                            disabled={busy || testing}
                            onClick={() => void test()}
                        >
                            {testing ? 'در حال آزمایش…' : 'آزمایش اتصال'}
                        </Button>
                    </div>

                    {result ? (
                        <p className="translator-result" role="status">
                            <Icon name="check" size={14} />
                            <span>{result}</span>
                        </p>
                    ) : null}
                    {error ? (
                        <p className="translator-result is-error" role="alert">
                            <Icon name="alert" size={14} />
                            <span>{error}</span>
                        </p>
                    ) : null}

                    <p className="translate__engine-note">
                        <Icon name="shield" size={14} />
                        <span>
                            هر سرویس سازگار با OpenAI (OpenAI، OpenRouter، Groq، Gemini، DeepSeek، Mistral، Ollama،
                            LM Studio، llama.cpp و هر نشانی دیگر) با همان آدرس و نام مدل کار می‌کند. کلید API فقط در
                            سرور برنامه ذخیره می‌شود و به مرورگر برنمی‌گردد.
                        </span>
                    </p>
                </>
            )}
        </section>
    );
}
