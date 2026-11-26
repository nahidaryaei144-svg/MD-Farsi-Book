/* Translation providers.

   Every engine exposes the same `translate(texts, target, label, abort, context)`
   contract, so the job runner can fan out batches in parallel regardless of
   whether the work is done by a machine service or a language model.
   Providers are created per job, so a config change never mutates a running
   translation. */

import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type { TranslateConfig, TranslateEngineId } from './translate-config.js';

const MAX_RETRIES = 4;
const GOOGLE_BATCH_ENDPOINT =
    'https://translate.googleapis.com/translate_a/t?client=gtx&sl=auto&dt=t&tl=';
const GOOGLE_SINGLE_ENDPOINT =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&tl=';

export class FatalEngineError extends Error {}

class BatchSplitError extends Error {}

class RetryableError extends Error {
    retryAfterMs?: number;
    constructor(message: string, retryAfterMs?: number) {
        super(message);
        this.retryAfterMs = retryAfterMs;
    }
}

export interface TokenUsageDelta {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    requests: number;
}

export interface TranslateBatchContext {
    sourceLabel?: string;
    bookTitle?: string;
    chapterHeading?: string;
    previousPairs?: { source: string; translated: string }[];
    tmHints?: { source: string; translated: string }[];
    mode?: 'body' | 'frontmatter';
    onUsage?: (delta: TokenUsageDelta) => void;
    onRateLimit?: (retryAfterMs?: number) => void;
}

/* ----------------------------- Engine Language Matrix ----------------------------- */

const LANGUAGE_ALIASES: Record<string, string> = {
    fa: 'fa',
    'fa-ir': 'fa',
    persian: 'fa',
    farsi: 'fa',
    'فارسی': 'fa',
    en: 'en',
    'en-us': 'en-US',
    'en-gb': 'en-GB',
    english: 'en',
    'انگلیسی': 'en',
    ar: 'ar',
    arabic: 'ar',
    'عربی': 'ar',
    ur: 'ur',
    urdu: 'ur',
    'اردو': 'ur',
    tr: 'tr',
    turkish: 'tr',
    'ترکی': 'tr',
    'ترکی استانبولی': 'tr',
    az: 'az',
    azerbaijani: 'az',
    'ترکی آذربایجانی': 'az',
    ru: 'ru',
    russian: 'ru',
    'روسی': 'ru',
    fr: 'fr',
    french: 'fr',
    'فرانسوی': 'fr',
    de: 'de',
    german: 'de',
    'آلمانی': 'de',
    es: 'es',
    spanish: 'es',
    'اسپانیایی': 'es',
    id: 'id',
    indonesian: 'id',
    'اندونزیایی': 'id',
    hi: 'hi',
    hindi: 'hi',
    'هندی': 'hi',
    zh: 'zh',
    'zh-cn': 'zh-CN',
    'zh-tw': 'zh-TW',
    chinese: 'zh',
    'چینی': 'zh',
    ja: 'ja',
    japanese: 'ja',
    'ژاپنی': 'ja',
    pt: 'pt',
    'pt-br': 'pt-BR',
    'pt-pt': 'pt-PT',
    portuguese: 'pt',
    'پرتغالی': 'pt',
    it: 'it',
    italian: 'it',
    'ایتالیایی': 'it',
    ko: 'ko',
    korean: 'ko',
    'کره‌ای': 'ko'
};

const DEEPL_SUPPORTED = new Set([
    'AR', 'BG', 'CS', 'DA', 'DE', 'EL', 'EN', 'EN-GB', 'EN-US', 'ES', 'ET',
    'FI', 'FR', 'HE', 'HU', 'ID', 'IT', 'JA', 'KO', 'LT', 'LV', 'NB', 'NL',
    'PL', 'PT', 'PT-BR', 'PT-PT', 'RO', 'RU', 'SK', 'SL', 'SV', 'TH', 'TR',
    'UK', 'VI', 'ZH', 'ZH-HANS', 'ZH-HANT'
]);

export function normalizeLanguageCode(target: string): string {
    const trimmed = target.trim();
    if (!trimmed) return 'fa';
    const lower = trimmed.toLowerCase();
    return LANGUAGE_ALIASES[lower] ?? trimmed;
}

export function resolveEngineTargetLang(engine: TranslateEngineId, target: string): string {
    const canonical = normalizeLanguageCode(target);
    if (engine === 'deepl') {
        const upper = canonical.toUpperCase();
        if (upper === 'EN') return 'EN-US';
        if (upper === 'PT') return 'PT-PT';
        if (upper === 'ZH-CN') return 'ZH-HANS';
        if (upper === 'ZH-TW') return 'ZH-HANT';
        if (!DEEPL_SUPPORTED.has(upper)) {
            throw new FatalEngineError(
                `موتور DeepL از زبان مقصد «${target}» پشتیبانی نمی‌کند؛ برای فارسی از جمنای، OpenAI، Claude یا گوگل استفاده کنید.`
            );
        }
        return upper;
    }
    if (engine === 'google' || engine === 'libretranslate') {
        const lower = canonical.toLowerCase();
        if (engine === 'libretranslate') {
            return lower.split('-')[0] || 'fa';
        }
        return canonical;
    }
    return canonical;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepAbortable(ms: number, shouldAbort: () => boolean): Promise<void> {
    let remaining = ms;
    while (remaining > 0) {
        if (shouldAbort()) throw new Error('cancelled');
        const chunk = Math.min(250, remaining);
        await sleep(chunk);
        remaining -= chunk;
    }
}

function parseRetryAfterMs(response: Response): number | undefined {
    const raw = response.headers.get('retry-after');
    if (!raw) return undefined;
    const trimmed = raw.trim();
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
        const seconds = Number(trimmed);
        if (Number.isFinite(seconds) && seconds > 0) {
            return Math.min(90_000, Math.max(500, Math.ceil(seconds * 1000)));
        }
    }
    const parsedDate = Date.parse(trimmed);
    if (Number.isFinite(parsedDate)) {
        const diff = parsedDate - Date.now();
        if (diff > 0) return Math.min(90_000, Math.max(500, diff));
    }
    return undefined;
}

async function fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number
): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function withRetry<T>(
    run: () => Promise<T>,
    shouldAbort: () => boolean,
    onRateLimit?: (retryAfterMs?: number) => void
): Promise<T> {
    let lastError: Error = new Error('سرویس ترجمه پاسخ نداد.');
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        if (shouldAbort()) throw new Error('cancelled');
        try {
            return await run();
        } catch (error) {
            lastError = error instanceof Error ? error : lastError;
            if (error instanceof FatalEngineError || error instanceof BatchSplitError) throw lastError;
            const retryAfter = error instanceof RetryableError ? error.retryAfterMs : undefined;
            if (error instanceof RetryableError) onRateLimit?.(retryAfter);
            if (attempt === MAX_RETRIES) break;
            const backoff =
                retryAfter ??
                Math.min(12_000, 600 * Math.pow(2, attempt)) + Math.round(Math.random() * 320);
            await sleepAbortable(backoff, shouldAbort);
        }
    }
    throw lastError;
}

/** Immersive Translate's budgeted recovery: when a whole batch is rejected
    (one malformed item, an over-long request or a protocol violation), split
    it in half a couple of times instead of re-sending every item separately.
    When reduced to a single item, falls back to `singleRequest` if supplied. */
async function budgetedRecovery(
    texts: string[],
    request: (batch: string[]) => Promise<string[]>,
    shouldAbort: () => boolean,
    singleRequest?: (text: string) => Promise<string>,
    maxRecovery = 3
): Promise<string[]> {
    const results: string[] = new Array(texts.length).fill('');
    let budget = maxRecovery;

    const recover = async (indices: number[]): Promise<void> => {
        if (!indices.length || shouldAbort()) return;
        const batch = indices.map((index) => texts[index]);
        try {
            const values = await request(batch);
            indices.forEach((index, position) => {
                results[index] = String(values[position] ?? '');
            });
            return;
        } catch (error) {
            if (shouldAbort() || error instanceof FatalEngineError) throw error;
            if (indices.length === 1) {
                if (!singleRequest) return;
                try {
                    results[indices[0]] = await singleRequest(batch[0]);
                } catch (singleError) {
                    if (singleError instanceof FatalEngineError) throw singleError;
                }
                return;
            }
            const isSizeSplit = error instanceof BatchSplitError;
            if (!isSizeSplit && budget <= 0) {
                /* Even if split budget ran out, try singleRequest for small remainders
                   if available, rather than silently dropping items. */
                if (singleRequest && indices.length <= 4) {
                    for (const index of indices) {
                        if (shouldAbort()) break;
                        try {
                            results[index] = await singleRequest(texts[index]);
                        } catch (singleError) {
                            if (singleError instanceof FatalEngineError) throw singleError;
                        }
                    }
                }
                return;
            }
            if (!isSizeSplit) budget -= 1;
            const middle = Math.ceil(indices.length / 2);
            await recover(indices.slice(0, middle));
            await recover(indices.slice(middle));
        }
    };

    await recover(texts.map((_, index) => index));
    return results;
}

