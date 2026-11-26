/* Translation engine configuration.

   Keeps the machine/AI provider choice, credentials and tuning knobs in
   `storage/translation-config.json`. API keys never leave the server: the
   public payload only reports whether a key has been stored.

   Nothing about the translation itself is fixed here. The reader writes the
   prompt, the Markdown rules, the front-matter rules and the glossary, exactly
   as in the standalone sample translators; empty fields simply send nothing. */

import fs from 'node:fs';
import path from 'node:path';
import { STORAGE_DIR } from './config.js';

export type TranslateEngineId = 'google' | 'libretranslate' | 'deepl' | 'gemini' | 'openai' | 'anthropic';

/* The order in which a book is sent to the engine: page by page, or the
   structured order the reader asked for — first the book's own information
   (the front matter), then the table of contents, then the paragraphs. */
export type TranslateOrder = 'page' | 'structured';
export type TranslationPresetId = 'islamic-ar-fa' | 'literary-general' | 'technical-academic' | 'custom';
export type GeminiPlan = 'free' | 'paid';

export interface TranslationPreset {
    id: TranslationPresetId;
    label: string;
    description: string;
    prompt: string;
    rules: string;
    fmRules: string;
    glossary: string;
}

export interface TranslateConfig {
    engine: TranslateEngineId;
    endpoint: string;
    model: string;
    apiKey: string;
    geminiPlan: GeminiPlan;
    preset: TranslationPresetId;
    /* Free-form instructions written by the reader. */
    prompt: string;
    rules: string;
    fmRules: string;
    glossary: string;
    concurrency: number;
    order: TranslateOrder;
    bilingual: boolean;
}

export interface TranslateConfigPublic {
    engine: TranslateEngineId;
    endpoint: string;
    model: string;
    hasApiKey: boolean;
    geminiPlan: GeminiPlan;
    preset: TranslationPresetId;
    prompt: string;
    rules: string;
    fmRules: string;
    glossary: string;
    concurrency: number;
    order: TranslateOrder;
    bilingual: boolean;
}

export interface TranslateEngineInfo {
    id: TranslateEngineId;
    label: string;
    hint: string;
    kind: 'machine' | 'ai';
    needsKey: boolean;
    needsEndpoint: boolean;
    needsModel: boolean;
}

const CONFIG_FILE = path.join(STORAGE_DIR, 'translation-config.json');

/* The defaults are the instructions of the three sample translators, split into
   the same editable boxes they use: the main prompt, the Markdown rules, the
   front-matter rules and a glossary. */
export const DEFAULT_TRANSLATION_PROMPT = `ترجمهٔ فارسی معیار، علمی و روان. امانت کامل: افزودن، کاستن و توضیح ممنوع. خروجی فقط ترجمه با فرمت مارک‌داون ارسال‌شده باشد، بی‌هیچ مقدمه یا توضیحی.

اصطلاحات علوم قرآنی و اصول را با معادل جاافتادهٔ فارسی و یکسان برگردان، نه با آوانگاری. آیات و احادیث را ترجمه کن و ارجاع را با ضبط فارسی بنویس: (سورهٔ ص: ۲۹). نام اشخاص و کتاب‌ها را آوانگاری کن (ابن منظور، لسان العرب). نام کتاب در پراپرتی‌ها به معادل فارسی دقیق برگردان و نام عربی آن را با حروف فارسی در برچسب‌ها بنویس. پاورقی‌ها و ارجاع جلد/صفحه را کامل برگردان. پاراگراف‌بندی را نگه دار؛ فقط ترجمه را بنویس.`;

