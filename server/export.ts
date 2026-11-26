/* Book export engine: Markdown, HTML, DOCX and PDF.

   It understands both plain standard Markdown (GFM, `[^note]` footnotes) and the
   converted-book Markdown this library stores: `---` page separators, `**ص ٧**`
   page labels, `<a id="pN"></a>` anchors, `==پاورقی‌ها==` footnote blocks with
   `> (١) …` lines and `(¬1)` references.

   HTML is self-contained (RTL, print CSS, optional embedded Vazirmatn). DOCX is
   written as OOXML inside a ZIP this project builds without dependencies. PDF is
   produced by printing the same HTML with the Chromium/Edge engine already on
   the machine; if no browser is found the caller receives the print page so it
   can be saved as PDF from the browser's print dialog. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { marked } from 'marked';
import { DIST_DIR } from './config.js';
import { parseFrontmatter, resolveBookPath } from './library.js';
import { HttpError } from './http.js';
import { measureText } from './text-stats.js';
import { createZip } from './zip.js';

const execFileAsync = promisify(execFile);

export type ExportFormat = 'md' | 'html' | 'docx' | 'pdf';
export type ExportDisplayMode = 'both' | 'translated' | 'original';

export interface ExportResult {
    contentType: string;
    asciiName: string;
    fileName: string;
    data: Buffer;
    inline?: boolean;
}

/* ----------------------------- shared helpers ----------------------------- */

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

function toPersianDigits(value: number | string): string {
    return String(value).replace(/\d/g, (digit) => PERSIAN_DIGITS[Number(digit)] ?? digit);
}

function normalizeDigits(value: string): string {
    return String(value).replace(/[\u06F0-\u06F9]/g, (digit) =>
        String(digit.charCodeAt(0) - 0x06f0)
    );
}