export interface TranslationEngine {
    id: string;
    label: string;
    limits: { maxItems: number; maxChars: number };
    translate(
        texts: string[],
        target: string,
        targetLabel: string,
        shouldAbort: () => boolean,
        context?: TranslateBatchContext
    ): Promise<string[]>;
}

/* ----------------------------- google ----------------------------- */

function extractGoogleBatch(data: unknown, expected: number): string[] | null {
    if (!Array.isArray(data) || data.length !== expected) return null;
    const results: string[] = [];
    for (const item of data) {
        if (Array.isArray(item)) results.push(String(item[0] ?? ''));
        else if (typeof item === 'string') results.push(item);
        else if (item && typeof item === 'object' && 'trans' in item) {
            results.push(String((item as { trans: unknown }).trans ?? ''));
        } else results.push('');
    }
    return results;
}

async function googleBatch(
    texts: string[],
    target: string,
    shouldAbort: () => boolean,
    onRateLimit?: (ms?: number) => void
): Promise<string[]> {
    const body = new URLSearchParams();
    for (const text of texts) body.append('q', text);
    const tl = resolveEngineTargetLang('google', target);

    return withRetry(
        async () => {
            const response = await fetchWithTimeout(
                GOOGLE_BATCH_ENDPOINT + encodeURIComponent(tl),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                    body
                },
                25_000
            );
            if (response.status === 400) {
                throw new FatalEngineError('گوگل این درخواست را نپذیرفت؛ کد زبان مقصد یا اندازهٔ متن را بررسی کنید.');
            }
            if (response.status === 429) {
                throw new RetryableError(
                    'سرویس ترجمه موقتاً درخواست‌ها را محدود کرده است.',
                    parseRetryAfterMs(response) ?? 4000
                );
            }
            if (response.status >= 500) {
                throw new Error(`سرویس ترجمه خطای ${response.status} داد.`);
            }
            if (!response.ok) throw new FatalEngineError(`سرویس ترجمه پاسخ ${response.status} داد.`);

            const parsed = extractGoogleBatch(await response.json(), texts.length);
            if (!parsed) throw new Error('پاسخ سرویس ترجمه با درخواست هم‌خوانی نداشت.');
            return parsed;
        },
        shouldAbort,
        onRateLimit
    );
}

async function googleSingle(
    text: string,
    target: string,
    shouldAbort: () => boolean,
    onRateLimit?: (ms?: number) => void
): Promise<string> {
    const tl = resolveEngineTargetLang('google', target);
    return withRetry(
        async () => {
            const response = await fetchWithTimeout(
                `${GOOGLE_SINGLE_ENDPOINT}${encodeURIComponent(tl)}&q=${encodeURIComponent(text)}`,
                { method: 'GET' },
                25_000
            );
            if (response.status === 400) throw new FatalEngineError('گوگل این متن را نپذیرفت.');
            if (response.status === 429) {
                throw new RetryableError(
                    'سرویس ترجمه موقتاً پاسخ نمی‌دهد.',
                    parseRetryAfterMs(response) ?? 4000
                );
            }
            if (response.status >= 500) {
                throw new Error('سرویس ترجمه موقتاً پاسخ نمی‌دهد.');
            }
            if (!response.ok) throw new FatalEngineError(`سرویس ترجمه پاسخ ${response.status} داد.`);
            const parsed = (await response.json()) as unknown;
            if (!Array.isArray(parsed) || !Array.isArray(parsed[0])) {
                throw new Error('پاسخ سرویس ترجمه خوانا نبود.');
            }
            return (parsed[0] as unknown[])
                .map((chunk) => (Array.isArray(chunk) ? String(chunk[0] ?? '') : ''))
                .join('');
        },
        shouldAbort,
        onRateLimit
    );
}

function createGoogleEngine(): TranslationEngine {
    return {
        id: 'google',
        label: 'گوگل ترنسلیت',
        limits: { maxItems: 24, maxChars: 2400 },
        async translate(texts, target, _label, shouldAbort, context) {
            if (!texts.length) return [];
            return budgetedRecovery(
                texts,
                (batch) => googleBatch(batch, target, shouldAbort, context?.onRateLimit),
                shouldAbort,
                (text) => googleSingle(text, target, shouldAbort, context?.onRateLimit)
            );
        }
    };
}

/* ----------------------------- libretranslate ----------------------------- */

function libreEndpoint(config: TranslateConfig): string {
    const base = (config.endpoint || 'https://libretranslate.com').replace(/\/+$/, '');
    return /\/translate$/.test(base) ? base : `${base}/translate`;
}

function createLibreEngine(config: TranslateConfig): TranslationEngine {
    return {
        id: 'libretranslate',
        label: 'LibreTranslate',
        limits: { maxItems: 40, maxChars: 4000 },
        async translate(texts, target, _label, shouldAbort, context) {
            if (!texts.length) return [];
            const endpoint = libreEndpoint(config);
            const apiKey = config.apiKey;
            const tl = resolveEngineTargetLang('libretranslate', target);

            return withRetry(
                async () => {
                    const response = await fetchWithTimeout(
                        endpoint,
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                q: texts,
                                source: 'auto',
                                target: tl,
                                format: 'text',
                                ...(apiKey ? { api_key: apiKey } : {})
                            })
                        },
                        40_000
                    );
                    if (response.status === 401 || response.status === 403) {
                        throw new FatalEngineError('LibreTranslate کلید یا دسترسی را نپذیرفت.');
                    }
                    if (response.status === 400) {
                        throw new FatalEngineError(`LibreTranslate درخواست یا زبان مقصد (${tl}) را نپذیرفت.`);
                    }
                    if (response.status === 429) {
                        throw new RetryableError(
                            'LibreTranslate موقتاً درخواست‌ها را محدود کرده است.',
                            parseRetryAfterMs(response)
                        );
                    }
                    if (!response.ok) throw new Error(`LibreTranslate پاسخ ${response.status} داد.`);
                    const parsed = (await response.json()) as { translatedText?: unknown };
                    const raw = parsed?.translatedText;
                    const list = Array.isArray(raw) ? raw.map(String) : [String(raw ?? '')];
                    if (list.length !== texts.length) {
                        throw new Error('پاسخ LibreTranslate با درخواست هم‌خوانی نداشت.');
                    }
                    return list;
                },
                shouldAbort,
                context?.onRateLimit
            );
        }
    };
}

/* ----------------------------- deepl ----------------------------- */