export const DEFAULT_MARKDOWN_RULES = `نقش: تو مترجم متون عربی علوم اسلامی (تفسیر، علوم قرآنی، اصول فقه) به فارسی هستی و ترجمه‌ات باید امانت‌دارانه و یکدست باشد.

قواعد فنی ساختار مارک‌داون (الزامی):
- ساختار مارک‌داون را عیناً حفظ کن: سطح عنوان‌ها (#)، فهرست‌ها، جدول‌ها، نقل‌قول‌ها (>‎)، خطوط جداکنندهٔ ---، پیوندها، درشت‌نویسی (**) و کج‌نویسی.
- برچسب‌هایی مانند <a id="p12"></a>، مِقصد پیوندها مانند (#p12) و نشانی‌های اینترنتی را هرگز تغییر نده و حذف نکن؛ در پیوندها فقط متن نمایشی را ترجمه کن.
- نشانگر صفحه مانند **ص ١٢** را با همان ساختار نگه دار و رقم را فارسی بنویس: **ص ۱۲**.
- نشانگر ==پاورقی‌ها== را دقیقاً با همین املا (با نیم‌فاصله) نگه دار و هر پاورقی را در همان جا و با همان شماره ترجمه کن؛ شمارهٔ ارجاع در متن و در پاورقی (١) را به (۱) بنویس.
- در جعبه‌های توضیح مانند > [!info] عنوان، نشانگر [!info] را نگه دار و فقط عنوان و متن را ترجمه کن.
- ارقام را فارسی بنویس (۰۱۲۳۴۵۶۷۸۹) و ارجاع جلد/صفحه را کامل برگردان: (٧/ ٢٤٧) → (۷/ ۲۴۷)؛ «ص:» → «ص:»؛ «ط:» → «چاپ:».
- هر آیه را ترجمه کن و درون همان آکولاد {…} همراه با شمارهٔ آیه بگذار؛ ارجاع آیه را با ضبط فارسی بنویس: [سورة ص: ٢٩] → (سورهٔ ص: ۲۹) و در پاورقی: سورة القيامة: ١٧ → سورهٔ قیامت: ۱۷.
- احادیث و آثار را ترجمه کن و ارجاع‌شان را کامل بیاور.
- ارجاع‌های کتاب‌شناختی را با قالبی یکسان بنویس: «يُنظر:» = «ر.ک:»، «للمؤلف» = «از …»؛ نام کتاب‌ها و اشخاص آوانگاری شود (مثلاً: لسان العرب، از ابن منظور (۵/ ۵۵)).
- عبارت‌های دعایی را به همان صیغه بنویس و چیزی نیفزا: صلى الله عليه وسلم = صلی‌الله‌علیه‌وسلم؛ رضي الله عنه = رضی‌الله‌عنه؛ رحمه الله = رحمه‌الله؛ عز وجل = عزّوجلّ.
- در مباحث لغوی که خودِ واژهٔ عربی موضوع بحث است (مثل ریشهٔ «فَسَر» یا تعریف لغوی)، واژه را با حروف فارسی و ضبط درست بنویس و معنا را همان‌گونه که در متن آمده ترجمه کن؛ چیزی از خود نیفزا.
- متن عربی ترجمه‌نشده باقی نگذار، مگر موارد بالا. خروجی را داخل بلوک کد قرار نده.`;

export const DEFAULT_FRONTMATTER_RULES = `این بخش فراداده‌های کتاب (Front matter) است که در قالب کلید/مقدار ارسال می‌شود:
- کلیدها و فیلدهای عددی/منطقی (مانند امتیاز، تعداد جلدها، خوانده شده) را دست نزن.
- مقدار «نام کتاب» را به معادل دقیق و رسای زبان مقصد ترجمه کن (نه آوانگاری). مثال: «كتاب التفسير بالبيان المتصل في القرآن الكريم» → «کتاب تفسیر به بیان متصل در قرآن کریم».
- مقدار «نویسنده» را آوانگاری کن (نام اشخاص). اگر مقدار ناقص یا نامعتبر بود (مثل «[»)، همان را بدون تغییر نگه دار.
- مقدار «جلد» و «بخش» و «معلومات نویسنده» را به زبان مقصد برگردان (المتن = متن).
- مقدارهای خالی («مترجم»، «بخش») خالی بمانند.
- در آرایهٔ «برچسب ها» موارد موجود را حفظ کن و در صورت وجود نام عربی کتاب، یک برچسب تازه از نام اصلی کتاب با الفبای فارسی (بدون ترجمه؛ ي→ی، ك→ک) بیفزا.`;

