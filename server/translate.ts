/* Automatic book translation engine.
   Splits a markdown book into translatable text segments (keeping all markdown
   syntax, links, code and tables intact), translates them with several parallel
   workers against the selected provider (Google, LibreTranslate, DeepL or any
   OpenAI-compatible AI model, online or local), keeps a translation memory in
   storage, writes the result back to the original file atomically and reports
   live progress.

   Segmentation, request batching and the AI multi-item protocol follow the
   rules Immersive Translate uses: sentence-aware splitting that keeps every
   clause whole, a per-item id protocol with [[source_end]], and budgeted
   recursive recovery for rejected batches.

   A page of the book is also one request: the lines between two `---` rules
   are sent together, exactly as the reading view shows them. A page that is
   bigger than the engine accepts is divided on paragraph boundaries into a few
   evenly sized requests instead of one full request and a leftover.

   Translation itself is not restricted: no wording, style or script rules are
   applied to the output, and the only instructions sent to an AI engine are
   the ones that keep the Markdown file valid plus whatever the reader typed in
   settings. Machine engines such as Google translate freely on their own.

   It can also re-scan a book that was translated before: segments that were
   left in the source language, or whose stored translation is empty or
   half-translated, are found in one fast pass and repaired. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { STORAGE_DIR } from './config.js';
import { createBookSnapshot } from './backups.js';
import { parseFrontmatter, resolveBookPath, serializeBookFrontmatter } from './library.js';
import { HttpError } from './http.js';
import { readTranslateConfig, type TranslateConfig, type TranslateOrder } from './translate-config.js';
import { createEngine, type TranslationEngine } from './translate-engines.js';

const MEMORY_FILE = path.join(STORAGE_DIR, 'translation-memory.json');
/* The memory is a cache, not an archive: its file is kept under 10 MB so it can
   never grow without bound. Once the budget is full the oldest translations
   are dropped first and only the newest ones stay. */
const MEMORY_LIMIT_BYTES = 10 * 1024 * 1024;
const FLUSH_INTERVAL_MS = 1600;
const MAX_CONSECUTIVE_FAILURES = 6;
const TRANSLATOR_LABEL = 'ترجمهٔ ماشینی';

export type TranslationStatus = 'idle' | 'running' | 'paused' | 'done' | 'cancelled' | 'error';
export type TranslationMode = 'translate' | 'review';

export interface TranslationSample {
    source: string;
    translated: string;
}

export interface TranslationJob {
    id: string;
    filename: string;
    title: string;
    target: string;
    targetLabel: string;
    mode: TranslationMode;
    engine: string;
    engineLabel: string;
    parallel: number;
    status: TranslationStatus;
    total: number;
    done: number;
    translated: number;
    cached: number;
    skipped: number;
    failed: number;
    inspected: number;
    repaired: number;
    characters: number;
    startedAt: string | null;
    finishedAt: string | null;
    updatedAt: string;
    snapshotId: string | null;
    revision: string | null;
    message: string;
    samples: TranslationSample[];
    speed: number;
    etaSeconds: number | null;
    bilingual?: boolean;
}

export interface TranslationEstimate {
    filename: string;
    target: string;
    targetLabel: string;
    mode: TranslationMode;
    engine: string;
    engineLabel: string;
    segments: number;
    candidates: number;
    cached: number;
    skipped: number;
    untranslated: number;
    suspicious: number;
    characters: number;
}

/* ----------------------------- markdown model ----------------------------- */

interface TextToken {
    type: 'text';
    id: number;
    value: string;
}

interface FixedToken {
    type: 'fixed';
    value: string;
}

type Token = TextToken | FixedToken;

interface Line {
    tokens: Token[];
    ending: string;
    alreadyBilingual?: boolean;
}

/* The table of contents is translated before the body when the reader picks
   the structured order, so the segments remember which part they belong to. */
type SegmentZone = 'toc' | 'body';

interface Segment {
    id: number;
    value: string;
    /* Page and source line the segment came from: pages are delimited by a
       `---` rule, and a line is one paragraph of that page. */
    page: number;
    block: number;
    zone: SegmentZone;
}

interface BookModel {
    frontmatter: string;
    lines: Line[];
    segments: Segment[];
}

interface TokenState {
    next: number;
    segments: Segment[];
    page: number;
    block: number;
    zone: SegmentZone;
}