function createDeeplEngine(config: TranslateConfig): TranslationEngine {
    return {
        id: 'deepl',
        label: 'DeepL',
        limits: { maxItems: 40, maxChars: 4500 },
        async translate(texts, target, _label, shouldAbort, context) {
            if (!texts.length) return [];
            const apiKey = config.apiKey;
            if (!apiKey) throw new FatalEngineError('برای DeepL کلید API لازم است.');
            const targetLang = resolveEngineTargetLang('deepl', target);
            const base = (config.endpoint || 'https://api-free.deepl.com').replace(/\/+$/, '');
            const body = new URLSearchParams();
            for (const text of texts) body.append('text', text);
            body.set('target_lang', targetLang);

            return withRetry(
                async () => {
                    const response = await fetchWithTimeout(
                        `${base}/v2/translate`,
                        {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                                Authorization: `DeepL-Auth-Key ${apiKey}`
                            },
                            body
                        },
                        45_000
                    );
                    if (response.status === 401 || response.status === 403) {
                        throw new FatalEngineError('DeepL کلید API را نپذیرفت.');
                    }
                    if (response.status === 400) {
                        throw new FatalEngineError(`DeepL کد زبان یا درخواست را نپذیرفت (${targetLang}).`);
                    }
                    if (response.status === 429) {
                        throw new RetryableError(
                            'DeepL موقتاً درخواست‌ها را محدود کرده است.',
                            parseRetryAfterMs(response)
                        );
                    }
                    if (response.status === 456) {
                        throw new FatalEngineError('سهمیهٔ DeepL تمام شده است.');
                    }
                    if (!response.ok) throw new Error(`DeepL پاسخ ${response.status} داد.`);
                    const parsed = (await response.json()) as { translations?: unknown };
                    const list = Array.isArray(parsed.translations)
                        ? parsed.translations.map((item) =>
                              item && typeof item === 'object'
                                  ? String((item as { text?: unknown }).text ?? '')
                                  : ''
                          )
                        : [];
                    if (list.length !== texts.length) {
                        throw new Error('پاسخ DeepL با درخواست هم‌خوانی نداشت.');
                    }
                    return list;
                },
                shouldAbort,
                context?.onRateLimit
            );
        }
    };
}

/* ----------------------------- shared LLM prompt, glossary & protocol ----------------------------- */

function chatEndpoint(config: TranslateConfig): string {
    const base = (config.endpoint || '').replace(/\/+$/, '');
    if (!base) throw new FatalEngineError('آدرس سرویس هوش مصنوعی تنظیم نشده است.');
    return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

function chatModel(config: TranslateConfig): string {
    const model = config.model || '';
    if (!model) throw new FatalEngineError('نام مدل هوش مصنوعی تنظیم نشده است.');
    return model;
}

const ITEM_ID = /^\[\[p(\d+)\]\]\s*(.*)$/;
const PROTOCOL_END = /^\[\[(?:source_end|end|terms)\]\]$/;

function protocolPayload(texts: string[], context?: TranslateBatchContext): string {
    const parts: string[] = [];
    const contextBlock = formatContextBlock(context);
    if (contextBlock) parts.push(contextBlock);
    parts.push(`${texts.map((text, index) => `[[p${index + 1}]]\n${text}`).join('\n')}\n[[source_end]]`);
    return parts.join('\n\n');
}

function structuredUserPayload(texts: string[], context?: TranslateBatchContext): string {
    const parts: string[] = [];
    const contextBlock = formatContextBlock(context);
    if (contextBlock) parts.push(contextBlock);
    const items = texts.map((text, index) => ({ id: index + 1, text }));
    parts.push(`ITEMS_TO_TRANSLATE (JSON):\n${JSON.stringify({ items })}`);
    return parts.join('\n\n');
}

function formatContextBlock(context?: TranslateBatchContext): string {
    if (!context) return '';
    const lines: string[] = [];
    if (context.bookTitle) lines.push(`Book Title: ${context.bookTitle}`);
    if (context.chapterHeading) lines.push(`Current Section: ${context.chapterHeading}`);
    if (context.previousPairs?.length) {
        lines.push('Recent Preceding Context (already translated):');
        for (const pair of context.previousPairs.slice(-2)) {
            lines.push(`- Source: ${pair.source.slice(0, 240)}`);
            lines.push(`  Translation: ${pair.translated.slice(0, 240)}`);
        }
    }
    if (context.tmHints?.length) {
        lines.push('Cross-Engine Reference Matches (use only as terminology guidance):');
        for (const hint of context.tmHints.slice(0, 3)) {
            lines.push(`- Source: ${hint.source.slice(0, 200)}`);
            lines.push(`  Reference: ${hint.translated.slice(0, 200)}`);
        }
    }
    if (!lines.length) return '';
    return [
        'CONTEXT_ONLY (DO NOT TRANSLATE OR INCLUDE IN OUTPUT; USE ONLY FOR PRONOUN/TERMINOLOGY CONTINUITY):',
        ...lines
    ].join('\n');
}

function cleanTranslation(value: string): string {
    let text = value.trim();
    const fenced = text.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
    if (fenced) text = fenced[1].trim();
    /* Strip only unambiguous LLM wrapper chatter; never strip bare "ترجمه:" which
       can legitimately appear at the start of translated prose. */
    text = text.replace(
        /^(?:here\s+is\s+the\s+translation\s*[:：]|translated\s+text\s*[:：]|translation\s*[:：]|ترجمهٔ?\s+متن(?:\s+بالا|\s+زیر|\s+فوق)?\s*[:：]|译文\s*[:：]|翻譯\s*[:：])\s*/i,
        ''
    );
    return text.trim();
}

export function parseTranslationProtocol(content: string, expected: number): string[] | null {
    const normalized = content.replace(/\r\n/g, '\n');
    const values = new Map<number, string>();
    let current: number | null = null;
    let buffer: string[] = [];

    const flush = () => {
        if (current === null) return;
        if (values.has(current)) throw new Error('duplicate');
        values.set(current, cleanTranslation(buffer.join('\n')));
        buffer = [];
    };

    try {
        for (const line of normalized.split('\n')) {
            const trimmed = line.trim();
            const id = trimmed.match(ITEM_ID);
            if (id) {
                flush();
                current = Number(id[1]);
                if (id[2]) buffer.push(id[2]);
                continue;
            }
            if (PROTOCOL_END.test(trimmed)) {
                flush();
                current = null;
                continue;
            }
            if (current !== null) buffer.push(line);
        }
        flush();
    } catch {
        return null;
    }

    if (!values.size) return parseTranslationPayload(content, expected);
    const output: string[] = [];
    for (let index = 1; index <= expected; index += 1) {
        const value = values.get(index);
        if (value === undefined) return null;
        output.push(value);
    }
    return output;
}

export function parseStructuredTranslations(data: unknown, expected: number): string[] | null {
    if (!data || typeof data !== 'object') return null;
    const list = Array.isArray(data)
        ? data
        : Array.isArray((data as { translations?: unknown }).translations)
          ? (data as { translations: unknown[] }).translations
          : null;
    if (!list || list.length !== expected) return null;

    if (list.every((item) => typeof item === 'string')) {
        return list.map((item) => cleanTranslation(String(item)));
    }

    const byId = new Map<number, string>();
    for (let index = 0; index < list.length; index += 1) {
        const item = list[index];
        if (!item || typeof item !== 'object') return null;
        const obj = item as Record<string, unknown>;
        const rawId = Number(obj.id ?? index + 1);
        const text = typeof obj.text === 'string' ? obj.text : typeof obj.translation === 'string' ? obj.translation : '';
        if (!Number.isFinite(rawId)) return null;
        byId.set(rawId, cleanTranslation(text));
    }
    const output: string[] = [];
    for (let index = 1; index <= expected; index += 1) {
        const val = byId.get(index);
        if (val === undefined) return null;
        output.push(val);
    }
    return output;
}

function normalizeGlossaryMatch(text: string): string {
    return text
        .replace(/[\u064B-\u065F\u0670]/g, '')
        .replace(/ي/g, 'ی')
        .replace(/ى/g, 'ی')
        .replace(/ك/g, 'ک')
        .replace(/ة/g, 'ه')
        .replace(/[أإآٱ]/g, 'ا')
        .toLowerCase();
}

/** Filters the user's glossary to only entries whose source term actually appears
    in the current batch (using diacritic-insensitive & ي/ك-normalized matching). */
export function filterGlossaryForBatch(glossary: string, texts: string[]): string {
    const trimmed = glossary.trim();
    if (!trimmed) return '';
    const lines = trimmed
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));
    if (!lines.length || !texts.length) return trimmed;

    const haystack = normalizeGlossaryMatch(texts.join('\n'));
    const matched: string[] = [];
    for (const line of lines) {
        const sep = line.match(/\s*(?:=>|->|=|:|\t)\s*/);
        if (!sep || sep.index === undefined || sep.index <= 0) {
            matched.push(line);
            continue;
        }
        const sourceTerm = normalizeGlossaryMatch(line.slice(0, sep.index).trim());
        if (!sourceTerm || haystack.includes(sourceTerm)) {
            matched.push(line);
        }
    }
    return matched.join('\n');
}