export const DEFAULT_GLOSSARY = `البيان المتصل = بیان متصل
المجمل = مجمل
المطلق = مطلق
العام = عام
المبيَّن = مبيَّن`;

export const TRANSLATION_PRESETS: TranslationPreset[] = [
    {
        id: 'islamic-ar-fa',
        label: 'متون علوم اسلامی (عربی ← فارسی)',
        description: 'مناسب کتب تفسیر، حدیث، فقه و اصول عربی با حفظ آیات، ارجاع‌ها و اصطلاحات تخصصی.',
        prompt: DEFAULT_TRANSLATION_PROMPT,
        rules: DEFAULT_MARKDOWN_RULES,
        fmRules: DEFAULT_FRONTMATTER_RULES,
        glossary: DEFAULT_GLOSSARY
    },
    {
        id: 'literary-general',
        label: 'عمومی، ادبی و رمان (روان و طبیعی)',
        description: 'مناسب کتاب‌های عمومی، داستان، تاریخ و آثار انگلیسی یا عربی با نثر طبیعی و خوش‌خوان.',
        prompt: `ترجمهٔ روان، طبیعی، ادبی و امانت‌دارانه. ساختار جمله‌ها را به نحو طبیعی زبان مقصد بازآرایی کن تا ترجمه رنگ‌وبوی ماشینی نداشته باشد، بی‌آنکه معنایی افزوده یا کاسته شود. لحن نویسنده و حس‌وحال متن اصلی را حفظ کن.`,
        rules: `قواعد فنی ساختار مارک‌داون (الزامی):
- ساختار مارک‌داون را عیناً حفظ کن: عنوان‌ها (#)، فهرست‌ها، نقل‌قول‌ها (>)، جدول‌ها، پیوندها، **درشت** و *کج*.
- نگهدارنده‌های ⟦0⟧، ⟦1⟧ و برچسب‌های HTML یا ارجاع‌های پاورقی را بدون تغییر در جای مناسب جمله قرار بده.
- نشانگر ==پاورقی‌ها== را دقیقاً با همین املا نگه دار.
- نام اشخاص و مکان‌های معروف را با ضبط جاافتاده بنویس و خروجی را داخل بلوک کد قرار نده.`,
        fmRules: `فراداده‌های کتاب (Front matter) را به زبان مقصد برگردان:
- نام کتاب را روان و دقیق ترجمه کن؛ نام نویسنده را با ضبط رایج در زبان مقصد آوانگاری کن.
- فیلدهای خالی را خالی نگه دار و مقدارهای عددی/منطقی را تغییر نده.`,
        glossary: ''
    },
    {
        id: 'technical-academic',
        label: 'علمی، فنی و دانشگاهی (دقیق)',
        description: 'مناسب مقالات پژوهشی، کتاب‌های علمی و مستندات فنی با حفظ دقیق اصطلاحات و کدها.',
        prompt: `ترجمهٔ دقیق، علمی و اصطلاحی. انسجام واژگانی را در سراسر متن حفظ کن و از معادل‌های علمی معتبر استفاده کن. در صورت لزوم برای نخستین کاربرد یک اصطلاح تخصصی، معادل انگلیسی آن را در پرانتز یا همان گونه که در متن است حفظ کن. افزودن یا حذف مطلب ممنوع است.`,
        rules: `قواعد فنی ساختار مارک‌داون (الزامی):
- تمامی ساختارهای مارک‌داون، جدول‌ها، فهرست‌ها، تیترها و بلوک‌های نقل‌قول را عیناً نگه دار.
- نگهدارنده‌های ⟦0⟧، ⟦1⟧، کدهای درون‌خطی، فرمول‌های ریاضی و پیوندها را دست‌نخورده و در موقعیت صحیح نگه دار.
- نشانگر ==پاورقی‌ها== را دقیقاً با همین املا نگه دار.
- ارقام فرمول‌ها و شناسه‌های فنی را تغییر نده و خروجی را در بلوک کد نگذار.`,
        fmRules: `فراداده‌های کتاب را دقیق و علمی ترجمه کن:
- عنوان کتاب، بخش و اطلاعات نویسنده را به زبان مقصد برگردان.
- نام نویسنده را آوانگاری یا حفظ کن و فیلدهای عددی/منطقی را دست نزن.`,
        glossary: ''
    },
    {
        id: 'custom',
        label: 'سفارشی (دلخواه کاربر)',
        description: 'تنظیمات آزاد بر اساس دستورها و واژه‌نامهٔ شخصی خودتان.',
        prompt: '',
        rules: '',
        fmRules: '',
        glossary: ''
    }
];