function escapeHtml(value: string): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function safeId(value: string): string {
    return encodeURIComponent(value).replace(/%/g, '_').replace(/[#?]/g, '-');
}

function stripTags(value: string): string {
    return String(value)
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function plainText(value: string): string {
    return stripTags(value)
        .replace(/[*_`~]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function fileNamePart(value: string): string {
    return (
        String(value)
            .replace(/[\\/:*?"<>|\r\n\t]+/g, '-')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 90) || 'book'
    );
}

function asciiNamePart(value: string): string {
    const ascii = String(value)
        .replace(/[^\w.-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60);
    return ascii || 'book';
}

/* ----------------------------- document model ----------------------------- */

interface Footnote {
    label: string;
    text: string;
}

interface ExportPage {
    marker: string;
    markdown: string;
    footnotes: Footnote[];
}

interface StandardNote {
    id: string;
    label: string;
    text: string;
}

interface DocumentModel {
    filename: string;
    title: string;
    author: string;
    authorInfo: string;
    translator: string;
    section: string;
    volume: string;
    volumeCount: string;
    tags: string[];
    wordCount: number;
    readingMinutes: number;
    footnoteCount: number;
    hasBilingual: boolean;
    frontmatterRaw: string;
    bodyRaw: string;
    format: 'book' | 'standard';
    pages: ExportPage[];
    notes: StandardNote[];
}

const PAGE_MARKER = /^(?:بخش\s*:\s*[\d\u06F0-\u06F9]+(?:\s*-?\s*صفحه\s*:\s*[\d\u06F0-\u06F9]+)?|الجزء\s*:.*|صفحه\s*:.*|ص\s*[\d\u06F0-\u06F9]+)$/;
const NOTE_HEADING = /^\s*==\s*پاورقی‌ها\s*==\s*$/;
const NOTE_START = /^(?:¬\s*_+|>\s*پاورقی.*|\*{3,})$/;
const NOTE_LINE = /^\(?¬?\s*([\d\u06F0-\u06F9]+)\)?[.)]?\s+(.*)$/;

function parseFootnoteLines(lines: string[]): Footnote[] {
    const notes: Footnote[] = [];
    let current: Footnote | null = null;
    for (const raw of lines) {
        const text = raw.replace(/^>\s?/, '').trim();
        if (!text) continue;
        if (NOTE_HEADING.test(text) || NOTE_START.test(text)) continue;
        const match = text.match(NOTE_LINE);
        if (match) {
            current = { label: match[1], text: match[2].trim() };
            notes.push(current);
            continue;
        }
        if (current) current.text = `${current.text} ${text}`.trim();
        else notes.push({ label: String(notes.length + 1), text });
    }
    return notes;
}

function parseStandardNotes(body: string): { body: string; notes: StandardNote[] } {
    const lines = body.split('\n');
    const notes: StandardNote[] = [];
    const kept: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const match = line.match(/^\[\^([^\]\n]+)\]:\s*(.*)$/);
        if (match) {
            const id = match[1].trim();
            let text = match[2].trim();
            while (
                index + 1 < lines.length &&
                /^(?: {2,}|\t)/.test(lines[index + 1]) &&
                !/^\[\^[^\]\n]+\]:/.test(lines[index + 1].trim())
            ) {
                text = `${text} ${lines[index + 1].trim()}`.trim();
                index += 1;
            }
            notes.push({ id, label: id, text });
            continue;
        }
        kept.push(line);
    }
    const cleaned = kept
        .join('\n')
        .replace(/^#{1,6}\s+پاورقی‌ها\s*$/gim, '')
        .replace(/\n{3,}/g, '\n\n');
    return { body: cleaned, notes };
}

function findBalancedSpanClose(text: string, startIndex: number): number {
    const tagRe = /<span\b[^>]*>|<\/span>/gi;
    tagRe.lastIndex = startIndex;
    let depth = 1;
    let match: RegExpExecArray | null;
    while ((match = tagRe.exec(text)) !== null) {
        if (match[0].startsWith('</')) {
            depth -= 1;
            if (depth === 0) return match.index;
        } else {
            depth += 1;
        }
    }
    return -1;
}

function filterBilingualContent(text: string, display: ExportDisplayMode): string {
    if (display === 'both') return text;
    if (
        !/<span\b[^>]*\bclass\s*=\s*(?:"[^"]*\bbi-(?:orig|trans)\b|'[^']*\bbi-(?:orig|trans)\b)/i.test(
            text
        )
    ) {
        return text;
    }

    const openRe = /<span\b[^>]*\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi;
    let result = '';
    let cursor = 0;

    while (cursor < text.length) {
        openRe.lastIndex = cursor;
        const match = openRe.exec(text);
        if (!match) {
            result += text.slice(cursor);
            break;
        }

        const classAttr = match[1] ?? match[2] ?? '';
        const hasOrig = /(?:^|\s)bi-orig(?:\s|$)/.test(classAttr);
        const hasTrans = /(?:^|\s)bi-trans(?:\s|$)/.test(classAttr);
        if (!hasOrig && !hasTrans) {
            result += text.slice(cursor, match.index + match[0].length);
            cursor = match.index + match[0].length;
            continue;
        }

        const openStart = match.index;
        const openEnd = openStart + match[0].length;
        const closeStart = findBalancedSpanClose(text, openEnd);
        if (closeStart === -1) {
            result += text.slice(cursor, openEnd);
            cursor = openEnd;
            continue;
        }
        const closeEnd = text.indexOf('>', closeStart) + 1;

        result += text.slice(cursor, openStart);
        const inner = text.slice(openEnd, closeStart);
        const keep =
            (display === 'translated' && hasTrans) ||
            (display === 'original' && hasOrig);

        if (keep) {
            result += inner;
            cursor = closeEnd;
        } else {
            const trimmedBr = result.replace(/[ \t]*<br\s*\/?>[ \t]*$/i, '');
            if (trimmedBr !== result) {
                result = trimmedBr;
            }
            let nextPos = closeEnd;
            const rest = text.slice(nextPos);
            const brAfter = rest.match(/^[ \t]*<br\s*\/?>[ \t]*/i);
            if (brAfter) {
                nextPos += brAfter[0].length;
            } else {
                const blankSep = rest.match(
                    /^[ \t]*\n{1,2}[ \t]*(?=<span\b[^>]*\bbi-(?:orig|trans)\b)/i
                );
                if (blankSep) {
                    nextPos += blankSep[0].length;
                } else {
                    const nlAfter = rest.match(/^[ \t]*\n/);
                    if (nlAfter) {
                        const dropped = result.replace(/\n[ \t]*\n[ \t]*$/, '\n');
                        if (dropped !== result) {
                            result = dropped;
                            nextPos += nlAfter[0].length;
                        }
                    }
                }
            }
            cursor = nextPos;
        }
    }

    return result.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

function parseDocument(
    content: string,
    filename: string,
    display: ExportDisplayMode = 'both'
): DocumentModel {
    const frontmatterMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    const frontmatterRaw = frontmatterMatch ? frontmatterMatch[0] : '';
    const rawBody = (frontmatterMatch ? content.slice(frontmatterMatch[0].length) : content)
        .replace(/^\uFEFF/, '')
        .replace(/\r\n/g, '\n');
    const bodyRaw = filterBilingualContent(rawBody, display);

    const meta = parseFrontmatter(content);
    const headingMatch = bodyRaw.match(/^\s*#\s+(.+?)\s*$/m);
    const authorMatch =
        bodyRaw
            .slice(0, 6000)
            .match(/^\s*\*\*(?:المؤلف|نویسنده|تألیف)\s*[:：]\*\*\s*(.+)$/m) ||
        bodyRaw.slice(0, 6000).match(/^\s*(?:المؤلف|نویسنده)\s*[:：]\s*(.+)$/m);

    const title = String(
        meta['نام کتاب'] ||
            meta['عنوان کتاب'] ||
            meta.title ||
            (headingMatch ? headingMatch[1].replace(/[*_`]/g, '') : '') ||
            path.basename(filename, path.extname(filename))
    ).trim();
    const author = String(
        meta['نویسنده'] ||
            meta.author ||
            (authorMatch ? authorMatch[1].replace(/[*_`]/g, '') : '')
    ).trim();

    const looksBook =
        NOTE_HEADING.test(bodyRaw) ||
        /\(¬\s*[\d\u06F0-\u06F9]+\)/.test(bodyRaw) ||
        /<a id="p[\d]/i.test(bodyRaw) ||
        /^[ \t]*---[ \t]*$/m.test(bodyRaw);
    const hasStandardNotes = /^\[\^[^\]\n]+\]:/m.test(bodyRaw);
    const format: 'book' | 'standard' = hasStandardNotes && !looksBook ? 'standard' : looksBook ? 'book' : 'standard';

    const hasBilingual = /<span\b[^>]*\bclass=["'][^"']*\bbi-orig\b/i.test(bodyRaw);
    const authorInfo = String(meta['معلومات نویسنده'] || '').trim();
    const translator = String(meta['مترجم'] || meta.translator || '').trim();
    const section = String(meta['بخش'] || meta.category || '').trim();
    const volume = String(meta['جلد'] || '').trim();
    const volumeCount = String(meta['تعداد جلدها'] || '').trim();
    const tags = Array.isArray(meta['برچسب ها'])
        ? (meta['برچسب ها'] as unknown[]).map(String).filter(Boolean)
        : [];
    const stats = measureText(stripTags(bodyRaw));
    const readingMinutes = stats.words > 0 ? Math.max(1, Math.round(stats.words / 180)) : 0;

    if (format === 'standard') {
        const parsed = parseStandardNotes(bodyRaw);
        return {
            filename,
            title,
            author,
            authorInfo,
            translator,
            section,
            volume,
            volumeCount,
            tags,
            wordCount: stats.words,
            readingMinutes,
            footnoteCount: parsed.notes.length,
            hasBilingual,
            frontmatterRaw,
            bodyRaw: parsed.body,
            format,
            pages: [{ marker: '', markdown: parsed.body.trim(), footnotes: [] }],
            notes: parsed.notes
        };
    }

    const pages: ExportPage[] = [];
    const sections = bodyRaw.split(/\n[ \t]*---[ \t]*\n/);
    for (const sec of sections) {
        const lines = sec.split('\n');
        let marker = '';
        let inNotes = false;
        const contentLines: string[] = [];
        const noteLines: string[] = [];
        for (const line of lines) {
            const text = line.trim();
            if (!inNotes && NOTE_HEADING.test(text)) {
                inNotes = true;
                continue;
            }
            if (!inNotes && NOTE_START.test(text)) {
                inNotes = true;
                continue;
            }
            if (!inNotes && PAGE_MARKER.test(text)) {
                marker = text;
                continue;
            }
            if (inNotes) noteLines.push(line);
            else contentLines.push(line);
        }
        const markdown = contentLines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
        if (!markdown && !marker && !noteLines.length) continue;
        pages.push({ marker, markdown, footnotes: parseFootnoteLines(noteLines) });
    }
    if (!pages.length) pages.push({ marker: '', markdown: bodyRaw.trim(), footnotes: [] });

    const footnoteCount = pages.reduce((sum, page) => sum + page.footnotes.length, 0);

    return {
        filename,
        title,
        author,
        authorInfo,
        translator,
        section,
        volume,
        volumeCount,
        tags,
        wordCount: stats.words,
        readingMinutes,
        footnoteCount,
        hasBilingual,
        frontmatterRaw,
        bodyRaw,
        format,
        pages,
        notes: []
    };
}

/* ----------------------------- markdown export ----------------------------- */

function normalizedMarkdown(doc: DocumentModel): string {
    if (doc.format === 'standard') {
        const body = doc.bodyRaw.trim();
        const notes = doc.notes.map((note) => `[^${note.id}]: ${note.text.replace(/\s+/g, ' ').trim()}`);
        return `${doc.frontmatterRaw}${body}${notes.length ? `\n\n${notes.join('\n')}` : ''}\n`;
    }

    let counter = 0;
    const definitions: string[] = [];
    const pages = doc.pages.map((page) => {
        const used = new Map<string, string>();
        for (const note of page.footnotes) {
            counter += 1;
            const id = String(counter);
            if (!used.has(normalizeDigits(note.label))) used.set(normalizeDigits(note.label), id);
            definitions.push(`[^${id}]: ${note.text.replace(/\s+/g, ' ').trim()}`);
        }

        let markdown = page.markdown.replace(/\(¬\s*([\d\u06F0-\u06F9]+)\)/g, (match, label: string) => {
            const id = used.get(normalizeDigits(label));
            return id ? `[^${id}]` : match;
        });

        const unreferenced = page.footnotes.filter((note) => {
            const id = used.get(normalizeDigits(note.label));
            return !id || !markdown.includes(`[^${id}]`);
        });
        if (unreferenced.length) {
            const list = unreferenced
                .map((note) => `> **${note.label}.** ${note.text.replace(/\s+/g, ' ').trim()}`)
                .join('\n');
            markdown += `\n\n> **پاورقی‌ها**\n>\n${list.replace(/\n/g, '\n')}`;
        }

        const marker = page.marker ? `> ${page.marker}\n\n` : '';
        return `${marker}${markdown}`.trim();
    });

    const body = pages.join('\n\n---\n\n');
    return `${doc.frontmatterRaw}${body}${definitions.length ? `\n\n${definitions.join('\n')}` : ''}\n`;
}

/* ----------------------------- html rendering ----------------------------- */

interface TocEntry {
    level: number;
    text: string;
    html: string;
    id: string;
    pageNumber: number;
    pageLabel: string;
}

function renderMarkdown(markdown: string): string {
    return marked.parse(markdown, { async: false }) as unknown as string;
}

function sanitizeHtml(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
        .replace(/<object[\s\S]*?<\/object>/gi, '')
        .replace(/<embed[^>]*>/gi, '')
        .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
        .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
        .replace(/\s(href|src)\s*=\s*"\s*javascript:[^"]*"/gi, ' href="#"')
        .replace(/\s(href|src)\s*=\s*'\s*javascript:[^']*'/gi, " href='#'");
}

function highlightMarks(html: string): string {
    const parts = html.split(/(<pre\b[\s\S]*?<\/pre>|<code\b[\s\S]*?<\/code>)/gi);
    return parts
        .map((part, index) =>
            index % 2 === 1
                ? part
                : part.replace(/==([^=\n<>]{1,240})==/g, '<mark class="book-highlight">$1</mark>')
        )
        .join('');
}

const CALLOUT_LABELS: Record<string, string> = {
    note: 'یادداشت',
    info: 'نکتهٔ توضیحی',
    tip: 'توصیه',
    hint: 'راهنما',
    warning: 'هشدار',
    caution: 'احتیاط',
    attention: 'توجه',
    important: 'مهم',
    danger: 'هشدار جدی',
    quote: 'نقل‌قول',
    cite: 'استناد',
    abstract: 'چکیده',
    summary: 'خلاصه',
    question: 'پرسش',
    example: 'نمونه'
};

function calloutKind(rawType: string): string {
    const lower = rawType.toLowerCase();
    if (lower === 'warning' || lower === 'caution' || lower === 'attention' || lower === 'danger') {
        return 'warning';
    }
    if (lower === 'tip' || lower === 'hint' || lower === 'success') return 'tip';
    if (lower === 'important') return 'important';
    if (lower === 'quote' || lower === 'cite') return 'quote';
    return 'info';
}

function transformCallouts(html: string): string {
    return html.replace(/<blockquote>\s*([\s\S]*?)\s*<\/blockquote>/gi, (full, inner: string) => {
        const match = inner.match(
            /^\s*<p>\[!([a-zA-Z]+)\](?:[ \t]*([^\n<]*?))?(?:<br\s*\/?>|\n)?([\s\S]*?)<\/p>([\s\S]*)$/i
        );
        if (!match) return full;
        const type = match[1].toLowerCase();
        const kind = calloutKind(type);
        const customTitle = plainText(match[2] || '');
        const title = customTitle || CALLOUT_LABELS[type] || 'یادداشت';
        const firstBody = (match[3] || '').trim();
        const restBody = (match[4] || '').trim();
        const bodyHtml = `${firstBody ? `<p>${firstBody}</p>` : ''}${restBody}`;
        return (
            `<aside class="callout callout--${kind}">` +
            `<div class="callout__head"><span class="callout__dot" aria-hidden="true"></span><span>${escapeHtml(
                title
            )}</span></div>` +
            `<div class="callout__body">${bodyHtml}</div>` +
            `</aside>`
        );
    });
}

function wrapTables(html: string): string {
    return html.replace(/<table\b[\s\S]*?<\/table>/gi, (table) => `<div class="table-scroll">${table}</div>`);
}

function bilingualHeadingHtml(inner: string): string {
    const origMatch = inner.match(/<span\b[^>]*\bclass=["'][^"']*\bbi-orig\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    const transMatch = inner.match(/<span\b[^>]*\bclass=["'][^"']*\bbi-trans\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
    if (origMatch && transMatch) {
        const orig = plainText(origMatch[1]);
        const trans = plainText(transMatch[1]);
        return (
            `<span class="toc-bi">` +
            `<span class="bi-orig">${escapeHtml(orig)}</span>` +
            `<span class="bi-trans">${escapeHtml(trans)}</span>` +
            `</span>`
        );
    }
    return escapeHtml(plainText(inner));
}

function addHeadingIds(
    html: string,
    toc: TocEntry[],
    pageNumber: number,
    pageLabel: string
): string {
    return html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_match, levelRaw: string, inner: string) => {
        const level = Number(levelRaw);
        const text = plainText(inner);
        if (!text) return `<h${level}>${inner}</h${level}>`;
        const id = `h-${toc.length + 1}`;
        if (level <= 3) {
            toc.push({
                level,
                text,
                html: bilingualHeadingHtml(inner),
                id,
                pageNumber,
                pageLabel
            });
        }
        return `<h${level} id="${id}" data-heading-label="${escapeHtml(text)}">${inner}</h${level}>`;
    });
}

let fontCssCache: Promise<string> | null = null;

async function loadFontCss(): Promise<string> {
    const assets = path.join(DIST_DIR, 'assets');
    try {
        const files = await fs.promises.readdir(assets);
        const parts: string[] = [];
        const candidates: { prefix: string; range: string }[] = [
            {
                prefix: 'vazirmatn-arabic',
                range: 'U+0600-06FF,U+0750-077F,U+FB50-FDFF,U+FE70-FEFF,U+200C-200D'
            },
            { prefix: 'vazirmatn-latin-wght', range: 'U+0000-00FF,U+2000-206F' }
        ];
        for (const candidate of candidates) {
            const file = files.find(
                (name) => name.startsWith(candidate.prefix) && name.endsWith('.woff2')
            );
            if (!file) continue;
            const data = await fs.promises.readFile(path.join(assets, file));
            parts.push(
                `@font-face{font-family:'VazirmatnBook';font-style:normal;font-weight:100 900;` +
                    `font-display:swap;src:url(data:font/woff2;base64,${data.toString('base64')}) format('woff2');` +
                    `unicode-range:${candidate.range};}`
            );
        }
        return parts.join('\n');
    } catch {
        return '';
    }
}

function fontCss(): Promise<string> {
    if (!fontCssCache) fontCssCache = loadFontCss();
    return fontCssCache;
}

function coverHtml(doc: DocumentModel): string {
    const metaItems: string[] = [];
    if (doc.translator) metaItems.push(`<span>مترجم: ${escapeHtml(doc.translator)}</span>`);
    if (doc.section) metaItems.push(`<span>بخش: ${escapeHtml(doc.section)}</span>`);
    if (doc.volume) {
        const volText = doc.volumeCount
            ? `جلد ${escapeHtml(toPersianDigits(doc.volume))} از ${escapeHtml(toPersianDigits(doc.volumeCount))}`
            : `جلد ${escapeHtml(toPersianDigits(doc.volume))}`;
        metaItems.push(`<span>${volText}</span>`);
    }

    const stats: { label: string; value: string }[] = [
        { label: 'صفحات', value: toPersianDigits(doc.pages.length) },
        { label: 'واژگان', value: toPersianDigits(doc.wordCount.toLocaleString('en-US')) }
    ];
    if (doc.readingMinutes > 0) {
        stats.push({ label: 'زمان مطالعه', value: `${toPersianDigits(doc.readingMinutes)} دقیقه` });
    }
    if (doc.footnoteCount > 0) {
        stats.push({ label: 'پاورقی‌ها', value: toPersianDigits(doc.footnoteCount) });
    }

    return (
        `<header class="cover">` +
        `<p class="cover__kicker">کتابخانهٔ فارسی MD</p>` +
        `<h1>${escapeHtml(doc.title)}</h1>` +
        `<div class="cover__rule" aria-hidden="true"></div>` +
        (doc.author ? `<p class="cover__author">${escapeHtml(doc.author)}</p>` : '') +
        (doc.authorInfo ? `<p class="cover__author-info">${escapeHtml(doc.authorInfo)}</p>` : '') +
        (metaItems.length ? `<p class="cover__meta">${metaItems.join(' <span aria-hidden="true">·</span> ')}</p>` : '') +
        (doc.tags.length
            ? `<p class="cover__tags">${doc.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</p>`
            : '') +
        `<dl class="cover__stats">${stats
            .map((item) => `<div><dt>${item.label}</dt><dd>${item.value}</dd></div>`)
            .join('')}</dl>` +
        `</header>`
    );
}

const HTML_STYLES = `
:root,
html[data-theme="light"] {
    color-scheme: light;
    --ink: #111827;
    --ink-soft: #374151;
    --muted: #6b7280;
    --line: #e5e7eb;
    --line-strong: #d1d5db;
    --accent: #312e81;
    --accent-soft: #eef2ff;
    --accent-ink: #312e81;
    --paper: #ffffff;
    --surface-soft: #f8fafc;
    --page-bg: #f3f4f6;
    --bar-bg: rgba(255, 255, 255, 0.92);
    --mark-bg: #fef08a;
    --mark-active-bg: #f59e0b;
    --mark-active-ink: #111827;
    --code-bg: #f3f4f6;
    --cover-bg: linear-gradient(155deg, #1e1b4b 0%, #312e81 55%, #0f4c5c 100%);
    --cover-ink: #f8fafc;
    --shadow-card: 0 18px 44px -34px rgba(15, 23, 42, 0.25);
    --reader-size: 16.5px;
    --reader-leading: 2.02;
    --reader-measure: 820px;
}
html[data-theme="sepia"] {
    color-scheme: light;
    --ink: #292118;
    --ink-soft: #4a3d2f;
    --muted: #786958;
    --line: #dfd5c3;
    --line-strong: #c9bca5;
    --accent: #7c3f1d;
    --accent-soft: #f2e6d5;
    --accent-ink: #6b3416;
    --paper: #faf6ed;
    --surface-soft: #f3ede0;
    --page-bg: #efe8d8;
    --bar-bg: rgba(250, 246, 237, 0.94);
    --mark-bg: #fde68a;
    --mark-active-bg: #d97706;
    --mark-active-ink: #ffffff;
    --code-bg: #efe6d6;
    --cover-bg: linear-gradient(155deg, #3b2314 0%, #5b341c 58%, #2e3b2f 100%);
    --cover-ink: #fbf7ef;
    --shadow-card: 0 18px 44px -34px rgba(41, 33, 24, 0.24);
}
html[data-theme="dark"] {
    color-scheme: dark;
    --ink: #e5e7eb;
    --ink-soft: #cbd5e1;
    --muted: #94a3b8;
    --line: #272e3f;
    --line-strong: #374151;
    --accent: #a5b4fc;
    --accent-soft: rgba(99, 102, 241, 0.16);
    --accent-ink: #c7d2fe;
    --paper: #161922;
    --surface-soft: #1d222e;
    --page-bg: #0e1017;
    --bar-bg: rgba(22, 25, 34, 0.92);
    --mark-bg: rgba(250, 204, 21, 0.34);
    --mark-active-bg: #f59e0b;
    --mark-active-ink: #111827;
    --code-bg: #1f2533;
    --cover-bg: linear-gradient(155deg, #111428 0%, #1e1b4b 58%, #0d2b36 100%);
    --cover-ink: #f1f5f9;
    --shadow-card: 0 22px 50px -34px rgba(0, 0, 0, 0.65);
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
@media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    *, *::before, *::after { transition: none !important; animation: none !important; }
}
body {
    margin: 0;
    padding: 0 18px 80px;
    background: var(--page-bg);
    color: var(--ink);
    font-family: 'VazirmatnBook', Vazirmatn, Tahoma, 'Segoe UI', 'Iranian Sans', sans-serif;
    font-size: var(--reader-size);
    line-height: var(--reader-leading);
    text-align: justify;
    word-spacing: -0.01em;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
}
html[data-align="start"] body { text-align: start; }
html[data-bilingual="translated"] .bi-orig { display: none !important; }
html[data-bilingual="original"] .bi-trans { display: none !important; }
html[data-orig-font="traditional"] .bi-orig {
    font-family: 'Traditional Arabic', 'Amiri', 'Scheherazade New', 'Times New Roman', serif;
    font-size: 1.06em;
    line-height: 2.15;
}
html[data-focus="true"] .reader-bar,
html[data-focus="true"] .toc-drawer,
html[data-focus="true"] .drawer-backdrop,
html[data-focus="true"] .resume-banner { display: none !important; }

/* Progress track */
.progress-track {
    position: fixed;
    top: 0;
    inset-inline: 0;
    height: 3px;
    z-index: 60;
    background: transparent;
    pointer-events: none;
}
.progress-fill {
    height: 100%;
    width: 0%;
    background: var(--accent);
    transition: width 120ms linear;
}

/* Sticky 3-zone reader bar */
.reader-bar {
    position: sticky;
    top: 0;
    z-index: 40;
    margin: 0 -18px 24px;
    padding: 10px 18px;
    background: var(--bar-bg);
    backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--line);
}
.reader-bar__inner {
    max-width: 1180px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
}
.reader-bar__start,
.reader-bar__center,
.reader-bar__end {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}
.reader-bar__start { flex: 1 1 180px; }
.reader-bar__center { flex: 2 1 320px; justify-content: center; flex-wrap: wrap; }
.reader-bar__end { flex: 1 1 auto; justify-content: flex-end; flex-wrap: wrap; }
.bar-title {
    margin: 0;
    font-size: 0.92rem;
    font-weight: 700;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.bar-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 34px;
    padding: 0 11px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--paper);
    color: var(--ink-soft);
    font: inherit;
    font-size: 0.82rem;
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
}
.bar-btn:hover { border-color: var(--line-strong); color: var(--ink); background: var(--surface-soft); }
.bar-btn[aria-pressed="true"],
.bar-btn.is-active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent-ink);
}
.bar-btn--icon { width: 34px; padding: 0; }
.bar-btn:focus-visible,
.bar-input:focus-visible,
.toc-filter:focus-visible,
.page-jump__input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
}

.segmented {
    display: inline-flex;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface-soft);
    padding: 2px;
    gap: 2px;
    flex-shrink: 0;
}
.segmented button {
    border: 0;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 0.78rem;
    font-weight: 600;
    padding: 5px 9px;
    border-radius: 6px;
    cursor: pointer;
    white-space: nowrap;
}
.segmented button[aria-pressed="true"] {
    background: var(--paper);
    color: var(--ink);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}

.search-box {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 34px;
    padding: 0 6px 0 8px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--paper);
    min-width: 210px;
    flex: 1 1 220px;
    max-width: 340px;
}
.bar-input {
    border: 0;
    background: transparent;
    color: var(--ink);
    font: inherit;
    font-size: 0.84rem;
    width: 100%;
    min-width: 0;
    outline: none;
}
.search-count {
    font-size: 0.76rem;
    color: var(--muted);
    white-space: nowrap;
    padding: 0 4px;
    font-variant-numeric: tabular-nums;
}
.search-nav {
    border: 0;
    background: transparent;
    color: var(--ink-soft);
    width: 24px;
    height: 24px;
    border-radius: 5px;
    cursor: pointer;
    font: inherit;
    font-size: 0.78rem;
    display: inline-grid;
    place-items: center;
}
.search-nav:hover:not(:disabled) { background: var(--surface-soft); color: var(--ink); }
.search-nav:disabled { opacity: 0.35; cursor: default; }

.page-jump {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 34px;
    padding: 0 8px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--paper);
    font-size: 0.8rem;
    color: var(--muted);
    white-space: nowrap;
    flex-shrink: 0;
}
.page-jump__input {
    width: 44px;
    height: 24px;
    border: 1px solid var(--line);
    border-radius: 5px;
    background: var(--surface-soft);
    color: var(--ink);
    font: inherit;
    font-size: 0.8rem;
    text-align: center;
    font-variant-numeric: tabular-nums;
}

/* Settings popover */
.settings-wrap { position: relative; }
.settings-popover {
    position: absolute;
    top: calc(100% + 8px);
    inset-inline-end: 0;
    width: 292px;
    padding: 14px;
    border-radius: 12px;
    background: var(--paper);
    border: 1px solid var(--line);
    box-shadow: 0 20px 48px -18px rgba(0, 0, 0, 0.28);
    z-index: 70;
    display: none;
    text-align: start;
}
.settings-popover.is-open { display: block; }
.settings-row { margin-bottom: 12px; }
.settings-row:last-child { margin-bottom: 0; }
.settings-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.78rem;
    font-weight: 700;
    color: var(--muted);
    margin-bottom: 6px;
}
.settings-grid { display: flex; gap: 6px; flex-wrap: wrap; }
.settings-grid button {
    flex: 1 1 auto;
    height: 30px;
    padding: 0 8px;
    border: 1px solid var(--line);
    border-radius: 7px;
    background: var(--surface-soft);
    color: var(--ink-soft);
    font: inherit;
    font-size: 0.78rem;
    cursor: pointer;
}
.settings-grid button[aria-pressed="true"] {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent-ink);
    font-weight: 700;
}