function structureRules(): string {
    return [
        '## Markdown & placeholder structure',
        '- Keep the markdown of every item intact: heading marks (#), list markers, blockquote marks (>), table pipes, emphasis (**bold**, *italic*), and links ([text](...)).',
        '- Atomic placeholders like ⟦0⟧, ⟦1⟧, ⟦2⟧ represent protected code, anchors, URLs, math, or footnote refs. You MUST preserve every ⟦N⟧ placeholder verbatim and place it in the grammatically natural position of the translated sentence.',
        '- Translate only readable prose; do not invent extra commentary and do not wrap the answer in a code fence.'
    ].join('\n');
}

function protocolRules(structured: boolean): string {
    if (structured) {
        return [
            '## Structured output format',
            'You will receive ITEMS_TO_TRANSLATE containing JSON objects `{ "id": number, "text": string }`.',
            'Return a valid JSON object matching `{ "translations": [{ "id": number, "text": string }] }` with the exact same count and matching ids, without translating any CONTEXT_ONLY lines.'
        ].join('\n');
    }
    return [
        '## Multi-item format',
        'The input holds several items. Each item starts with its exact id on its own line ([[p1]], [[p2]], …) followed by that item\'s text, and the list ends with one [[source_end]] line.',
        'Return every id exactly once, unchanged, on its own line, followed by its translated text. Do not output any CONTEXT_ONLY text.'
    ].join('\n');
}

function systemPrompt(
    targetLabel: string,
    config: TranslateConfig,
    batchTexts: string[],
    options: { structured: boolean; context?: TranslateBatchContext }
): string {
    const mode = options.context?.mode ?? 'body';
    const sourceLabel = options.context?.sourceLabel || 'Source';

    if (mode === 'frontmatter') {
        const parts = [`Localize the book metadata fields into ${targetLabel}.`];
        const prompt = config.prompt.trim();
        if (prompt) parts.push('', '## Translation instructions', prompt);
        const glossary = config.glossary.trim();
        if (glossary) parts.push('', `## Glossary (${sourceLabel} -> ${targetLabel})`, glossary);
        const fmRules = config.fmRules.trim();
        if (fmRules) parts.push('', '## Front-matter rules', fmRules);
        return parts.join('\n');
    }

    const parts = [
        `Translate each item into ${targetLabel}.`,
        '',
        structureRules(),
        '',
        protocolRules(options.structured)
    ];

    const prompt = config.prompt.trim();
    if (prompt) parts.push('', '## Translation instructions', prompt);

    const glossary = filterGlossaryForBatch(config.glossary, batchTexts);
    if (glossary) parts.push('', `## Glossary (${sourceLabel} -> ${targetLabel})`, glossary);

    const rules = config.rules.trim();
    if (rules) parts.push('', '## Markdown rules', rules);

    return parts.join('\n');
}

function singleItemSystemPrompt(targetLabel: string, config: TranslateConfig, sourceText: string): string {
    const parts = [
        `Translate the provided text into ${targetLabel}.`,
        'Return ONLY the translated text itself—no JSON, no [[p1]] tags, no quotes or commentary.',
        'Keep all markdown formatting and all atomic placeholders like ⟦0⟧, ⟦1⟧ verbatim in their natural position.'
    ];
    const prompt = config.prompt.trim();
    if (prompt) parts.push('', '## Translation instructions', prompt);
    const glossary = filterGlossaryForBatch(config.glossary, [sourceText]);
    if (glossary) parts.push('', `## Glossary (-> ${targetLabel})`, glossary);
    const rules = config.rules.trim();
    if (rules) parts.push('', '## Markdown rules', rules);
    return parts.join('\n');
}

export function parseTranslationPayload(content: string, expected: number): string[] | null {
    const trimmed = content
        .trim()
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/, '')
        .trim();

    const collect = (value: unknown): string[] | null => {
        const structured = parseStructuredTranslations(value, expected);
        if (structured) return structured;
        if (Array.isArray(value)) return value.map((item) => cleanTranslation(String(item ?? '')));
        if (value && typeof value === 'object') {
            const found = Object.values(value as Record<string, unknown>).find((item) =>
                Array.isArray(item)
            );
            if (Array.isArray(found)) return found.map((item) => cleanTranslation(String(item ?? '')));
        }
        return null;
    };

    let values: string[] | null = null;
    try {
        values = collect(JSON.parse(trimmed));
    } catch {
        /* the model may wrap the JSON in prose; dig it out below */
    }
    if (!values) {
        const start = trimmed.indexOf('{');
        const end = trimmed.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try {
                values = collect(JSON.parse(trimmed.slice(start, end + 1)));
            } catch {
                values = null;
            }
        }
    }
    if (!values) {
        const start = trimmed.indexOf('[');
        const end = trimmed.lastIndexOf(']');
        if (start >= 0 && end > start) {
            try {
                values = collect(JSON.parse(trimmed.slice(start, end + 1)));
            } catch {
                values = null;
            }
        }
    }
    if (!values || values.length !== expected) return null;
    return values;
}

/* ----------------------------- openai-compatible ----------------------------- */

type OpenAiFormatMode = 'json_schema' | 'json_object' | 'protocol';
const openAiModeCache = new Map<string, OpenAiFormatMode>();

const OPENAI_TRANSLATIONS_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        translations: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    id: { type: 'integer' },
                    text: { type: 'string' }
                },
                required: ['id', 'text']
            }
        }
    },
    required: ['translations']
};

function openAiModeKey(config: TranslateConfig): string {
    return `${chatEndpoint(config)}::${chatModel(config)}`;
}

function openAiBody(
    texts: string[],
    targetLabel: string,
    config: TranslateConfig,
    formatMode: OpenAiFormatMode,
    context?: TranslateBatchContext
): Record<string, unknown> {
    const structured = formatMode !== 'protocol';
    const body: Record<string, unknown> = {
        model: chatModel(config),
        temperature: 0.15,
        messages: [
            { role: 'system', content: systemPrompt(targetLabel, config, texts, { structured, context }) },
            {
                role: 'user',
                content: structured ? structuredUserPayload(texts, context) : protocolPayload(texts, context)
            }
        ]
    };
    if (formatMode === 'json_schema') {
        body.response_format = {
            type: 'json_schema',
            json_schema: {
                name: 'translations_payload',
                strict: true,
                schema: OPENAI_TRANSLATIONS_SCHEMA
            }
        };
    } else if (formatMode === 'json_object') {
        body.response_format = { type: 'json_object' };
    }
    return body;
}

async function openAiRequest(
    texts: string[],
    targetLabel: string,
    config: TranslateConfig,
    shouldAbort: () => boolean,
    context?: TranslateBatchContext
): Promise<string[]> {
    const url = chatEndpoint(config);
    const apiKey = config.apiKey;
    const modeKey = openAiModeKey(config);

    return withRetry(
        async () => {
            const formatMode: OpenAiFormatMode = openAiModeCache.get(modeKey) ?? 'json_schema';
            const body = openAiBody(texts, targetLabel, config, formatMode, context);
            const response = await fetchWithTimeout(
                url,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
                    },
                    body: JSON.stringify(body)
                },
                180_000
            );
            if (response.status === 401 || response.status === 403) {
                throw new FatalEngineError('کلید API پذیرفته نشد؛ کلید و سرویس را بررسی کنید.');
            }
            if (response.status === 404) {
                throw new FatalEngineError('سرویس یا مدل پیدا نشد؛ آدرس و نام مدل را بررسی کنید.');
            }
            if (response.status === 429) {
                throw new RetryableError(
                    'سرویس هوش مصنوعی سهمیه یا نرخ درخواست را محدود کرده است.',
                    parseRetryAfterMs(response)
                );
            }
            if (response.status === 400 || response.status === 422) {
                const detail = await response.text().catch(() => '');
                if (formatMode === 'json_schema') {
                    openAiModeCache.set(modeKey, 'json_object');
                    throw new Error('مدل از json_schema پشتیبانی نکرد؛ تبدیل به json_object.');
                }
                if (formatMode === 'json_object') {
                    openAiModeCache.set(modeKey, 'protocol');
                    throw new Error('مدل از json_object پشتیبانی نکرد؛ تبدیل به پروتکل متنی.');
                }
                throw new FatalEngineError(
                    `سرویس هوش مصنوعی پاسخ ${response.status} داد${detail ? `: ${detail.slice(0, 160)}` : ''}`
                );
            }
            if (response.status >= 500) {
                throw new Error(`سرویس هوش مصنوعی خطای ${response.status} داد.`);
            }
            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                throw new FatalEngineError(
                    `سرویس هوش مصنوعی پاسخ ${response.status} داد${detail ? `: ${detail.slice(0, 160)}` : ''}`
                );
            }

            const parsed = (await response.json()) as {
                choices?: { finish_reason?: string; message?: { content?: unknown } }[];
                usage?: {
                    prompt_tokens?: number;
                    completion_tokens?: number;
                    prompt_tokens_details?: { cached_tokens?: number };
                };
            };
            if (parsed.usage) {
                context?.onUsage?.({
                    inputTokens: Number(parsed.usage.prompt_tokens) || 0,
                    outputTokens: Number(parsed.usage.completion_tokens) || 0,
                    cachedTokens: Number(parsed.usage.prompt_tokens_details?.cached_tokens) || 0,
                    requests: 1
                });
            }
            const choice = parsed?.choices?.[0];
            if (choice?.finish_reason === 'length' && texts.length > 1) {
                throw new BatchSplitError('پاسخ مدل به سقف طول رسید؛ دسته نصف می‌شود.');
            }
            const content = choice?.message?.content;
            const text = typeof content === 'string' ? content : '';
            const values =
                formatMode === 'protocol'
                    ? parseTranslationProtocol(text, texts.length)
                    : parseTranslationPayload(text, texts.length) ?? parseTranslationProtocol(text, texts.length);
            if (!values) throw new Error('پاسخ مدل ساختار درستی نداشت و دوباره درخواست می‌شود.');
            return values;
        },
        shouldAbort,
        context?.onRateLimit
    );
}