export const DEFAULT_TRANSLATE_CONFIG: TranslateConfig = {
    engine: 'google',
    endpoint: '',
    model: '',
    apiKey: '',
    geminiPlan: 'free',
    preset: 'islamic-ar-fa',
    prompt: DEFAULT_TRANSLATION_PROMPT,
    rules: DEFAULT_MARKDOWN_RULES,
    fmRules: DEFAULT_FRONTMATTER_RULES,
    glossary: DEFAULT_GLOSSARY,
    concurrency: 8,
    order: 'page',
    bilingual: false
};

export const ENGINE_CATALOG: TranslateEngineInfo[] = [
    {
        id: 'google',
        label: 'گوگل ترنسلیت (رایگان)',
        hint: 'بدون کلید و بدون تنظیم؛ سریع و برای هر زبانی. دستورهای متنی نمی‌پذیرد، پس فقط ترجمهٔ خام می‌دهد.',
        kind: 'machine',
        needsKey: false,
        needsEndpoint: false,
        needsModel: false
    },
    {
        id: 'libretranslate',
        label: 'LibreTranslate (خودمیزبان / آفلاین)',
        hint: 'سرویس آزاد روی همین رایانه یا شبکهٔ محلی؛ نشانی سرویس خودتان را بنویسید.',
        kind: 'machine',
        needsKey: false,
        needsEndpoint: true,
        needsModel: false
    },
    {
        id: 'deepl',
        label: 'DeepL',
        hint: 'کیفیت بالا برای زبان‌های اروپایی؛ کلید API لازم دارد.',
        kind: 'machine',
        needsKey: true,
        needsEndpoint: true,
        needsModel: false
    },
    {
        id: 'gemini',
        label: 'Google Gemini (رایگان)',
        hint: 'ترجمه با API رایگان جمنای از کلید سرور؛ درخواست‌ها به‌صورت ترتیبی و با مکث خودکار ارسال می‌شوند تا خطای محدودیت سرعت رخ ندهد.',
        kind: 'ai',
        needsKey: false,
        needsEndpoint: false,
        needsModel: true
    },
    {
        id: 'openai',
        label: 'هوش مصنوعی (سازگار با OpenAI)',
        hint: 'هر سرویس سازگار با OpenAI: OpenAI، OpenRouter، Groq، Gemini، DeepSeek، Mistral، Ollama، LM Studio، llama.cpp و هر نشانی دیگر.',
        kind: 'ai',
        needsKey: true,
        needsEndpoint: true,
        needsModel: true
    },
    {
        id: 'anthropic',
        label: 'Anthropic Claude',
        hint: 'مدل‌های Claude با API رسمی Anthropic؛ کلید از console.anthropic.com.',
        kind: 'ai',
        needsKey: true,
        needsEndpoint: true,
        needsModel: true
    }
];

let cached: TranslateConfig | null = null;

function positiveInt(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) return fallback;
    return Math.round(parsed);
}

function isEngine(value: unknown): value is TranslateEngineId {
    return typeof value === 'string' && ENGINE_CATALOG.some((engine) => engine.id === value);
}