function tokenizeInline(text: string, state: TokenState): Token[] {
    const tokens: Token[] = [];
    let buffer = '';

    const flush = () => {
        if (!buffer) return;
        const id = state.next;
        state.next += 1;
        state.segments.push({
            id,
            value: buffer,
            page: state.page,
            block: state.block,
            zone: state.zone
        });
        tokens.push({ type: 'text', id, value: buffer });
        buffer = '';
    };

    const addFixed = (value: string) => {
        flush();
        tokens.push({ type: 'fixed', value });
    };

    for (let i = 0; i < text.length; ) {
        if (text[i] === '`') {
            const run = text.slice(i).match(/^`+/);
            if (run) {
                const end = text.indexOf(run[0], i + run[0].length);
                if (end >= 0) {
                    addFixed(text.slice(i, end + run[0].length));
                    i = end + run[0].length;
                    continue;
                }
            }
        }
        if (text[i] === '<') {
            const biMatch = text
                .slice(i)
                .match(/^<span\b[^>]*\bclass=["'][^"']*\bbi-orig\b[^"']*["'][^>]*>/i);
            if (biMatch) {
                let cursor = i + biMatch[0].length;
                let depth = 1;
                while (cursor < text.length && depth > 0) {
                    const nextOpen = text.indexOf('<span', cursor);
                    const nextClose = text.indexOf('</span>', cursor);
                    if (nextClose < 0) break;
                    if (nextOpen >= 0 && nextOpen < nextClose) {
                        depth += 1;
                        cursor = nextOpen + 5;
                    } else {
                        depth -= 1;
                        cursor = nextClose + 7;
                    }
                }
                if (depth === 0) {
                    addFixed(text.slice(i, cursor));
                    i = cursor;
                    continue;
                }
            }
            const end = text.indexOf('>', i + 1);
            if (end >= 0) {
                addFixed(text.slice(i, end + 1));
                i = end + 1;
                continue;
            }
        }
        if (text.startsWith('http://', i) || text.startsWith('https://', i)) {
            const match = text.slice(i).match(/^https?:\/\/[^\s<>)]+/i);
            if (match) {
                addFixed(match[0]);
                i += match[0].length;
                continue;
            }
        }
        if (text[i] === '!' && text[i + 1] === '[') {
            const close = text.indexOf('](', i + 2);
            const end = close >= 0 ? text.indexOf(')', close) : -1;
            if (end >= 0) {
                addFixed(text.slice(i, close + 2));
                tokens.push(...tokenizeInline(text.slice(i + 2, close), state));
                addFixed(text.slice(close + 2, end + 1));
                i = end + 1;
                continue;
            }
        }
        if (text[i] === '[' && text[i + 1] === '^') {
            const end = text.indexOf(']', i + 2);
            if (end >= 0) {
                addFixed(text.slice(i, end + 1));
                i = end + 1;
                continue;
            }
        }
        /* Obsidian-style callout markers ([!info], [!warning]) are structural:
           the reader styles the box by them, so they are never translated. */
        if (text[i] === '[' && text[i + 1] === '!') {
            const end = text.indexOf(']', i + 2);
            if (end >= 0) {
                addFixed(text.slice(i, end + 1));
                i = end + 1;
                continue;
            }
        }
        if (text[i] === '[') {
            const close = text.indexOf('](', i + 1);
            const end = close >= 0 ? text.indexOf(')', close) : -1;
            if (end >= 0) {
                addFixed('[');
                tokens.push(...tokenizeInline(text.slice(i + 1, close), state));
                addFixed(text.slice(close, end + 1));
                i = end + 1;
                continue;
            }
        }
        if ('*_~|[]()!`#>'.includes(text[i])) {
            addFixed(text[i]);
            i += 1;
            continue;
        }
        if (text[i] === '\\' && i + 1 < text.length) {
            addFixed(text.slice(i, i + 2));
            i += 2;
            continue;
        }
        buffer += text[i];
        i += 1;
    }
    flush();
    return tokens;
}

function tokenizeLine(
    line: string,
    fence: { active: boolean },
    state: TokenState
): Token[] {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) fence.active = !fence.active;
    /* Four-space indentation only means a code block when the line is not part
       of a markdown structure; converted books indent nested table-of-contents
       items and quoted poetry that still need translating. */
    const indentedCode =
        /^ {4,}\S/.test(line) &&
        !/^ *(?:[-+*]|\d+[.)])\s+/.test(line) &&
        !/^ *(?:>|#{1,6}\s)/.test(line) &&
        !/^ *\|/.test(line);

    const fixedLine =
        fence.active ||
        Boolean(fenceMatch) ||
        indentedCode ||
        /^\s*$/.test(line) ||
        /^\s*---\s*$/.test(line) ||
        /^\s*==پاورقی‌ها==\s*$/.test(line) ||
        /* Footnote section headings are structural: the reader uses them to
           find the note list, so they must keep their Persian wording. */
        /^\s*#{1,6}\s+پاورقی/i.test(line) ||
        /^\s*>\s*پاورقی/i.test(line) ||
        /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);

    if (fixedLine) return line ? [{ type: 'fixed', value: line }] : [];

    let rest = line;
    let prefix = '';
    const indent = rest.match(/^ +/);
    if (indent) {
        prefix += indent[0];
        rest = rest.slice(indent[0].length);
    }
    let changed = true;
    while (changed && rest) {
        changed = false;
        const match =
            rest.match(/^ {0,3}>\s?/) ||
            rest.match(/^ {0,3}#{1,6}\s+/) ||
            rest.match(/^ {0,3}(?:[-+*]|\d+[.)])\s+/);
        if (match) {
            prefix += match[0];
            rest = rest.slice(match[0].length);
            changed = true;
        }
    }

    /* Footnote markers stay fixed while the note text itself is translated. */
    const wikiFootnote = rest.match(/^\[\^[^\]]+\]:\s*/);
    const numberedFootnote = rest.match(/^\(?¬\s*[\d\u06F0-\u06F9]+\)?\s*/);
    if (wikiFootnote) {
        prefix += wikiFootnote[0];
        rest = rest.slice(wikiFootnote[0].length);
    } else if (numberedFootnote) {
        prefix += numberedFootnote[0];
        rest = rest.slice(numberedFootnote[0].length);
    }

    const tokens: Token[] = [];
    if (prefix) tokens.push({ type: 'fixed', value: prefix });
    tokens.push(...tokenizeInline(rest, state));
    return tokens;
}

/* A heading that opens the table of contents, in either language the books of
   this library use. */
const TOC_HEADING =
    /^\s{0,3}#{1,6}\s+(?:فهرست(?: مطالب| موضوعات| محتويات)?|محتويات(?: الكتاب)?|المحتويات|جدول المحتويات)\s*$/u;