async function openAiSingleRequest(
    text: string,
    targetLabel: string,
    config: TranslateConfig,
    shouldAbort: () => boolean,
    context?: TranslateBatchContext
): Promise<string> {
    const url = chatEndpoint(config);
    const apiKey = config.apiKey;
    return withRetry(
        async () => {
            const response = await fetchWithTimeout(
                url,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
                    },
                    body: JSON.stringify({
                        model: chatModel(config),
                        temperature: 0.15,
                        messages: [
                            { role: 'system', content: singleItemSystemPrompt(targetLabel, config, text) },
                            { role: 'user', content: text }
                        ]
                    })
                },
                120_000
            );
            if (response.status === 401 || response.status === 403) {
                throw new FatalEngineError('کلید API پذیرفته نشد؛ کلید و سرویس را بررسی کنید.');
            }
            if (response.status === 404) {
                throw new FatalEngineError('سرویس یا مدل پیدا نشد؛ آدرس و نام مدل را بررسی کنید.');
            }
            if (response.status === 429) {
                throw new RetryableError(
                    'سرویس هوش مصنوعی سهمیه یا نرخ درخواست را محدود کرده است.',
                    parseRetryAfterMs(response)
                );
            }
            if (response.status >= 500) {
                throw new Error(`سرویس هوش مصنوعی خطای ${response.status} داد.`);
            }
            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                throw new FatalEngineError(
                    `سرویس هوش مصنوعی پاسخ ${response.status} داد${detail ? `: ${detail.slice(0, 160)}` : ''}`
                );
            }
            const parsed = (await response.json()) as {
                choices?: { message?: { content?: unknown } }[];
                usage?: {
                    prompt_tokens?: number;
                    completion_tokens?: number;
                    prompt_tokens_details?: { cached_tokens?: number };
                };
            };
            if (parsed.usage) {
                context?.onUsage?.({
                    inputTokens: Number(parsed.usage.prompt_tokens) || 0,
                    outputTokens: Number(parsed.usage.completion_tokens) || 0,
                    cachedTokens: Number(parsed.usage.prompt_tokens_details?.cached_tokens) || 0,
                    requests: 1
                });
            }
            const raw = parsed?.choices?.[0]?.message?.content;
            const cleaned = cleanTranslation(typeof raw === 'string' ? raw : '');
            if (!cleaned) throw new Error('پاسخ تک‌بندی خالی بود.');
            return cleaned;
        },
        shouldAbort,
        context?.onRateLimit
    );
}

function createOpenAiEngine(config: TranslateConfig): TranslationEngine {
    return {
        id: 'openai',
        label: 'هوش مصنوعی',
        limits: { maxItems: 28, maxChars: 7500 },
        async translate(texts, target, targetLabel, shouldAbort, context) {
            if (!texts.length) return [];
            const label = targetLabel || target;
            return budgetedRecovery(
                texts,
                (batch) => openAiRequest(batch, label, config, shouldAbort, context),
                shouldAbort,
                (single) => openAiSingleRequest(single, label, config, shouldAbort, context)
            );
        }
    };
}

/* ----------------------------- anthropic ----------------------------- */

function anthropicEndpoint(config: TranslateConfig): string {
    const base = (config.endpoint || 'https://api.anthropic.com').replace(/\/+$/, '');
    return /\/v1\/messages$/.test(base) ? base : `${base}/v1/messages`;
}

const anthropicToolFallback = new Set<string>();

async function anthropicRequest(
    texts: string[],
    targetLabel: string,
    config: TranslateConfig,
    shouldAbort: () => boolean,
    context?: TranslateBatchContext
): Promise<string[]> {
    const apiKey = config.apiKey;
    if (!apiKey) throw new FatalEngineError('برای Claude کلید API لازم است.');
    const url = anthropicEndpoint(config);
    const model = config.model || 'claude-sonnet-4-5';
    const cacheKey = `${url}::${model}`;
    const isOfficialAnthropic = /api\.anthropic\.com/i.test(url);

    return withRetry(
        async () => {
            const useTool = !anthropicToolFallback.has(cacheKey);
            const sysText = systemPrompt(targetLabel, config, texts, { structured: useTool, context });
            const body: Record<string, unknown> = {
                model,
                max_tokens: 8192,
                temperature: 0.15,
                system:
                    isOfficialAnthropic && sysText.length > 600
                        ? [{ type: 'text', text: sysText, cache_control: { type: 'ephemeral' } }]
                        : sysText,
                messages: [
                    {
                        role: 'user',
                        content: useTool
                            ? structuredUserPayload(texts, context)
                            : protocolPayload(texts, context)
                    }
                ]
            };
            if (useTool) {
                body.tools = [
                    {
                        name: 'submit_translations',
                        description: 'Submit the ordered list of translated items matching each input id.',
                        input_schema: {
                            type: 'object',
                            properties: {
                                translations: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            id: { type: 'integer' },
                                            text: { type: 'string' }
                                        },
                                        required: ['id', 'text']
                                    }
                                }
                            },
                            required: ['translations']
                        }
                    }
                ];
                body.tool_choice = { type: 'tool', name: 'submit_translations' };
            }

            const response = await fetchWithTimeout(
                url,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01'
                    },
                    body: JSON.stringify(body)
                },
                180_000
            );
            if (response.status === 401 || response.status === 403) {
                throw new FatalEngineError('کلید Anthropic پذیرفته نشد؛ کلید و سرویس را بررسی کنید.');
            }
            if (response.status === 404) {
                throw new FatalEngineError('مدل یا سرویس Claude پیدا نشد؛ نام مدل را بررسی کنید.');
            }
            if (response.status === 429) {
                throw new RetryableError(
                    'سهمیه یا نرخ درخواست Anthropic محدود شده است.',
                    parseRetryAfterMs(response)
                );
            }
            if (response.status === 400 && useTool) {
                anthropicToolFallback.add(cacheKey);
                throw new Error('ابزار ساختاریافته در این سرویس پشتیبانی نشد؛ بازگشت به پروتکل متنی.');
            }
            if (response.status === 529) {
                throw new Error('سرور Anthropic موقتاً شلوغ است.');
            }
            if (response.status >= 500) {
                throw new Error(`Anthropic خطای ${response.status} داد.`);
            }
            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                throw new FatalEngineError(
                    `Anthropic پاسخ ${response.status} داد${detail ? `: ${detail.slice(0, 200)}` : ''}`
                );
            }

            const parsed = (await response.json()) as {
                stop_reason?: string;
                content?: { type?: string; name?: string; input?: unknown; text?: unknown }[];
                usage?: {
                    input_tokens?: number;
                    output_tokens?: number;
                    cache_read_input_tokens?: number;
                };
            };
            if (parsed.usage) {
                context?.onUsage?.({
                    inputTokens: Number(parsed.usage.input_tokens) || 0,
                    outputTokens: Number(parsed.usage.output_tokens) || 0,
                    cachedTokens: Number(parsed.usage.cache_read_input_tokens) || 0,
                    requests: 1
                });
            }
            if (parsed.stop_reason === 'max_tokens' && texts.length > 1) {
                throw new BatchSplitError('پاسخ Claude به سقف توکن رسید؛ دسته نصف می‌شود.');
            }
            const toolBlock = Array.isArray(parsed.content)
                ? parsed.content.find((part) => part?.type === 'tool_use' && part.name === 'submit_translations')
                : undefined;
            if (toolBlock?.input) {
                const values = parseStructuredTranslations(toolBlock.input, texts.length);
                if (values) return values;
            }
            const text = Array.isArray(parsed.content)
                ? parsed.content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('')
                : '';
            const values = parseTranslationProtocol(text, texts.length);
            if (!values) throw new Error('پاسخ Claude ساختار درستی نداشت و دوباره درخواست می‌شود.');
            return values;
        },
        shouldAbort,
        context?.onRateLimit
    );
}