/* TOC & Bookmarks Drawer */
.drawer-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.36);
    z-index: 50;
    display: none;
}
.drawer-backdrop.is-open { display: block; }
.toc-drawer {
    position: fixed;
    top: 0;
    bottom: 0;
    inset-inline-start: 0;
    width: min(360px, 90vw);
    background: var(--paper);
    border-inline-end: 1px solid var(--line);
    z-index: 55;
    display: flex;
    flex-direction: column;
    transform: translateX(105%);
    transition: transform 180ms ease;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.22);
}
.toc-drawer.is-open { transform: translateX(0); }
.toc-drawer__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--line);
}
.toc-drawer__tabs { display: flex; gap: 6px; }
.toc-drawer__tabs button {
    border: 1px solid var(--line);
    background: var(--surface-soft);
    color: var(--muted);
    font: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    padding: 5px 10px;
    border-radius: 7px;
    cursor: pointer;
}
.toc-drawer__tabs button[aria-selected="true"] {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent-ink);
}
.toc-drawer__search { padding: 10px 16px; border-bottom: 1px solid var(--line); }
.toc-filter {
    width: 100%;
    height: 34px;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface-soft);
    color: var(--ink);
    font: inherit;
    font-size: 0.84rem;
}
.toc-drawer__body {
    flex: 1;
    overflow-y: auto;
    padding: 10px 12px 24px;
    text-align: start;
}
.drawer-list { list-style: none; margin: 0; padding: 0; }
.drawer-list li { margin: 2px 0; }
.drawer-list li.is-level-2 { padding-inline-start: 14px; }
.drawer-list li.is-level-3 { padding-inline-start: 28px; }
.drawer-list a {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    padding: 6px 10px;
    border-radius: 7px;
    color: var(--ink-soft);
    text-decoration: none;
    font-size: 0.86rem;
    line-height: 1.6;
}
.drawer-list a:hover { background: var(--surface-soft); color: var(--ink); }
.drawer-list a.is-current {
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-weight: 700;
}
.drawer-list .toc-pg {
    font-size: 0.74rem;
    color: var(--muted);
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
}
.drawer-empty {
    padding: 28px 14px;
    text-align: center;
    color: var(--muted);
    font-size: 0.88rem;
}

/* Resume reading prompt */
.resume-banner {
    max-width: var(--reader-measure);
    margin: 0 auto 18px;
    padding: 10px 14px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--paper);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    font-size: 0.88rem;
    color: var(--ink-soft);
}
.resume-banner__actions { display: flex; gap: 8px; flex-shrink: 0; }

/* AutoPrint fallback banner */
.banner {
    max-width: var(--reader-measure);
    margin: 18px auto 22px;
    padding: 14px 18px;
    border: 1px solid var(--line);
    background: var(--accent-soft);
    border-radius: 12px;
    color: var(--accent-ink);
    font-size: 0.92rem;
    line-height: 1.9;
}
.banner strong { display: block; margin-bottom: 4px; }

/* Cover */
.cover {
    position: relative;
    max-width: var(--reader-measure);
    margin: 18px auto 26px;
    padding: 64px 40px 44px;
    border-radius: 18px;
    overflow: hidden;
    text-align: center;
    background: var(--cover-bg);
    color: var(--cover-ink);
    border: 1px solid rgba(255, 255, 255, 0.14);
    break-after: page;
    page-break-after: always;
}
.cover__kicker {
    margin: 0 0 22px;
    color: rgba(248, 250, 252, 0.76);
    font-size: 0.82rem;
    letter-spacing: 0.12em;
}
.cover h1 {
    margin: 0 0 18px;
    padding-bottom: 0;
    border-bottom: 0;
    font-size: clamp(1.75rem, 3.2vw, 2.5rem);
    line-height: 1.5;
    color: #ffffff;
    text-align: center;
}
.cover__rule {
    width: 64px;
    height: 2px;
    margin: 0 auto 20px;
    background: rgba(255, 255, 255, 0.45);
}
.cover__author { margin: 0 0 8px; font-size: 1.15rem; font-weight: 700; color: rgba(255, 255, 255, 0.96); }
.cover__author-info {
    margin: 0 auto 12px;
    max-width: 62ch;
    font-size: 0.88rem;
    line-height: 1.85;
    color: rgba(248, 250, 252, 0.78);
}
.cover__meta { margin: 4px 0; color: rgba(248, 250, 252, 0.8); font-size: 0.9rem; }
.cover__tags {
    margin: 20px 0 0;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
}
.cover__tags span {
    padding: 3px 10px;
    border: 1px solid rgba(255, 255, 255, 0.26);
    border-radius: 4px;
    font-size: 0.8rem;
    color: rgba(248, 250, 252, 0.92);
}
.cover__stats {
    margin: 28px auto 0;
    padding-top: 18px;
    border-top: 1px solid rgba(255, 255, 255, 0.18);
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: 12px;
    max-width: 560px;
}
.cover__stats dt { font-size: 0.74rem; color: rgba(248, 250, 252, 0.68); margin: 0 0 2px; }
.cover__stats dd { margin: 0; font-size: 0.98rem; font-weight: 700; color: #ffffff; font-variant-numeric: tabular-nums; }

/* Printable Document TOC */
.toc {
    max-width: var(--reader-measure);
    margin: 0 auto 26px;
    padding: 28px 34px 24px;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: var(--shadow-card);
    break-after: page;
    page-break-after: always;
}
.toc h2 {
    margin: 0 0 16px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--line);
    font-size: 1.25rem;
    color: var(--ink);
}
.toc ol { list-style: none; margin: 0; padding: 0; }
.toc li { margin: 0; font-size: 0.95rem; line-height: 1.9; }
.toc li.is-level-2 { margin-inline-start: 18px; font-size: 0.91rem; }
.toc li.is-level-3 { margin-inline-start: 36px; font-size: 0.87rem; }
.toc a {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 4px 8px;
    border-radius: 6px;
    color: var(--ink-soft);
    text-decoration: none;
}
.toc li.is-level-1 > a { font-weight: 700; color: var(--ink); }
.toc a:hover { background: var(--surface-soft); color: var(--accent); }
.toc__pg { font-size: 0.78rem; color: var(--muted); flex-shrink: 0; font-variant-numeric: tabular-nums; }

/* Page Surface */
.page {
    position: relative;
    max-width: var(--reader-measure);
    margin: 0 auto 24px;
    padding: 28px 40px 38px;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: var(--shadow-card);
    break-after: page;
    page-break-after: always;
}
.page:last-of-type { break-after: auto; page-break-after: auto; }
.page__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 12px;
    margin-bottom: 18px;
    border-bottom: 1px solid var(--line);
    font-size: 0.82rem;
    color: var(--muted);
}
.page__marker {
    font-weight: 700;
    color: var(--accent-ink);
    font-variant-numeric: tabular-nums;
}
.page__actions { display: inline-flex; align-items: center; gap: 6px; }
.page-act {
    border: 1px solid var(--line);
    background: var(--surface-soft);
    color: var(--muted);
    font: inherit;
    font-size: 0.75rem;
    font-weight: 600;
    padding: 3px 9px;
    border-radius: 6px;
    cursor: pointer;
}
.page-act:hover { color: var(--ink); border-color: var(--line-strong); }
.page-act[aria-pressed="true"] {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent-ink);
}

/* Typography */
h1, h2, h3, h4, h5, h6 {
    line-height: 1.55;
    color: var(--ink);
    margin: 1.2em 0 0.55em;
    text-align: start;
    scroll-margin-top: 76px;
}
h1 { font-size: 1.65em; padding-bottom: 0.3em; border-bottom: 1px solid var(--line); }
h2 { font-size: 1.35em; padding-bottom: 0.2em; border-bottom: 1px solid var(--line); }
h3 { font-size: 1.15em; color: var(--accent-ink); }
h4 { font-size: 1.05em; }
h5 { font-size: 0.98em; }
h6 { font-size: 0.92em; color: var(--muted); }
p { margin: 0 0 0.8em; }
a { color: var(--accent-ink); text-underline-offset: 3px; }
ul, ol { margin: 0 0 0.85em; padding-inline-start: 22px; }
li { margin: 0.2em 0; }
li::marker { color: var(--muted); }
blockquote {
    margin: 1em 0;
    padding: 12px 18px;
    border: 1px solid var(--line);
    border-inline-start: 2px solid var(--line-strong);
    border-radius: 8px;
    color: var(--ink-soft);
    background: var(--surface-soft);
}
blockquote p:last-child { margin-bottom: 0; }

