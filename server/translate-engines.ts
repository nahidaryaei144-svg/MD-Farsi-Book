/* Translation providers.

   Every engine exposes the same `translate(texts, target, label, abort)`
   contract, so the job runner can fan out batches in parallel regardless of
   whether the work is done by a machine service or a local language model.
   Providers are created per job, so a config change never mutates a running
   translation. */

import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import type { TranslateConfig } from './translate-config.js';

const MAX_RETRIES = 4;
const GOOGLE_BATCH_ENDPOINT =
    'https://translate.googleapis.com/translate_a/t?client=gtx&sl=auto&dt=t&tl=';
const GOOGLE_SINGLE_ENDPOINT =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&tl=';

class FatalEngineError extends Error {}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

async function withRetry<T>(run: () => Promise<T>, shouldAbort: () => boolean): Promise<T> {
    let lastError: Error = new Error('سرویس ترجمه پاسخ نداد.');
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        if (shouldAbort()) throw new Error('cancelled');
        try {
            return await run();
        } catch (error) {
            lastError = error instanceof Error ? error : lastError;
            if (error instanceof FatalEngineError) throw lastError;
            if (attempt === MAX_RETRIES) break;
            await sleep(Math.min(8000, 500 * Math.pow(2, attempt)) + Math.random() * 320);
        }
    }
    throw lastError;
}

/** Immersive Translate's budgeted recovery: when a whole batch is rejected
    (one malformed item, an over-long request or a protocol violation), split
    it in half a couple of times instead of re-sending every item separately.
    Items still unresolved after the budget stay empty so the book job can
    retry them later rather than hammering the service. */
async function budgetedRecovery(
    texts: string[],
    request: (batch: string[]) => Promise<string[]>,
    shouldAbort: () => boolean,
    singleRequest?: (text: string) => Promise<string>,
    maxRecovery = 2
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
            if (budget <= 0) return;
            budget -= 1;
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
        shouldAbort: () => boolean
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
    shouldAbort: () => boolean
): Promise<string[]> {
    const body = new URLSearchParams();
    for (const text of texts) body.append('q', text);

    return withRetry(async () => {
        const response = await fetchWithTimeout(
            GOOGLE_BATCH_ENDPOINT + target,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                body
            },
            25_000
        );
        if (response.status === 400) {
            throw new FatalEngineError('گوگل این درخواست را نپذیرفت؛ دوباره با متن کوتاه‌تر امتحان کنید.');
        }
        if (response.status === 429) {
            throw new Error('سرویس ترجمه موقتاً درخواست‌ها را محدود کرده است.');
        }
        if (response.status >= 500) {
            throw new Error(`سرویس ترجمه خطای ${response.status} داد.`);
        }
        if (!response.ok) throw new FatalEngineError(`سرویس ترجمه پاسخ ${response.status} داد.`);

        const parsed = extractGoogleBatch(await response.json(), texts.length);
        if (!parsed) throw new Error('پاسخ سرویس ترجمه با درخواست هم‌خوانی نداشت.');
        return parsed;
    }, shouldAbort);
}

async function googleSingle(
    text: string,
    target: string,
    shouldAbort: () => boolean
): Promise<string> {
    return withRetry(async () => {
        const response = await fetchWithTimeout(
            `${GOOGLE_SINGLE_ENDPOINT}${target}&q=${encodeURIComponent(text)}`,
            { method: 'GET' },
            25_000
        );
        if (response.status === 400) throw new FatalEngineError('گوگل این متن را نپذیرفت.');
        if (response.status === 429 || response.status >= 500) {
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
    }, shouldAbort);
}

function createGoogleEngine(): TranslationEngine {
    return {
        id: 'google',
        label: 'گوگل ترنسلیت',
        limits: { maxItems: 24, maxChars: 2400 },
        async translate(texts, target, _label, shouldAbort) {
            if (!texts.length) return [];
            return budgetedRecovery(
                texts,
                (batch) => googleBatch(batch, target, shouldAbort),
                shouldAbort,
                (text) => googleSingle(text, target, shouldAbort)
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
        async translate(texts, target, _label, shouldAbort) {
            if (!texts.length) return [];
            const endpoint = libreEndpoint(config);
            const apiKey = config.apiKey;

            return withRetry(async () => {
                const response = await fetchWithTimeout(
                    endpoint,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            q: texts,
                            source: 'auto',
                            target,
                            format: 'text',
                            ...(apiKey ? { api_key: apiKey } : {})
                        })
                    },
                    40_000
                );
                if (response.status === 401 || response.status === 403) {
                    throw new FatalEngineError('LibreTranslate کلید یا دسترسی را نپذیرفت.');
                }
                if (response.status === 429) {
                    throw new Error('LibreTranslate موقتاً درخواست‌ها را محدود کرده است.');
                }
                if (!response.ok) throw new Error(`LibreTranslate پاسخ ${response.status} داد.`);
                const parsed = (await response.json()) as { translatedText?: unknown };
                const raw = parsed?.translatedText;
                const list = Array.isArray(raw) ? raw.map(String) : [String(raw ?? '')];
                if (list.length !== texts.length) {
                    throw new Error('پاسخ LibreTranslate با درخواست هم‌خوانی نداشت.');
                }
                return list;
            }, shouldAbort);
        }
    };
}