async function anthropicSingleRequest(
    text: string,
    targetLabel: string,
    config: TranslateConfig,
    shouldAbort: () => boolean,
    context?: TranslateBatchContext
): Promise<string> {
    const apiKey = config.apiKey;
    if (!apiKey) throw new FatalEngineError('برای Claude کلید API لازم است.');
    const url = anthropicEndpoint(config);
    const model = config.model || 'claude-sonnet-4-5';

    return withRetry(
        async () => {
            const response = await fetchWithTimeout(
                url,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01'
                    },
                    body: JSON.stringify({
                        model,
                        max_tokens: 4096,
                        temperature: 0.15,
                        system: singleItemSystemPrompt(targetLabel, config, text),
                        messages: [{ role: 'user', content: text }]
                    })
                },
                120_000
            );
            if (response.status === 401 || response.status === 403) {
                throw new FatalEngineError('کلید Anthropic پذیرفته نشد؛ کلید و سرویس را بررسی کنید.');
            }
            if (response.status === 404) {
                throw new FatalEngineError('مدل یا سرویس Claude پیدا نشد؛ نام مدل را بررسی کنید.');
            }
            if (response.status === 429) {
                throw new RetryableError(
                    'سهمیه یا نرخ درخواست Anthropic محدود شده است.',
                    parseRetryAfterMs(response)
                );
            }
            if (response.status === 529 || response.status >= 500) {
                throw new Error(`Anthropic خطای ${response.status} داد.`);
            }
            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                throw new FatalEngineError(
                    `Anthropic پاسخ ${response.status} داد${detail ? `: ${detail.slice(0, 200)}` : ''}`
                );
            }
            const parsed = (await response.json()) as {
                content?: { type?: string; text?: unknown }[];
                usage?: {
                    input_tokens?: number;
                    output_tokens?: number;
                    cache_read_input_tokens?: number;
                };
            };
            if (parsed.usage) {
                context?.onUsage?.({
                    inputTokens: Number(parsed.usage.input_tokens) || 0,
                    outputTokens: Number(parsed.usage.output_tokens) || 0,
                    cachedTokens: Number(parsed.usage.cache_read_input_tokens) || 0,
                    requests: 1
                });
            }
            const raw = Array.isArray(parsed.content)
                ? parsed.content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('')
                : '';
            const cleaned = cleanTranslation(raw);
            if (!cleaned) throw new Error('پاسخ تک‌بندی Claude خالی بود.');
            return cleaned;
        },
        shouldAbort,
        context?.onRateLimit
    );
}

function createAnthropicEngine(config: TranslateConfig): TranslationEngine {
    return {
        id: 'anthropic',
        label: 'Anthropic Claude',
        limits: { maxItems: 28, maxChars: 7500 },
        async translate(texts, target, targetLabel, shouldAbort, context) {
            if (!texts.length) return [];
            const label = targetLabel || target;
            return budgetedRecovery(
                texts,
                (batch) => anthropicRequest(batch, label, config, shouldAbort, context),
                shouldAbort,
                (single) => anthropicSingleRequest(single, label, config, shouldAbort, context)
            );
        }
    };
}

/* ----------------------------- gemini (free API with pacing) ----------------------------- */

const DEFAULT_GEMINI_MODEL = 'gemini-4-hydrogen';
const GEMINI_FREE_MIN_INTERVAL_MS = 4500;
const GEMINI_MAX_RETRIES = 6;

let geminiMutex: Promise<void> = Promise.resolve();
let geminiNextAllowedAt = 0;
const geminiClients = new Map<string, GoogleGenAI>();

function getGeminiClient(apiKey: string): GoogleGenAI {
    let client = geminiClients.get(apiKey);
    if (!client) {
        client = new GoogleGenAI({
            apiKey,
            httpOptions: {
                headers: {
                    'User-Agent': 'aistudio-build'
                }
            }
        });
        geminiClients.set(apiKey, client);
    }
    return client;
}

function extractGeminiStatus(error: unknown): {
    status?: number;
    message: string;
    retryAfterMs?: number;
} {
    const obj = error && typeof error === 'object' ? (error as Record<string, unknown>) : null;
    const status =
        typeof obj?.status === 'number'
            ? obj.status
            : typeof obj?.code === 'number'
              ? obj.code
              : undefined;
    const message = error instanceof Error ? error.message : String(error ?? '');
    let retryAfterMs: number | undefined;
    const secMatch = message.match(/(?:retry\s+in|retryDelay['":\s]+)(\d+(?:\.\d+)?)\s*s/i);
    if (secMatch) {
        const parsed = Number(secMatch[1]);
        if (Number.isFinite(parsed) && parsed > 0) {
            retryAfterMs = Math.min(90_000, Math.ceil(parsed * 1000) + 1000);
        }
    }
    return { status, message, retryAfterMs };
}

function runGeminiSerialized<T>(
    task: () => Promise<T>,
    shouldAbort: () => boolean
): Promise<T> {
    const run = async (): Promise<T> => {
        const wait = geminiNextAllowedAt - Date.now();
        if (wait > 0) {
            await sleepAbortable(wait, shouldAbort);
        }
        if (shouldAbort()) throw new Error('cancelled');
        try {
            return await task();
        } finally {
            geminiNextAllowedAt = Math.max(
                geminiNextAllowedAt,
                Date.now() + GEMINI_FREE_MIN_INTERVAL_MS
            );
        }
    };
    const queued = geminiMutex.then(run, run);
    geminiMutex = queued.then(
        () => undefined,
        () => undefined
    );
    return queued;
}

class ProtocolMismatchError extends Error {}

const GEMINI_RESPONSE_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        translations: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    id: { type: Type.INTEGER },
                    text: { type: Type.STRING }
                },
                required: ['id', 'text']
            }
        }
    },
    required: ['translations']
};