function buildModel(content: string): BookModel {
    const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    const frontmatter = match ? match[0] : '';
    const body = match ? content.slice(match[0].length) : content.replace(/^\uFEFF/, '');

    const state: TokenState = { next: 1, segments: [], page: 1, block: 1, zone: 'body' };
    const lines: Line[] = [];
    const parts = body.split(/(\r\n|\n|\r)/);
    const fence = { active: false };
    let page = 1;
    /* Everything under the table-of-contents heading, down to the next heading
       of the same level or higher, belongs to the contents. */
    let tocLevel = 0;
    for (let index = 0; index < parts.length; index += 2) {
        const line = parts[index] || '';
        const ending = parts[index + 1] || '';
        const inCode = fence.active;
        const heading = inCode ? null : line.match(/^\s{0,3}(#{1,6})\s+/);
        if (heading) {
            const level = heading[1].length;
            if (tocLevel && level <= tocLevel) tocLevel = 0;
            if (!tocLevel && TOC_HEADING.test(line)) tocLevel = level;
        }
        state.zone = tocLevel ? 'toc' : 'body';
        state.page = page;
        state.block = lines.length;
        const tokenized = tokenizeLine(line, fence, state);
        /* A line holding only `---` separates two pages of the book, exactly as
           the reading view splits it. A ruler inside a code block is not one. */
        if (!inCode && /^\s*---\s*$/.test(line)) page += 1;
        const alreadyBilingual = /<span\b[^>]*\bclass=["'][^"']*\bbi-orig\b/i.test(line);
        lines.push({ tokens: tokenized, ending, alreadyBilingual });
    }

    return { frontmatter, lines, segments: state.segments };
}

function renderTokensOrig(tokens: Token[]): string {
    return tokens.map((token) => token.value).join('');
}

function renderTokensTrans(
    tokens: Token[],
    translations: Map<number, string>,
    normalize: (value: string) => string,
    stripAnchors = false
): string {
    return tokens
        .map((token) => {
            if (token.type === 'text') return normalize(translations.get(token.id) ?? token.value);
            if (stripAnchors && /^<a\b[^>]*\bid=/i.test(token.value)) return '';
            return token.value;
        })
        .join('');
}

function isMarkdownTableRow(tokens: Token[]): boolean {
    let pipeCount = 0;
    let firstNonSpace = '';
    for (const token of tokens) {
        if (token.type === 'fixed' && token.value === '|') pipeCount += 1;
        if (!firstNonSpace && token.value.trim()) firstNonSpace = token.value.trim();
    }
    return pipeCount >= 2 && firstNonSpace.startsWith('|');
}

function renderBilingualTableRow(
    line: Line,
    translations: Map<number, string>,
    normalize: (value: string) => string
): string {
    const groups: Token[][] = [];
    let current: Token[] = [];
    for (const token of line.tokens) {
        if (token.type === 'fixed' && token.value === '|') {
            groups.push(current);
            current = [];
        } else {
            current.push(token);
        }
    }
    groups.push(current);

    if (groups.length < 3) {
        return renderTokensTrans(line.tokens, translations, normalize) + line.ending;
    }

    const rendered = groups.map((cellTokens, idx) => {
        if (idx === 0 || idx === groups.length - 1) {
            return renderTokensOrig(cellTokens);
        }
        const orig = renderTokensOrig(cellTokens).trim();
        const trans = renderTokensTrans(cellTokens, translations, normalize, true).trim();
        if (!orig || !trans || orig === trans) return renderTokensTrans(cellTokens, translations, normalize);
        return ` <span class="bi-orig">${orig}</span><br><span class="bi-trans">${trans}</span> `;
    });

    return rendered.join('|') + line.ending;
}

function renderBody(
    model: BookModel,
    translations: Map<number, string>,
    normalize: (value: string) => string = (value) => value,
    options?: { bilingual?: boolean; newline?: string }
): string {
    const bilingual = options?.bilingual === true;
    const paraSep = (options?.newline || '\n').repeat(2);

    return model.lines
        .map((line) => {
            if (!bilingual || line.alreadyBilingual) {
                return (
                    line.tokens
                        .map((token) =>
                            token.type === 'text'
                                ? normalize(translations.get(token.id) ?? token.value)
                                : token.value
                        )
                        .join('') + line.ending
                );
            }

            const hasTranslated = line.tokens.some(
                (token) =>
                    token.type === 'text' &&
                    translations.has(token.id) &&
                    translations.get(token.id)!.trim() !== token.value.trim()
            );
            if (!hasTranslated) {
                return renderTokensOrig(line.tokens) + line.ending;
            }

            if (isMarkdownTableRow(line.tokens)) {
                return renderBilingualTableRow(line, translations, normalize);
            }

            let splitAt = 0;
            if (
                line.tokens[0]?.type === 'fixed' &&
                /^(?:\s+| {0,3}>.*| {0,3}#{1,6}\s+.*| {0,3}(?:[-+*]|\d+[.)])\s+.*|\[\^[^\]]+\]:\s*|\(?¬\s*[\d\u06F0-\u06F9]+\)?\s*)$/.test(
                    line.tokens[0].value
                )
            ) {
                splitAt = 1;
            }
            while (
                splitAt < line.tokens.length &&
                line.tokens[splitAt].type === 'fixed' &&
                /^<a\b[^>]*\bid=/i.test(line.tokens[splitAt].value)
            ) {
                splitAt += 1;
            }

            const prefix = renderTokensOrig(line.tokens.slice(0, splitAt));
            const restTokens = line.tokens.slice(splitAt);
            const origRest = renderTokensOrig(restTokens).trim();
            const transRest = renderTokensTrans(restTokens, translations, normalize, true).trim();

            if (!origRest || !transRest || origRest === transRest) {
                return renderTokensTrans(line.tokens, translations, normalize) + line.ending;
            }

            const isStructured = /(?:^|\s)(?:#{1,6}\s|>\s?|[-+*]\s|\d+[.)]\s)|\[\^[^\]]+\]:|\(?¬/.test(
                prefix
            );
            if (isStructured) {
                return `${prefix}<span class="bi-orig">${origRest}</span><br><span class="bi-trans">${transRest}</span>${line.ending}`;
            }

            return `${prefix}<span class="bi-orig">${origRest}</span>${paraSep}<span class="bi-trans">${transRest}</span>${line.ending}`;
        })
        .join('');
}

/* ----------------------------- what to translate ----------------------------- */

/* No language list and no word list decides what is translated: every segment
   that carries at least one letter is sent to the engine. Only letter-free
   fragments (punctuation, numbers, symbols) are skipped, because a translator
   has nothing to do with them. */
function hasLetters(value: string): boolean {
    return /[\p{L}\p{M}]/u.test(value);
}

/* No wording, length or script is judged any more: whatever the engine (or the
   reader's own prompt) returned is written back as it is. Only an empty answer
   counts as a failure, because there is nothing to write. */
function translationLooksWrong(_source: string, result: string, _target: string): boolean {
    return !result.trim();
}

/* ----------------------------- length handling ----------------------------- */

/* A long paragraph is split on sentence boundaries so every clause stays whole
   and each part can be cached on its own. This is only a request-size guard;
   batch size, concurrency and how finely the text is split belong to the
   reader, not to a fixed preset. */
const SEGMENT_CHARS = 1800;
const SENTENCE_END = /[.!?؟۔…]/;
const CLOSING_MARK = /["'”’»›)\]}）］｝】〕〉》」』]/;
const ABBREVIATION =
    /(?:^|\s)(?:etc|Mr|Mrs|Ms|Dr|Prof|No|vs|St|Jr|Sr|Inc|Ltd|e\.g|i\.e|a\.m|p\.m)\.$/i;

function splitSentences(core: string): string[] {
    const pieces: string[] = [];
    let start = 0;
    for (let index = 0; index < core.length; index += 1) {
        const char = core[index];
        if (!SENTENCE_END.test(char)) continue;
        if (char === '.' && /\d/.test(core[index - 1] ?? '') && /\d/.test(core[index + 1] ?? '')) continue;
        if (char === '.' && ABBREVIATION.test(core.slice(start, index + 1))) continue;
        let end = index + 1;
        while (end < core.length && CLOSING_MARK.test(core[end])) end += 1;
        if (end < core.length && !/\s/.test(core[end])) continue;
        const piece = core.slice(start, end).trim();
        if (piece) pieces.push(piece);
        start = end;
        index = end - 1;
    }
    const tail = core.slice(start).trim();
    if (tail) pieces.push(tail);
    return pieces.length ? pieces : [core];
}

function splitOversize(text: string, limit: number): string[] {
    const parts: string[] = [];
    let rest = text;
    const floor = Math.max(80, Math.floor(limit / 2));
    while (rest.length > limit) {
        let cut = -1;
        for (let index = Math.min(rest.length - 1, limit); index >= floor; index -= 1) {
            if ('،,؛;:：'.includes(rest[index])) {
                cut = index + 1;
                break;
            }
        }
        if (cut < 0) {
            for (let index = Math.min(rest.length - 1, limit); index >= floor; index -= 1) {
                if (/\s/.test(rest[index])) {
                    cut = index + 1;
                    break;
                }
            }
        }
        if (cut <= 0) cut = Math.min(rest.length, limit);
        const head = rest.slice(0, cut).trim();
        if (head) parts.push(head);
        rest = rest.slice(cut);
    }
    const tail = rest.trim();
    if (tail) parts.push(tail);
    return parts.length ? parts : [text];
}

function splitForLength(core: string, limit: number): string[] {
    if (core.length <= limit) return [core];
    const parts: string[] = [];
    let buffer = '';
    for (const sentence of splitSentences(core)) {
        if (buffer && buffer.length + sentence.length + 1 > limit) {
            parts.push(buffer);
            buffer = sentence;
        } else {
            buffer = buffer ? `${buffer} ${sentence}` : sentence;
        }
    }
    if (buffer) parts.push(buffer);

    const output: string[] = [];
    for (const part of parts) {
        if (part.length <= limit) output.push(part);
        else output.push(...splitOversize(part, limit));
    }
    return output.length ? output : [core];
}

function joinSeparator(): string {
    return ' ';
}

interface SpaceSplit {
    lead: string;
    core: string;
    trail: string;
}

function outerSpaces(value: string): SpaceSplit {
    const lead = value.match(/^\s*/)?.[0] ?? '';
    const trail = value.match(/\s*$/)?.[0] ?? '';
    if (lead.length + trail.length >= value.length) return { lead: '', core: '', trail: value };
    return { lead, core: value.slice(lead.length, value.length - trail.length), trail };
}

/* ----------------------------- translation memory ----------------------------- */

let memory: Map<string, string> | null = null;
let memoryDirty = false;

function memoryKey(target: string, value: string): string {
    return `${target}:${crypto.createHash('sha1').update(value).digest('hex')}`;
}

function memoryEntryBytes(key: string, value: string): number {
    /* `"key":"value",` in the JSON payload plus the stored strings. */
    return Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8') + 6;
}

/** Drops the oldest entries until the whole memory fits its 10 MB budget. */
function trimMemory(store: Map<string, string>): void {
    let total = 0;
    for (const [key, value] of store) total += memoryEntryBytes(key, value);
    while (store.size > 0 && total > MEMORY_LIMIT_BYTES) {
        const oldest = store.keys().next();
        if (oldest.done) break;
        const value = store.get(oldest.value) ?? '';
        total -= memoryEntryBytes(oldest.value, value);
        store.delete(oldest.value);
    }
}

async function loadMemory(): Promise<Map<string, string>> {
    if (memory) return memory;
    const map = new Map<string, string>();
    try {
        const raw = await fs.promises.readFile(MEMORY_FILE, 'utf8');
        const parsed = JSON.parse(raw) as { entries?: Record<string, unknown> };
        const entries = parsed && typeof parsed === 'object' && parsed.entries ? parsed.entries : {};
        for (const [key, value] of Object.entries(entries)) {
            if (typeof value === 'string' && value.trim()) map.set(key, value);
        }
    } catch {
        /* a missing or broken memory file simply starts empty */
    }
    memory = map;
    /* A memory file written by an older version may already be too big; it is
       trimmed in place and saved this way on the next flush. */
    const before = map.size;
    trimMemory(map);
    if (map.size !== before) memoryDirty = true;
    return map;
}

async function persistMemory(force = false): Promise<void> {
    if (!memory || (!memoryDirty && !force)) return;
    const store = memory;
    trimMemory(store);
    const payload = JSON.stringify({ version: 1, entries: Object.fromEntries(store) });
    const tempPath = `${MEMORY_FILE}.${Date.now()}.tmp`;
    try {
        await fs.promises.mkdir(path.dirname(MEMORY_FILE), { recursive: true });
        await fs.promises.writeFile(tempPath, payload, 'utf8');
        await fs.promises.rename(tempPath, MEMORY_FILE);
        memoryDirty = false;
    } catch {
        await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    }
}

/* ----------------------------- planning ----------------------------- */

const control = { paused: false, cancelled: false };

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

interface QueueTarget {
    id: number;
    lead: string;
    trail: string;
}

interface QueueItem {
    core: string;
    parts: string[];
    values: (string | null)[];
    resolved: number;
    settled: boolean;
    /* Literal separators between the translated parts of a split paragraph. */
    template: string[];
    targets: QueueTarget[];
    page: number;
    block: number;
    zone: SegmentZone;
}

interface WorkUnit {
    item: number;
    part: number;
    text: string;
    page: number;
    block: number;
}

interface PlanOptions {
    mode: TranslationMode;
    force: boolean;
    apply: boolean;
}

interface Plan {
    translations: Map<number, string>;
    queue: QueueItem[];
    segments: number;
    queuedSegments: number;
    skipped: number;
    cached: number;
    characters: number;
    inspected: number;
    untranslated: number;
    suspicious: number;
}

function linearTemplate(parts: string[], separator: string): string[] {
    return Array.from({ length: parts.length + 1 }, (_, index) =>
        index === 0 || index === parts.length ? '' : separator
    );
}

function createQueueItem(core: string, page: number, block: number, zone: SegmentZone): QueueItem {
    const parts = splitForLength(core, SEGMENT_CHARS);
    return {
        core,
        parts,
        values: parts.map(() => null),
        resolved: 0,
        settled: false,
        template: linearTemplate(parts, joinSeparator()),
        targets: [],
        page,
        block,
        zone
    };
}

function planTranslation(
    model: BookModel,
    target: string,
    store: Map<string, string>,
    options: PlanOptions
): Plan {
    const translations = new Map<number, string>();
    const byCore = new Map<string, QueueItem>();
    const queue: QueueItem[] = [];
    let skipped = 0;
    let cached = 0;
    let characters = 0;
    let inspected = 0;
    let untranslated = 0;
    let suspicious = 0;
    let queuedSegments = 0;

    for (const segment of model.segments) {
        inspected += 1;
        const { lead, core, trail } = outerSpaces(segment.value);
        if (!core) {
            skipped += 1;
            continue;
        }
        if (!hasLetters(core)) {
            skipped += 1;
            continue;
        }

        const key = memoryKey(target, core);
        const remembered = store.get(key);
        const rememberedOk =
            typeof remembered === 'string' && !translationLooksWrong(core, remembered, target);

        /* Review mode deliberately ignores the memory, so every segment is sent
           again and repaired. Normal mode reuses anything already translated
           unless the reader asked to ignore the memory. */
        if (remembered && !options.force && options.mode === 'translate' && rememberedOk) {
            translations.set(segment.id, `${lead}${remembered}${trail}`);
            cached += 1;
            continue;
        }
        if (remembered && options.apply && (!rememberedOk || options.mode === 'review')) store.delete(key);
        if (options.mode === 'review') untranslated += 1;

        queuedSegments += 1;
        let item = byCore.get(core);
        if (!item) {
            item = createQueueItem(core, segment.page, segment.block, segment.zone);
            byCore.set(core, item);
            queue.push(item);
            characters += core.length;
        }
        item.targets.push({ id: segment.id, lead, trail });
    }

    return {
        translations,
        queue,
        segments: model.segments.length,
        queuedSegments,
        skipped,
        cached,
        characters,
        inspected,
        untranslated,
        suspicious
    };
}

/* ----------------------------- job ----------------------------- */

interface JobContext {
    job: TranslationJob;
    filename: string;
    filePath: string;
    model: BookModel;
    translations: Map<number, string>;
    queue: QueueItem[];
    store: Map<string, string>;
    revision: string;
    frontmatter: string;
    newline: string;
    markTranslator: boolean;
    bilingual: boolean;
    engine: TranslationEngine;
    order: TranslateOrder;
    /* Front-matter values are translated once and reused by every flush. */
    frontmatterCache?: string;
}

let activeJob: TranslationJob | null = null;

function touch(job: TranslationJob): void {
    job.updatedAt = new Date().toISOString();
    if (!job.startedAt) return;
    const elapsed = (Date.now() - Date.parse(job.startedAt)) / 1000;
    if (elapsed <= 0) return;
    job.speed = job.done / elapsed;
    const remaining = Math.max(0, job.total - job.done);
    job.etaSeconds = job.speed > 0.001 ? Math.round(remaining / job.speed) : null;
}

function revisionOf(stat: fs.Stats): string {
    return `${stat.size}-${Math.floor(stat.mtimeMs)}`;
}

async function writeBookFile(filePath: string, content: string, expected: string | null): Promise<string> {
    const stat = await fs.promises.stat(filePath);
    if (expected && revisionOf(stat) !== expected) {
        throw new Error('فایل کتاب بیرون از این ابزار تغییر کرده است؛ ترجمه متوقف شد.');
    }
    const tempPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.translate-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`
    );
    try {
        await fs.promises.writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx' });
        await fs.promises.rename(tempPath, filePath);
    } catch (error) {
        await fs.promises.rm(tempPath, { force: true }).catch(() => {});
        throw error;
    }
    const after = await fs.promises.stat(filePath);
    return revisionOf(after);
}

const YAML_VALUE_LINE = /^(\s*[^:\n]+:\s*)(.*)$/;
const YAML_PLAIN_SCALAR = /^(?:true|false|null|~|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/i;

function unquoteYaml(value: string): { text: string; quote: string } {
    const trimmed = value.trim();
    if (trimmed.length >= 2) {
        const quote = trimmed[0];
        if ((quote === '"' || quote === "'") && trimmed[trimmed.length - 1] === quote) {
            return { text: trimmed.slice(1, -1), quote };
        }
    }
    return { text: trimmed, quote: '' };
}

function yamlNeedsTranslation(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (YAML_PLAIN_SCALAR.test(trimmed)) return false;
    return /[\p{L}\p{M}]/u.test(trimmed);
}

/** Front-matter values are translated line by line from the raw YAML, so the
    file keeps its exact keys, order, quotes and layout. Every key is handled
    the same way — no field name is predefined — and keys themselves are never
    translated. Numbers, booleans and empty values stay untouched. */
async function localizedFrontmatter(ctx: JobContext): Promise<string> {
    if (ctx.frontmatterCache !== undefined) return ctx.frontmatterCache;
    const raw = ctx.frontmatter;
    if (!raw) {
        ctx.frontmatterCache = raw;
        return raw;
    }

    const lines = raw.split('\n');
    const pending: { index: number; prefix: string; text: string; quote: string; key: string }[] = [];
    lines.forEach((line, index) => {
        if (!line.trim() || /^-{3,}\s*$/.test(line.trim())) return;
        /* List items (tags) identify the book elsewhere in the app; they are
           kept exactly as written. */
        if (/^\s*-\s/.test(line)) return;
        const match = line.match(YAML_VALUE_LINE);
        if (!match) return;
        const { text, quote } = unquoteYaml(match[2]);
        if (!yamlNeedsTranslation(text)) return;
        pending.push({
            index,
            prefix: match[1],
            text,
            quote,
            key: match[1].replace(/:\s*$/, '').trim()
        });
    });

    if (pending.length) {
        /* An AI model gets the key with the value so it knows what it is
           translating (title, author, volume…); a machine engine gets the bare
           value, because it would otherwise translate the pair as prose. */
        const withKey =
            ctx.engine.id === 'openai' || ctx.engine.id === 'anthropic' || ctx.engine.id === 'gemini';
        let values: string[] = [];
        try {
            values = await ctx.engine.translate(
                pending.map((item) => (withKey ? `${item.key}: ${item.text}` : item.text)),
                ctx.job.target,
                ctx.job.targetLabel,
                () => false
            );
        } catch {
            /* an unreachable engine leaves the front-matter exactly as it was */
            values = [];
        }
        pending.forEach((item, index) => {
            let value = String(values[index] ?? '').trim();
            if (!value) return;
            const separator = value.indexOf(':');
            if (withKey && separator > 0 && separator < 80) value = value.slice(separator + 1).trim();
            value = unquoteYaml(value).text;
            if (!value) return;
            lines[item.index] = `${item.prefix}${item.quote}${value}${item.quote}`;
        });
    }

    let result = lines.join('\n');
    if (ctx.markTranslator) {
        const meta = parseFrontmatter(result);
        if (!String(meta['مترجم'] ?? '').trim()) {
            meta['مترجم'] = TRANSLATOR_LABEL;
            result = serializeBookFrontmatter(meta, ctx.newline, ctx.filename);
        }
    }
    ctx.frontmatterCache = result;
    return result;
}

async function flushJob(ctx: JobContext, final = false): Promise<void> {
    /* In the structured order the book's own information is translated before
       anything else, so it is written to the file from the first flush on. */
    const frontmatter =
        final || ctx.order === 'structured' ? await localizedFrontmatter(ctx) : ctx.frontmatter;
    const content =
        frontmatter +
        renderBody(ctx.model, ctx.translations, undefined, {
            bilingual: ctx.bilingual,
            newline: ctx.newline
        });
    ctx.revision = await writeBookFile(ctx.filePath, content, ctx.revision);
    ctx.job.revision = ctx.revision;
    await persistMemory();
}

function buildUnits(queue: QueueItem[], only?: Set<number>): WorkUnit[] {
    const units: WorkUnit[] = [];
    queue.forEach((item, index) => {
        if (only && !only.has(index)) return;
        item.parts.forEach((part, partIndex) => {
            units.push({
                item: index,
                part: partIndex,
                text: part,
                page: item.page,
                block: item.block
            });
        });
    });
    /* Reading order is kept: pages must stay whole and in sequence, so the units
       are no longer sorted by length. */
    return units;
}

/* ----------------------------- request plan ----------------------------- */

/* The book marks its pages with a line holding only `---`, and that is also the
   unit of translation: all paragraphs of a page travel in one request, so the
   engine reads the page as the reader does. When a page is larger than the
   engine accepts, it is divided on paragraph boundaries into as few requests as
   it needs, evenly sized — ten paragraphs become five and five, never nine and
   one. Only a single paragraph that is too long on its own is cut inside
   itself, and splitForLength already does that on sentence boundaries. */

interface Pack {
    block: number;
    units: WorkUnit[];
}

function packChars(pack: Pack): number {
    return pack.units.reduce((sum, unit) => sum + unit.text.length, 0);
}

/* Cuts a list at its own boundaries, as close to equal weight as possible. Both
   helpers below share the same rule: each piece keeps at least one entry and
   leaves one for every piece still to come. */
function splitUnits(units: WorkUnit[], count: number): WorkUnit[][] {
    const total = units.reduce((sum, unit) => sum + unit.text.length, 0);
    const cumulative: number[] = [];
    let running = 0;
    for (const unit of units) {
        running += unit.text.length;
        cumulative.push(running);
    }
    const batches: WorkUnit[][] = [];
    let start = 0;
    for (let index = 1; index <= count; index += 1) {
        let end = units.length;
        if (index < count) {
            const target = (total * index) / count;
            end = start + 1;
            while (end < units.length - (count - index) && cumulative[end - 1] < target) end += 1;
        }
        batches.push(units.slice(start, end));
        start = end;
    }
    return batches;
}

function splitPacks(packs: Pack[], count: number): Pack[][] {
    const total = packs.reduce((sum, pack) => sum + packChars(pack), 0);
    const cumulative: number[] = [];
    let running = 0;
    for (const pack of packs) {
        running += packChars(pack);
        cumulative.push(running);
    }
    const groups: Pack[][] = [];
    let start = 0;
    for (let index = 1; index <= count; index += 1) {
        let end = packs.length;
        if (index < count) {
            const target = (total * index) / count;
            end = start + 1;
            while (end < packs.length - (count - index) && cumulative[end - 1] < target) end += 1;
        }
        groups.push(packs.slice(start, end));
        start = end;
    }
    return groups;
}

/* Last resort for one paragraph that is still too big for a single request. */
function unitBatches(units: WorkUnit[], limitChars: number, maxItems: number): WorkUnit[][] {
    if (units.length <= 1) return units.length ? [units] : [];
    const total = units.reduce((sum, unit) => sum + unit.text.length, 0);
    if (units.length <= maxItems && total <= limitChars) return [units];
    const count = Math.min(
        units.length,
        Math.max(2, Math.ceil(total / limitChars), Math.ceil(units.length / maxItems))
    );
    const parts = count >= units.length ? units.map((unit) => [unit]) : splitUnits(units, count);
    return parts.flatMap((part) => unitBatches(part, limitChars, maxItems));
}

function planBatches(units: WorkUnit[], limitChars: number, maxItems: number): WorkUnit[][] {
    const pages: { page: number; packs: Pack[] }[] = [];
    for (const unit of units) {
        let page = pages[pages.length - 1];
        if (!page || page.page !== unit.page) {
            page = { page: unit.page, packs: [] };
            pages.push(page);
        }
        let pack = page.packs[page.packs.length - 1];
        if (!pack || pack.block !== unit.block) {
            pack = { block: unit.block, units: [] };
            page.packs.push(pack);
        }
        pack.units.push(unit);
    }

    const batches: WorkUnit[][] = [];
    for (const page of pages) {
        const total = page.packs.reduce((sum, pack) => sum + packChars(pack), 0);
        const count = page.packs.reduce((sum, pack) => sum + pack.units.length, 0);
        const requests = Math.max(1, Math.ceil(total / limitChars), Math.ceil(count / maxItems));
        /* The whole page fits: one request, every paragraph in it. */
        if (requests === 1) {
            batches.push(page.packs.flatMap((pack) => pack.units));
            continue;
        }
        /* Too big: split between paragraphs, as evenly as the boundaries allow. */
        const groups = splitPacks(page.packs, Math.min(requests, page.packs.length));
        for (const group of groups) {
            batches.push(...unitBatches(group.flatMap((pack) => pack.units), limitChars, maxItems));
        }
    }
    return batches;
}

function trimSample(value: string, max: number): string {
    const compact = value.replace(/\s+/g, ' ').trim();
    return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

/** Runs every unit through the provider with a pool of parallel workers. */
async function runUnits(
    ctx: JobContext,
    units: WorkUnit[],
    concurrency: number
): Promise<void> {
    const job = ctx.job;
    /* The request size is chosen here, never by the reader: page by page sends
       a whole page in one request and the structured order fills every request
       up to the same capacity, so the only ceiling is what the engine accepts. */
    const limitChars = Math.max(600, ctx.engine.limits.maxChars);
    const maxItems = Math.max(1, ctx.engine.limits.maxItems);
    const batches = planBatches(units, limitChars, maxItems);

    let cursor = 0;
    let halted = false;
    let failures = 0;

    const settle = (index: number): void => {
        const item = ctx.queue[index];
        if (item.settled || item.resolved < item.parts.length) return;
        item.settled = true;
        job.done += item.targets.length;

        const ready = item.values.every(
            (value) => typeof value === 'string' && value.trim().length > 0
        );
        if (!ready) {
            job.failed += 1;
            return;
        }

        const composed = item.template
            .map((chunk, index) => {
                const value = index < item.values.length ? item.values[index] : null;
                return typeof value === 'string' ? `${chunk}${value.trim()}` : chunk;
            })
            .join('')
            .trim();

        if (!composed) {
            job.failed += 1;
            return;
        }

        for (const target of item.targets) {
            ctx.translations.set(target.id, `${target.lead}${composed}${target.trail}`);
        }
        job.translated += item.targets.length;

        if (!translationLooksWrong(item.core, composed, job.target)) {
            const key = memoryKey(job.target, item.core);
            /* Re-insert so a freshly translated entry counts as the newest and
               is not dropped as an old one. */
            ctx.store.delete(key);
            ctx.store.set(key, composed);
            memoryDirty = true;
        }

        job.samples = [
            ...job.samples.slice(-1),
            { source: trimSample(item.core, 220), translated: trimSample(composed, 220) }
        ];
    };

    const takeBatch = (): WorkUnit[] => {
        if (control.cancelled || halted) return [];
        const batch = batches[cursor];
        if (!batch) return [];
        cursor += 1;
        return batch;
    };

    const worker = async (): Promise<void> => {
        for (;;) {
            if (control.cancelled || halted) return;
            while (control.paused && !control.cancelled) {
                job.status = 'paused';
                await sleep(180);
            }
            if (control.cancelled || halted) return;
            if (job.status === 'paused') {
                job.status = 'running';
                job.message =
                    job.engine === 'gemini'
                        ? 'ترجمه با جمنای با مکث کنترل‌شده ادامه دارد…'
                        : `${job.parallel} درخواست هم‌زمان در حال ترجمه…`;
            }

            const batch = takeBatch();
            if (!batch.length) return;

            let values: string[] | null = null;
            try {
                values = await ctx.engine.translate(
                    batch.map((unit) => unit.text),
                    job.target,
                    job.targetLabel,
                    () => control.cancelled
                );
                failures = 0;
            } catch (error) {
                failures += 1;
                if (failures >= MAX_CONSECUTIVE_FAILURES) {
                    halted = true;
                    job.message =
                        error instanceof Error && error.message && error.message !== 'cancelled'
                            ? error.message
                            : 'سرویس ترجمه پاسخ نداد؛ بخش‌های انجام‌شده ذخیره شدند.';
                }
            }

            batch.forEach((unit, position) => {
                const value = values && typeof values[position] === 'string' ? values[position] : '';
                const item = ctx.queue[unit.item];
                if (item.values[unit.part] !== null) return;
                item.values[unit.part] = value.trim();
                item.resolved += 1;
                settle(unit.item);
            });
        }
    };

    const workers = Math.max(1, Math.round(concurrency) || 1);
    await Promise.all(Array.from({ length: workers }, () => worker()));

    // Anything the provider never answered counts as a failure, not as pending.
    for (let index = 0; index < ctx.queue.length; index += 1) {
        const item = ctx.queue[index];
        if (item.settled) continue;
        let touched = false;
        for (let part = 0; part < item.parts.length; part += 1) {
            if (item.values[part] === null) {
                item.values[part] = '';
                item.resolved += 1;
                touched = true;
            }
        }
        if (touched && item.resolved >= item.parts.length) settle(index);
    }
}

async function runJob(ctx: JobContext): Promise<void> {
    const job = ctx.job;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    touch(job);

    let stopTicker = false;
    let flushing = false;
    let outcome: TranslationStatus = 'done';

    const ticker = (async () => {
        while (!stopTicker) {
            await sleep(FLUSH_INTERVAL_MS);
            if (stopTicker) break;
            touch(job);
            if (flushing) continue;
            flushing = true;
            try {
                await flushJob(ctx);
            } catch (error) {
                if (!stopTicker) {
                    job.message =
                        error instanceof Error ? error.message : 'ذخیرهٔ نتیجهٔ ترجمه انجام نشد.';
                }
            } finally {
                flushing = false;
            }
        }
    })();

    try {
        const allUnits = buildUnits(ctx.queue);
        let nextUnits = allUnits;
        if (ctx.order === 'structured') {
            /* The reader's order: book information first, then the table of
               contents, and only then the paragraphs of the book. */
            job.message = 'ترجمهٔ معلومات کتاب…';
            touch(job);
            await localizedFrontmatter(ctx);
            await flushJob(ctx);
            const tocUnits = allUnits.filter((unit) => ctx.queue[unit.item].zone === 'toc');
            if (tocUnits.length && !control.cancelled) {
                job.message = 'ترجمهٔ فهرست مطالب…';
                touch(job);
                await runUnits(ctx, tocUnits, job.parallel);
            }
            nextUnits = allUnits.filter((unit) => ctx.queue[unit.item].zone !== 'toc');
        }
        await runUnits(ctx, nextUnits, job.parallel);

        const retry: QueueItem[] = ctx.queue.filter(
            (item) => item.settled && item.values.some((value) => !value || !value.trim())
        );
        if (retry.length && !control.cancelled) {
            job.message = `تلاش دوباره برای ${retry.length} متن ناموفق…`;
            touch(job);
            const indexes = new Set<number>();
            ctx.queue.forEach((item, index) => {
                if (retry.includes(item)) indexes.add(index);
            });
            for (const index of indexes) {
                const item = ctx.queue[index];
                job.done = Math.max(0, job.done - item.targets.length);
                job.failed = Math.max(0, job.failed - 1);
                item.values = item.parts.map(() => null);
                item.resolved = 0;
                item.settled = false;
            }
            await runUnits(ctx, buildUnits(ctx.queue, indexes), Math.min(3, job.parallel));
        }

        outcome = control.cancelled ? 'cancelled' : 'done';
        if (control.cancelled) {
            job.message = 'ترجمه لغو شد؛ بخش‌های انجام‌شده در فایل کتاب ذخیره شدند.';
        } else if (job.failed) {
            job.message =
                job.mode === 'review'
                    ? `بازبینی کامل شد؛ ${job.repaired} بخش ترمیم شد و ${job.failed} متن از سرویس دریافت نشد.`
                    : `ترجمهٔ کتاب کامل شد؛ ${job.failed} متن از سرویس ترجمه دریافت نشد و به زبان اصلی ماند.`;
        } else if (job.mode === 'review') {
            job.message = job.translated
                ? `بازبینی کامل شد؛ ${job.repaired} بخش ناقص یا ترجمه‌نشده ترمیم شد.`
                : 'همهٔ بخش‌ها ترجمه‌شده و سالم بودند؛ چیزی برای ترمیم پیدا نشد.';
        } else {
            job.message = 'ترجمهٔ کتاب کامل شد.';
        }
    } catch (error) {
        outcome = 'error';
        job.message =
            error instanceof Error && error.message !== 'cancelled'
                ? error.message
                : 'ترجمه نیمه‌کاره ماند؛ بخش‌های انجام‌شده ذخیره شدند.';
    } finally {
        stopTicker = true;
        await ticker;
        try {
            await flushJob(ctx, outcome === 'done');
            job.status = outcome;
        } catch (error) {
            job.status = 'error';
            job.message = error instanceof Error ? error.message : 'ذخیرهٔ نتیجهٔ ترجمه انجام نشد.';
        }
        job.finishedAt = new Date().toISOString();
        touch(job);
        await persistMemory(true);
        control.paused = false;
        control.cancelled = false;
    }
}

/* ----------------------------- public api ----------------------------- */

interface TranslateOptions {
    target?: unknown;
    force?: unknown;
    markTranslator?: unknown;
    mode?: unknown;
    bilingual?: unknown;
}

/* Any language is accepted, written either as a code (fa, en, ku…) or as a
   name in any script. No catalogue limits the choice. */
function normalizeTarget(value: unknown): string {
    const raw = typeof value === 'string' ? value.trim() : '';
    return raw ? raw.slice(0, 60) : 'fa';
}

const LANGUAGE_NAMES = (() => {
    try {
        return new Intl.DisplayNames(['fa'], { type: 'language' });
    } catch {
        return null;
    }
})();

function targetLabel(target: string): string {
    if (!/^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i.test(target)) return target;
    try {
        const name = LANGUAGE_NAMES?.of(target.replace(/_/g, '-'));
        if (name && name !== target) return name;
    } catch {
        /* an unknown code simply stays as the reader wrote it */
    }
    return target;
}

function normalizeMode(value: unknown): TranslationMode {
    return value === 'review' ? 'review' : 'translate';
}

function displayTitle(content: string, filename: string): string {
    const meta = parseFrontmatter(content);
    const fromMeta = String(meta['نام کتاب'] ?? '').trim();
    if (fromMeta) return fromMeta;
    const heading = content.match(/^\s*#\s+(.+?)\s*$/m);
    if (heading) return heading[1].replace(/[*_`]/g, '');
    return filename.split('/').pop()?.replace(/\.md$/i, '') || filename;
}

function emptyJobStats() {
    return {
        total: 0,
        done: 0,
        translated: 0,
        cached: 0,
        skipped: 0,
        failed: 0,
        inspected: 0,
        repaired: 0,
        characters: 0
    };
}

export async function estimateTranslation(
    filenameInput: unknown,
    options: TranslateOptions = {}
): Promise<TranslationEstimate> {
    const filePath = resolveBookPath(filenameInput);
    if (!filePath) throw new HttpError('فایل کتاب برای ترجمه معتبر نیست.');
    const target = normalizeTarget(options.target);
    const mode = normalizeMode(options.mode);
    const force = options.force === true;
    const config = await readTranslateConfig();
    const engine = createEngine(config);
    const content = await fs.promises.readFile(filePath, 'utf8');
    const model = buildModel(content);
    const store = await loadMemory();

    const plan = planTranslation(model, target, store, {
        mode,
        force,
        apply: false
    });

    return {
        filename: String(filenameInput),
        target,
        targetLabel: targetLabel(target),
        mode,
        engine: config.engine,
        engineLabel: engine.label,
        segments: plan.segments,
        candidates: plan.queuedSegments,
        cached: plan.cached,
        skipped: plan.skipped,
        untranslated: plan.untranslated,
        suspicious: plan.suspicious,
        characters: plan.characters
    };
}

export interface TranslationTestResult {
    ok: boolean;
    engine: string;
    engineLabel: string;
    model: string;
    milliseconds: number;
    sample: string;
}

/** Sends one short greeting with the saved settings so the settings screen can
    prove an endpoint, model and key actually work before a whole book is
    queued. */
export async function testTranslationProvider(): Promise<TranslationTestResult> {
    const config = await readTranslateConfig();
    const engine = createEngine(config);
    const started = Date.now();
    try {
        const values = await engine.translate(['Hello world'], 'fa', 'فارسی', () => false);
        const sample = String(values[0] ?? '').trim();
        if (!sample) throw new Error('سرویس ترجمه پاسخ خالی داد.');
        return {
            ok: true,
            engine: config.engine,
            engineLabel: engine.label,
            model: config.engine === 'gemini' ? config.model || 'gemini-4-hydrogen' : config.model,
            milliseconds: Date.now() - started,
            sample: sample.slice(0, 160)
        };
    } catch (error) {
        const message =
            error instanceof Error && error.message && error.message !== 'cancelled'
                ? error.message
                : 'اتصال به سرویس ترجمه برقرار نشد.';
        throw new HttpError(message, 502);
    }
}

export function getTranslationJob(): TranslationJob | null {
    return activeJob ? { ...activeJob, samples: [...activeJob.samples] } : null;
}

export async function startTranslation(
    filenameInput: unknown,
    options: TranslateOptions = {}
): Promise<TranslationJob> {
    if (activeJob && (activeJob.status === 'running' || activeJob.status === 'paused')) {
        throw new HttpError('یک ترجمهٔ دیگر در حال اجراست؛ ابتدا آن را متوقف کنید.', 409);
    }
    const filePath = resolveBookPath(filenameInput);
    if (!filePath) throw new HttpError('فایل کتاب برای ترجمه معتبر نیست.');

    const filename = String(filenameInput);
    const target = normalizeTarget(options.target);
    const mode = normalizeMode(options.mode);
    const force = options.force === true;
    const markTranslator = options.markTranslator !== false;
    const config = await readTranslateConfig();
    const bilingual =
        typeof options.bilingual === 'boolean' ? options.bilingual : config.bilingual;
    const engine = createEngine(config);

    const content = await fs.promises.readFile(filePath, 'utf8');
    const stat = await fs.promises.stat(filePath);
    const model = buildModel(content);
    const store = await loadMemory();

    const plan = planTranslation(model, target, store, {
        mode,
        force,
        apply: true
    });

    const needsSnapshot = plan.queuedSegments > 0 || plan.cached > 0;
    const snapshot = needsSnapshot ? await createBookSnapshot(filename, 'before-translation') : null;
    const parallel = config.engine === 'gemini' ? 1 : Math.max(1, config.concurrency);

    const job: TranslationJob = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        filename,
        title: displayTitle(content, filename),
        target,
        targetLabel: targetLabel(target),
        mode,
        engine: config.engine,
        engineLabel: engine.label,
        parallel,
        bilingual,
        status: plan.queuedSegments ? 'running' : 'done',
        ...emptyJobStats(),
        total: plan.queuedSegments,
        cached: plan.cached,
        skipped: plan.skipped,
        inspected: plan.inspected,
        repaired: mode === 'review' ? plan.untranslated + plan.suspicious : 0,
        characters: plan.characters,
        startedAt: null,
        finishedAt: plan.queuedSegments ? null : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        snapshotId: snapshot?.id ?? null,
        revision: revisionOf(stat),
        message: plan.queuedSegments
            ? mode === 'review'
                ? `بازبینی آغاز شد؛ ${plan.queuedSegments} بخش برای ترمیم پیدا شد.`
                : config.engine === 'gemini'
                  ? 'ترجمه با جمنای رایگان آغاز شد (ارسال ترتیبی با مکث خودکار برای جلوگیری از خطا).'
                  : `ترجمه با ${parallel} درخواست هم‌زمان آغاز شد.`
            : mode === 'review'
              ? 'همهٔ بخش‌ها ترجمه‌شده و سالم بودند؛ چیزی برای ترمیم پیدا نشد.'
              : plan.cached
                ? 'همهٔ بخش‌ها از حافظهٔ ترجمه بازیابی شدند؛ نیازی به ارسال دوباره نبود.'
                : 'متنی برای ترجمه پیدا نشد.',
        samples: [],
        speed: 0,
        etaSeconds: null
    };

    activeJob = job;
    control.paused = false;
    control.cancelled = false;

    const ctx: JobContext = {
        job,
        filename,
        filePath,
        model,
        translations: plan.translations,
        queue: plan.queue,
        store,
        revision: job.revision!,
        frontmatter: model.frontmatter,
        newline: content.includes('\r\n') ? '\r\n' : '\n',
        markTranslator,
        bilingual,
        engine,
        order: config.order
    };

    if (!plan.queuedSegments) {
        if (plan.cached) {
            try {
                await flushJob(ctx, true);
                job.status = 'done';
            } catch (error) {
                job.status = 'error';
                job.message = error instanceof Error ? error.message : 'ذخیرهٔ ترجمه انجام نشد.';
            }
        }
        return getTranslationJob()!;
    }

    void runJob(ctx);
    return getTranslationJob()!;
}

export function pauseTranslation(): TranslationJob | null {
    if (activeJob && activeJob.status === 'running') {
        control.paused = true;
        activeJob.status = 'paused';
        activeJob.message = 'ترجمه موقتاً متوقف شد.';
        activeJob.updatedAt = new Date().toISOString();
    }
    return getTranslationJob();
}

export function resumeTranslation(): TranslationJob | null {
    if (activeJob && activeJob.status === 'paused') {
        control.paused = false;
        activeJob.status = 'running';
        activeJob.message = 'ترجمه ادامه یافت.';
        activeJob.updatedAt = new Date().toISOString();
    }
    return getTranslationJob();
}

export function cancelTranslation(): TranslationJob | null {
    if (activeJob && (activeJob.status === 'running' || activeJob.status === 'paused')) {
        control.cancelled = true;
        control.paused = false;
        activeJob.message = 'در حال توقف و ذخیرهٔ بخش‌های انجام‌شده…';
        activeJob.updatedAt = new Date().toISOString();
    }
    return getTranslationJob();
}