/* ----------------------------- deepl ----------------------------- */

function createDeeplEngine(config: TranslateConfig): TranslationEngine {
    return {
        id: 'deepl',
        label: 'DeepL',
        limits: { maxItems: 40, maxChars: 4500 },
        async translate(texts, target, _label, shouldAbort) {
            if (!texts.length) return [];
            const apiKey = config.apiKey;
            if (!apiKey) throw new FatalEngineError('برای DeepL کلید API لازم است.');
            const base = (config.endpoint || 'https://api-free.deepl.com').replace(/\/+$/, '');
            const body = new URLSearchParams();
            for (const text of texts) body.append('text', text);
            body.set('target_lang', target.toUpperCase());

            return withRetry(async () => {
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
                if (response.status === 429) {
                    throw new Error('DeepL موقتاً درخواست‌ها را محدود کرده است.');
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
            }, shouldAbort);
        }
    };
}

/* ----------------------------- openai-compatible ----------------------------- */

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

/* The multi-item protocol follows Immersive Translate: every source item is
   tagged with its own id line and the list closes with [[source_end]]. Models
   that ignore the protocol and answer with a JSON array are still accepted. */
const ITEM_ID = /^\[\[p(\d+)\]\]\s*(.*)$/;
const PROTOCOL_END = /^\[\[(?:source_end|end|terms)\]\]$/;

function protocolPayload(texts: string[]): string {
    return `${texts.map((text, index) => `[[p${index + 1}]]\n${text}`).join('\n')}\n[[source_end]]`;
}

function cleanTranslation(value: string): string {
    let text = value.trim();
    const fenced = text.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
    if (fenced) text = fenced[1].trim();
    text = text.replace(/^(?:translation|translated text|ترجمهٔ?|译文|翻譯)\s*[:：]\s*/i, '');
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

/* The only rules left in the prompt are the ones the Markdown file itself
   needs: the multi-item envelope (so answers can be matched back to their
   lines) and the markup inside each item (so a translated book stays a valid
   Markdown file). Tone, style, approach and terminology are not prescribed
   here any more; the engine is free, or the user's own instructions decide. */
function structureRules(): string {
    return [
        '## Markdown structure',
        '- Keep the markdown of every item exactly as it is: heading marks (#), list markers, blockquote marks (>), table pipes and rows, footnote markers and definitions ([^1]), links, images, inline code, fenced code blocks, HTML tags, emphasis marks and line breaks.',
        '- Translate only the readable words; leave code, URLs, anchors, ids and markup untouched.',
        '- Do not translate item ids, and do not wrap the whole answer in a code fence.'
    ].join('\n');
}

function protocolRules(): string {
    return [
        '## Multi-item format',
        'The input holds several items. Each item starts with its exact id on its own line ([[p1]], [[p2]], …) followed by that item\'s text, and the list ends with one [[source_end]] line.',
        'Return every id exactly once, unchanged, on its own line, followed by its translated text. A translated item may span multiple lines.'
    ].join('\n');
}

/* Everything the reader wrote in the settings is sent verbatim, in the same
   order the sample translators use: main prompt, glossary, Markdown rules and
   front-matter rules. Empty boxes add nothing at all. */
function systemPrompt(targetLabel: string, config: TranslateConfig): string {
    const parts = [`Translate each item into ${targetLabel}.`, '', structureRules(), '', protocolRules()];

    const prompt = config.prompt.trim();
    if (prompt) parts.push('', '## Translation instructions', prompt);

    const glossary = config.glossary.trim();
    if (glossary) parts.push('', '## Glossary (Arabic = Persian)', glossary);

    const rules = config.rules.trim();
    if (rules) parts.push('', '## Markdown rules', rules);

    const fmRules = config.fmRules.trim();
    if (fmRules) parts.push('', '## Front-matter rules', fmRules);

    return parts.join('\n');
}

export function parseTranslationPayload(content: string, expected: number): string[] | null {
    const trimmed = content
        .trim()
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/, '')
        .trim();

    const collect = (value: unknown): string[] | null => {
        if (Array.isArray(value)) return value.map((item) => String(item ?? ''));
        if (value && typeof value === 'object') {
            const found = Object.values(value as Record<string, unknown>).find((item) =>
                Array.isArray(item)
            );
            if (Array.isArray(found)) return found.map((item) => String(item ?? ''));
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
    if (!values || values.length !== expected) return null;
    return values;
}

function openAiBody(
    texts: string[],
    targetLabel: string,
    config: TranslateConfig
): Record<string, unknown> {
    const body: Record<string, unknown> = {
        model: chatModel(config),
        temperature: 0.15,
        messages: [
            { role: 'system', content: systemPrompt(targetLabel, config) },
            { role: 'user', content: protocolPayload(texts) }
        ]
    };
    return body;
}

async function openAiRequest(
    texts: string[],
    targetLabel: string,
    config: TranslateConfig,
    shouldAbort: () => boolean
): Promise<string[]> {
    const url = chatEndpoint(config);
    const apiKey = config.apiKey;
    const body = openAiBody(texts, targetLabel, config);

    return withRetry(async () => {
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
            throw new Error('سرویس هوش مصنوعی سهمیه یا نرخ درخواست را محدود کرده است.');
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
        };
        const content = parsed?.choices?.[0]?.message?.content;
        const text = typeof content === 'string' ? content : '';
        const values = parseTranslationProtocol(text, texts.length);
        if (!values) throw new Error('پاسخ مدل ساختار درستی نداشت و دوباره درخواست می‌شود.');
        return values;
    }, shouldAbort);
}

function createOpenAiEngine(config: TranslateConfig): TranslationEngine {
    return {
        id: 'openai',
        label: 'هوش مصنوعی',
        limits: { maxItems: 8, maxChars: 1800 },
        async translate(texts, target, targetLabel, shouldAbort) {
            if (!texts.length) return [];
            const label = targetLabel || target;
            return budgetedRecovery(
                texts,
                (batch) => openAiRequest(batch, label, config, shouldAbort),
                shouldAbort
            );
        }
    };
}

/* ----------------------------- anthropic ----------------------------- */

function anthropicEndpoint(config: TranslateConfig): string {
    const base = (config.endpoint || 'https://api.anthropic.com').replace(/\/+$/, '');
    return /\/v1\/messages$/.test(base) ? base : `${base}/v1/messages`;
}

async function anthropicRequest(
    texts: string[],
    targetLabel: string,
    config: TranslateConfig,
    shouldAbort: () => boolean
): Promise<string[]> {
    const apiKey = config.apiKey;
    if (!apiKey) throw new FatalEngineError('برای Claude کلید API لازم است.');
    const url = anthropicEndpoint(config);
    const model = config.model || 'claude-sonnet-4-5';

    return withRetry(async () => {
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
                    system: systemPrompt(targetLabel, config),
                    messages: [{ role: 'user', content: protocolPayload(texts) }]
                })
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
            throw new Error('سهمیه یا نرخ درخواست Anthropic محدود شده است.');
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
            content?: { type?: string; text?: unknown }[];
        };
        const text = Array.isArray(parsed.content)
            ? parsed.content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('')
            : '';
        const values = parseTranslationProtocol(text, texts.length);
        if (!values) throw new Error('پاسخ Claude ساختار درستی نداشت و دوباره درخواست می‌شود.');
        return values;
    }, shouldAbort);
}