async function invokeGemini<T>(
    config: TranslateConfig,
    shouldAbort: () => boolean,
    fn: (ai: GoogleGenAI, model: string) => Promise<T>,
    onRateLimit?: (ms?: number) => void
): Promise<T> {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) {
        throw new FatalEngineError(
            'کلید API جمنای (GEMINI_API_KEY) در سرور تنظیم نشده است. لطفاً در بخش Settings > Secrets کلید را بررسی کنید.'
        );
    }

    const ai = getGeminiClient(apiKey);
    const model = (config.model || '').trim() || DEFAULT_GEMINI_MODEL;
    const isPaid = config.geminiPlan === 'paid';

    let lastError: Error = new Error('سرویس جمنای پاسخ نداد.');
    for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt += 1) {
        if (shouldAbort()) throw new Error('cancelled');
        try {
            return isPaid
                ? await fn(ai, model)
                : await runGeminiSerialized(() => fn(ai, model), shouldAbort);
        } catch (error) {
            if (error instanceof FatalEngineError || error instanceof BatchSplitError) throw error;
            if (error instanceof ProtocolMismatchError) {
                if (attempt >= 1) throw error;
                lastError = error;
                await sleepAbortable(1500, shouldAbort);
                continue;
            }
            if (shouldAbort() || (error instanceof Error && error.message === 'cancelled')) {
                throw new Error('cancelled');
            }

            const info = extractGeminiStatus(error);
            const lower = info.message.toLowerCase();

            if (
                info.status === 401 ||
                info.status === 403 ||
                lower.includes('permission_denied') ||
                lower.includes('api_key_invalid') ||
                lower.includes('api key not valid')
            ) {
                throw new FatalEngineError(
                    'کلید API جمنای معتبر نیست یا دسترسی ندارد؛ کلید GEMINI_API_KEY را در Settings > Secrets بررسی کنید.'
                );
            }
            if (info.status === 404 || lower.includes('not_found')) {
                throw new FatalEngineError(
                    `مدل جمنای (${model}) پیدا نشد یا پشتیبانی نمی‌شود؛ مدل را بررسی کنید.`
                );
            }
            if (info.status === 400 && lower.includes('invalid_argument') && !lower.includes('api key')) {
                throw new FatalEngineError(`درخواست به جمنای نپذیرفته شد: ${info.message.slice(0, 160)}`);
            }

            const isRateLimit =
                info.status === 429 ||
                lower.includes('429') ||
                lower.includes('resource_exhausted') ||
                lower.includes('rate') ||
                lower.includes('quota');

            if (isRateLimit) onRateLimit?.(info.retryAfterMs);

            lastError = new Error(
                isRateLimit
                    ? isPaid
                        ? 'محدودیت نرخ موقت جمنای؛ کاهش خودکار سرعت و تلاش دوباره…'
                        : 'محدودیت سرعت API رایگان جمنای؛ در حال مکث و تلاش دوباره…'
                    : info.message || 'خطای موقت در ارتباط با جمنای.'
            );

            if (attempt === GEMINI_MAX_RETRIES) break;

            const backoffMs = isRateLimit
                ? info.retryAfterMs ?? Math.min(65_000, (isPaid ? 5_000 : 12_000) * (attempt + 1))
                : Math.min(20_000, 3_000 * Math.pow(2, attempt));
            const waitMs = backoffMs + Math.round(Math.random() * 1000);
            if (!isPaid) {
                geminiNextAllowedAt = Math.max(geminiNextAllowedAt, Date.now() + waitMs);
            }
            await sleepAbortable(waitMs, shouldAbort);
        }
    }
    throw lastError;
}

async function geminiRequest(
    texts: string[],
    targetLabel: string,
    config: TranslateConfig,
    shouldAbort: () => boolean,
    context?: TranslateBatchContext
): Promise<string[]> {
    const sysInstruction = systemPrompt(targetLabel, config, texts, { structured: true, context });
    const payload = structuredUserPayload(texts, context);

    return invokeGemini(
        config,
        shouldAbort,
        async (ai, model) => {
            const response = await ai.models.generateContent({
                model,
                contents: payload,
                config: {
                    systemInstruction: sysInstruction,
                    responseMimeType: 'application/json',
                    responseSchema: GEMINI_RESPONSE_SCHEMA,
                    thinkingConfig: {
                        thinkingLevel: ThinkingLevel.LOW
                    }
                }
            });

            if (response.usageMetadata) {
                context?.onUsage?.({
                    inputTokens: Number(response.usageMetadata.promptTokenCount) || 0,
                    outputTokens: Number(response.usageMetadata.candidatesTokenCount) || 0,
                    cachedTokens: Number(response.usageMetadata.cachedContentTokenCount) || 0,
                    requests: 1
                });
            }

            const finishReason = String(response.candidates?.[0]?.finishReason ?? '').toUpperCase();
            if (finishReason === 'MAX_TOKENS') {
                throw new BatchSplitError('پاسخ جمنای به سقف توکن رسید؛ دسته نصف می‌شود.');
            }
            if (
                finishReason === 'SAFETY' ||
                finishReason === 'RECITATION' ||
                finishReason === 'PROHIBITED_CONTENT' ||
                finishReason === 'BLOCKLIST' ||
                finishReason === 'SPII'
            ) {
                if (texts.length > 1) {
                    throw new BatchSplitError(`جمنای این دسته را با دلیل ${finishReason} متوقف کرد؛ تقسیم می‌شود.`);
                }
                throw new ProtocolMismatchError(`جمنای به دلیل ${finishReason} پاسخ نداد.`);
            }

            const text = (response.text ?? '').trim();
            const values =
                parseTranslationPayload(text, texts.length) ??
                parseTranslationProtocol(text, texts.length);
            if (!values) {
                if (texts.length > 1) throw new BatchSplitError('پاسخ جمنای ساختار درستی نداشت؛ دسته نصف می‌شود.');
                throw new ProtocolMismatchError('پاسخ جمنای ساختار درستی نداشت.');
            }
            return values;
        },
        context?.onRateLimit
    );
}

async function geminiSingleRequest(
    text: string,
    targetLabel: string,
    config: TranslateConfig,
    shouldAbort: () => boolean,
    context?: TranslateBatchContext
): Promise<string> {
    const sysInstruction = singleItemSystemPrompt(targetLabel, config, text);
    return invokeGemini(
        config,
        shouldAbort,
        async (ai, model) => {
            const response = await ai.models.generateContent({
                model,
                contents: text,
                config: {
                    systemInstruction: sysInstruction,
                    thinkingConfig: {
                        thinkingLevel: ThinkingLevel.LOW
                    }
                }
            });
            if (response.usageMetadata) {
                context?.onUsage?.({
                    inputTokens: Number(response.usageMetadata.promptTokenCount) || 0,
                    outputTokens: Number(response.usageMetadata.candidatesTokenCount) || 0,
                    cachedTokens: Number(response.usageMetadata.cachedContentTokenCount) || 0,
                    requests: 1
                });
            }
            const finishReason = String(response.candidates?.[0]?.finishReason ?? '').toUpperCase();
            if (
                finishReason === 'SAFETY' ||
                finishReason === 'RECITATION' ||
                finishReason === 'PROHIBITED_CONTENT'
            ) {
                throw new Error(`جمنای به دلیل ${finishReason} پاسخ نداد.`);
            }
            const cleaned = cleanTranslation(response.text ?? '');
            if (!cleaned) throw new Error('پاسخ تک‌بندی جمنای خالی بود.');
            return cleaned;
        },
        context?.onRateLimit
    );
}

function createGeminiEngine(config: TranslateConfig): TranslationEngine {
    const isPaid = config.geminiPlan === 'paid';
    return {
        id: 'gemini',
        label: isPaid ? 'Google Gemini (پولی)' : 'Google Gemini (رایگان)',
        limits: isPaid ? { maxItems: 32, maxChars: 9000 } : { maxItems: 28, maxChars: 7000 },
        async translate(texts, target, targetLabel, shouldAbort, context) {
            if (!texts.length) return [];
            const label = targetLabel || target;
            return budgetedRecovery(
                texts,
                (batch) => geminiRequest(batch, label, config, shouldAbort, context),
                shouldAbort,
                (single) => geminiSingleRequest(single, label, config, shouldAbort, context)
            );
        }
    };
}

/* ----------------------------- unified frontmatter JSON localization ----------------------------- */

/** Translates a clean dictionary of frontmatter fields + optional `برچسب ها` array
    in a single structured JSON call for AI engines, respecting `fmRules`. Returns null
    when the engine is a machine translator or structured parsing fails so the caller
    can fall back gracefully. */
