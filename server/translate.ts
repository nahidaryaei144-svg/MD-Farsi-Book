/* Automatic book translation engine.
   Splits a markdown book into paragraph-level translatable segments while
   protecting fragile syntax (inline code, anchors, URLs, math, footnote refs,
   HTML blocks, fenced code blocks) via atomic placeholders (⟦0⟧, ⟦1⟧, ...),
   translates them with parallel workers, verifies output quality with the QA
   gatekeeper, keeps translation memory in storage, writes atomically and
   invalidates the library cache. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { STORAGE_DIR } from './config.js';
import { createBookSnapshot } from './backups.js';
import { parseFrontmatter, resolveBookPath, serializeBookFrontmatter } from './library.js';
import { invalidateCachedBook } from './library-index.js';
import { HttpError } from './http.js';
import { readTranslateConfig, type TranslateConfig, type TranslateOrder } from './translate-config.js';
import {
    createEngine,
    extractGlossaryWithAi,
    FatalEngineError,
    normalizeLanguageCode,
    resolveEngineTargetLang,
    translateFrontmatterJson,
    type TokenUsageDelta,
    type TranslateBatchContext,
    type TranslationEngine
} from './translate-engines.js';
import { normalizeTranslation } from './translate-postprocess.js';
import { assessTranslation, classifyExistingText, placeholdersMatch } from './translate-qa.js';

const MEMORY_FILE = path.join(STORAGE_DIR, 'translation-memory.json');
const MEMORY_NDJSON_FILE = path.join(STORAGE_DIR, 'translation-memory.ndjson');
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

export interface TranslationUsage {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    requests: number;
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
    pageRange?: string;
    usage?: TranslationUsage;
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

/* ----------------------------- markdown model & placeholder masking ----------------------------- */

interface TextToken {
    type: 'text';
    id: number;
    value: string;
    placeholders: Map<string, string>;
}

interface BilingualToken {
    type: 'bilingual';
    id: number;
    orig: string;
    trans: string;
    separator: string;
    maskedOrig: string;
    placeholders: Map<string, string>;
}

interface FixedToken {
    type: 'fixed';
    value: string;
}

type Token = TextToken | BilingualToken | FixedToken;

interface Line {
    tokens: Token[];
    ending: string;
    alreadyBilingual?: boolean;
}

type SegmentZone = 'toc' | 'body';

interface Segment {
    id: number;
    value: string;
    placeholders: Map<string, string>;
    page: number;
    block: number;
    zone: SegmentZone;
    heading: string;
    bilingualOrig?: string;
    bilingualTrans?: string;
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
    heading: string;
}

function findBalancedSpanClose(text: string, openEnd: number): number {
    let cursor = openEnd;
    let depth = 1;
    while (cursor < text.length && depth > 0) {
        const nextOpen = text.indexOf('<span', cursor);
        const nextClose = text.indexOf('</span>', cursor);
        if (nextClose < 0) return -1;
        if (nextOpen >= 0 && nextOpen < nextClose) {
            depth += 1;
            cursor = nextOpen + 5;
        } else {
            depth -= 1;
            cursor = nextClose + 7;
        }
    }
    return depth === 0 ? cursor : -1;
}