/* Callouts */
.callout {
    margin: 1.1em 0;
    padding: 12px 16px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--surface-soft);
}
.callout__head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    font-size: 0.88em;
    font-weight: 700;
    color: var(--accent-ink);
}
.callout__dot { width: 8px; height: 8px; border-radius: 2px; background: currentColor; }
.callout--warning .callout__head { color: #b45309; }
html[data-theme="dark"] .callout--warning .callout__head { color: #fbbf24; }
.callout--tip .callout__head { color: #047857; }
html[data-theme="dark"] .callout--tip .callout__head { color: #34d399; }
.callout__body p:last-child { margin-bottom: 0; }

code {
    font-family: 'Cascadia Mono', Consolas, ui-monospace, monospace;
    background: var(--code-bg);
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 0.88em;
}
.pre-wrap { position: relative; margin: 1em 0; }
pre {
    background: var(--code-bg);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 14px 16px;
    margin: 0;
    overflow: auto;
    direction: ltr;
    text-align: left;
    line-height: 1.65;
}
pre code { background: none; padding: 0; }
.code-copy {
    position: absolute;
    top: 8px;
    right: 8px;
    border: 1px solid var(--line);
    background: var(--paper);
    color: var(--muted);
    font: inherit;
    font-size: 0.72rem;
    padding: 3px 8px;
    border-radius: 6px;
    cursor: pointer;
}
.code-copy:hover { color: var(--ink); }

.table-scroll { overflow-x: auto; margin: 1em 0; border-radius: 8px; border: 1px solid var(--line); }
table { width: 100%; border-collapse: collapse; margin: 0; font-size: 0.9em; }
th, td {
    border-bottom: 1px solid var(--line);
    border-inline-start: 1px solid var(--line);
    padding: 8px 12px;
    text-align: start;
    vertical-align: top;
}
th:first-child, td:first-child { border-inline-start: none; }
tbody tr:last-child td { border-bottom: 0; }
th { background: var(--accent-soft); color: var(--accent-ink); font-weight: 700; }
tbody tr:nth-child(even) td { background: var(--surface-soft); }

.page img {
    max-width: 100%;
    height: auto;
    border-radius: 8px;
    cursor: zoom-in;
    border: 1px solid var(--line);
}
mark.book-highlight { background: var(--mark-bg); color: #111827; padding: 0 3px; border-radius: 3px; }
mark.search-hit { background: var(--mark-bg); color: #111827; padding: 0 2px; border-radius: 3px; }
mark.search-hit.is-active { background: var(--mark-active-bg); color: var(--mark-active-ink); box-shadow: 0 0 0 2px var(--mark-active-bg); }
hr { border: 0; height: 1px; background: var(--line); margin: 1.5em 0; }

/* Bilingual blocks */
.bi-orig {
    display: block;
    color: var(--muted);
    font-size: 0.92em;
    padding-inline-start: 10px;
    border-inline-start: 1px solid var(--line-strong);
    margin-bottom: 5px;
}
.bi-trans {
    display: block;
    color: var(--ink);
    background: var(--surface-soft);
    padding: 5px 10px;
    border-radius: 6px;
}
h1 .bi-orig, h2 .bi-orig, h3 .bi-orig, .toc .bi-orig, .toc-drawer .bi-orig {
    font-size: 0.85em;
    margin-bottom: 2px;
    border-inline-start: none;
    padding-inline-start: 0;
}
.toc .bi-trans, .toc-drawer .bi-trans {
    background: transparent;
    padding: 0;
}

/* Footnotes & interactive popover */
sup.fn-ref a {
    display: inline-block;
    min-width: 1.4em;
    padding: 0 4px;
    border-radius: 4px;
    background: var(--accent-soft);
    color: var(--accent-ink);
    text-decoration: none;
    font-size: 0.72em;
    font-weight: 700;
    text-align: center;
}
sup.fn-ref.is-flash a { outline: 2px solid var(--accent); }
.footnotes {
    margin-top: 26px;
    padding-top: 16px;
    border-top: 1px dashed var(--line-strong);
    font-size: 0.86em;
    color: var(--ink-soft);
}
.footnotes h4 { margin: 0 0 10px; font-size: 0.95em; color: var(--accent-ink); }
.footnotes ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
.footnotes li {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 11px;
    background: var(--surface-soft);
    border: 1px solid var(--line);
    border-radius: 8px;
    line-height: 1.85;
}
.footnotes li.is-flash { border-color: var(--accent); background: var(--accent-soft); }
.footnotes .fn-num {
    flex: none;
    min-width: 22px;
    height: 22px;
    padding: 0 4px;
    display: inline-grid;
    place-items: center;
    border-radius: 6px;
    background: var(--paper);
    border: 1px solid var(--line);
    color: var(--accent-ink);
    font-weight: 700;
    font-size: 0.82em;
}
.fn-back { flex: none; margin-inline-start: auto; text-decoration: none; color: var(--accent-ink); opacity: 0.75; }
.fn-back:hover { opacity: 1; }

.fn-popover {
    position: fixed;
    z-index: 75;
    max-width: min(400px, calc(100vw - 24px));
    padding: 12px 14px;
    border-radius: 10px;
    background: var(--paper);
    border: 1px solid var(--line-strong);
    box-shadow: 0 20px 44px -14px rgba(0, 0, 0, 0.32);
    font-size: 0.88rem;
    line-height: 1.85;
    color: var(--ink);
    display: none;
    text-align: start;
}
.fn-popover.is-open { display: block; }
.fn-popover__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 6px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--line);
    font-size: 0.78rem;
    font-weight: 700;
    color: var(--accent-ink);
}
.fn-popover__body p:last-child { margin-bottom: 0; }
.fn-popover__foot { margin-top: 8px; display: flex; justify-content: flex-end; gap: 8px; }

/* Image lightbox */
.lightbox {
    position: fixed;
    inset: 0;
    z-index: 80;
    background: rgba(10, 12, 18, 0.88);
    display: none;
    align-items: center;
    justify-content: center;
    padding: 24px;
}
.lightbox.is-open { display: flex; }
.lightbox img { max-width: 94vw; max-height: 88vh; border-radius: 8px; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5); }
.lightbox__close {
    position: fixed;
    top: 16px;
    inset-inline-end: 16px;
}

/* Floating controls & toast */
.fab-top {
    position: fixed;
    bottom: 20px;
    inset-inline-end: 20px;
    z-index: 35;
    opacity: 0;
    pointer-events: none;
    transition: opacity 160ms ease;
}
.fab-top.is-visible { opacity: 1; pointer-events: auto; }
.focus-exit {
    position: fixed;
    top: 14px;
    inset-inline-end: 16px;
    z-index: 45;
    display: none;
}
html[data-focus="true"] .focus-exit { display: inline-flex; }
.toast-msg {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%) translateY(16px);
    padding: 8px 16px;
    border-radius: 8px;
    background: var(--ink);
    color: var(--paper);
    font-size: 0.84rem;
    font-weight: 600;
    z-index: 90;
    opacity: 0;
    pointer-events: none;
    transition: opacity 150ms ease, transform 150ms ease;
}
.toast-msg.is-open { opacity: 1; transform: translateX(-50%) translateY(0); }

@media (max-width: 720px) {
    body { padding: 0 10px 70px; }
    .reader-bar { margin: 0 -10px 16px; padding: 8px 10px; }
    .page, .toc { padding: 20px 18px 26px; }
    .cover { padding: 44px 20px 32px; }
    .bar-title { max-width: 140px; }
}

@media print {
    html,
    html[data-theme="sepia"],
    html[data-theme="dark"] {
        color-scheme: light !important;
        --ink: #111827 !important;
        --ink-soft: #334155 !important;
        --muted: #64748b !important;
        --line: #e2e8f0 !important;
        --line-strong: #cbd5e1 !important;
        --accent: #312e81 !important;
        --accent-soft: #eef2ff !important;
        --accent-ink: #312e81 !important;
        --paper: #ffffff !important;
        --surface-soft: #f8fafc !important;
        --page-bg: #ffffff !important;
        --code-bg: #f8fafc !important;
    }
    html, body { background: #ffffff !important; color: #111827 !important; }
    body { padding: 0; font-size: 11pt; line-height: 1.95; }
    .no-print { display: none !important; }
    .cover, .toc, .page {
        max-width: none;
        margin: 0;
        border: none;
        border-radius: 0;
        box-shadow: none;
        padding: 0;
    }
    .cover { padding: 34mm 14mm; border: none; }
    .toc { padding: 0 0 10mm; }
    .page { break-after: page; page-break-after: always; }
    .page__head { border-bottom-color: #e2e8f0; margin-bottom: 14px; padding-bottom: 8px; }
    a { color: inherit; text-decoration: none; }
    h1, h2, h3, h4 { break-after: avoid; page-break-after: avoid; }
    table, pre, blockquote, .callout, .footnotes li { break-inside: avoid; page-break-inside: avoid; }
    .table-scroll { overflow: visible; border: none; }
    thead { display: table-header-group; }
    th { background: #eef2ff !important; }
}
@page { size: A4; margin: 18mm 16mm 20mm; }
`;

interface HtmlMetaPayload {
    bookKey: string;
    title: string;
    author: string;
    totalPages: number;
    hasBilingual: boolean;
}

const HTML_READER_SCRIPT = `(function () {
    var metaEl = document.getElementById('book-meta');
    var meta = { bookKey: 'book', title: document.title, author: '', totalPages: 1, hasBilingual: false };
    try {
        if (metaEl) meta = JSON.parse(metaEl.textContent || '{}');
    } catch (_) {}

    var root = document.documentElement;
    var STORAGE_PREFS = 'mdbook-reader-prefs-v1';
    var STORAGE_BOOK = 'mdbook-state:' + String(meta.bookKey || 'book');
    var PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

    function toFa(n) {
        return String(n).replace(/\\d/g, function (d) { return PERSIAN_DIGITS[Number(d)] || d; });
    }
    function normalizeDigits(s) {
        return String(s || '').replace(/[\\u06F0-\\u06F9]/g, function (d) {
            return String(d.charCodeAt(0) - 0x06f0);
        });
    }
    function safeGet(key) {
        try { return window.localStorage.getItem(key); } catch (_) { return null; }
    }
    function safeSet(key, value) {
        try { window.localStorage.setItem(key, value); } catch (_) {}
    }

    var prefs = {
        theme: 'light',
        bilingual: 'both',
        fontSize: 16.5,
        lineHeight: 2.02,
        measure: 820,
        align: 'justify',
        origFont: 'sans'
    };
    try {
        var savedPrefs = safeGet(STORAGE_PREFS);
        if (savedPrefs) {
            var parsedPrefs = JSON.parse(savedPrefs);
            if (parsedPrefs && typeof parsedPrefs === 'object') {
                Object.assign(prefs, parsedPrefs);
            }
        }
    } catch (_) {}

    var bookState = { page: 1, bookmarks: [] };
    try {
        var savedBook = safeGet(STORAGE_BOOK);
        if (savedBook) {
            var parsedBook = JSON.parse(savedBook);
            if (parsedBook && typeof parsedBook === 'object') {
                if (typeof parsedBook.page === 'number') bookState.page = parsedBook.page;
                if (Array.isArray(parsedBook.bookmarks)) bookState.bookmarks = parsedBook.bookmarks;
            }
        }
    } catch (_) {}

    var toastTimer = null;
    var toastEl = document.getElementById('toast-msg');
    function showToast(msg) {
        if (!toastEl) return;
        toastEl.textContent = msg;
        toastEl.classList.add('is-open');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            toastEl.classList.remove('is-open');
        }, 2000);
    }

    function applyPrefs() {
        root.setAttribute('data-theme', prefs.theme);
        root.setAttribute('data-bilingual', prefs.bilingual);
        root.setAttribute('data-align', prefs.align);
        root.setAttribute('data-orig-font', prefs.origFont);
        root.style.setProperty('--reader-size', prefs.fontSize + 'px');
        root.style.setProperty('--reader-leading', String(prefs.lineHeight));
        root.style.setProperty('--reader-measure', prefs.measure + 'px');

        document.querySelectorAll('[data-set-theme]').forEach(function (btn) {
            btn.setAttribute('aria-pressed', String(btn.getAttribute('data-set-theme') === prefs.theme));
        });
        document.querySelectorAll('[data-set-bi]').forEach(function (btn) {
            btn.setAttribute('aria-pressed', String(btn.getAttribute('data-set-bi') === prefs.bilingual));
        });
        document.querySelectorAll('[data-set-leading]').forEach(function (btn) {
            btn.setAttribute('aria-pressed', String(Number(btn.getAttribute('data-set-leading')) === prefs.lineHeight));
        });
        document.querySelectorAll('[data-set-measure]').forEach(function (btn) {
            btn.setAttribute('aria-pressed', String(Number(btn.getAttribute('data-set-measure')) === prefs.measure));
        });
        document.querySelectorAll('[data-set-align]').forEach(function (btn) {
            btn.setAttribute('aria-pressed', String(btn.getAttribute('data-set-align') === prefs.align));
        });
        document.querySelectorAll('[data-set-orig-font]').forEach(function (btn) {
            btn.setAttribute('aria-pressed', String(btn.getAttribute('data-set-orig-font') === prefs.origFont));
        });
        var sizeLabel = document.getElementById('font-size-val');
        if (sizeLabel) sizeLabel.textContent = toFa(Math.round(prefs.fontSize)) + 'px';
        safeSet(STORAGE_PREFS, JSON.stringify(prefs));
    }

    function saveBookState() {
        safeSet(STORAGE_BOOK, JSON.stringify(bookState));
    }

    var pages = Array.prototype.slice.call(document.querySelectorAll('.page'));
    var currentPage = 1;
    var pageInput = document.getElementById('page-jump-input');

    function setCurrentPage(num) {
        if (num < 1 || num > pages.length) return;
        currentPage = num;
        if (pageInput && document.activeElement !== pageInput) {
            pageInput.value = String(num);
        }
        bookState.page = num;
        saveBookState();
    }

    function goToPage(num) {
        var idx = Math.max(1, Math.min(pages.length, Number(num) || 1));
        var target = pages[idx - 1];
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setCurrentPage(idx);
    }

    /* Resume banner */
    var resumeBanner = document.getElementById('resume-banner');
    var resumeBtn = document.getElementById('resume-go');
    var resumeDismiss = document.getElementById('resume-dismiss');
    if (resumeBanner && bookState.page > 1 && bookState.page <= pages.length) {
        var resumeLabel = document.getElementById('resume-page-label');
        if (resumeLabel) resumeLabel.textContent = toFa(bookState.page);
        resumeBanner.hidden = false;
        if (resumeBtn) {
            resumeBtn.addEventListener('click', function () {
                var targetPage = bookState.page;
                resumeBanner.hidden = true;
                goToPage(targetPage);
            });
        }
        if (resumeDismiss) {
            resumeDismiss.addEventListener('click', function () {
                resumeBanner.hidden = true;
            });
        }
    }

    /* Theme, bilingual, typography bindings */
    document.querySelectorAll('[data-set-theme]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            prefs.theme = btn.getAttribute('data-set-theme') || 'light';
            applyPrefs();
        });
    });
    document.querySelectorAll('[data-set-bi]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            prefs.bilingual = btn.getAttribute('data-set-bi') || 'both';
            applyPrefs();
            if (searchInput && searchInput.value.trim()) runSearch(searchInput.value);
        });
    });
    document.querySelectorAll('[data-set-leading]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            prefs.lineHeight = Number(btn.getAttribute('data-set-leading')) || 2.02;
            applyPrefs();
        });
    });
    document.querySelectorAll('[data-set-measure]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            prefs.measure = Number(btn.getAttribute('data-set-measure')) || 820;
            applyPrefs();
        });
    });
    document.querySelectorAll('[data-set-align]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            prefs.align = btn.getAttribute('data-set-align') || 'justify';
            applyPrefs();
        });
    });
    document.querySelectorAll('[data-set-orig-font]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            prefs.origFont = btn.getAttribute('data-set-orig-font') || 'sans';
            applyPrefs();
        });
    });

    var fontDown = document.getElementById('font-dec');
    var fontUp = document.getElementById('font-inc');
    var fontReset = document.getElementById('font-reset');
    if (fontDown) fontDown.addEventListener('click', function () {
        prefs.fontSize = Math.max(13, Math.round((prefs.fontSize - 1) * 10) / 10);
        applyPrefs();
    });
    if (fontUp) fontUp.addEventListener('click', function () {
        prefs.fontSize = Math.min(24, Math.round((prefs.fontSize + 1) * 10) / 10);
        applyPrefs();
    });
    if (fontReset) fontReset.addEventListener('click', function () {
        prefs.fontSize = 16.5;
        prefs.lineHeight = 2.02;
        prefs.measure = 820;
        prefs.align = 'justify';
        prefs.origFont = 'sans';
        applyPrefs();
    });

    /* Settings popover */
    var settingsBtn = document.getElementById('btn-settings');
    var settingsPopover = document.getElementById('settings-popover');
    function toggleSettings(force) {
        if (!settingsPopover || !settingsBtn) return;
        var next = typeof force === 'boolean' ? force : !settingsPopover.classList.contains('is-open');
        settingsPopover.classList.toggle('is-open', next);
        settingsBtn.setAttribute('aria-expanded', String(next));
    }
    if (settingsBtn) {
        settingsBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            toggleSettings();
        });
    }

    /* TOC Drawer & Bookmarks */
    var drawer = document.getElementById('toc-drawer');
    var backdrop = document.getElementById('drawer-backdrop');
    var drawerBtn = document.getElementById('btn-toc');
    var drawerClose = document.getElementById('btn-toc-close');
    var tocFilter = document.getElementById('toc-filter');
    var tabToc = document.getElementById('tab-toc');
    var tabBookmarks = document.getElementById('tab-bookmarks');
    var panelToc = document.getElementById('panel-toc');
    var panelBookmarks = document.getElementById('panel-bookmarks');

    function toggleDrawer(force) {
        if (!drawer || !backdrop) return;
        var next = typeof force === 'boolean' ? force : !drawer.classList.contains('is-open');
        drawer.classList.toggle('is-open', next);
        backdrop.classList.toggle('is-open', next);
        if (drawerBtn) drawerBtn.setAttribute('aria-pressed', String(next));
    }
    if (drawerBtn) drawerBtn.addEventListener('click', function () { toggleDrawer(); });
    if (drawerClose) drawerClose.addEventListener('click', function () { toggleDrawer(false); });
    if (backdrop) backdrop.addEventListener('click', function () { toggleDrawer(false); });

    if (tabToc && tabBookmarks && panelToc && panelBookmarks) {
        tabToc.addEventListener('click', function () {
            tabToc.setAttribute('aria-selected', 'true');
            tabBookmarks.setAttribute('aria-selected', 'false');
            panelToc.hidden = false;
            panelBookmarks.hidden = true;
        });
        tabBookmarks.addEventListener('click', function () {
            tabToc.setAttribute('aria-selected', 'false');
            tabBookmarks.setAttribute('aria-selected', 'true');
            panelToc.hidden = true;
            panelBookmarks.hidden = false;
            renderBookmarksList();
        });
    }

    if (tocFilter) {
        tocFilter.addEventListener('input', function () {
            var q = tocFilter.value.trim().toLowerCase();
            document.querySelectorAll('#drawer-toc-list li').forEach(function (li) {
                var text = (li.textContent || '').toLowerCase();
                li.style.display = !q || text.indexOf(q) !== -1 ? '' : 'none';
            });
        });
    }

    document.querySelectorAll('#drawer-toc-list a').forEach(function (a) {
        a.addEventListener('click', function () {
            if (window.innerWidth < 1100) toggleDrawer(false);
        });
    });

    function syncBookmarkButtons() {
        document.querySelectorAll('.js-bookmark-btn').forEach(function (btn) {
            var p = Number(btn.getAttribute('data-page'));
            var marked = bookState.bookmarks.indexOf(p) !== -1;
            btn.setAttribute('aria-pressed', String(marked));
            btn.textContent = marked ? 'نشان‌شده ★' : 'نشانک';
        });
    }

    function renderBookmarksList() {
        if (!panelBookmarks) return;
        panelBookmarks.textContent = '';
        if (!bookState.bookmarks.length) {
            var empty = document.createElement('p');
            empty.className = 'drawer-empty';
            empty.textContent = 'هنوز صفحه‌ای نشانک نشده است. روی دکمهٔ «نشانک» در بالای هر صفحه بزنید.';
            panelBookmarks.appendChild(empty);
            return;
        }
        var ol = document.createElement('ol');
        ol.className = 'drawer-list';
        bookState.bookmarks
            .slice()
            .sort(function (a, b) { return a - b; })
            .forEach(function (p) {
                var section = pages[p - 1];
                var label = section ? section.getAttribute('data-page-label') || ('صفحه ' + toFa(p)) : ('صفحه ' + toFa(p));
                var li = document.createElement('li');
                var link = document.createElement('a');
                link.href = '#page-' + p;
                var titleSpan = document.createElement('span');
                titleSpan.textContent = label;
                var pgSpan = document.createElement('span');
                pgSpan.className = 'toc-pg';
                pgSpan.textContent = 'ص ' + toFa(p);
                link.appendChild(titleSpan);
                link.appendChild(pgSpan);
                link.addEventListener('click', function () {
                    if (window.innerWidth < 1100) toggleDrawer(false);
                });
                li.appendChild(link);
                ol.appendChild(li);
            });
        panelBookmarks.appendChild(ol);
    }

    document.querySelectorAll('.js-bookmark-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var p = Number(btn.getAttribute('data-page'));
            var idx = bookState.bookmarks.indexOf(p);
            if (idx === -1) {
                bookState.bookmarks.push(p);
                showToast('صفحه به نشانک‌ها افزوده شد');
            } else {
                bookState.bookmarks.splice(idx, 1);
                showToast('نشانک برداشته شد');
            }
            saveBookState();
            syncBookmarkButtons();
            if (panelBookmarks && !panelBookmarks.hidden) renderBookmarksList();
        });
    });

    /* Copy citation */
    function copyText(text, okMsg) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
                showToast(okMsg);
            }).catch(function () {
                fallbackCopy(text, okMsg);
            });
        } else {
            fallbackCopy(text, okMsg);
        }
    }
    function fallbackCopy(text, okMsg) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); showToast(okMsg); } catch (_) {}
        ta.remove();
    }

    document.querySelectorAll('.js-cite-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var label = btn.getAttribute('data-label') || '';
            var parts = ['«' + (meta.title || '') + '»'];
            if (meta.author) parts.push(meta.author);
            if (label) parts.push(label);
            copyText(parts.join('، '), 'ارجاع صفحه رونوشت شد');
        });
    });

    /* Code copy buttons */
    document.querySelectorAll('.page pre').forEach(function (pre) {
        var wrap = document.createElement('div');
        wrap.className = 'pre-wrap';
        pre.parentNode.insertBefore(wrap, pre);
        wrap.appendChild(pre);
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'code-copy no-print';
        btn.textContent = 'رونوشت';
        btn.addEventListener('click', function () {
            copyText(pre.textContent || '', 'کد رونوشت شد');
        });
        wrap.appendChild(btn);
    });

    /* Page navigation */
    var prevPageBtn = document.getElementById('btn-prev-page');
    var nextPageBtn = document.getElementById('btn-next-page');
    if (prevPageBtn) prevPageBtn.addEventListener('click', function () { goToPage(currentPage - 1); });
    if (nextPageBtn) nextPageBtn.addEventListener('click', function () { goToPage(currentPage + 1); });
    if (pageInput) {
        pageInput.addEventListener('change', function () {
            var val = Number(normalizeDigits(pageInput.value));
            if (!isNaN(val) && val >= 1) goToPage(val);
        });
        pageInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                var val = Number(normalizeDigits(pageInput.value));
                if (!isNaN(val) && val >= 1) goToPage(val);
                pageInput.blur();
            }
        });
    }

    /* Live search with TreeWalker */
    var searchInput = document.getElementById('search-input');
    var searchCount = document.getElementById('search-count');
    var searchPrev = document.getElementById('search-prev');
    var searchNext = document.getElementById('search-next');
    var searchClear = document.getElementById('search-clear');
    var hits = [];
    var hitIndex = -1;

    function clearSearch() {
        document.querySelectorAll('mark.search-hit').forEach(function (mark) {
            var parent = mark.parentNode;
            if (!parent) return;
            parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
            parent.normalize();
        });
        hits = [];
        hitIndex = -1;
        updateSearchUi();
    }

    function updateSearchUi() {
        if (searchCount) {
            searchCount.textContent = hits.length ? toFa(hitIndex + 1) + ' از ' + toFa(hits.length) : '۰';
        }
        if (searchPrev) searchPrev.disabled = hits.length === 0;
        if (searchNext) searchNext.disabled = hits.length === 0;
        if (searchClear) searchClear.disabled = !(searchInput && searchInput.value);
    }

    function activateHit(idx) {
        if (!hits.length) return;
        hits.forEach(function (m) { m.classList.remove('is-active'); });
        hitIndex = (idx + hits.length) % hits.length;
        var el = hits[hitIndex];
        el.classList.add('is-active');
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        updateSearchUi();
    }

    function isHiddenNode(node) {
        var el = node.parentElement;
        while (el && el !== document.body) {
            if (el.classList.contains('no-print')) return true;
            if (prefs.bilingual === 'translated' && el.classList.contains('bi-orig')) return true;
            if (prefs.bilingual === 'original' && el.classList.contains('bi-trans')) return true;
            var tag = el.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'MARK') return true;
            el = el.parentElement;
        }
        return false;
    }

    function runSearch(query) {
        clearSearch();
        var q = String(query || '').trim();
        if (!q || q.length < 2) {
            updateSearchUi();
            return;
        }
        var qLower = q.toLowerCase();
        var textNodes = [];
        pages.forEach(function (page) {
            var walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT, {
                acceptNode: function (node) {
                    if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
                    return isHiddenNode(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
                }
            });
            var n;
            while ((n = walker.nextNode())) textNodes.push(n);
        });

        textNodes.forEach(function (node) {
            var text = node.nodeValue || '';
            var lower = text.toLowerCase();
            var idx = lower.indexOf(qLower);
            if (idx === -1) return;
            var frag = document.createDocumentFragment();
            var pos = 0;
            while (idx !== -1 && hits.length < 400) {
                if (idx > pos) frag.appendChild(document.createTextNode(text.slice(pos, idx)));
                var mark = document.createElement('mark');
                mark.className = 'search-hit';
                mark.textContent = text.slice(idx, idx + q.length);
                frag.appendChild(mark);
                hits.push(mark);
                pos = idx + q.length;
                idx = lower.indexOf(qLower, pos);
            }
            if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
            if (node.parentNode) node.parentNode.replaceChild(frag, node);
        });

        if (hits.length) activateHit(0);
        else updateSearchUi();
    }

    var searchTimer = null;
    if (searchInput) {
        searchInput.addEventListener('input', function () {
            if (searchTimer) clearTimeout(searchTimer);
            searchTimer = setTimeout(function () { runSearch(searchInput.value); }, 180);
        });
        searchInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (!hits.length) runSearch(searchInput.value);
                else activateHit(e.shiftKey ? hitIndex - 1 : hitIndex + 1);
            } else if (e.key === 'Escape') {
                searchInput.value = '';
                clearSearch();
                searchInput.blur();
            }
        });
    }
    if (searchNext) searchNext.addEventListener('click', function () { activateHit(hitIndex + 1); });
    if (searchPrev) searchPrev.addEventListener('click', function () { activateHit(hitIndex - 1); });
    if (searchClear) searchClear.addEventListener('click', function () {
        if (searchInput) searchInput.value = '';
        clearSearch();
    });

    /* Footnote popover */
    var fnPopover = document.getElementById('fn-popover');
    var fnTitle = document.getElementById('fn-popover-title');
    var fnBody = document.getElementById('fn-popover-body');
    var fnJump = document.getElementById('fn-popover-jump');
    var fnClose = document.getElementById('fn-popover-close');

    function closeFootnote() {
        if (fnPopover) fnPopover.classList.remove('is-open');
    }

    document.querySelectorAll('sup.fn-ref a').forEach(function (link) {
        link.addEventListener('click', function (e) {
            var href = link.getAttribute('href') || '';
            if (!href.startsWith('#') || !fnPopover || !fnBody || !fnTitle || !fnJump) return;
            var target = document.getElementById(href.slice(1));
            if (!target) return;
            e.preventDefault();
            e.stopPropagation();

            fnTitle.textContent = 'پاورقی ' + (link.textContent || '');
            fnBody.textContent = '';
            var contentSpan = target.querySelector('span:nth-child(2)');
            if (contentSpan) fnBody.appendChild(contentSpan.cloneNode(true));
            fnJump.setAttribute('href', href);

            fnPopover.classList.add('is-open');
            var rect = link.getBoundingClientRect();
            var popW = fnPopover.offsetWidth || 320;
            var popH = fnPopover.offsetHeight || 140;
            var left = Math.min(window.innerWidth - popW - 12, Math.max(12, rect.left + rect.width / 2 - popW / 2));
            var top = rect.bottom + 8 + popH > window.innerHeight ? Math.max(12, rect.top - popH - 8) : rect.bottom + 8;
            fnPopover.style.left = left + 'px';
            fnPopover.style.top = top + 'px';
        });
    });

    if (fnClose) fnClose.addEventListener('click', closeFootnote);
    if (fnJump) fnJump.addEventListener('click', function () {
        var href = fnJump.getAttribute('href') || '';
        closeFootnote();
        if (href.startsWith('#')) {
            var li = document.getElementById(href.slice(1));
            if (li) {
                li.classList.add('is-flash');
                setTimeout(function () { li.classList.remove('is-flash'); }, 1500);
            }
        }
    });

    document.querySelectorAll('.fn-back').forEach(function (back) {
        back.addEventListener('click', function () {
            var href = back.getAttribute('href') || '';
            if (href.startsWith('#')) {
                var sup = document.getElementById(href.slice(1));
                if (sup) {
                    sup.classList.add('is-flash');
                    setTimeout(function () { sup.classList.remove('is-flash'); }, 1500);
                }
            }
        });
    });

    /* Image lightbox */
    var lightbox = document.getElementById('lightbox');
    var lightboxImg = document.getElementById('lightbox-img');
    var lightboxClose = document.getElementById('lightbox-close');
    function closeLightbox() {
        if (lightbox) lightbox.classList.remove('is-open');
    }
    document.querySelectorAll('.page img').forEach(function (img) {
        img.addEventListener('click', function () {
            if (!lightbox || !lightboxImg) return;
            lightboxImg.src = img.currentSrc || img.src;
            lightboxImg.alt = img.alt || '';
            lightbox.classList.add('is-open');
        });
    });
    if (lightboxClose) lightboxClose.addEventListener('click', closeLightbox);
    if (lightbox) lightbox.addEventListener('click', function (e) {
        if (e.target === lightbox) closeLightbox();
    });

    /* Focus mode & print & scroll progress */
    var focusBtn = document.getElementById('btn-focus');
    var focusExit = document.getElementById('btn-focus-exit');
    var printBtn = document.getElementById('btn-print');
    var topBtn = document.getElementById('btn-top');
    var progressFill = document.getElementById('progress-fill');

    function toggleFocus(force) {
        var next = typeof force === 'boolean' ? force : root.getAttribute('data-focus') !== 'true';
        root.setAttribute('data-focus', String(next));
        if (focusBtn) focusBtn.setAttribute('aria-pressed', String(next));
        if (next) toggleDrawer(false);
    }
    if (focusBtn) focusBtn.addEventListener('click', function () { toggleFocus(); });
    if (focusExit) focusExit.addEventListener('click', function () { toggleFocus(false); });
    if (printBtn) printBtn.addEventListener('click', function () { window.print(); });
    if (topBtn) topBtn.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });

    var headings = Array.prototype.slice.call(document.querySelectorAll('.page h1[id], .page h2[id], .page h3[id]'));
    var tocLinks = new Map();
    document.querySelectorAll('#drawer-toc-list a[href^="#"]').forEach(function (a) {
        tocLinks.set(a.getAttribute('href').slice(1), a);
    });

    function onScroll() {
        var docH = document.documentElement.scrollHeight - window.innerHeight;
        var ratio = docH > 0 ? Math.min(1, Math.max(0, window.scrollY / docH)) : 0;
        if (progressFill) progressFill.style.width = (ratio * 100).toFixed(1) + '%';
        if (topBtn) topBtn.classList.toggle('is-visible', window.scrollY > 420);

        var activePage = 1;
        var mid = window.innerHeight * 0.28;
        for (var i = 0; i < pages.length; i += 1) {
            var rect = pages[i].getBoundingClientRect();
            if (rect.top <= mid) activePage = i + 1;
            else break;
        }
        if (activePage !== currentPage) setCurrentPage(activePage);

        var activeHeadingId = '';
        for (var j = 0; j < headings.length; j += 1) {
            if (headings[j].getBoundingClientRect().top <= 120) activeHeadingId = headings[j].id;
            else break;
        }
        tocLinks.forEach(function (link, id) {
            link.classList.toggle('is-current', id === activeHeadingId);
        });
    }
    var scrollRaf = 0;
    window.addEventListener('scroll', function () {
        if (scrollRaf) return;
        scrollRaf = window.requestAnimationFrame(function () {
            scrollRaf = 0;
            onScroll();
        });
    }, { passive: true });

    document.addEventListener('click', function (e) {
        if (settingsPopover && settingsPopover.classList.contains('is-open')) {
            if (!settingsPopover.contains(e.target) && e.target !== settingsBtn) toggleSettings(false);
        }
        if (fnPopover && fnPopover.classList.contains('is-open')) {
            if (!fnPopover.contains(e.target)) closeFootnote();
        }
    });

    document.addEventListener('keydown', function (e) {
        var tag = e.target && e.target.tagName;
        var typing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);
        if (e.key === 'Escape') {
            toggleSettings(false);
            closeFootnote();
            closeLightbox();
            toggleDrawer(false);
            if (root.getAttribute('data-focus') === 'true') toggleFocus(false);
            return;
        }
        if (typing) return;
        if (e.key === '/' && searchInput) {
            e.preventDefault();
            if (root.getAttribute('data-focus') === 'true') toggleFocus(false);
            searchInput.focus();
            searchInput.select();
        } else if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            toggleFocus();
        } else if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            toggleDrawer();
        } else if (e.key === ']') {
            e.preventDefault();
            goToPage(currentPage + 1);
        } else if (e.key === '[') {
            e.preventDefault();
            goToPage(currentPage - 1);
        }
    });

    applyPrefs();
    syncBookmarkButtons();
    updateSearchUi();
    onScroll();
})();`;

async function renderHtmlDocument(
    doc: DocumentModel,
    options: { autoPrint?: boolean } = {}
): Promise<string> {
    const fonts = await fontCss();
    const toc: TocEntry[] = [];
    const usedAnchors = new Set<string>();

    const notesHtml = (notes: { label: string; text: string; anchor: string }[]): string => {
        if (!notes.length) return '';
        const items = notes
            .map(
                (note) =>
                    `<li id="${note.anchor}"><span class="fn-num">${escapeHtml(note.label)}</span>` +
                    `<span>${sanitizeHtml(renderMarkdown(note.text))}</span>` +
                    `<a href="#ref-${note.anchor}" class="fn-back" aria-label="بازگشت">↩</a></li>`
            )
            .join('');
        return `<section class="footnotes"><h4>پاورقی‌ها</h4><ol>${items}</ol></section>`;
    };

    const pageSection = (
        page: ExportPage,
        pageIndex: number,
        notes: StandardNote[]
    ): string => {
        const pageNumber = pageIndex + 1;
        const pageLabel = page.marker || `صفحه ${toPersianDigits(pageNumber)}`;

        const prepared = (notes.length ? notes : page.footnotes).map((note, index) => {
            const label = String(note.label || index + 1);
            let anchor = `fn-${pageNumber}-${safeId(label)}`;
            while (usedAnchors.has(anchor)) anchor = `${anchor}-x`;
            usedAnchors.add(anchor);
            return { label, text: note.text, anchor };
        });

        const byLabel = new Map(prepared.map((note) => [normalizeDigits(note.label), note]));
        const byId = new Map(
            notes.map((note, index) => [note.id, prepared[index]] as const)
        );

        let markdown = page.markdown;
        markdown = markdown.replace(/\(¬\s*([\d\u06F0-\u06F9]+)\)/g, (match, raw: string) => {
            const note = byLabel.get(normalizeDigits(raw));
            if (!note) return match;
            return `<sup class="fn-ref" id="ref-${note.anchor}"><a href="#${note.anchor}">${escapeHtml(
                raw
            )}</a></sup>`;
        });
        markdown = markdown.replace(/\[\^([^\]\n]+)\]/g, (match, raw: string) => {
            const note = byId.get(raw.trim()) ?? byLabel.get(normalizeDigits(raw.trim()));
            if (!note) return match;
            return `<sup class="fn-ref" id="ref-${note.anchor}"><a href="#${note.anchor}">${escapeHtml(
                note.label
            )}</a></sup>`;
        });
        markdown = markdown.replace(/^\s*==\s*پاورقی‌ها\s*==\s*$/gm, '');

        let html = sanitizeHtml(renderMarkdown(markdown));
        html = highlightMarks(html);
        html = transformCallouts(html);
        html = wrapTables(html);
        html = addHeadingIds(html, toc, pageNumber, pageLabel);

        const pageHead =
            `<div class="page__head">` +
            `<span class="page__marker">${escapeHtml(pageLabel)}</span>` +
            `<span class="page__actions no-print">` +
            `<button type="button" class="page-act js-bookmark-btn" data-page="${pageNumber}" aria-pressed="false">نشانک</button>` +
            `<button type="button" class="page-act js-cite-btn" data-label="${escapeHtml(pageLabel)}">ارجاع</button>` +
            `</span>` +
            `</div>`;

        return `<section class="page" id="page-${pageNumber}" data-page-index="${pageNumber}" data-page-label="${escapeHtml(
            pageLabel
        )}">${pageHead}${html}${notesHtml(prepared)}</section>`;
    };

    const pageParts: string[] = [];
    if (doc.format === 'standard') {
        pageParts.push(pageSection(doc.pages[0], 0, doc.notes));
    } else {
        doc.pages.forEach((page, index) => pageParts.push(pageSection(page, index, [])));
    }

    const tocHtml = toc.length
        ? `<nav class="toc"><h2>فهرست مطالب</h2><ol>${toc
              .map(
                  (entry) =>
                      `<li class="is-level-${entry.level}"><a href="#${entry.id}">` +
                      `<span>${entry.html}</span>` +
                      `<span class="toc__pg">${escapeHtml(toPersianDigits(entry.pageNumber))}</span>` +
                      `</a></li>`
              )
              .join('')}</ol></nav>`
        : '';

    const drawerTocHtml = toc.length
        ? `<ol class="drawer-list" id="drawer-toc-list">${toc
              .map(
                  (entry) =>
                      `<li class="is-level-${entry.level}"><a href="#${entry.id}">` +
                      `<span>${entry.html}</span>` +
                      `<span class="toc-pg">${escapeHtml(toPersianDigits(entry.pageNumber))}</span>` +
                      `</a></li>`
              )
              .join('')}</ol>`
        : `<p class="drawer-empty">سرفصلی در متن یافت نشد.</p>`;

    const bilingualSwitch = doc.hasBilingual
        ? `<div class="segmented" role="group" aria-label="حالت نمایش زبان">` +
          `<button type="button" data-set-bi="both" aria-pressed="true">دوزبانه</button>` +
          `<button type="button" data-set-bi="translated" aria-pressed="false">ترجمه</button>` +
          `<button type="button" data-set-bi="original" aria-pressed="false">اصلی</button>` +
          `</div>`
        : '';

    const origFontSetting = doc.hasBilingual
        ? `<div class="settings-row"><div class="settings-label"><span>قلم متن اصلی</span></div>` +
          `<div class="settings-grid">` +
          `<button type="button" data-set-orig-font="sans" aria-pressed="true">وزیرمتن</button>` +
          `<button type="button" data-set-orig-font="traditional" aria-pressed="false">نسخ سنتی</button>` +
          `</div></div>`
        : '';

    const readerBar =
        `<div class="progress-track no-print" aria-hidden="true"><div class="progress-fill" id="progress-fill"></div></div>` +
        `<header class="reader-bar no-print">` +
        `<div class="reader-bar__inner">` +
        `<div class="reader-bar__start">` +
        `<button type="button" class="bar-btn" id="btn-toc" aria-pressed="false" title="فهرست مطالب و نشانک‌ها (T)">فهرست</button>` +
        `<p class="bar-title" title="${escapeHtml(doc.title)}">${escapeHtml(doc.title)}</p>` +
        `</div>` +
        `<div class="reader-bar__center">` +
        `<div class="search-box">` +
        `<input type="search" id="search-input" class="bar-input" placeholder="جستجو در متن... (/)" aria-label="جستجو در متن">` +
        `<span class="search-count" id="search-count">۰</span>` +
        `<button type="button" class="search-nav" id="search-prev" title="نتیجهٔ قبلی" aria-label="نتیجهٔ قبلی" disabled>▲</button>` +
        `<button type="button" class="search-nav" id="search-next" title="نتیجهٔ بعدی" aria-label="نتیجهٔ بعدی" disabled>▼</button>` +
        `<button type="button" class="search-nav" id="search-clear" title="پاک کردن جستجو" aria-label="پاک کردن جستجو" disabled>✕</button>` +
        `</div>` +
        `<div class="page-jump">` +
        `<button type="button" class="search-nav" id="btn-prev-page" title="صفحهٔ قبل ([)" aria-label="صفحهٔ قبل">›</button>` +
        `<span>صفحه</span>` +
        `<input type="text" inputmode="numeric" id="page-jump-input" class="page-jump__input" value="1" aria-label="شماره صفحه">` +
        `<span>از ${escapeHtml(toPersianDigits(doc.pages.length))}</span>` +
        `<button type="button" class="search-nav" id="btn-next-page" title="صفحهٔ بعد (])" aria-label="صفحهٔ بعد">‹</button>` +
        `</div>` +
        `</div>` +
        `<div class="reader-bar__end">` +
        bilingualSwitch +
        `<div class="segmented" role="group" aria-label="تم مطالعه">` +
        `<button type="button" data-set-theme="light" aria-pressed="true">روشن</button>` +
        `<button type="button" data-set-theme="sepia" aria-pressed="false">سپیا</button>` +
        `<button type="button" data-set-theme="dark" aria-pressed="false">تاریک</button>` +
        `</div>` +
        `<div class="settings-wrap">` +
        `<button type="button" class="bar-btn" id="btn-settings" aria-expanded="false" aria-controls="settings-popover">قلم و صفحه</button>` +
        `<div class="settings-popover" id="settings-popover" role="dialog" aria-label="تنظیمات خواندن">` +
        `<div class="settings-row"><div class="settings-label"><span>اندازهٔ قلم</span><span id="font-size-val">۱۷px</span></div>` +
        `<div class="settings-grid">` +
        `<button type="button" id="font-dec">کوچک‌تر</button>` +
        `<button type="button" id="font-inc">بزرگ‌تر</button>` +
        `<button type="button" id="font-reset">بازنشانی</button>` +
        `</div></div>` +
        `<div class="settings-row"><div class="settings-label"><span>فاصلهٔ خطوط</span></div>` +
        `<div class="settings-grid">` +
        `<button type="button" data-set-leading="1.75" aria-pressed="false">فشرده</button>` +
        `<button type="button" data-set-leading="2.02" aria-pressed="true">متعادل</button>` +
        `<button type="button" data-set-leading="2.3" aria-pressed="false">باز</button>` +
        `</div></div>` +
        `<div class="settings-row"><div class="settings-label"><span>عرض صفحه</span></div>` +
        `<div class="settings-grid">` +
        `<button type="button" data-set-measure="680" aria-pressed="false">باریک</button>` +
        `<button type="button" data-set-measure="820" aria-pressed="true">میانه</button>` +
        `<button type="button" data-set-measure="1020" aria-pressed="false">عریض</button>` +
        `</div></div>` +
        `<div class="settings-row"><div class="settings-label"><span>تراز متن</span></div>` +
        `<div class="settings-grid">` +
        `<button type="button" data-set-align="justify" aria-pressed="true">دوطرفه</button>` +
        `<button type="button" data-set-align="start" aria-pressed="false">راست‌چین</button>` +
        `</div></div>` +
        origFontSetting +
        `</div>` +
        `</div>` +
        `<button type="button" class="bar-btn" id="btn-focus" aria-pressed="false" title="حالت تمرکز (F)">تمرکز</button>` +
        `<button type="button" class="bar-btn" id="btn-print" title="چاپ یا ذخیرهٔ PDF">چاپ / PDF</button>` +
        `</div>` +
        `</div>` +
        `</header>` +
        `<div class="drawer-backdrop no-print" id="drawer-backdrop"></div>` +
        `<aside class="toc-drawer no-print" id="toc-drawer" aria-label="فهرست و نشانک‌ها">` +
        `<div class="toc-drawer__head">` +
        `<div class="toc-drawer__tabs" role="tablist">` +
        `<button type="button" id="tab-toc" role="tab" aria-selected="true">فهرست مطالب</button>` +
        `<button type="button" id="tab-bookmarks" role="tab" aria-selected="false">نشانک‌ها</button>` +
        `</div>` +
        `<button type="button" class="bar-btn bar-btn--icon" id="btn-toc-close" aria-label="بستن">✕</button>` +
        `</div>` +
        `<div class="toc-drawer__search"><input type="search" id="toc-filter" class="toc-filter" placeholder="فیلتر سرفصل‌ها..."></div>` +
        `<div class="toc-drawer__body">` +
        `<div id="panel-toc" role="tabpanel">${drawerTocHtml}</div>` +
        `<div id="panel-bookmarks" role="tabpanel" hidden></div>` +
        `</div>` +
        `</aside>` +
        `<div class="resume-banner no-print" id="resume-banner" hidden>` +
        `<span>آخرین مطالعهٔ شما در صفحهٔ <strong id="resume-page-label"></strong> بوده است.</span>` +
        `<div class="resume-banner__actions">` +
        `<button type="button" class="bar-btn is-active" id="resume-go">ادامهٔ مطالعه</button>` +
        `<button type="button" class="bar-btn" id="resume-dismiss">بستن</button>` +
        `</div>` +
        `</div>` +
        `<button type="button" class="bar-btn focus-exit no-print" id="btn-focus-exit">خروج از تمرکز (Esc)</button>` +
        `<button type="button" class="bar-btn fab-top no-print" id="btn-top" aria-label="بازگشت به بالا">↑ بالا</button>` +
        `<div class="fn-popover no-print" id="fn-popover" role="dialog" aria-label="پاورقی">` +
        `<div class="fn-popover__head"><span id="fn-popover-title">پاورقی</span><button type="button" class="search-nav" id="fn-popover-close" aria-label="بستن">✕</button></div>` +
        `<div class="fn-popover__body" id="fn-popover-body"></div>` +
        `<div class="fn-popover__foot"><a href="#" class="bar-btn" id="fn-popover-jump">رفتن به پاورقی صفحه</a></div>` +
        `</div>` +
        `<div class="lightbox no-print" id="lightbox" role="dialog" aria-label="نمایش تصویر">` +
        `<button type="button" class="bar-btn lightbox__close" id="lightbox-close">بستن (Esc)</button>` +
        `<img id="lightbox-img" src="" alt="">` +
        `</div>` +
        `<div class="toast-msg no-print" id="toast-msg" role="status" aria-live="polite"></div>`;

    const metaPayload: HtmlMetaPayload = {
        bookKey: doc.filename || doc.title,
        title: doc.title,
        author: doc.author,
        totalPages: doc.pages.length,
        hasBilingual: doc.hasBilingual
    };
    const safeMetaJson = JSON.stringify(metaPayload).replace(/</g, '\\u003c');

    const banner = options.autoPrint
        ? `<div class="banner no-print"><strong>آمادهٔ ذخیره به PDF</strong>در پنجرهٔ چاپ، مقصد را «Save as PDF / ذخیره به PDF» انتخاب کنید. اگر پنجره باز نشد، Ctrl+P بزنید.</div>`
        : '';
    const printScript = options.autoPrint
        ? `<script>window.addEventListener('load',function(){setTimeout(function(){window.print();},700);});</script>`
        : '';

    return (
        `<!doctype html><html lang="fa" dir="rtl" data-theme="light" data-bilingual="both" data-align="justify" data-orig-font="sans"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<title>${escapeHtml(doc.title)}</title><style>${fonts}\n${HTML_STYLES}</style></head>` +
        `<body>${banner}${readerBar}${coverHtml(doc)}${tocHtml}${pageParts.join('')}` +
        `<script id="book-meta" type="application/json">${safeMetaJson}</script>` +
        `<script>${HTML_READER_SCRIPT}</script>${printScript}</body></html>`
    );
}