function isOrder(value: unknown): value is TranslateOrder {
    return value === 'page' || value === 'structured';
}

function text(value: unknown, fallback: string): string {
    return typeof value === 'string' ? value.replace(/\r\n/g, '\n') : fallback;
}

function isPreset(value: unknown): value is TranslationPresetId {
    return typeof value === 'string' && TRANSLATION_PRESETS.some((preset) => preset.id === value);
}

function isGeminiPlan(value: unknown): value is GeminiPlan {
    return value === 'free' || value === 'paid';
}

export function normalizeTranslateConfig(input: unknown, base: TranslateConfig): TranslateConfig {
    const source =
        input && typeof input === 'object' && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : {};

    let apiKey = base.apiKey;
    if (source.clearApiKey === true) apiKey = '';
    else if (typeof source.apiKey === 'string' && source.apiKey.trim()) {
        apiKey = source.apiKey.trim();
    }

    const nextEngine = isEngine(source.engine) ? source.engine : base.engine;
    const rawModel = typeof source.model === 'string' ? source.model.trim() : base.model;
    const nextModel = nextEngine === 'gemini' && !rawModel ? 'gemini-4-hydrogen' : rawModel;

    /* Text and numbers are taken as the reader wrote them: no length limit on
       the instructions and no ceiling on concurrency. The size of each request
       is not a setting at all: it follows the order and the engine's capacity. */
    return {
        engine: nextEngine,
        endpoint: typeof source.endpoint === 'string' ? source.endpoint.trim() : base.endpoint,
        model: nextModel,
        apiKey,
        geminiPlan: isGeminiPlan(source.geminiPlan) ? source.geminiPlan : base.geminiPlan,
        preset: isPreset(source.preset) ? source.preset : base.preset,
        prompt: text(source.prompt, base.prompt),
        rules: text(source.rules, base.rules),
        fmRules: text(source.fmRules, base.fmRules),
        glossary: text(source.glossary, base.glossary),
        concurrency: positiveInt(source.concurrency, base.concurrency),
        order: isOrder(source.order) ? source.order : base.order,
        bilingual: typeof source.bilingual === 'boolean' ? source.bilingual : base.bilingual
    };
}

export async function readTranslateConfig(): Promise<TranslateConfig> {
    if (cached) return cached;
    try {
        const raw = await fs.promises.readFile(CONFIG_FILE, 'utf8');
        cached = normalizeTranslateConfig(JSON.parse(raw), DEFAULT_TRANSLATE_CONFIG);
    } catch {
        cached = { ...DEFAULT_TRANSLATE_CONFIG };
    }
    return cached;
}

export async function updateTranslateConfig(patch: unknown): Promise<TranslateConfig> {
    const current = await readTranslateConfig();
    const next = normalizeTranslateConfig(patch, current);
    await fs.promises.mkdir(STORAGE_DIR, { recursive: true });
    const tempFile = `${CONFIG_FILE}.${process.pid}.tmp`;
    await fs.promises.writeFile(tempFile, JSON.stringify(next, null, 2) + '\n', 'utf8');
    await fs.promises.rename(tempFile, CONFIG_FILE);
    cached = next;
    return next;
}

export function publicTranslateConfig(config: TranslateConfig): TranslateConfigPublic {
    return {
        engine: config.engine,
        endpoint: config.endpoint,
        model: config.model,
        hasApiKey: Boolean(config.apiKey),
        geminiPlan: config.geminiPlan,
        preset: config.preset,
        prompt: config.prompt,
        rules: config.rules,
        fmRules: config.fmRules,
        glossary: config.glossary,
        concurrency: config.concurrency,
        order: config.order,
        bilingual: config.bilingual
    };
}

export function translateCatalogs(): { engines: TranslateEngineInfo[]; presets: TranslationPreset[] } {
    return { engines: ENGINE_CATALOG, presets: TRANSLATION_PRESETS };
}