function createAnthropicEngine(config: TranslateConfig): TranslationEngine {
    return {
        id: 'anthropic',
        label: 'Anthropic Claude',
        limits: { maxItems: 8, maxChars: 1800 },
        async translate(texts, target, targetLabel, shouldAbort) {
            if (!texts.length) return [];
            const label = targetLabel || target;
            return budgetedRecovery(
                texts,
                (batch) => anthropicRequest(batch, label, config, shouldAbort),
                shouldAbort
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

async function sleepAbortable(ms: number, shouldAbort: () => boolean): Promise<void> {
    let remaining = ms;
    while (remaining > 0) {
        if (shouldAbort()) throw new Error('cancelled');
        const chunk = Math.min(250, remaining);
        await sleep(chunk);
        remaining -= chunk;
    }
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

async function geminiRequest(
    texts: string[],
    targetLabel: string,
    config: TranslateConfig,
    shouldAbort: () => boolean
): Promise<string[]> {
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) {
        throw new FatalEngineError(
            'کلید API جمنای (GEMINI_API_KEY) در سرور تنظیم نشده است. لطفاً در بخش Settings > Secrets کلید را بررسی کنید.'
        );
    }

    const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
            headers: {
                'User-Agent': 'aistudio-build'
            }
        }
    });
    const model = (config.model || '').trim() || DEFAULT_GEMINI_MODEL;
    const sysInstruction = systemPrompt(targetLabel, config);
    const payload = protocolPayload(texts);

    let lastError: Error = new Error('سرویس جمنای پاسخ نداد.');
    for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt += 1) {
        if (shouldAbort()) throw new Error('cancelled');
        try {
            const response = await runGeminiSerialized(
                () =>
                    ai.models.generateContent({
                        model,
                        contents: payload,
                        config: {
                            systemInstruction: sysInstruction,
                            thinkingConfig: {
                                thinkingLevel: ThinkingLevel.LOW
                            }
                        }
                    }),
                shouldAbort
            );

            const text = (response.text ?? '').trim();
            let values = parseTranslationProtocol(text, texts.length);
            if (!values && texts.length === 1 && text) {
                const stripped = cleanTranslation(
                    text
                        .replace(/^\[\[p1\]\]\s*/i, '')
                        .replace(/\s*\[\[(?:source_end|end|terms)\]\]\s*$/i, '')
                );
                if (stripped) values = [stripped];
            }
            if (!values) {
                throw new ProtocolMismatchError('پاسخ جمنای ساختار درستی نداشت.');
            }
            return values;
        } catch (error) {
            if (error instanceof FatalEngineError) throw error;
            if (error instanceof ProtocolMismatchError) {
                if (texts.length > 1 || attempt >= 1) throw error;
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

            lastError = new Error(
                isRateLimit
                    ? 'محدودیت سرعت API رایگان جمنای؛ در حال مکث و تلاش دوباره…'
                    : info.message || 'خطای موقت در ارتباط با جمنای.'
            );

            if (attempt === GEMINI_MAX_RETRIES) break;

            const backoffMs = isRateLimit
                ? info.retryAfterMs ?? Math.min(65_000, 12_000 * (attempt + 1))
                : Math.min(20_000, 3_000 * Math.pow(2, attempt));
            const waitMs = backoffMs + Math.round(Math.random() * 1000);
            geminiNextAllowedAt = Math.max(geminiNextAllowedAt, Date.now() + waitMs);
            await sleepAbortable(waitMs, shouldAbort);
        }
    }
    throw lastError;
}

function createGeminiEngine(config: TranslateConfig): TranslationEngine {
    return {
        id: 'gemini',
        label: 'Google Gemini (رایگان)',
        limits: { maxItems: 20, maxChars: 3600 },
        async translate(texts, target, targetLabel, shouldAbort) {
            if (!texts.length) return [];
            const label = targetLabel || target;
            return budgetedRecovery(
                texts,
                (batch) => geminiRequest(batch, label, config, shouldAbort),
                shouldAbort,
                async (single) => {
                    const [res] = await geminiRequest([single], label, config, shouldAbort);
                    return res ?? '';
                }
            );
        }
    };
}

/* ----------------------------- factory ----------------------------- */

/* Machine translators take no instructions, so their answer is written back
   exactly as it arrived. Nothing is rewritten, substituted or normalized on
   the way: the reader's text and the engine's output are the only content. */
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