/* ----------------------------- docx rendering ----------------------------- */

interface MdToken {
    type: string;
    raw?: string;
    text?: string;
    depth?: number;
    ordered?: boolean;
    start?: number | '';
    items?: MdToken[];
    tokens?: MdToken[];
    href?: string;
    header?: { text: string; tokens?: MdToken[] }[];
    rows?: { text: string; tokens?: MdToken[] }[][];
}

interface RunFormat {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strike?: boolean;
    code?: boolean;
    color?: string;
    size?: number;
}

function escapeXml(value: string): string {
    return escapeHtml(value);
}

function run(text: string, format: RunFormat = {}): string {
    if (!text) return '';
    const props: string[] = [];
    if (format.code) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>');
    if (format.bold) props.push('<w:b/><w:bCs/>');
    if (format.italic) props.push('<w:i/><w:iCs/>');
    if (format.strike) props.push('<w:strike/>');
    if (format.color) props.push(`<w:color w:val="${format.color}"/>`);
    if (format.size) props.push(`<w:sz w:val="${format.size}"/><w:szCs w:val="${format.size}"/>`);
    if (format.underline) props.push('<w:u w:val="single"/>');
    props.push('<w:rtl/>');
    const pieces = text.split('\n');
    const inner = pieces
        .map(
            (piece, index) =>
                `${index ? '<w:br/>' : ''}<w:t xml:space="preserve">${escapeXml(piece)}</w:t>`
        )
        .join('');
    return `<w:r><w:rPr>${props.join('')}</w:rPr>${inner}</w:r>`;
}