export async function translateFrontmatterJson(
    config: TranslateConfig,
    fields: Record<string, string>,
    tags: string[],
    targetLabel: string,
    shouldAbort: () => boolean
): Promise<{ fields: Record<string, string>; tags: string[] } | null> {
    if (config.engine !== 'gemini' && config.engine !== 'openai' && config.engine !== 'anthropic') {
        return null;
    }
    const sys = systemPrompt(targetLabel, config, [], {
        structured: true,
        context: { mode: 'frontmatter' }
    });
    const userMsg =
        'Translate/localize the JSON frontmatter object below according to the Front-matter rules. ' +
        'Return ONLY a JSON object with exact shape `{ "fields": { ... }, "tags": [ ... ] }` keeping all keys in `fields` identical:\n' +
        JSON.stringify({ fields, tags }, null, 2);

    const extractObj = (raw: string): { fields: Record<string, string>; tags: string[] } | null => {
        const cleaned = raw
            .trim()
            .replace(/^```(?:json)?/i, '')
            .replace(/```$/, '')
            .trim();
        let parsed: unknown = null;
        try {
            parsed = JSON.parse(cleaned);
        } catch {
            const start = cleaned.indexOf('{');
            const end = cleaned.lastIndexOf('}');
            if (start >= 0 && end > start) {
                try {
                    parsed = JSON.parse(cleaned.slice(start, end + 1));
                } catch {
                    parsed = null;
                }
            }
        }
        if (!parsed || typeof parsed !== 'object') return null;
        const obj = parsed as { fields?: unknown; tags?: unknown };
        const rawFields =
            obj.fields && typeof obj.fields === 'object' && !Array.isArray(obj.fields)
                ? (obj.fields as Record<string, unknown>)
                : (parsed as Record<string, unknown>);
        const nextFields: Record<string, string> = {};
        for (const key of Object.keys(fields)) {
            const val = rawFields[key];
            if (typeof val === 'string' && val.trim()) nextFields[key] = val.trim();
        }
        const nextTags = Array.isArray(obj.tags)
            ? obj.tags.map((item) => String(item ?? '').trim()).filter(Boolean)
            : tags;
        return { fields: nextFields, tags: nextTags };
    };

    try {
        if (config.engine === 'gemini') {
            const rawText = await invokeGemini(config, shouldAbort, async (ai, model) => {
                const response = await ai.models.generateContent({
                    model,
                    contents: userMsg,
                    config: {
                        systemInstruction: sys,
                        responseMimeType: 'application/json',
                        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
                    }
                });
                return response.text ?? '';
            });
            return extractObj(rawText);
        }

        if (config.engine === 'openai') {
            const url = chatEndpoint(config);
            const rawText = await withRetry(async () => {
                const response = await fetchWithTimeout(
                    url,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
                        },
                        body: JSON.stringify({
                            model: chatModel(config),
                            temperature: 0.15,
                            messages: [
                                { role: 'system', content: sys },
                                { role: 'user', content: userMsg }
                            ]
                        })
                    },
                    60_000
                );
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const parsed = (await response.json()) as {
                    choices?: { message?: { content?: unknown } }[];
                };
                return String(parsed?.choices?.[0]?.message?.content ?? '');
            }, shouldAbort);
            return extractObj(rawText);
        }

        if (config.engine === 'anthropic') {
            if (!config.apiKey) return null;
            const url = anthropicEndpoint(config);
            const model = config.model || 'claude-sonnet-4-5';
            const rawText = await withRetry(async () => {
                const response = await fetchWithTimeout(
                    url,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-api-key': config.apiKey,
                            'anthropic-version': '2023-06-01'
                        },
                        body: JSON.stringify({
                            model,
                            max_tokens: 2048,
                            temperature: 0.15,
                            system: sys,
                            messages: [{ role: 'user', content: userMsg }]
                        })
                    },
                    60_000
                );
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const parsed = (await response.json()) as {
                    content?: { text?: unknown }[];
                };
                return Array.isArray(parsed.content)
                    ? parsed.content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('')
                    : '';
            }, shouldAbort);
            return extractObj(rawText);
        }
    } catch {
        return null;
    }
    return null;
}

/* ----------------------------- Pre-flight Glossary Discovery ----------------------------- */

/** Extracts up to 20 recurring proper names, titles, and key specialized terms
    from an excerpt of the book using the active AI provider, formatted as
    `Source = Target` pairs for terminology consistency across all workers. */
export async function extractGlossaryWithAi(
    config: TranslateConfig,
    excerpt: string,
    targetLabel: string,
    shouldAbort: () => boolean,
    onUsage?: (delta: TokenUsageDelta) => void
): Promise<string[]> {
    if (config.engine !== 'gemini' && config.engine !== 'openai' && config.engine !== 'anthropic') {
        return [];
    }
    const trimmed = excerpt.trim().slice(0, 4800);
    if (!trimmed) return [];

    const sys = [
        `Analyze this book excerpt and extract up to 20 key recurring proper names, book/work titles, and specialized domain terms that must be translated consistently into ${targetLabel}.`,
        'Return ONLY lines in the exact format `source term = consistent target translation` (no numbering, no explanations, no markdown code blocks).',
        'Do not extract common everyday words.'
    ].join('\n');

    const parseLines = (raw: string): string[] =>
        raw
            .replace(/\r\n/g, '\n')
            .split('\n')
            .map((line) => line.replace(/^[-*\d.)\s]+/, '').trim())
            .filter((line) => {
                const eq = line.indexOf('=');
                return eq > 0 && eq < line.length - 1 && !line.startsWith('```');
            })
            .slice(0, 20);

    try {
        if (config.engine === 'gemini') {
            const raw = await invokeGemini(config, shouldAbort, async (ai, model) => {
                const response = await ai.models.generateContent({
                    model,
                    contents: trimmed,
                    config: {
                        systemInstruction: sys,
                        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
                    }
                });
                if (response.usageMetadata) {
                    onUsage?.({
                        inputTokens: Number(response.usageMetadata.promptTokenCount) || 0,
                        outputTokens: Number(response.usageMetadata.candidatesTokenCount) || 0,
                        cachedTokens: Number(response.usageMetadata.cachedContentTokenCount) || 0,
                        requests: 1
                    });
                }
                return response.text ?? '';
            });
            return parseLines(raw);
        }
        if (config.engine === 'openai') {
            const url = chatEndpoint(config);
            const raw = await withRetry(async () => {
                const response = await fetchWithTimeout(
                    url,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
                        },
                        body: JSON.stringify({
                            model: chatModel(config),
                            temperature: 0.1,
                            messages: [
                                { role: 'system', content: sys },
                                { role: 'user', content: trimmed }
                            ]
                        })
                    },
                    60_000
                );
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const parsed = (await response.json()) as {
                    choices?: { message?: { content?: unknown } }[];
                    usage?: { prompt_tokens?: number; completion_tokens?: number };
                };
                if (parsed.usage) {
                    onUsage?.({
                        inputTokens: Number(parsed.usage.prompt_tokens) || 0,
                        outputTokens: Number(parsed.usage.completion_tokens) || 0,
                        cachedTokens: 0,
                        requests: 1
                    });
                }
                return String(parsed?.choices?.[0]?.message?.content ?? '');
            }, shouldAbort);
            return parseLines(raw);
        }
        if (config.engine === 'anthropic') {
            if (!config.apiKey) return [];
            const url = anthropicEndpoint(config);
            const model = config.model || 'claude-sonnet-4-5';
            const raw = await withRetry(async () => {
                const response = await fetchWithTimeout(
                    url,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-api-key': config.apiKey,
                            'anthropic-version': '2023-06-01'
                        },
                        body: JSON.stringify({
                            model,
                            max_tokens: 1500,
                            temperature: 0.1,
                            system: sys,
                            messages: [{ role: 'user', content: trimmed }]
                        })
                    },
                    60_000
                );
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const parsed = (await response.json()) as {
                    content?: { text?: unknown }[];
                    usage?: { input_tokens?: number; output_tokens?: number };
                };
                if (parsed.usage) {
                    onUsage?.({
                        inputTokens: Number(parsed.usage.input_tokens) || 0,
                        outputTokens: Number(parsed.usage.output_tokens) || 0,
                        cachedTokens: 0,
                        requests: 1
                    });
                }
                return Array.isArray(parsed.content)
                    ? parsed.content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('')
                    : '';
            }, shouldAbort);
            return parseLines(raw);
        }
    } catch {
        return [];
    }
    return [];
}

/* ----------------------------- factory ----------------------------- */

export function createEngine(config: TranslateConfig): TranslationEngine {
    switch (config.engine) {
        case 'libretranslate':
            return createLibreEngine(config);
        case 'deepl':
            return createDeeplEngine(config);
        case 'gemini':
            return createGeminiEngine(config);
        case 'openai':
            return createOpenAiEngine(config);
        case 'anthropic':
            return createAnthropicEngine(config);
        default:
            return createGoogleEngine();
    }
}