function findBalancedBracketEnd(text: string, openIndex: number): number {
    let depth = 0;
    for (let i = openIndex; i < text.length; i += 1) {
        if (text[i] === '\\') {
            i += 1;
            continue;
        }
        if (text[i] === '`') {
            const run = text.slice(i).match(/^`+/)?.[0];
            if (run) {
                const close = text.indexOf(run, i + run.length);
                if (close >= 0) {
                    i = close + run.length - 1;
                    continue;
                }
            }
        }
        if (text[i] === '[') depth += 1;
        else if (text[i] === ']') {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function findBalancedParenEnd(text: string, openIndex: number): number {
    let depth = 0;
    for (let i = openIndex; i < text.length; i += 1) {
        if (text[i] === '\\') {
            i += 1;
            continue;
        }
        if (text[i] === '(') depth += 1;
        else if (text[i] === ')') {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/** Masks fragile inline syntax (inline code, anchors, HTML tags, URLs, math,
    footnote markers, obsidian callouts) as atomic placeholders `⟦N⟧` while
    keeping full sentences, emphasis (`**...**`, `*...*`), parentheses, and
    link display text intact for high-quality translation. */
function maskInlineProse(text: string): { masked: string; placeholders: Map<string, string> } {
    const placeholders = new Map<string, string>();
    let nextPlaceholder = 0;
    const addPlaceholder = (raw: string): string => {
        const key = `⟦${nextPlaceholder}⟧`;
        nextPlaceholder += 1;
        placeholders.set(key, raw);
        return key;
    };

    let out = '';
    for (let i = 0; i < text.length; ) {
        /* Escaped characters */
        if (text[i] === '\\' && i + 1 < text.length) {
            out += text.slice(i, i + 2);
            i += 2;
            continue;
        }

        /* Inline code: `...` or ``...`` */
        if (text[i] === '`') {
            const run = text.slice(i).match(/^`+/);
            if (run) {
                const end = text.indexOf(run[0], i + run[0].length);
                if (end >= 0) {
                    out += addPlaceholder(text.slice(i, end + run[0].length));
                    i = end + run[0].length;
                    continue;
                }
            }
        }

        /* Inline math: $...$ (not $$) */
        if (text[i] === '$' && text[i + 1] !== '$' && text[i + 1] && !/\s/.test(text[i + 1])) {
            let close = i + 1;
            let found = -1;
            while (close < text.length) {
                if (text[close] === '\\') {
                    close += 2;
                    continue;
                }
                if (text[close] === '\n') break;
                if (text[close] === '$' && text[close + 1] !== '$' && !/\s/.test(text[close - 1])) {
                    found = close;
                    break;
                }
                close += 1;
            }
            if (found > i + 1) {
                out += addPlaceholder(text.slice(i, found + 1));
                i = found + 1;
                continue;
            }
        }

        /* HTML comments & inline HTML tags */
        if (text[i] === '<') {
            if (text.startsWith('<!--', i)) {
                const endComment = text.indexOf('-->', i + 4);
                if (endComment >= 0) {
                    out += addPlaceholder(text.slice(i, endComment + 3));
                    i = endComment + 3;
                    continue;
                }
            }
            const tagMatch = text.slice(i).match(/^<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s+[^>]*)?>/);
            if (tagMatch) {
                out += addPlaceholder(tagMatch[0]);
                i += tagMatch[0].length;
                continue;
            }
        }

        /* Bare URLs (handles parentheses inside Wikipedia-style URLs) */
        if (text.startsWith('http://', i) || text.startsWith('https://', i)) {
            const match = text.slice(i).match(/^https?:\/\/[^\s<>]+/i);
            if (match) {
                let url = match[0];
                /* Trim trailing sentence punctuation unless balanced parentheses */
                while (url.length > 1 && /[.,;!?،؛؟»"'\]>]$/.test(url)) {
                    url = url.slice(0, -1);
                }
                while (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
                    url = url.slice(0, -1);
                }
                out += addPlaceholder(url);
                i += url.length;
                continue;
            }
        }

        /* Footnote references [^1] and numbered footnote markers (¬1) */
        if (text[i] === '[' && text[i + 1] === '^') {
            const end = text.indexOf(']', i + 2);
            if (end >= 0 && !text.slice(i, end).includes('\n')) {
                out += addPlaceholder(text.slice(i, end + 1));
                i = end + 1;
                continue;
            }
        }
        const negMatch = text.slice(i).match(/^\(¬\s*[\d\u06F0-\u06F9]+\)/);
        if (negMatch) {
            out += addPlaceholder(negMatch[0]);
            i += negMatch[0].length;
            continue;
        }

        /* Obsidian callout marker [!info] */
        if (text[i] === '[' && text[i + 1] === '!') {
            const end = text.indexOf(']', i + 2);
            if (end >= 0 && !text.slice(i, end).includes('\n')) {
                out += addPlaceholder(text.slice(i, end + 1));
                i = end + 1;
                continue;
            }
        }

        /* Wikilinks: [[target|label]] or [[target]] */
        if (text[i] === '[' && text[i + 1] === '[') {
            const close = text.indexOf(']]', i + 2);
            if (close >= 0 && !text.slice(i, close).includes('\n')) {
                const inner = text.slice(i + 2, close);
                const pipe = inner.indexOf('|');
                if (pipe > 0) {
                    const targetPart = inner.slice(0, pipe);
                    const labelPart = inner.slice(pipe + 1);
                    out += `[[${addPlaceholder(targetPart)}|${labelPart}]]`;
                } else {
                    out += addPlaceholder(text.slice(i, close + 2));
                }
                i = close + 2;
                continue;
            }
        }

        /* Markdown images ![alt](url) and links [text](url) with balanced parens */
        if ((text[i] === '!' && text[i + 1] === '[') || text[i] === '[') {
            const isImage = text[i] === '!';
            const bracketStart = isImage ? i + 1 : i;
            const closeBracket = findBalancedBracketEnd(text, bracketStart);
            if (closeBracket >= 0 && text[closeBracket + 1] === '(') {
                const closeParen = findBalancedParenEnd(text, closeBracket + 1);
                if (closeParen >= 0) {
                    const label = text.slice(bracketStart + 1, closeBracket);
                    const url = text.slice(closeBracket + 2, closeParen);
                    if (isImage && !hasLetters(label)) {
                        out += addPlaceholder(text.slice(i, closeParen + 1));
                    } else {
                        const innerMasked = maskInlineProse(label);
                        /* Re-key inner placeholders so ids remain unique */
                        let rekeyedLabel = innerMasked.masked;
                        for (const [k, v] of innerMasked.placeholders) {
                            const newKey = addPlaceholder(v);
                            rekeyedLabel = rekeyedLabel.replace(k, newKey);
                        }
                        out += `${isImage ? '!' : ''}[${rekeyedLabel}](${addPlaceholder(url)})`;
                    }
                    i = closeParen + 1;
                    continue;
                }
            }
        }

        out += text[i];
        i += 1;
    }

    return { masked: out, placeholders };
}

function unmaskText(translated: string, placeholders: Map<string, string>): string {
    if (!placeholders.size) return translated;
    let out = translated.replace(/⟦\s*(\d+)\s*⟧/g, '⟦$1⟧');
    for (const [token, original] of placeholders) {
        out = out.split(token).join(original);
    }
    return out;
}

function tokenizeInline(text: string, state: TokenState): Token[] {
    if (!text) return [];
    const tokens: Token[] = [];

    const pushProse = (chunk: string) => {
        if (!chunk) return;
        /* Preserve leading/trailing pure whitespace as fixed if chunk is only spaces */
        if (!chunk.trim()) {
            tokens.push({ type: 'fixed', value: chunk });
            return;
        }
        const { masked, placeholders } = maskInlineProse(chunk);
        const id = state.next;
        state.next += 1;
        state.segments.push({
            id,
            value: masked,
            placeholders,
            page: state.page,
            block: state.block,
            zone: state.zone,
            heading: state.heading
        });
        tokens.push({ type: 'text', id, value: masked, placeholders });
    };

    /* Detect inline `<span class="bi-orig">...</span>...<span class="bi-trans">...</span>`
       pairs (and standalone `bi-orig` / `bi-trans` spans) so existing translations
       are never re-translated as source prose. */
    let cursor = 0;
    while (cursor < text.length) {
        const nextSpanRel = text.slice(cursor).search(/<span\b[^>]*\bclass=["'][^"']*\bbi-(?:orig|trans)\b[^"']*["'][^>]*>/i);
        if (nextSpanRel < 0) {
            pushProse(text.slice(cursor));
            break;
        }
        const spanStart = cursor + nextSpanRel;
        if (spanStart > cursor) pushProse(text.slice(cursor, spanStart));

        const openMatch = text
            .slice(spanStart)
            .match(/^<span\b[^>]*\bclass=["'][^"']*\bbi-(orig|trans)\b[^"']*["'][^>]*>/i);
        if (!openMatch) {
            pushProse(text.slice(spanStart));
            break;
        }

        const spanEnd = findBalancedSpanClose(text, spanStart + openMatch[0].length);
        if (spanEnd < 0) {
            tokens.push({ type: 'fixed', value: text.slice(spanStart) });
            break;
        }

        const kind = openMatch[1].toLowerCase();
        const inner = text.slice(spanStart + openMatch[0].length, spanEnd - 7);

        if (kind === 'orig') {
            const afterOrig = text.slice(spanEnd);
            const sepMatch = afterOrig.match(
                /^(\s*(?:<br\s*\/?>\s*)+|\s+)(<span\b[^>]*\bclass=["'][^"']*\bbi-trans\b[^"']*["'][^>]*>)/i
            );
            if (sepMatch) {
                const transOpenStart = spanEnd + sepMatch[1].length;
                const transCloseEnd = findBalancedSpanClose(
                    text,
                    transOpenStart + sepMatch[2].length
                );
                if (transCloseEnd >= 0) {
                    const transInner = text.slice(
                        transOpenStart + sepMatch[2].length,
                        transCloseEnd - 7
                    );
                    const { masked, placeholders } = maskInlineProse(inner);
                    const id = state.next;
                    state.next += 1;
                    state.segments.push({
                        id,
                        value: masked,
                        placeholders,
                        page: state.page,
                        block: state.block,
                        zone: state.zone,
                        heading: state.heading,
                        bilingualOrig: inner,
                        bilingualTrans: transInner
                    });
                    tokens.push({
                        type: 'bilingual',
                        id,
                        orig: inner,
                        trans: transInner,
                        separator: sepMatch[1],
                        maskedOrig: masked,
                        placeholders
                    });
                    cursor = transCloseEnd;
                    continue;
                }
            }
        }

        /* Standalone bi-orig or bi-trans: keep fixed so it is never re-translated */
        tokens.push({ type: 'fixed', value: text.slice(spanStart, spanEnd) });
        cursor = spanEnd;
    }

    return tokens;
}

function splitTableRowCells(line: string): string[] | null {
    if (!/^\s*\|/.test(line)) return null;
    const cells: string[] = [];
    let current = '';
    let inCode = false;
    for (let i = 0; i < line.length; i += 1) {
        if (line[i] === '\\' && i + 1 < line.length) {
            current += line.slice(i, i + 2);
            i += 1;
            continue;
        }
        if (line[i] === '`') inCode = !inCode;
        if (!inCode && line[i] === '|') {
            cells.push(current);
            current = '';
            continue;
        }
        current += line[i];
    }
    cells.push(current);
    return cells.length >= 3 ? cells : null;
}

interface FenceState {
    active: boolean;
    char: '`' | '~' | '';
    len: number;
}

interface BlockState {
    fence: FenceState;
    htmlClose: RegExp | null;
    inMath: boolean;
}

const STRUCTURAL_OR_NON_PROSE =
    /^\s*(?:$|---|===|\*\*\*|___|#{1,6}\s|>|\| |\|$|[-+*]\s|\d+[.)]\s|\[\^[^\]]+\]:|\(?¬\s*[\d\u06F0-\u06F9]+\)?\s|==(?:پاورقی‌ها|پاورقی ها|الحواشي|Footnotes)==|بخش\s*:|الجزء\s*:|صفحه\s*:|\*\*قسمت\s|<span\b[^>]*\bbi-(?:orig|trans)\b|<a\b[^>]*\bid=|<(?:pre|table|style|script|div|details|summary|!--|\/))/i;

function canMergeProseLine(line: string): boolean {
    if (!line || !line.trim()) return false;
    if (/^ {4,}\S/.test(line)) return false;
    if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return false;
    if (/^\s*\$\$/.test(line)) return false;
    if (/^\s*\|/.test(line)) return false;
    if (STRUCTURAL_OR_NON_PROSE.test(line)) return false;
    if (/^\s*\*\*ص\s+[\d\u06F0-\u06F9]+\*\*\s*$/.test(line)) return false;
    return true;
}

function endsWithHardBreak(line: string): boolean {
    return /(?: {2}|\\|<br\s*\/?>)\s*$/i.test(line);
}

function updateFence(line: string, fence: FenceState): boolean {
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!fence.active) {
        if (!open) return false;
        const marker = open[1];
        if (marker[0] === '`' && open[2].includes('`')) return false;
        fence.active = true;
        fence.char = marker[0] as '`' | '~';
        fence.len = marker.length;
        return true;
    }
    if (open && open[1][0] === fence.char && open[1].length >= fence.len && !open[2].trim()) {
        fence.active = false;
        fence.char = '';
        fence.len = 0;
        return true;
    }
    return true;
}

function tokenizeLine(line: string, blockState: BlockState, state: TokenState): Token[] {
    const wasInFence = blockState.fence.active;
    const fenceTouched = updateFence(line, blockState.fence);
    if (wasInFence || fenceTouched) {
        return line ? [{ type: 'fixed', value: line }] : [];
    }

    /* Multiline HTML comment or <pre>/<style>/<script>/<svg> block */
    if (blockState.htmlClose) {
        if (blockState.htmlClose.test(line)) blockState.htmlClose = null;
        return line ? [{ type: 'fixed', value: line }] : [];
    }
    const htmlOpen = line.match(/^\s*(?:(<!--)|<(pre|style|script|svg)\b)/i);
    if (htmlOpen) {
        const closeRe = htmlOpen[1] ? /-->/ : new RegExp(`</${htmlOpen[2]}>`, 'i');
        if (!closeRe.test(line.slice(htmlOpen[0].length))) {
            blockState.htmlClose = closeRe;
            return [{ type: 'fixed', value: line }];
        }
        if (/^\s*(?:<!--[\s\S]*-->|<(?:pre|style|script|svg)\b[\s\S]*<\/(?:pre|style|script|svg)>)\s*$/i.test(line)) {
            return [{ type: 'fixed', value: line }];
        }
    }

    /* Display math block $$...$$ */
    if (blockState.inMath) {
        if (/\$\$/.test(line)) blockState.inMath = false;
        return line ? [{ type: 'fixed', value: line }] : [];
    }
    if (/^\s*\$\$/.test(line)) {
        const rest = line.replace(/^\s*\$\$/, '');
        if (!/\$\$/.test(rest)) blockState.inMath = true;
        return [{ type: 'fixed', value: line }];
    }

    const indentedCode =
        /^ {4,}\S/.test(line) &&
        !/^ *(?:[-+*]|\d+[.)])\s+/.test(line) &&
        !/^ *(?:>|#{1,6}\s)/.test(line) &&
        !/^ *\|/.test(line);

    const fixedLine =
        indentedCode ||
        /^\s*$/.test(line) ||
        /^\s*(?:---|\*\*\*|___)\s*$/.test(line) ||
        /^\s*==(?:پاورقی‌ها|پاورقی ها|الحواشي|Footnotes)==\s*$/i.test(line) ||
        /^\s*#{1,6}\s+(?:پاورقی(?:‌ها)?|الحواشي|Footnotes?)\b/i.test(line) ||
        /^\s*>\s*پاورقی/i.test(line) ||
        /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);

    if (fixedLine) return line ? [{ type: 'fixed', value: line }] : [];

    /* Markdown table row: keep pipes fixed, tokenize each cell intact */
    const cells = splitTableRowCells(line);
    if (cells) {
        const tokens: Token[] = [];
        cells.forEach((cell, idx) => {
            if (idx > 0) tokens.push({ type: 'fixed', value: '|' });
            if (idx === 0 || idx === cells.length - 1) {
                if (cell) tokens.push({ type: 'fixed', value: cell });
            } else {
                tokens.push(...tokenizeInline(cell, state));
            }
        });
        return tokens;
    }

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

    const wikiFootnote = rest.match(/^\[\^[^\]]+\]:\s*/);
    const numberedFootnote = rest.match(/^\(?¬\s*[\d\u06F0-\u06F9]+\)?\s*/);
    if (wikiFootnote) {
        prefix += wikiFootnote[0];
        rest = rest.slice(wikiFootnote[0].length);
    } else if (numberedFootnote) {
        prefix += numberedFootnote[0];
        rest = rest.slice(numberedFootnote[0].length);
    }

    /* Keep leading `<a id="..."></a>` page anchors in prefix so bilingual
       output places them cleanly before `<span class="bi-orig">`. */
    while (rest) {
        const anchor = rest.match(/^(<a\b[^>]*\bid=["'][^"']*["'][^>]*>\s*<\/a>\s*)/i);
        if (!anchor) break;
        prefix += anchor[1];
        rest = rest.slice(anchor[1].length);
    }

    const tokens: Token[] = [];
    if (prefix) tokens.push({ type: 'fixed', value: prefix });
    tokens.push(...tokenizeInline(rest, state));
    return tokens;
}

const TOC_HEADING =
    /^\s{0,3}#{1,6}\s+(?:فهرست(?: مطالب| موضوعات| محتويات)?|محتويات(?: الكتاب)?|المحتويات|جدول المحتويات|Table of Contents|Contents)\s*$/iu;

const BI_ORIG_LINE_RE =
    /^(\s*(?:<a\b[^>]*\bid=["'][^"']*["'][^>]*>\s*<\/a>\s*)*)<span\b[^>]*\bclass=["'][^"']*\bbi-orig\b[^"']*["'][^>]*>([\s\S]*)<\/span>\s*$/i;
const BI_TRANS_LINE_RE =
    /^\s*<span\b[^>]*\bclass=["'][^"']*\bbi-trans\b[^"']*["'][^>]*>([\s\S]*)<\/span>\s*$/i;

function buildModel(content: string): BookModel {
    const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    const frontmatter = match ? match[0] : '';
    const body = match ? content.slice(match[0].length) : content.replace(/^\uFEFF/, '');

    const rawParts = body.split(/(\r\n|\n|\r)/);
    const rawLines: { text: string; ending: string }[] = [];
    for (let i = 0; i < rawParts.length; i += 2) {
        rawLines.push({ text: rawParts[i] || '', ending: rawParts[i + 1] || '' });
    }

    const state: TokenState = { next: 1, segments: [], page: 1, block: 1, zone: 'body', heading: '' };
    const lines: Line[] = [];
    const blockState: BlockState = {
        fence: { active: false, char: '', len: 0 },
        htmlClose: null,
        inMath: false
    };
    let page = 1;
    let tocLevel = 0;

    for (let index = 0; index < rawLines.length; index += 1) {
        let line = rawLines[index].text;
        let ending = rawLines[index].ending;
        const inSpecial = blockState.fence.active || Boolean(blockState.htmlClose) || blockState.inMath;

        /* Detect two-paragraph bilingual block:
           `<span class="bi-orig">...</span>\n\n<span class="bi-trans">...</span>` */
        if (!inSpecial && index + 2 < rawLines.length && !rawLines[index + 1].text.trim()) {
            const origMatch = line.match(BI_ORIG_LINE_RE);
            const transMatch = rawLines[index + 2].text.match(BI_TRANS_LINE_RE);
            if (origMatch && transMatch) {
                const separator = `${ending}${rawLines[index + 1].text}${rawLines[index + 1].ending}`;
                const combinedLine = `${origMatch[1]}<span class="bi-orig">${origMatch[2]}</span>${separator}<span class="bi-trans">${transMatch[1]}</span>`;
                state.zone = tocLevel ? 'toc' : 'body';
                state.page = page;
                state.block = lines.length;
                const tokens = tokenizeInline(combinedLine, state);
                lines.push({
                    tokens,
                    ending: rawLines[index + 2].ending,
                    alreadyBilingual: true
                });
                index += 2;
                continue;
            }
        }

        /* Merge consecutive soft-wrapped prose lines within the same paragraph */
        if (!inSpecial && ending && canMergeProseLine(line) && !endsWithHardBreak(line)) {
            while (
                index + 1 < rawLines.length &&
                ending &&
                canMergeProseLine(rawLines[index + 1].text) &&
                !TOC_HEADING.test(rawLines[index + 1].text)
            ) {
                index += 1;
                line = `${line.trimEnd()} ${rawLines[index].text.trimStart()}`;
                ending = rawLines[index].ending;
                if (endsWithHardBreak(line)) break;
            }
        }

        const heading = inSpecial ? null : line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/);
        if (heading) {
            const level = heading[1].length;
            if (tocLevel && level <= tocLevel) tocLevel = 0;
            if (!tocLevel && TOC_HEADING.test(line)) tocLevel = level;
            state.heading = heading[2].replace(/[*_`]/g, '').slice(0, 120);
        }

        state.zone = tocLevel ? 'toc' : 'body';
        state.page = page;
        state.block = lines.length;
        const tokenized = tokenizeLine(line, blockState, state);

        if (!inSpecial && /^\s*---\s*$/.test(line)) {
            page += 1;
        }
        const alreadyBilingual = tokenized.some((token) => token.type === 'bilingual') ||
            /<span\b[^>]*\bclass=["'][^"']*\bbi-orig\b/i.test(line);
        lines.push({ tokens: tokenized, ending, alreadyBilingual });
    }

    return { frontmatter, lines, segments: state.segments };
}

function renderTokenOrig(token: Token): string {
    if (token.type === 'bilingual') {
        return `<span class="bi-orig">${token.orig}</span>${token.separator}<span class="bi-trans">${token.trans}</span>`;
    }
    if (token.type === 'text') {
        return unmaskText(token.value, token.placeholders);
    }
    return token.value;
}

function renderTokensOrig(tokens: Token[]): string {
    return tokens.map(renderTokenOrig).join('');
}

function renderTokensTrans(
    tokens: Token[],
    translations: Map<number, string>,
    normalize: (value: string) => string,
    stripAnchors = false
): string {
    return tokens
        .map((token) => {
            if (token.type === 'bilingual') {
                const updated = translations.get(token.id);
                const trans = updated !== undefined ? normalize(updated) : token.trans;
                return `<span class="bi-orig">${token.orig}</span>${token.separator}<span class="bi-trans">${trans}</span>`;
            }
            if (token.type === 'text') {
                const raw = translations.get(token.id);
                if (raw !== undefined) return normalize(raw);
                return unmaskText(token.value, token.placeholders);
            }
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
        if (!firstNonSpace) {
            const text = renderTokenOrig(token).trim();
            if (text) firstNonSpace = text;
        }
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
        if (cellTokens.some((token) => token.type === 'bilingual')) {
            return renderTokensTrans(cellTokens, translations, normalize);
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
                return renderTokensTrans(line.tokens, translations, normalize) + line.ending;
            }

            const hasTranslated = line.tokens.some((token) => {
                if (token.type !== 'text') return false;
                const translated = translations.get(token.id);
                if (translated === undefined) return false;
                return translated.trim() !== unmaskText(token.value, token.placeholders).trim();
            });
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
            while (splitAt < line.tokens.length) {
                const tok = line.tokens[splitAt];
                if (tok.type !== 'fixed' || !/^(?:<a\b[^>]*\bid=|\s*$)/i.test(tok.value)) break;
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

function hasLetters(value: string): boolean {
    const stripped = value.replace(/⟦\d+⟧/g, '');
    return /[\p{L}\p{M}]/u.test(stripped);
}

function translationLooksWrong(source: string, result: string, target: string): boolean {
    return !assessTranslation(source, result, target).ok;
}

/* ----------------------------- length handling ----------------------------- */

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

/* ----------------------------- translation memory (profile-aware NDJSON) ----------------------------- */

interface MemoryStore {
    exact: Map<string, string>;
    fallback: Map<string, string>;
    bytes: number;
}

let memory: MemoryStore | null = null;
let pendingAppendLines: string[] = [];
let memoryNeedsCompaction = false;

function computeProfileHash(target: string, config: TranslateConfig): string {
    const fingerprint = JSON.stringify({
        target,
        engine: config.engine,
        model: config.model,
        prompt: config.prompt.trim(),
        rules: config.rules.trim(),
        glossary: config.glossary.trim()
    });
    return crypto.createHash('sha1').update(fingerprint).digest('hex').slice(0, 12);
}

function coreSha1(value: string): string {
    return crypto.createHash('sha1').update(value).digest('hex');
}

function exactMemoryKey(target: string, profHash: string, coreHash: string): string {
    return `${target}:${profHash}:${coreHash}`;
}

function fallbackMemoryKey(target: string, coreHash: string): string {
    return `${target}:${coreHash}`;
}

function memoryEntryBytes(key: string, value: string): number {
    return Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8') + 24;
}

function trimMemory(store: MemoryStore): void {
    while (store.exact.size > 0 && store.bytes > MEMORY_LIMIT_BYTES) {
        const oldest = store.exact.keys().next();
        if (oldest.done) break;
        const val = store.exact.get(oldest.value) ?? '';
        store.bytes = Math.max(0, store.bytes - memoryEntryBytes(oldest.value, val));
        store.exact.delete(oldest.value);
        memoryNeedsCompaction = true;
    }
    while (store.fallback.size > store.exact.size + 4000) {
        const oldest = store.fallback.keys().next();
        if (oldest.done) break;
        store.fallback.delete(oldest.value);
    }
}

function recordMemory(
    store: MemoryStore,
    target: string,
    profHash: string,
    core: string,
    value: string
): void {
    const cHash = coreSha1(core);
    const ek = exactMemoryKey(target, profHash, cHash);
    const fk = fallbackMemoryKey(target, cHash);
    const prev = store.exact.get(ek);
    if (prev !== undefined) {
        store.bytes = Math.max(0, store.bytes - memoryEntryBytes(ek, prev));
        store.exact.delete(ek);
    }
    store.exact.set(ek, value);
    store.bytes += memoryEntryBytes(ek, value);
    store.fallback.set(fk, value);
    trimMemory(store);
    pendingAppendLines.push(JSON.stringify({ k: ek, fk, v: value }));
}

async function loadMemory(): Promise<MemoryStore> {
    if (memory) return memory;
    const store: MemoryStore = {
        exact: new Map<string, string>(),
        fallback: new Map<string, string>(),
        bytes: 0
    };

    let loadedNdjson = false;
    let rawLineCount = 0;
    try {
        const raw = await fs.promises.readFile(MEMORY_NDJSON_FILE, 'utf8');
        loadedNdjson = true;
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            rawLineCount += 1;
            try {
                const parsed = JSON.parse(trimmed) as { k?: unknown; fk?: unknown; v?: unknown };
                const k = typeof parsed.k === 'string' ? parsed.k : '';
                const v = typeof parsed.v === 'string' ? parsed.v : '';
                if (!k || !v.trim()) continue;
                const fk =
                    typeof parsed.fk === 'string' && parsed.fk
                        ? parsed.fk
                        : k.split(':').length === 2
                          ? k
                          : `${k.split(':')[0]}:${k.split(':').slice(2).join(':')}`;
                const prev = store.exact.get(k);
                if (prev !== undefined) {
                    store.bytes = Math.max(0, store.bytes - memoryEntryBytes(k, prev));
                    store.exact.delete(k);
                }
                if (k.split(':').length >= 3) {
                    store.exact.set(k, v);
                    store.bytes += memoryEntryBytes(k, v);
                }
                if (fk) store.fallback.set(fk, v);
            } catch {
                /* ignore malformed partial NDJSON line */
            }
        }
    } catch {
        /* fallback to legacy JSON file migration below */
    }

    if (!loadedNdjson) {
        try {
            const raw = await fs.promises.readFile(MEMORY_FILE, 'utf8');
            const parsed = JSON.parse(raw) as { entries?: Record<string, unknown> };
            const entries = parsed && typeof parsed === 'object' && parsed.entries ? parsed.entries : {};
            for (const [key, value] of Object.entries(entries)) {
                if (typeof value !== 'string' || !value.trim()) continue;
                store.fallback.set(key, value);
                if (key.split(':').length >= 3) {
                    store.exact.set(key, value);
                    store.bytes += memoryEntryBytes(key, value);
                }
            }
            if (store.fallback.size > 0) memoryNeedsCompaction = true;
        } catch {
            /* a missing or broken memory file starts empty */
        }
    }

    trimMemory(store);
    if (loadedNdjson && rawLineCount > store.exact.size * 1.6 + 600) {
        memoryNeedsCompaction = true;
    }
    memory = store;
    return store;
}

async function compactMemory(store: MemoryStore): Promise<void> {
    trimMemory(store);
    const lines: string[] = [];
    for (const [k, v] of store.exact) {
        const parts = k.split(':');
        const fk = parts.length >= 3 ? `${parts[0]}:${parts.slice(2).join(':')}` : k;
        lines.push(JSON.stringify({ k, fk, v }));
    }
    const payload = lines.length ? lines.join('\n') + '\n' : '';
    const tempPath = `${MEMORY_NDJSON_FILE}.${Date.now()}.tmp`;
    try {
        await fs.promises.mkdir(path.dirname(MEMORY_NDJSON_FILE), { recursive: true });
        await fs.promises.writeFile(tempPath, payload, 'utf8');
        await fs.promises.rename(tempPath, MEMORY_NDJSON_FILE);
        pendingAppendLines = [];
        memoryNeedsCompaction = false;
    } catch {
        await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    }
}

async function persistMemory(force = false): Promise<void> {
    if (!memory) return;
    if (force && memoryNeedsCompaction) {
        await compactMemory(memory);
        return;
    }
    if (!pendingAppendLines.length) return;
    const chunk = pendingAppendLines.splice(0).join('\n') + '\n';
    try {
        await fs.promises.mkdir(path.dirname(MEMORY_NDJSON_FILE), { recursive: true });
        await fs.promises.appendFile(MEMORY_NDJSON_FILE, chunk, 'utf8');
    } catch {
        /* non-fatal; entries remain in memory */
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
    placeholders: Map<string, string>;
}

interface QueueItem {
    core: string;
    parts: string[];
    values: (string | null)[];
    resolved: number;
    settled: boolean;
    template: string[];
    targets: QueueTarget[];
    page: number;
    block: number;
    zone: SegmentZone;
    heading: string;
    tmHint?: { source: string; translated: string };
}

interface WorkUnit {
    item: number;
    part: number;
    text: string;
    page: number;
    block: number;
    heading: string;
}

interface PlanOptions {
    mode: TranslationMode;
    force: boolean;
    apply: boolean;
    profHash: string;
    pageFilter?: Set<number> | null;
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

function createQueueItem(
    core: string,
    page: number,
    block: number,
    zone: SegmentZone,
    heading: string,
    tmHint?: { source: string; translated: string }
): QueueItem {
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
        zone,
        heading,
        tmHint
    };
}

function planTranslation(
    model: BookModel,
    target: string,
    store: MemoryStore,
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

        if (options.pageFilter && !options.pageFilter.has(segment.page)) {
            skipped += 1;
            continue;
        }

        /* Existing bilingual segment: inspect `bi-orig` vs `bi-trans` and NEVER
           re-translate `bi-trans` as source. */
        if (segment.bilingualOrig !== undefined) {
            const { lead, core, trail } = outerSpaces(segment.value);
            if (!core || !hasLetters(core)) {
                skipped += 1;
                continue;
            }
            const existingTrans = (segment.bilingualTrans ?? '').trim();
            const qa = assessTranslation(segment.bilingualOrig, existingTrans, target, {
                checkPlaceholders: false
            });

            if (!options.force && qa.ok) {
                skipped += 1;
                continue;
            }

            if (!existingTrans || qa.issue === 'untranslated' || qa.issue === 'identity') {
                untranslated += 1;
            } else {
                suspicious += 1;
            }

            const cHash = coreSha1(core);
            const ek = exactMemoryKey(target, options.profHash, cHash);
            const fk = fallbackMemoryKey(target, cHash);
            const remembered = store.exact.get(ek);
            const rememberedOk =
                typeof remembered === 'string' && !translationLooksWrong(core, remembered, target);
            if (remembered && !options.force && options.mode === 'translate' && rememberedOk) {
                translations.set(
                    segment.id,
                    `${lead}${unmaskText(remembered, segment.placeholders)}${trail}`
                );
                cached += 1;
                continue;
            }

            const crossVal = store.fallback.get(fk);
            const tmHint =
                typeof crossVal === 'string' && !translationLooksWrong(core, crossVal, target)
                    ? {
                          source: unmaskText(core, segment.placeholders),
                          translated: unmaskText(crossVal, segment.placeholders)
                      }
                    : undefined;

            queuedSegments += 1;
            let item = byCore.get(core);
            if (!item) {
                item = createQueueItem(core, segment.page, segment.block, segment.zone, segment.heading, tmHint);
                byCore.set(core, item);
                queue.push(item);
                characters += core.length;
            }
            item.targets.push({
                id: segment.id,
                lead,
                trail,
                placeholders: segment.placeholders
            });
            continue;
        }

        const { lead, core, trail } = outerSpaces(segment.value);
        if (!core || !hasLetters(core)) {
            skipped += 1;
            continue;
        }

        const cHash = coreSha1(core);
        const ek = exactMemoryKey(target, options.profHash, cHash);
        const fk = fallbackMemoryKey(target, cHash);
        const remembered = store.exact.get(ek);
        const rememberedOk =
            typeof remembered === 'string' && !translationLooksWrong(core, remembered, target);

        /* Always evaluate current file text quality for review mode and estimates */
        const existingStatus = classifyExistingText(
            unmaskText(core, segment.placeholders),
            target
        );

        if (options.mode === 'review') {
            if (!options.force && existingStatus === 'ok') {
                skipped += 1;
                continue;
            }
            if (existingStatus === 'suspicious') suspicious += 1;
            else untranslated += 1;

            if (remembered && options.apply && !rememberedOk) store.exact.delete(ek);
        } else {
            if (remembered && !options.force && rememberedOk) {
                translations.set(
                    segment.id,
                    `${lead}${unmaskText(remembered, segment.placeholders)}${trail}`
                );
                cached += 1;
                continue;
            }
            if (remembered && options.apply && !rememberedOk) store.exact.delete(ek);
            if (existingStatus === 'suspicious') suspicious += 1;
            else if (existingStatus === 'untranslated') untranslated += 1;
        }

        const crossVal = store.fallback.get(fk);
        const tmHint =
            typeof crossVal === 'string' && !translationLooksWrong(core, crossVal, target)
                ? {
                      source: unmaskText(core, segment.placeholders),
                      translated: unmaskText(crossVal, segment.placeholders)
                  }
                : undefined;

        queuedSegments += 1;
        let item = byCore.get(core);
        if (!item) {
            item = createQueueItem(core, segment.page, segment.block, segment.zone, segment.heading, tmHint);
            byCore.set(core, item);
            queue.push(item);
            characters += core.length;
        }
        item.targets.push({
            id: segment.id,
            lead,
            trail,
            placeholders: segment.placeholders
        });
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
    store: MemoryStore;
    profHash: string;
    revision: string;
    frontmatter: string;
    newline: string;
    markTranslator: boolean;
    bilingual: boolean;
    engine: TranslationEngine;
    config: TranslateConfig;
    order: TranslateOrder;
    bookTitle: string;
    frontmatterCache?: string;
}

export interface QueuedBookJob {
    id: string;
    filename: string;
    title: string;
    target: string;
    targetLabel: string;
    mode: TranslationMode;
    bilingual?: boolean;
    force?: boolean;
    markTranslator?: boolean;
    pageRange?: string;
    autoGlossary?: boolean;
    addedAt: string;
}

export interface TranslationEventPayload {
    job: TranslationJob | null;
    queue: QueuedBookJob[];
}

let activeJob: TranslationJob | null = null;
const translationQueue: QueuedBookJob[] = [];
const sseListeners = new Set<(payload: TranslationEventPayload) => void>();
let lastSseEmitAt = 0;

function snapshotJob(): TranslationJob | null {
    return activeJob
        ? {
              ...activeJob,
              samples: [...activeJob.samples],
              usage: activeJob.usage ? { ...activeJob.usage } : undefined
          }
        : null;
}

function emitTranslationEvent(force = false): void {
    if (!sseListeners.size) return;
    const now = Date.now();
    if (!force && now - lastSseEmitAt < 250) return;
    lastSseEmitAt = now;
    const payload: TranslationEventPayload = {
        job: snapshotJob(),
        queue: [...translationQueue]
    };
    for (const listener of sseListeners) {
        try {
            listener(payload);
        } catch {
            /* ignore broken SSE listener */
        }
    }
}

export function subscribeTranslationEvents(
    listener: (payload: TranslationEventPayload) => void
): () => void {
    sseListeners.add(listener);
    return () => {
        sseListeners.delete(listener);
    };
}

function addUsage(job: TranslationJob, delta: TokenUsageDelta): void {
    if (!job.usage) {
        job.usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, requests: 0 };
    }
    job.usage.inputTokens += Number(delta.inputTokens) || 0;
    job.usage.outputTokens += Number(delta.outputTokens) || 0;
    job.usage.cachedTokens += Number(delta.cachedTokens) || 0;
    job.usage.requests += Number(delta.requests) || 0;
}

function touch(job: TranslationJob, forceEmit = false): void {
    job.updatedAt = new Date().toISOString();
    if (job.startedAt) {
        const elapsed = (Date.now() - Date.parse(job.startedAt)) / 1000;
        if (elapsed > 0) {
            job.speed = job.done / elapsed;
            const remaining = Math.max(0, job.total - job.done);
            job.etaSeconds = job.speed > 0.001 ? Math.round(remaining / job.speed) : null;
        }
    }
    emitTranslationEvent(forceEmit);
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

const FM_LOCALIZE_KEYS = ['نام کتاب', 'نویسنده', 'معلومات نویسنده', 'بخش', 'جلد'] as const;

async function localizedFrontmatter(ctx: JobContext): Promise<string> {
    if (ctx.frontmatterCache !== undefined) return ctx.frontmatterCache;
    const raw = ctx.frontmatter;
    if (!raw) {
        ctx.frontmatterCache = raw;
        return raw;
    }

    /* Unified AI JSON localization: sends all translatable fields + tags together
       with `fmRules`, so relationships (e.g. adding a Persian-transliterated tag
       of the Arabic book title) are preserved cleanly. */
    if (ctx.engine.id === 'gemini' || ctx.engine.id === 'openai' || ctx.engine.id === 'anthropic') {
        const meta = parseFrontmatter(raw);
        const fieldsToLocalize: Record<string, string> = {};
        for (const key of FM_LOCALIZE_KEYS) {
            const val = String(meta[key] ?? '').trim();
            if (val && yamlNeedsTranslation(val)) fieldsToLocalize[key] = val;
        }
        const rawTags = Array.isArray(meta['برچسب ها'])
            ? meta['برچسب ها'].map((t) => String(t ?? '').trim()).filter(Boolean)
            : [];

        if (Object.keys(fieldsToLocalize).length || rawTags.length) {
            const localized = await translateFrontmatterJson(
                ctx.config,
                fieldsToLocalize,
                rawTags,
                ctx.job.targetLabel,
                () => control.cancelled
            );
            if (localized) {
                for (const [k, v] of Object.entries(localized.fields)) {
                    if (v) meta[k] = v;
                }
                if (localized.tags.length) meta['برچسب ها'] = localized.tags;
                if (ctx.markTranslator && !String(meta['مترجم'] ?? '').trim()) {
                    meta['مترجم'] = TRANSLATOR_LABEL;
                }
                const out = serializeBookFrontmatter(meta, ctx.newline, ctx.filename);
                ctx.frontmatterCache = out;
                return out;
            }
        }
    }

    /* Fallback line-by-line localization for machine translators or if JSON failed */
    const lines = raw.split('\n');
    const pending: { index: number; prefix: string; text: string; quote: string; key: string }[] = [];
    lines.forEach((line, index) => {
        if (!line.trim() || /^-{3,}\s*$/.test(line.trim())) return;
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
        const withKey =
            ctx.engine.id === 'openai' || ctx.engine.id === 'anthropic' || ctx.engine.id === 'gemini';
        let values: string[] = [];
        try {
            values = await ctx.engine.translate(
                pending.map((item) => (withKey ? `${item.key}: ${item.text}` : item.text)),
                ctx.job.target,
                ctx.job.targetLabel,
                () => false,
                { mode: 'frontmatter' }
            );
        } catch {
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
    const frontmatter =
        final || ctx.order === 'structured' ? await localizedFrontmatter(ctx) : ctx.frontmatter;
    const postprocess = (value: string) => normalizeTranslation(value, ctx.job.target);
    const content =
        frontmatter +
        renderBody(ctx.model, ctx.translations, postprocess, {
            bilingual: ctx.bilingual,
            newline: ctx.newline
        });
    ctx.revision = await writeBookFile(ctx.filePath, content, ctx.revision);
    ctx.job.revision = ctx.revision;
    invalidateCachedBook(ctx.filename);
    await persistMemory();
    emitTranslationEvent(final);
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
                block: item.block,
                heading: item.heading
            });
        });
    });
    return units;
}

/* ----------------------------- request plan ----------------------------- */

interface Pack {
    block: number;
    units: WorkUnit[];
}

function packChars(pack: Pack): number {
    return pack.units.reduce((sum, unit) => sum + unit.text.length, 0);
}

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
        if (requests === 1) {
            batches.push(page.packs.flatMap((pack) => pack.units));
            continue;
        }
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

async function runUnits(
    ctx: JobContext,
    units: WorkUnit[],
    concurrency: number
): Promise<void> {
    const job = ctx.job;
    const limitChars = Math.max(600, ctx.engine.limits.maxChars);
    const maxItems = Math.max(1, ctx.engine.limits.maxItems);
    const batches = planBatches(units, limitChars, maxItems);
    if (!batches.length) return;

    let cursor = 0;
    let halted = false;
    let failures = 0;
    let fatalError: FatalEngineError | null = null;
    let recentPairs: { source: string; translated: string }[] = [];

    /* Adaptive AIMD concurrency & pacing controller */
    const maxLimit = Math.max(1, Math.round(concurrency) || 1);
    let currentLimit = ctx.engine.id === 'google' ? Math.min(4, maxLimit) : maxLimit;
    let inFlight = 0;
    let delayMs = ctx.engine.id === 'google' ? 120 : 0;
    let successStreak = 0;
    const waiters: (() => void)[] = [];

    const notifyWaiters = (): void => {
        while (inFlight < currentLimit && waiters.length > 0) {
            waiters.shift()?.();
        }
    };

    const acquireSlot = async (): Promise<boolean> => {
        while (inFlight >= currentLimit) {
            if (control.cancelled || halted) return false;
            await new Promise<void>((resolve) => {
                waiters.push(resolve);
            });
        }
        if (control.cancelled || halted) {
            notifyWaiters();
            return false;
        }
        inFlight += 1;
        if (delayMs > 0 && !control.cancelled) {
            await sleep(delayMs);
        }
        return true;
    };

    const releaseSlot = (ok: boolean): void => {
        inFlight = Math.max(0, inFlight - 1);
        if (ok) {
            successStreak += 1;
            if (successStreak >= 10) {
                successStreak = 0;
                if (currentLimit < maxLimit) {
                    currentLimit += 1;
                    job.parallel = currentLimit;
                }
                if (delayMs > 0) {
                    delayMs = Math.max(
                        ctx.engine.id === 'google' ? 80 : 0,
                        Math.floor(delayMs * 0.65)
                    );
                }
            }
        }
        notifyWaiters();
    };

    const onRateLimit = (retryAfterMs?: number): void => {
        successStreak = 0;
        const nextLimit = Math.max(1, Math.floor(currentLimit / 2));
        if (nextLimit !== currentLimit) {
            currentLimit = nextLimit;
            job.parallel = currentLimit;
        }
        const suggested = retryAfterMs ? Math.min(retryAfterMs, 4000) : delayMs ? delayMs * 2 : 500;
        delayMs = Math.min(8000, Math.max(350, suggested));
        emitTranslationEvent(true);
    };

    const settle = (index: number): void => {
        const item = ctx.queue[index];
        if (item.settled || item.resolved < item.parts.length) return;
        item.settled = true;
        job.done += item.targets.length;

        const ready = item.values.every(
            (value) => typeof value === 'string' && value.trim().length > 0
        );
        if (!ready) {
            job.failed += item.targets.length;
            return;
        }

        const rawComposed = item.template
            .map((chunk, idx) => {
                const value = idx < item.values.length ? item.values[idx] : null;
                return typeof value === 'string' ? `${chunk}${value.trim()}` : chunk;
            })
            .join('')
            .trim()
            .replace(/⟦\s*(\d+)\s*⟧/g, '⟦$1⟧');

        const composed = normalizeTranslation(rawComposed, job.target);

        if (!composed || !placeholdersMatch(item.core, composed)) {
            job.failed += item.targets.length;
            return;
        }

        for (const target of item.targets) {
            const unmasked = unmaskText(composed, target.placeholders);
            ctx.translations.set(
                target.id,
                `${target.lead}${normalizeTranslation(unmasked, job.target)}${target.trail}`
            );
        }
        job.translated += item.targets.length;
        if (job.mode === 'review') job.repaired += item.targets.length;

        const qa = assessTranslation(item.core, composed, job.target);
        if (qa.ok) {
            recordMemory(ctx.store, job.target, ctx.profHash, item.core, composed);
        }

        const firstTarget = item.targets[0];
        const sampleSrc = firstTarget ? unmaskText(item.core, firstTarget.placeholders) : item.core;
        const sampleDst = firstTarget
            ? normalizeTranslation(unmaskText(composed, firstTarget.placeholders), job.target)
            : composed;
        recentPairs = [
            ...recentPairs.slice(-1),
            { source: trimSample(sampleSrc, 240), translated: trimSample(sampleDst, 240) }
        ];
        job.samples = [
            ...job.samples.slice(-1),
            { source: trimSample(sampleSrc, 220), translated: trimSample(sampleDst, 220) }
        ];
        emitTranslationEvent(false);
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
                    job.engine === 'gemini' && ctx.config.geminiPlan !== 'paid'
                        ? 'ترجمه با جمنای با مکث کنترل‌شده ادامه دارد…'
                        : `${job.parallel} درخواست هم‌زمان در حال ترجمه…`;
                emitTranslationEvent(true);
            }

            const acquired = await acquireSlot();
            if (!acquired) return;

            let ok = false;
            try {
                const batch = takeBatch();
                if (!batch.length) {
                    notifyWaiters();
                    return;
                }

                const tmHints: { source: string; translated: string }[] = [];
                for (const unit of batch) {
                    const hint = ctx.queue[unit.item]?.tmHint;
                    if (hint && !tmHints.some((h) => h.source === hint.source)) {
                        tmHints.push(hint);
                        if (tmHints.length >= 3) break;
                    }
                }

                const batchContext: TranslateBatchContext = {
                    bookTitle: ctx.bookTitle,
                    chapterHeading: batch.find((u) => u.heading)?.heading || '',
                    previousPairs: recentPairs,
                    tmHints: tmHints.length ? tmHints : undefined,
                    mode: 'body',
                    onUsage: (delta) => addUsage(job, delta),
                    onRateLimit
                };

                let values: string[] | null = null;
                try {
                    values = await ctx.engine.translate(
                        batch.map((unit) => unit.text),
                        job.target,
                        job.targetLabel,
                        () => control.cancelled,
                        batchContext
                    );
                    failures = 0;
                    ok = true;
                } catch (error) {
                    if (error instanceof FatalEngineError) {
                        fatalError = error;
                        halted = true;
                        job.message = error.message;
                        return;
                    }
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
            } finally {
                releaseSlot(ok);
            }
        }
    };

    await Promise.all(Array.from({ length: maxLimit }, () => worker()));
    while (waiters.length) waiters.shift()?.();

    /* Anything the provider never answered counts as a failure, not as pending. */
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

    if (fatalError) throw fatalError;
}

async function drainTranslationQueue(): Promise<void> {
    if (activeJob && (activeJob.status === 'running' || activeJob.status === 'paused')) return;
    while (translationQueue.length > 0) {
        const next = translationQueue.shift()!;
        emitTranslationEvent(true);
        try {
            await startTranslation(next.filename, {
                target: next.target,
                mode: next.mode,
                bilingual: next.bilingual,
                force: next.force,
                markTranslator: next.markTranslator,
                pageRange: next.pageRange,
                autoGlossary: next.autoGlossary
            });
            if (activeJob && activeJob.status === 'running') {
                return;
            }
        } catch {
            /* skip failing queued book and continue to next */
        }
    }
}

async function runJob(ctx: JobContext): Promise<void> {
    const job = ctx.job;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    touch(job, true);

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
            job.message = 'ترجمهٔ معلومات کتاب…';
            touch(job, true);
            await localizedFrontmatter(ctx);
            await flushJob(ctx);
            const tocUnits = allUnits.filter((unit) => ctx.queue[unit.item].zone === 'toc');
            if (tocUnits.length && !control.cancelled) {
                job.message = 'ترجمهٔ فهرست مطالب…';
                touch(job, true);
                await runUnits(ctx, tocUnits, job.parallel);
            }
            nextUnits = allUnits.filter((unit) => ctx.queue[unit.item].zone !== 'toc');
        }
        await runUnits(ctx, nextUnits, job.parallel);

        const retry: QueueItem[] = ctx.queue.filter((item) => {
            if (!item.settled) return false;
            if (item.values.some((value) => !value || !value.trim())) return true;
            const composed = item.template
                .map((chunk, idx) => {
                    const value = idx < item.values.length ? item.values[idx] : null;
                    return typeof value === 'string' ? `${chunk}${value.trim()}` : chunk;
                })
                .join('')
                .trim()
                .replace(/⟦\s*(\d+)\s*⟧/g, '⟦$1⟧');
            return !placeholdersMatch(item.core, composed);
        });
        if (retry.length && !control.cancelled) {
            job.message = `تلاش دوباره برای ${retry.length} متن ناموفق…`;
            touch(job, true);
            const indexes = new Set<number>();
            ctx.queue.forEach((item, index) => {
                if (retry.includes(item)) indexes.add(index);
            });
            for (const index of indexes) {
                const item = ctx.queue[index];
                job.done = Math.max(0, job.done - item.targets.length);
                job.failed = Math.max(0, job.failed - item.targets.length);
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
            job.message = job.repaired
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
        await persistMemory(true);
        control.paused = false;
        control.cancelled = false;
        touch(job, true);
        if (outcome === 'done' && translationQueue.length > 0) {
            setImmediate(() => {
                void drainTranslationQueue();
            });
        }
    }
}

/* ----------------------------- public api ----------------------------- */

interface TranslateOptions {
    target?: unknown;
    force?: unknown;
    markTranslator?: unknown;
    mode?: unknown;
    bilingual?: unknown;
    pageRange?: unknown;
    autoGlossary?: unknown;
    page?: unknown;
}

function normalizeTarget(value: unknown): string {
    const raw = typeof value === 'string' ? value.trim() : '';
    return raw ? normalizeLanguageCode(raw.slice(0, 60)) : 'fa';
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

function normalizeDigits(str: string): string {
    return str
        .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
        .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

export function parsePageRange(input: unknown, maxPages?: number): Set<number> | null {
    if (typeof input !== 'string') return null;
    const raw = input.trim();
    if (!raw) return null;
    const normalized = normalizeDigits(raw);
    const pages = new Set<number>();
    for (const rawPart of normalized.split(/[,،؛;]+/)) {
        const part = rawPart.trim();
        if (!part) continue;
        const range = part.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
        if (range) {
            let start = Number(range[1]);
            let end = Number(range[2]);
            if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
            if (start > end) [start, end] = [end, start];
            const cap = maxPages ? Math.min(end, maxPages) : Math.min(end, start + 5000);
            for (let p = Math.max(1, start); p <= cap; p += 1) pages.add(p);
            continue;
        }
        if (/^\d+$/.test(part)) {
            const p = Number(part);
            if (Number.isFinite(p) && p >= 1 && (!maxPages || p <= maxPages)) pages.add(p);
        }
    }
    if (!pages.size) {
        throw new HttpError('بازهٔ صفحات معتبر نیست؛ نمونهٔ درست: 1-10، 15');
    }
    return pages;
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
        characters: 0,
        usage: {
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            requests: 0
        }
    };
}

function validateEngineTargetOrThrow(config: TranslateConfig, target: string): void {
    try {
        resolveEngineTargetLang(config.engine, target);
    } catch (error) {
        if (error instanceof FatalEngineError) {
            throw new HttpError(error.message, 400);
        }
        throw error;
    }
}

function mergeGlossaryTerms(
    baseGlossary: string,
    newTerms: string[]
): { glossary: string; mergedCount: number } {
    const existingLines = baseGlossary
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    const seenSources = new Set<string>();
    for (const line of existingLines) {
        const eq = line.search(/\s*(?:=>|->|=|:|\t)\s*/);
        const key = (eq > 0 ? line.slice(0, eq) : line).trim().toLowerCase();
        if (key) seenSources.add(key);
    }
    let mergedCount = 0;
    const added: string[] = [];
    for (const raw of newTerms) {
        const line = raw.trim();
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const src = line.slice(0, eq).trim().toLowerCase();
        if (!src || seenSources.has(src)) continue;
        seenSources.add(src);
        added.push(line);
        mergedCount += 1;
    }
    return {
        glossary: [...existingLines, ...added].join('\n'),
        mergedCount
    };
}

function extractSampleExcerpt(model: BookModel): string {
    const parts: string[] = [];
    let total = 0;
    for (const seg of model.segments) {
        const raw = seg.bilingualOrig ?? unmaskText(seg.value, seg.placeholders);
        const clean = raw.replace(/\s+/g, ' ').trim();
        if (!clean || !hasLetters(clean)) continue;
        if (seg.zone === 'toc' || seg.page <= 4 || total < 2200) {
            parts.push(clean);
            total += clean.length + 1;
            if (total >= 4500) break;
        }
    }
    return parts.join('\n').slice(0, 4600);
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
    validateEngineTargetOrThrow(config, target);

    const engine = createEngine(config);
    const content = await fs.promises.readFile(filePath, 'utf8');
    const model = buildModel(content);
    const totalPages = model.segments.reduce((max, s) => Math.max(max, s.page), 1);
    const pageFilter = parsePageRange(options.pageRange, totalPages);
    const store = await loadMemory();
    const profHash = computeProfileHash(target, config);

    const plan = planTranslation(model, target, store, {
        mode,
        force,
        apply: false,
        profHash,
        pageFilter
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

export interface TranslationPreviewItem {
    source: string;
    translated: string;
    qaOk: boolean;
    qaIssue?: string;
}

export interface TranslationPreviewResult {
    filename: string;
    title: string;
    page: number;
    totalPages: number;
    target: string;
    targetLabel: string;
    engine: string;
    engineLabel: string;
    items: TranslationPreviewItem[];
    usage: TranslationUsage;
}

export async function previewTranslationPage(
    filenameInput: unknown,
    options: TranslateOptions = {}
): Promise<TranslationPreviewResult> {
    const filePath = resolveBookPath(filenameInput);
    if (!filePath) throw new HttpError('فایل کتاب معتبر نیست.');
    const filename = String(filenameInput);
    const target = normalizeTarget(options.target);
    const config = await readTranslateConfig();
    validateEngineTargetOrThrow(config, target);

    const engine = createEngine(config);
    const content = await fs.promises.readFile(filePath, 'utf8');
    const model = buildModel(content);
    const totalPages = model.segments.reduce((max, s) => Math.max(max, s.page), 1);
    const reqPage = Math.min(totalPages, Math.max(1, Math.round(Number(options.page) || 1)));
    const title = displayTitle(content, filename);
    const label = targetLabel(target);

    const pageSegments = model.segments
        .filter((s) => s.page === reqPage)
        .filter((s) => {
            const raw = s.bilingualOrig ?? s.value;
            return Boolean(raw.trim() && hasLetters(raw));
        })
        .slice(0, 12);

    const usage: TranslationUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, requests: 0 };
    if (!pageSegments.length) {
        return {
            filename,
            title,
            page: reqPage,
            totalPages,
            target,
            targetLabel: label,
            engine: config.engine,
            engineLabel: engine.label,
            items: [],
            usage
        };
    }

    const inputs = pageSegments.map((s) => {
        if (s.bilingualOrig !== undefined) {
            return maskInlineProse(s.bilingualOrig).masked.trim();
        }
        return outerSpaces(s.value).core;
    });

    try {
        const translatedRaw = await engine.translate(inputs, target, label, () => false, {
            bookTitle: title,
            chapterHeading: pageSegments[0]?.heading || '',
            mode: 'body',
            onUsage: (delta) => {
                usage.inputTokens += delta.inputTokens;
                usage.outputTokens += delta.outputTokens;
                usage.cachedTokens += delta.cachedTokens;
                usage.requests += delta.requests;
            }
        });

        const items: TranslationPreviewItem[] = pageSegments.map((seg, idx) => {
            const maskedSrc = inputs[idx];
            const srcUnmasked = unmaskText(maskedSrc, seg.placeholders);
            const rawOut = String(translatedRaw[idx] ?? '').trim();
            const post = normalizeTranslation(rawOut, target);
            const qa = assessTranslation(maskedSrc, post, target);
            const dstUnmasked = normalizeTranslation(unmaskText(post, seg.placeholders), target);
            return {
                source: srcUnmasked,
                translated: dstUnmasked,
                qaOk: qa.ok,
                qaIssue: qa.issue
            };
        });

        return {
            filename,
            title,
            page: reqPage,
            totalPages,
            target,
            targetLabel: label,
            engine: config.engine,
            engineLabel: engine.label,
            items,
            usage
        };
    } catch (error) {
        const message =
            error instanceof Error && error.message && error.message !== 'cancelled'
                ? error.message
                : 'اجرای پیش‌نمایش ترجمه انجام نشد.';
        throw new HttpError(message, error instanceof FatalEngineError ? 400 : 502);
    }
}

export interface GlossaryDiscoveryResult {
    terms: string[];
    mergedCount: number;
    glossary: string;
    usage: TranslationUsage;
}

export async function discoverBookGlossary(
    filenameInput: unknown,
    options: TranslateOptions = {}
): Promise<GlossaryDiscoveryResult> {
    const filePath = resolveBookPath(filenameInput);
    if (!filePath) throw new HttpError('فایل کتاب معتبر نیست.');
    const target = normalizeTarget(options.target);
    const label = targetLabel(target);
    const config = await readTranslateConfig();
    if (config.engine !== 'gemini' && config.engine !== 'openai' && config.engine !== 'anthropic') {
        throw new HttpError('استخراج خودکار واژه‌نامه فقط با موتورهای هوش مصنوعی فعال است.');
    }

    const content = await fs.promises.readFile(filePath, 'utf8');
    const model = buildModel(content);
    const excerpt = extractSampleExcerpt(model);
    if (!excerpt) {
        return { terms: [], mergedCount: 0, glossary: config.glossary, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, requests: 0 } };
    }

    const usage: TranslationUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, requests: 0 };
    const terms = await extractGlossaryWithAi(config, excerpt, label, () => false, (delta) => {
        usage.inputTokens += delta.inputTokens;
        usage.outputTokens += delta.outputTokens;
        usage.cachedTokens += delta.cachedTokens;
        usage.requests += delta.requests;
    });
    const merged = mergeGlossaryTerms(config.glossary, terms);
    return {
        terms,
        mergedCount: merged.mergedCount,
        glossary: merged.glossary,
        usage
    };
}

export async function retranslateSegment(body: {
    text?: unknown;
    target?: unknown;
}): Promise<{ translated: string; qaOk: boolean; qaIssue?: string; usage: TranslationUsage }> {
    const rawText = typeof body.text === 'string' ? body.text.trim() : '';
    if (!rawText) throw new HttpError('متن بند برای بازترجمه خالی است.');
    const target = normalizeTarget(body.target);
    const label = targetLabel(target);
    const config = await readTranslateConfig();
    validateEngineTargetOrThrow(config, target);

    const engine = createEngine(config);
    const { masked, placeholders } = maskInlineProse(rawText);
    const usage: TranslationUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, requests: 0 };

    try {
        const result = await engine.translate([masked], target, label, () => false, {
            mode: 'body',
            onUsage: (delta) => {
                usage.inputTokens += delta.inputTokens;
                usage.outputTokens += delta.outputTokens;
                usage.cachedTokens += delta.cachedTokens;
                usage.requests += delta.requests;
            }
        });
        const post = normalizeTranslation(String(result[0] ?? '').trim(), target);
        const qa = assessTranslation(masked, post, target);
        const unmasked = normalizeTranslation(unmaskText(post, placeholders), target);
        return {
            translated: unmasked,
            qaOk: qa.ok,
            qaIssue: qa.issue,
            usage
        };
    } catch (error) {
        const message =
            error instanceof Error && error.message && error.message !== 'cancelled'
                ? error.message
                : 'بازترجمهٔ بند انجام نشد.';
        throw new HttpError(message, 502);
    }
}

export async function saveMemoryEntry(body: {
    source?: unknown;
    translated?: unknown;
    target?: unknown;
}): Promise<{ saved: boolean }> {
    const source = typeof body.source === 'string' ? body.source.trim() : '';
    const translated = typeof body.translated === 'string' ? body.translated.trim() : '';
    if (!source || !translated) {
        throw new HttpError('متن مبدأ و ترجمه هر دو لازم هستند.');
    }
    const target = normalizeTarget(body.target);
    const config = await readTranslateConfig();
    const store = await loadMemory();
    const profHash = computeProfileHash(target, config);

    const { masked, placeholders } = maskInlineProse(source);
    const { core } = outerSpaces(masked);
    if (!core) return { saved: false };

    let remasked = translated;
    for (const [token, raw] of placeholders) {
        if (raw && remasked.includes(raw)) {
            remasked = remasked.split(raw).join(token);
        }
    }
    const normalizedVal = normalizeTranslation(remasked, target);
    recordMemory(store, target, profHash, core, normalizedVal);
    await persistMemory();
    return { saved: true };
}

export interface TranslationTestResult {
    ok: boolean;
    engine: string;
    engineLabel: string;
    model: string;
    milliseconds: number;
    sample: string;
}

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
    return snapshotJob();
}

export function getTranslationQueue(): QueuedBookJob[] {
    return [...translationQueue];
}

export async function enqueueTranslations(
    rawItems: Array<Record<string, unknown>>
): Promise<{ queue: QueuedBookJob[]; startedImmediately: boolean }> {
    const added: QueuedBookJob[] = [];
    for (const item of rawItems) {
        const filePath = resolveBookPath(item.filename);
        if (!filePath) continue;
        const filename = String(item.filename);
        if (
            activeJob &&
            (activeJob.status === 'running' || activeJob.status === 'paused') &&
            activeJob.filename === filename
        ) {
            continue;
        }
        if (translationQueue.some((q) => q.filename === filename)) continue;
        let content = '';
        try {
            content = await fs.promises.readFile(filePath, 'utf8');
        } catch {
            continue;
        }
        const target = normalizeTarget(item.target);
        const mode = normalizeMode(item.mode);
        const entry: QueuedBookJob = {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            filename,
            title: displayTitle(content, filename),
            target,
            targetLabel: targetLabel(target),
            mode,
            bilingual: typeof item.bilingual === 'boolean' ? item.bilingual : undefined,
            force: item.force === true,
            markTranslator: item.markTranslator !== false,
            pageRange: typeof item.pageRange === 'string' ? item.pageRange.trim() : undefined,
            autoGlossary: item.autoGlossary === true,
            addedAt: new Date().toISOString()
        };
        translationQueue.push(entry);
        added.push(entry);
    }

    let startedImmediately = false;
    if (
        (!activeJob || (activeJob.status !== 'running' && activeJob.status !== 'paused')) &&
        translationQueue.length > 0
    ) {
        startedImmediately = true;
        void drainTranslationQueue();
    } else {
        emitTranslationEvent(true);
    }
    return { queue: getTranslationQueue(), startedImmediately };
}

export function removeQueuedTranslation(id: unknown): QueuedBookJob[] {
    const idStr = typeof id === 'string' ? id.trim() : '';
    if (!idStr) return getTranslationQueue();
    const index = translationQueue.findIndex((item) => item.id === idStr);
    if (index >= 0) {
        translationQueue.splice(index, 1);
        emitTranslationEvent(true);
    }
    return getTranslationQueue();
}

export function clearTranslationQueue(): QueuedBookJob[] {
    if (translationQueue.length > 0) {
        translationQueue.length = 0;
        emitTranslationEvent(true);
    }
    return [];
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
    const autoGlossary = options.autoGlossary === true;
    const baseConfig = await readTranslateConfig();
    validateEngineTargetOrThrow(baseConfig, target);

    const content = await fs.promises.readFile(filePath, 'utf8');
    const stat = await fs.promises.stat(filePath);
    const model = buildModel(content);
    const totalPages = model.segments.reduce((max, s) => Math.max(max, s.page), 1);
    const pageRangeRaw = typeof options.pageRange === 'string' ? options.pageRange.trim() : '';
    const pageFilter = parsePageRange(pageRangeRaw, totalPages);

    /* Optional job-scoped pre-flight glossary extraction */
    const initialUsage: TranslationUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, requests: 0 };
    let jobConfig: TranslateConfig = baseConfig;
    if (
        autoGlossary &&
        (baseConfig.engine === 'gemini' || baseConfig.engine === 'openai' || baseConfig.engine === 'anthropic')
    ) {
        const excerpt = extractSampleExcerpt(model);
        if (excerpt) {
            const terms = await extractGlossaryWithAi(
                baseConfig,
                excerpt,
                targetLabel(target),
                () => false,
                (delta) => {
                    initialUsage.inputTokens += delta.inputTokens;
                    initialUsage.outputTokens += delta.outputTokens;
                    initialUsage.cachedTokens += delta.cachedTokens;
                    initialUsage.requests += delta.requests;
                }
            );
            if (terms.length) {
                const merged = mergeGlossaryTerms(baseConfig.glossary, terms);
                jobConfig = { ...baseConfig, glossary: merged.glossary };
            }
        }
    }

    const bilingual =
        typeof options.bilingual === 'boolean' ? options.bilingual : jobConfig.bilingual;
    const engine = createEngine(jobConfig);
    const store = await loadMemory();
    const profHash = computeProfileHash(target, jobConfig);

    const plan = planTranslation(model, target, store, {
        mode,
        force,
        apply: true,
        profHash,
        pageFilter
    });

    const needsSnapshot = plan.queuedSegments > 0 || plan.cached > 0;
    const snapshot = needsSnapshot ? await createBookSnapshot(filename, 'before-translation') : null;
    const parallel =
        jobConfig.engine === 'gemini' && jobConfig.geminiPlan !== 'paid'
            ? 1
            : Math.max(1, jobConfig.concurrency);
    const title = displayTitle(content, filename);

    const job: TranslationJob = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        filename,
        title,
        target,
        targetLabel: targetLabel(target),
        mode,
        engine: jobConfig.engine,
        engineLabel: engine.label,
        parallel,
        bilingual,
        pageRange: pageRangeRaw || undefined,
        status: plan.queuedSegments ? 'running' : 'done',
        ...emptyJobStats(),
        usage: initialUsage,
        total: plan.queuedSegments,
        cached: plan.cached,
        skipped: plan.skipped,
        inspected: plan.inspected,
        repaired: 0,
        characters: plan.characters,
        startedAt: null,
        finishedAt: plan.queuedSegments ? null : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        snapshotId: snapshot?.id ?? null,
        revision: revisionOf(stat),
        message: plan.queuedSegments
            ? mode === 'review'
                ? `بازبینی آغاز شد؛ ${plan.queuedSegments} بخش برای ترمیم پیدا شد.`
                : jobConfig.engine === 'gemini' && jobConfig.geminiPlan !== 'paid'
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
    emitTranslationEvent(true);

    const ctx: JobContext = {
        job,
        filename,
        filePath,
        model,
        translations: plan.translations,
        queue: plan.queue,
        store,
        profHash,
        revision: job.revision!,
        frontmatter: model.frontmatter,
        newline: content.includes('\r\n') ? '\r\n' : '\n',
        markTranslator,
        bilingual,
        engine,
        config: jobConfig,
        order: jobConfig.order,
        bookTitle: title
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
        emitTranslationEvent(true);
        if (translationQueue.length > 0) {
            setImmediate(() => {
                void drainTranslationQueue();
            });
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
        emitTranslationEvent(true);
    }
    return getTranslationJob();
}

export function resumeTranslation(): TranslationJob | null {
    if (activeJob && activeJob.status === 'paused') {
        control.paused = false;
        activeJob.status = 'running';
        activeJob.message = 'ترجمه ادامه یافت.';
        activeJob.updatedAt = new Date().toISOString();
        emitTranslationEvent(true);
    }
    return getTranslationJob();
}

export function cancelTranslation(): TranslationJob | null {
    if (activeJob && (activeJob.status === 'running' || activeJob.status === 'paused')) {
        control.cancelled = true;
        control.paused = false;
        activeJob.message = 'در حال توقف و ذخیرهٔ بخش‌های انجام‌شده…';
        activeJob.updatedAt = new Date().toISOString();
        emitTranslationEvent(true);
    }
    return getTranslationJob();
}