interface ParagraphOptions {
    style?: string;
    align?: 'both' | 'center' | 'right' | 'left';
    indent?: number;
    border?: boolean;
    rightBorder?: { color: string; sz?: number; space?: number };
    shading?: string;
    pageBreakBefore?: boolean;
    spacingAfter?: number;
}

function paragraph(content: string, options: ParagraphOptions = {}): string {
    const props: string[] = [];
    if (options.style) props.push(`<w:pStyle w:val="${options.style}"/>`);
    if (options.pageBreakBefore) props.push('<w:pageBreakBefore/>');
    if (options.border || options.rightBorder) {
        const bdrs: string[] = [];
        if (options.border) {
            bdrs.push('<w:bottom w:val="single" w:sz="6" w:space="1" w:color="CBD5E1"/>');
        }
        if (options.rightBorder) {
            const sz = options.rightBorder.sz ?? 12;
            const space = options.rightBorder.space ?? 6;
            bdrs.push(
                `<w:right w:val="single" w:sz="${sz}" w:space="${space}" w:color="${options.rightBorder.color}"/>`
            );
        }
        props.push(`<w:pBdr>${bdrs.join('')}</w:pBdr>`);
    }
    if (options.shading) {
        props.push(`<w:shd w:val="clear" w:color="auto" w:fill="${options.shading}"/>`);
    }
    props.push('<w:bidi/>');
    if (options.spacingAfter != null) props.push(`<w:spacing w:after="${options.spacingAfter}"/>`);
    if (options.indent) props.push(`<w:ind w:right="${Math.round(options.indent)}"/>`);
    if (options.align) props.push(`<w:jc w:val="${options.align}"/>`);
    return `<w:p><w:pPr>${props.join('')}</w:pPr>${content}</w:p>`;
}

function inlineRuns(tokens: MdToken[] | undefined, format: RunFormat = {}): string {
    if (!tokens || !tokens.length) return '';
    return tokens
        .map((token) => {
            switch (token.type) {
                case 'text':
                    if (token.tokens && token.tokens.length) return inlineRuns(token.tokens, format);
                    return run(stripTags(token.text ?? token.raw ?? ''), format);
                case 'escape':
                    return run(token.text ?? '', format);
                case 'strong':
                    return inlineRuns(token.tokens, { ...format, bold: true });
                case 'em':
                    return inlineRuns(token.tokens, { ...format, italic: true });
                case 'del':
                    return inlineRuns(token.tokens, { ...format, strike: true });
                case 'codespan':
                    return run(token.text ?? '', { ...format, code: true });
                case 'link':
                    return inlineRuns(
                        token.tokens ?? [{ type: 'text', text: token.text ?? token.href ?? '' }],
                        { ...format, underline: true, color: '1D4ED8' }
                    );
                case 'br':
                    return '<w:r><w:br/></w:r>';
                case 'image':
                    return run(stripTags(token.text ?? ''), format);
                case 'html':
                    return run(stripTags(token.text ?? token.raw ?? ''), format);
                default:
                    return run(stripTags(token.text ?? token.raw ?? ''), format);
            }
        })
        .join('');
}

interface BilingualDocxPart {
    kind: 'orig' | 'trans' | 'plain';
    text: string;
}

function extractBilingualParts(raw: string): BilingualDocxPart[] | null {
    if (!/<span\b[^>]*\bclass\s*=\s*(?:"[^"]*\bbi-(?:orig|trans)\b|'[^']*\bbi-(?:orig|trans)\b)/i.test(raw)) {
        return null;
    }
    const openRe = /<span\b[^>]*\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi;
    const parts: BilingualDocxPart[] = [];
    let cursor = 0;

    while (cursor < raw.length) {
        openRe.lastIndex = cursor;
        const match = openRe.exec(raw);
        if (!match) {
            const tail = raw.slice(cursor).replace(/^(?:\s*<br\s*\/?>\s*)+/gi, '').trim();
            if (tail) parts.push({ kind: 'plain', text: tail });
            break;
        }
        const classAttr = match[1] ?? match[2] ?? '';
        const hasOrig = /(?:^|\s)bi-orig(?:\s|$)/.test(classAttr);
        const hasTrans = /(?:^|\s)bi-trans(?:\s|$)/.test(classAttr);
        if (!hasOrig && !hasTrans) {
            cursor = match.index + match[0].length;
            continue;
        }
        const before = raw
            .slice(cursor, match.index)
            .replace(/(?:\s*<br\s*\/?>\s*)+$/gi, '')
            .trim();
        if (before) parts.push({ kind: 'plain', text: before });

        const openEnd = match.index + match[0].length;
        const closeStart = findBalancedSpanClose(raw, openEnd);
        if (closeStart < 0) {
            const rest = raw.slice(match.index).trim();
            if (rest) parts.push({ kind: 'plain', text: rest });
            break;
        }
        const inner = raw.slice(openEnd, closeStart).trim();
        if (inner) {
            parts.push({ kind: hasOrig ? 'orig' : 'trans', text: inner });
        }
        cursor = raw.indexOf('>', closeStart) + 1;
    }

    return parts.some((part) => part.kind === 'orig' || part.kind === 'trans') ? parts : null;
}

function inlineRunsFromMarkdown(text: string, format: RunFormat = {}): string {
    const lexed = marked.lexer(text) as unknown as MdToken[];
    const first = lexed[0];
    if (lexed.length === 1 && (first?.type === 'paragraph' || first?.type === 'text') && first.tokens) {
        return inlineRuns(first.tokens, format);
    }
    return inlineRuns(lexed, format);
}

function renderBilingualDocxParagraphs(
    raw: string,
    options: { style?: string; indent?: number; headingDepth?: number; quote?: boolean; prefix?: string } = {}
): string[] | null {
    const parts = extractBilingualParts(raw);
    if (!parts) return null;

    const out: string[] = [];
    let prefixPending = options.prefix ?? '';

    for (const part of parts) {
        const leadingRun = prefixPending ? run(prefixPending) : '';
        prefixPending = '';
        if (part.kind === 'orig') {
            const origSize = options.headingDepth ? Math.max(22, 34 - options.headingDepth * 2) : 21;
            out.push(
                paragraph(
                    leadingRun + inlineRunsFromMarkdown(part.text, { color: '475569', size: origSize }),
                    {
                        indent: (options.indent ?? 0) + 120,
                        rightBorder: { color: '94A3B8', sz: 12, space: 6 },
                        spacingAfter: 60
                    }
                )
            );
        } else if (part.kind === 'trans') {
            if (options.headingDepth) {
                out.push(
                    paragraph(leadingRun + inlineRunsFromMarkdown(part.text), {
                        style: `Heading${options.headingDepth}`
                    })
                );
            } else {
                out.push(
                    paragraph(leadingRun + inlineRunsFromMarkdown(part.text), {
                        style: options.quote ? 'Quote' : options.style,
                        indent: options.indent,
                        shading: options.quote ? undefined : 'EEF2FF',
                        spacingAfter: 140
                    })
                );
            }
        } else {
            out.push(
                paragraph(leadingRun + inlineRunsFromMarkdown(part.text), {
                    style: options.quote ? 'Quote' : options.style,
                    indent: options.indent
                })
            );
        }
    }

    return out;
}

function tableXml(token: MdToken): string {
    const header = token.header ?? [];
    const rows = token.rows ?? [];
    const cellParagraphs = (content: { text: string; tokens?: MdToken[] }, headerCell: boolean) => {
        const bi = renderBilingualDocxParagraphs(content.text);
        if (bi) return bi.join('');
        return paragraph(
            inlineRuns(
                content.tokens ?? [{ type: 'text', text: content.text }],
                headerCell ? { bold: true, color: '312E81' } : {}
            )
        );
    };
    const cell = (content: { text: string; tokens?: MdToken[] }) =>
        `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${cellParagraphs(content, false)}</w:tc>`;
    const rowXml = (cells: { text: string; tokens?: MdToken[] }[], bold: boolean) =>
        `<w:tr>${bold ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells
            .map((content) =>
                bold
                    ? `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>` +
                      '<w:shd w:val="clear" w:color="auto" w:fill="EEF2FF"/></w:tcPr>' +
                      cellParagraphs(content, true) +
                      '</w:tc>'
                    : cell(content)
            )
            .join('')}</w:tr>`;
    const columns = Math.max(1, header.length, ...rows.map((row) => row.length));
    const grid = `<w:tblGrid>${'<w:gridCol w:w="2400"/>'.repeat(columns)}</w:tblGrid>`;
    return (
        `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:bidiVisual/>` +
        `<w:tblW w:w="0" w:type="auto"/>` +
        `<w:tblBorders><w:top w:val="single" w:sz="4" w:color="D7DEE8"/>` +
        `<w:left w:val="single" w:sz="4" w:color="D7DEE8"/>` +
        `<w:bottom w:val="single" w:sz="4" w:color="D7DEE8"/>` +
        `<w:right w:val="single" w:sz="4" w:color="D7DEE8"/>` +
        `<w:insideH w:val="single" w:sz="4" w:color="D7DEE8"/>` +
        `<w:insideV w:val="single" w:sz="4" w:color="D7DEE8"/></w:tblBorders></w:tblPr>` +
        grid +
        (header.length ? rowXml(header, true) : '') +
        rows.map((row) => rowXml(row, false)).join('') +
        `</w:tbl>`
    );
}

function listBlocks(token: MdToken, indent: number, ordered: boolean): string[] {
    const out: string[] = [];
    const start = typeof token.start === 'number' ? token.start : 1;
    const nestedIndent = indent + 240;
    (token.items ?? []).forEach((item, index) => {
        const prefix = ordered ? `${start + index}. ` : '• ';
        let first = true;
        for (const child of item.tokens ?? []) {
            if (child.type === 'list') {
                out.push(
                    ...listBlocks(child, nestedIndent, Boolean(child.ordered))
                );
                continue;
            }
            if (child.type === 'paragraph' || child.type === 'text') {
                const bi = renderBilingualDocxParagraphs(child.raw ?? child.text ?? '', {
                    indent: nestedIndent,
                    prefix: first ? prefix : ''
                });
                if (bi) {
                    out.push(...bi);
                } else {
                    const runs = inlineRuns(child.tokens ?? [{ type: 'text', text: child.text ?? '' }]);
                    out.push(paragraph((first ? run(prefix) : '') + runs, { indent: nestedIndent }));
                }
            } else if (child.type === 'blockquote') {
                out.push(
                    ...blocksFromTokens(child.tokens ?? [], {
                        indent: nestedIndent,
                        quote: true
                    })
                );
            } else {
                out.push(paragraph((first ? run(prefix) : '') + inlineRuns([child]), { indent: nestedIndent }));
            }
            first = false;
        }
        if (!item.tokens?.length) out.push(paragraph(run(prefix.trimStart()), { indent: nestedIndent }));
    });
    return out;
}

function blocksFromTokens(
    tokens: MdToken[],
    options: { indent?: number; quote?: boolean } = {}
): string[] {
    const out: string[] = [];
    for (const token of tokens) {
        switch (token.type) {
            case 'heading': {
                const depth = Math.min(6, Math.max(1, token.depth ?? 1));
                const bi = renderBilingualDocxParagraphs(token.text ?? token.raw ?? '', {
                    headingDepth: depth
                });
                if (bi) out.push(...bi);
                else out.push(paragraph(inlineRuns(token.tokens), { style: `Heading${depth}` }));
                break;
            }
            case 'paragraph':
            case 'text': {
                const bi = renderBilingualDocxParagraphs(token.raw ?? token.text ?? '', {
                    indent: options.indent,
                    quote: options.quote
                });
                if (bi) {
                    out.push(...bi);
                } else {
                    const runs = inlineRuns(token.tokens ?? [{ type: 'text', text: token.text ?? '' }]);
                    out.push(
                        paragraph(runs, {
                            style: options.quote ? 'Quote' : undefined,
                            indent: options.indent
                        })
                    );
                }
                break;
            }
            case 'blockquote':
                out.push(
                    ...blocksFromTokens(token.tokens ?? [], { ...options, quote: true })
                );
                break;
            case 'list':
                out.push(...listBlocks(token, options.indent ?? 0, Boolean(token.ordered)));
                break;
            case 'code': {
                const code = (token.text ?? '').replace(/\t/g, '    ');
                for (const line of code.split('\n')) {
                    out.push(paragraph(run(line, { code: true }), { style: 'CodeBlock' }));
                }
                break;
            }
            case 'hr':
                out.push(paragraph('', { border: true, spacingAfter: 160 }));
                break;
            case 'table':
                out.push(tableXml(token));
                break;
            case 'html': {
                const rawHtml = token.text ?? token.raw ?? '';
                const bi = renderBilingualDocxParagraphs(rawHtml, {
                    indent: options.indent,
                    quote: options.quote
                });
                if (bi) {
                    out.push(...bi);
                } else {
                    const text = stripTags(rawHtml).trim();
                    if (text) out.push(paragraph(run(text)));
                }
                break;
            }
            case 'space':
                break;
            default: {
                const text = stripTags(token.text ?? token.raw ?? '').trim();
                if (text) out.push(paragraph(run(text)));
            }
        }
    }
    return out;
}

function pageBreak(): string {
    return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

function docxStyles(): string {
    const heading = (level: number, size: number, color: string, rule = false) =>
        `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/>` +
        `<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
        `<w:pPr><w:keepNext/>` +
        (rule ? '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="E2E8F0"/></w:pBdr>' : '') +
        `<w:bidi/><w:spacing w:before="${level === 1 ? 360 : 260}" w:after="120"/>` +
        `<w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
        `<w:rPr><w:b/><w:bCs/><w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:rtl/></w:rPr></w:style>`;

    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:docDefaults><w:rPrDefault><w:rPr>' +
        '<w:rFonts w:ascii="Tahoma" w:hAnsi="Tahoma" w:cs="Tahoma"/>' +
        '<w:sz w:val="24"/><w:szCs w:val="24"/><w:rtl/>' +
        '<w:lang w:val="fa-IR" w:bidi="fa-IR"/>' +
        '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:bidi/>' +
        '<w:spacing w:line="360" w:lineRule="auto" w:after="120"/>' +
        '<w:jc w:val="both"/></w:pPr></w:pPrDefault></w:docDefaults>' +
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Kicker"><w:name w:val="Kicker"/><w:basedOn w:val="Normal"/>' +
        '<w:pPr><w:bidi/><w:spacing w:before="240" w:after="200"/><w:jc w:val="center"/></w:pPr>' +
        '<w:rPr><w:color w:val="64748B"/><w:sz w:val="18"/><w:szCs w:val="18"/><w:rtl/></w:rPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>' +
        '<w:pPr><w:bidi/><w:spacing w:before="600" w:after="200"/><w:jc w:val="center"/></w:pPr>' +
        '<w:rPr><w:b/><w:bCs/><w:color w:val="312E81"/><w:sz w:val="52"/><w:szCs w:val="52"/><w:rtl/></w:rPr></w:style>' +
        heading(1, 40, '312E81', true) +
        heading(2, 34, '4338CA') +
        heading(3, 30, '0E7490') +
        heading(4, 26, '334155') +
        heading(5, 24, '334155') +
        heading(6, 24, '64748B') +
        '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>' +
        '<w:pPr><w:pBdr><w:right w:val="single" w:sz="12" w:space="6" w:color="22D3EE"/></w:pBdr>' +
        '<w:shd w:val="clear" w:color="auto" w:fill="F8FAFC"/><w:bidi/>' +
        '<w:spacing w:after="120"/><w:ind w:right="300" w:left="300"/></w:pPr>' +
        '<w:rPr><w:color w:val="334155"/><w:rtl/></w:rPr></w:style>' +
        '<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/>' +
        '<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"/>' +
        '<w:bidi w:val="0"/><w:spacing w:line="240" w:lineRule="auto" w:after="0"/><w:jc w:val="left"/></w:pPr>' +
        '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>' +
        '<w:style w:type="table" w:default="1" w:styleId="TableGrid"><w:name w:val="Table Grid"/>' +
        '<w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D7DEE8"/>' +
        '<w:left w:val="single" w:sz="4" w:color="D7DEE8"/>' +
        '<w:bottom w:val="single" w:sz="4" w:color="D7DEE8"/>' +
        '<w:right w:val="single" w:sz="4" w:color="D7DEE8"/>' +
        '<w:insideH w:val="single" w:sz="4" w:color="D7DEE8"/>' +
        '<w:insideV w:val="single" w:sz="4" w:color="D7DEE8"/></w:tblBorders></w:tblPr></w:style>' +
        '</w:styles>'
    );
}

function createDocx(doc: DocumentModel): Buffer {
    const body: string[] = [];

    body.push(paragraph(run('کتابخانهٔ فارسی MD'), { style: 'Kicker' }));
    body.push(
        paragraph(run(doc.title, { bold: true }), { style: 'Title', align: 'center', spacingAfter: 240 })
    );
    if (doc.author) {
        body.push(paragraph(run(doc.author, { size: 30, color: '334155' }), { align: 'center' }));
    }
    if (doc.translator) {
        body.push(
            paragraph(run(`مترجم: ${doc.translator}`, { color: '64748B' }), { align: 'center' })
        );
    }
    if (doc.section) {
        body.push(paragraph(run(doc.section, { color: '64748B' }), { align: 'center' }));
    }
    if (doc.tags.length) {
        body.push(paragraph(run(doc.tags.join(' · '), { color: '64748B' }), { align: 'center' }));
    }
    body.push(paragraph('', { border: true, spacingAfter: 320 }));
    body.push(pageBreak());

    const appendPage = (markdown: string, marker: string, footnotes: StandardNote[] | Footnote[]) => {
        if (marker) {
            body.push(
                paragraph(run(marker, { bold: true }), { align: 'center', spacingAfter: 160 })
            );
        }
        const cleaned = markdown.replace(/==([^=\n]+)==/g, '$1');
        const tokens = marked.lexer(cleaned) as unknown as MdToken[];
        body.push(...blocksFromTokens(tokens));
        if (footnotes.length) {
            body.push(
                paragraph(run('پاورقی‌ها', { bold: true }), { style: 'Heading4', spacingAfter: 60 })
            );
            footnotes.forEach((note) => {
                const noteBi = renderBilingualDocxParagraphs(note.text, {
                    quote: true,
                    prefix: `${note.label}) `
                });
                if (noteBi) {
                    body.push(...noteBi);
                } else {
                    body.push(
                        paragraph(
                            run(`${note.label}) `, { bold: true, size: 18 }) +
                                inlineRunsFromMarkdown(note.text),
                            { style: 'Quote' }
                        )
                    );
                }
            });
        }
    };

    if (doc.format === 'standard') {
        appendPage(doc.pages[0].markdown, '', doc.notes);
    } else {
        doc.pages.forEach((page, index) => {
            if (index > 0) body.push(pageBreak());
            appendPage(page.markdown, page.marker, page.footnotes);
        });
    }

    const documentXml =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<w:body>${body.join('')}` +
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
        '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/>' +
        '<w:bidi/></w:sectPr></w:body></w:document>';

    const contentTypes =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '</Types>';

    const rootRels =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '</Relationships>';

    const documentRels =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>';

    const core =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        `<dc:title>${escapeXml(doc.title)}</dc:title>` +
        `<dc:creator>${escapeXml(doc.author || 'کتابخانهٔ فارسی MD')}</dc:creator>` +
        `<cp:lastModifiedBy>${escapeXml('کتابخانهٔ فارسی MD')}</cp:lastModifiedBy>` +
        `<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>` +
        '</cp:coreProperties>';

    return createZip([
        { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
        { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
        { name: 'docProps/core.xml', data: Buffer.from(core, 'utf8') },
        { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
        { name: 'word/styles.xml', data: Buffer.from(docxStyles(), 'utf8') },
        { name: 'word/_rels/document.xml.rels', data: Buffer.from(documentRels, 'utf8') }
    ]);
}

/* ----------------------------- pdf rendering ----------------------------- */

function chromiumCandidates(): string[] {
    const candidates: string[] = [];
    if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
    if (process.env.BROWSER_PATH) candidates.push(process.env.BROWSER_PATH);

    if (process.platform === 'win32') {
        const roots = [
            process.env['PROGRAMFILES(X86)'],
            process.env['PROGRAMFILES'],
            process.env['LOCALAPPDATA']
        ].filter((root): root is string => Boolean(root));
        for (const root of roots) {
            candidates.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
            candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
            candidates.push(path.join(root, 'Chromium', 'Application', 'chrome.exe'));
        }
    } else if (process.platform === 'darwin') {
        candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
        candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
        candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
    } else {
        candidates.push(
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/usr/bin/microsoft-edge',
            '/usr/bin/microsoft-edge-stable'
        );
    }
    return candidates;
}

function findChromium(): string | null {
    for (const candidate of chromiumCandidates()) {
        try {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
        } catch {
            /* ignore unreadable candidates */
        }
    }
    return null;
}

async function printToPdf(html: string): Promise<Buffer | null> {
    const browser = findChromium();
    if (!browser) return null;

    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'md-book-pdf-'));
    const htmlPath = path.join(dir, 'book.html');
    const pdfPath = path.join(dir, 'book.pdf');
    const profilePath = path.join(dir, 'profile');

    const baseArgs = [
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-crash-reporter',
        '--no-pdf-header-footer',
        '--run-all-compositor-stages-before-draw',
        '--virtual-time-budget=8000',
        `--user-data-dir=${profilePath}`,
        `--print-to-pdf=${pdfPath}`,
        pathToFileURL(htmlPath).href
    ];

    try {
        await fs.promises.writeFile(htmlPath, html, 'utf8');
        for (const mode of ['--headless=new', '--headless']) {
            try {
                await execFileAsync(browser, [mode, ...baseArgs], {
                    timeout: 120_000,
                    maxBuffer: 8 * 1024 * 1024,
                    windowsHide: true
                });
            } catch {
                /* try the next headless mode */
            }
            try {
                const data = await fs.promises.readFile(pdfPath);
                if (data.subarray(0, 4).toString('latin1') === '%PDF') return data;
            } catch {
                /* no file yet */
            }
        }
        return null;
    } finally {
        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

/* ----------------------------- public api ----------------------------- */

export async function buildExport(
    filename: unknown,
    format: ExportFormat,
    display: ExportDisplayMode = 'both'
): Promise<ExportResult> {
    const filePath = resolveBookPath(filename);
    if (!filePath) throw new HttpError('فایل کتاب برای خروجی معتبر نیست.');

    const content = await fs.promises.readFile(filePath, 'utf8');
    const doc = parseDocument(content, String(filename), display);
    const base = asciiNamePart(doc.title);
    const name = fileNamePart(doc.title);

    if (format === 'md') {
        return {
            contentType: 'text/markdown; charset=utf-8',
            asciiName: `${base}.md`,
            fileName: `${name}.md`,
            data: Buffer.from(normalizedMarkdown(doc), 'utf8')
        };
    }

    if (format === 'html') {
        const html = await renderHtmlDocument(doc);
        return {
            contentType: 'text/html; charset=utf-8',
            asciiName: `${base}.html`,
            fileName: `${name}.html`,
            data: Buffer.from(html, 'utf8')
        };
    }

    if (format === 'docx') {
        return {
            contentType:
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            asciiName: `${base}.docx`,
            fileName: `${name}.docx`,
            data: createDocx(doc)
        };
    }

    const html = await renderHtmlDocument(doc);
    const pdf = await printToPdf(html);
    if (pdf) {
        return {
            contentType: 'application/pdf',
            asciiName: `${base}.pdf`,
            fileName: `${name}.pdf`,
            data: pdf
        };
    }

    const fallback = await renderHtmlDocument(doc, { autoPrint: true });
    return {
        contentType: 'text/html; charset=utf-8',
        asciiName: `${base}.html`,
        fileName: `${name}.html`,
        data: Buffer.from(fallback, 'utf8'),
        inline: true
    };
}
