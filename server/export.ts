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
import { createZip } from './zip.js';

const execFileAsync = promisify(execFile);

export type ExportFormat = 'md' | 'html' | 'docx' | 'pdf';

export interface ExportResult {
    contentType: string;
    asciiName: string;
    fileName: string;
    data: Buffer;
    inline?: boolean;
}

/* ----------------------------- shared helpers ----------------------------- */

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

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
    translator: string;
    section: string;
    tags: string[];
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

function parseDocument(content: string, filename: string): DocumentModel {
    const frontmatterMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    const frontmatterRaw = frontmatterMatch ? frontmatterMatch[0] : '';
    const bodyRaw = (frontmatterMatch ? content.slice(frontmatterMatch[0].length) : content)
        .replace(/^\uFEFF/, '')
        .replace(/\r\n/g, '\n');

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

    if (format === 'standard') {
        const parsed = parseStandardNotes(bodyRaw);
        return {
            filename,
            title,
            author,
            translator: String(meta['مترجم'] || meta.translator || '').trim(),
            section: String(meta['بخش'] || meta.category || '').trim(),
            tags: Array.isArray(meta['برچسب ها'])
                ? (meta['برچسب ها'] as unknown[]).map(String).filter(Boolean)
                : [],
            frontmatterRaw,
            bodyRaw: parsed.body,
            format,
            pages: [{ marker: '', markdown: parsed.body.trim(), footnotes: [] }],
            notes: parsed.notes
        };
    }

    const pages: ExportPage[] = [];
    const sections = bodyRaw.split(/\n[ \t]*---[ \t]*\n/);
    for (const section of sections) {
        const lines = section.split('\n');
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

    return {
        filename,
        title,
        author,
        translator: String(meta['مترجم'] || meta.translator || '').trim(),
        section: String(meta['بخش'] || meta.category || '').trim(),
        tags: Array.isArray(meta['برچسب ها'])
            ? (meta['برچسب ها'] as unknown[]).map(String).filter(Boolean)
            : [],
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
    id: string;
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
    return html.replace(/==([^=\n<>]{1,240})==/g, '<mark class="book-highlight">$1</mark>');
}

function addHeadingIds(html: string, toc: TocEntry[]): string {
    return html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_match, levelRaw: string, inner: string) => {
        const level = Number(levelRaw);
        const text = plainText(inner);
        if (!text) return `<h${level}>${inner}</h${level}>`;
        const id = `h-${toc.length + 1}`;
        if (level <= 3) toc.push({ level, text, id });
        return `<h${level} id="${id}">${inner}</h${level}>`;
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
    const rows: string[] = [];
    if (doc.author) rows.push(`<p class="cover__author">${escapeHtml(doc.author)}</p>`);
    if (doc.translator) rows.push(`<p class="cover__meta">مترجم: ${escapeHtml(doc.translator)}</p>`);
    if (doc.section) rows.push(`<p class="cover__meta">${escapeHtml(doc.section)}</p>`);
    if (doc.tags.length) {
        rows.push(
            `<p class="cover__tags">${doc.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</p>`
        );
    }
    return (
        `<header class="cover">` +
        `<p class="cover__kicker">کتابخانهٔ فارسی MD</p>` +
        `<h1>${escapeHtml(doc.title)}</h1>` +
        `<div class="cover__rule"></div>` +
        rows.join('') +
        `</header>`
    );
}

const HTML_STYLES = `
:root {
    color-scheme: light;
    --ink: #111827;
    --ink-soft: #334155;
    --muted: #64748b;
    --line: #e2e8f0;
    --accent: #4f46e5;
    --accent-2: #06b6d4;
    --paper: #ffffff;
    --page-bg: #f4f6fc;
}
* { box-sizing: border-box; }
body {
    margin: 0;
    padding: 30px 18px 64px;
    background: linear-gradient(180deg, #eef1fb 0, #f7f9fd 260px) no-repeat, var(--page-bg);
    color: var(--ink);
    font-family: 'VazirmatnBook', Vazirmatn, Tahoma, 'Segoe UI', 'Iranian Sans', sans-serif;
    font-size: 12pt;
    line-height: 2.05;
    text-align: justify;
    word-spacing: -0.01em;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
}
.cover {
    position: relative;
    max-width: 190mm;
    margin: 0 auto 26px;
    padding: 76px 44px 60px;
    border-radius: 26px;
    overflow: hidden;
    text-align: center;
    background: linear-gradient(140deg, #312e81 0%, #4338ca 46%, #0e7490 100%);
    color: #f8fafc;
    break-after: page;
    page-break-after: always;
}
.cover::before {
    content: '';
    position: absolute;
    top: -180px;
    inset-inline-start: -120px;
    width: 420px;
    height: 420px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(34, 211, 238, 0.45), transparent 66%);
}
.cover::after {
    content: '';
    position: absolute;
    bottom: -220px;
    inset-inline-end: -140px;
    width: 420px;
    height: 420px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(167, 139, 250, 0.4), transparent 66%);
}
.cover > * { position: relative; }
.cover__kicker { margin: 0 0 30px; color: rgba(248, 250, 252, 0.72); font-size: 10pt; letter-spacing: 0.14em; }
.cover h1 { margin: 0 0 22px; padding-bottom: 0; border-bottom: 0; font-size: 30pt; line-height: 1.5; color: #ffffff; letter-spacing: -0.01em; }
.cover__rule { width: 68px; height: 3px; margin: 0 auto 24px; border-radius: 999px; background: linear-gradient(90deg, #22d3ee, #a78bfa); }
.cover__author { margin: 0 0 10px; font-size: 15pt; color: rgba(248, 250, 252, 0.94); }
.cover__meta { margin: 4px 0; color: rgba(248, 250, 252, 0.72); font-size: 11pt; }
.cover__tags { margin: 24px 0 0; display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
.cover__tags span { padding: 4px 12px; border: 1px solid rgba(255, 255, 255, 0.28); background: rgba(255, 255, 255, 0.1); border-radius: 999px; font-size: 9.5pt; color: #f1f5f9; }
.toc {
    max-width: 172mm;
    margin: 0 auto 26px;
    padding: 28px 30px 24px;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 20px;
    box-shadow: 0 18px 44px -34px rgba(15, 23, 42, 0.45);
    break-after: page;
    page-break-after: always;
}
.toc h2 { display: flex; align-items: center; gap: 10px; margin: 0 0 16px; font-size: 16pt; color: #1e1b4b; }
.toc h2::before { content: ''; width: 22px; height: 4px; border-radius: 99px; background: linear-gradient(90deg, var(--accent), var(--accent-2)); }
.toc ol { list-style: none; margin: 0; padding: 0; }
.toc li { margin: 0; font-size: 11.5pt; line-height: 1.85; }
.toc li.is-level-2 { margin-inline-start: 18px; font-size: 11pt; }
.toc li.is-level-3 { margin-inline-start: 36px; font-size: 10.5pt; }
.toc a { display: flex; align-items: baseline; gap: 9px; padding: 5px 8px; border-radius: 9px; color: #1e293b; text-decoration: none; }
.toc a::before { content: ''; flex: none; width: 6px; height: 6px; border-radius: 50%; background: #c7d2fe; transform: translateY(-2px); }
.toc li.is-level-1 > a::before { background: linear-gradient(135deg, #6366f1, #22d3ee); }
.toc li.is-level-1 > a { font-weight: 700; }
.toc a:hover { background: #eef2ff; color: var(--accent); }
.page {
    position: relative;
    max-width: 190mm;
    margin: 0 auto 24px;
    padding: 34px 40px 38px;
    background: var(--paper);
    border: 1px solid var(--line);
    border-radius: 20px;
    box-shadow: 0 20px 50px -40px rgba(15, 23, 42, 0.5);
    break-after: page;
    page-break-after: always;
}
.page::before { content: ''; position: absolute; inset-inline: 0; top: 0; height: 4px; border-radius: 20px 20px 0 0; background: linear-gradient(90deg, #6366f1, #22d3ee); opacity: 0.75; }
.page:last-of-type { break-after: auto; page-break-after: auto; }
.page-marker { width: fit-content; margin: 0 auto 18px; padding: 3px 14px; border-radius: 999px; background: #eef2ff; color: #4338ca; font-size: 9.5pt; font-weight: 700; }
h1, h2, h3, h4, h5, h6 { line-height: 1.6; color: #0f172a; margin: 1.15em 0 0.55em; text-align: start; }
h1 { font-size: 21pt; color: #312e81; padding-bottom: 0.3em; border-bottom: 1px solid var(--line); }
h2 { font-size: 17pt; color: #1e1b4b; padding-inline-start: 0.55em; border-inline-start: 4px solid var(--accent); }
h3 { font-size: 14.5pt; color: #0e7490; }
h4 { font-size: 13pt; } h5 { font-size: 12pt; } h6 { font-size: 11pt; color: var(--ink-soft); }
p { margin: 0 0 0.75em; }
a { color: #1d4ed8; text-underline-offset: 3px; }
ul, ol { margin: 0 0 0.85em; padding-inline-start: 22px; }
li { margin: 0.18em 0; }
li::marker { color: var(--accent); }
blockquote { margin: 1em 0; padding: 12px 18px; border-inline-start: 3px solid var(--accent-2); border-radius: 0 12px 12px 0; color: var(--ink-soft); background: #f8fafc; }
blockquote p:last-child { margin-bottom: 0; }
code { font-family: 'Cascadia Mono', Consolas, monospace; background: #f1f5f9; padding: 0 4px; border-radius: 4px; font-size: 0.9em; }
pre { background: #f8fafc; border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; overflow: auto; direction: ltr; text-align: left; line-height: 1.7; }
pre code { background: none; padding: 0; }
table { width: 100%; border-collapse: collapse; margin: 1em 0; font-size: 10.5pt; border: 1px solid var(--line); }
th, td { border-bottom: 1px solid var(--line); border-inline-start: 1px solid var(--line); padding: 8px 11px; text-align: start; vertical-align: top; }
th:first-child, td:first-child { border-inline-start: none; }
th { background: #eef2ff; color: #312e81; font-weight: 700; }
tbody tr:nth-child(even) td { background: #f8fafc; }
img { max-width: 100%; height: auto; border-radius: 10px; }
mark.book-highlight { background: #fef3c7; color: inherit; padding: 0 3px; border-radius: 4px; }
hr { border: 0; height: 1px; background: linear-gradient(90deg, transparent, var(--line) 20%, var(--line) 80%, transparent); margin: 1.5em 0; }
sup.fn-ref a { display: inline-block; min-width: 1.4em; padding: 0 4px; border-radius: 5px; background: #eef2ff; color: var(--accent); text-decoration: none; font-size: 0.72em; font-weight: 700; text-align: center; }
.footnotes { margin-top: 26px; padding-top: 16px; border-top: 1px dashed var(--line); font-size: 9.8pt; color: var(--ink-soft); }
.footnotes h4 { margin: 0 0 10px; font-size: 11pt; color: var(--accent); }
.footnotes ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
.footnotes li { display: flex; align-items: flex-start; gap: 8px; padding: 8px 11px; background: #f8fafc; border: 1px solid var(--line); border-radius: 10px; line-height: 1.9; }
.footnotes .fn-num { flex: none; width: 22px; height: 22px; display: inline-grid; place-items: center; border-radius: 7px; background: #ffffff; border: 1px solid var(--line); color: var(--accent); font-weight: 800; font-size: 9pt; }
.fn-back { flex: none; margin-inline-start: auto; text-decoration: none; color: var(--accent); opacity: 0.7; }
.banner { max-width: 760px; margin: 0 auto 22px; padding: 14px 18px; border: 1px solid #c7d2fe; background: #eef2ff; border-radius: 14px; color: #312e81; font-size: 10.5pt; line-height: 1.9; }
.banner strong { display: block; margin-bottom: 4px; color: #1e1b4b; }
@media print {
    html, body { background: #ffffff; }
    body { padding: 0; font-size: 11pt; }
    .no-print { display: none !important; }
    .cover, .toc, .page { max-width: none; margin: 0; border: none; border-radius: 0; box-shadow: none; padding: 0; }
    .cover { padding: 34mm 14mm; }
    .toc { padding: 0 0 10mm; }
    .page { break-after: page; page-break-after: always; }
    .page::before { display: none; }
    a { color: inherit; text-decoration: none; }
    h1, h2, h3, h4 { break-after: avoid; page-break-after: avoid; }
    table, pre, blockquote, .footnotes li { break-inside: avoid; page-break-inside: avoid; }
    thead { display: table-header-group; }
    th { background: #eef2ff !important; }
}
@page { size: A4; margin: 18mm 16mm 20mm; }
`;

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
        const prepared = (notes.length ? notes : page.footnotes).map((note, index) => {
            const label = String(note.label || index + 1);
            let anchor = `fn-${pageIndex + 1}-${safeId(label)}`;
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
        html = addHeadingIds(html, toc);

        const marker = page.marker
            ? `<div class="page-marker">${escapeHtml(page.marker)}</div>`
            : '';
        return `<section class="page" id="page-${pageIndex + 1}">${marker}${html}${notesHtml(
            prepared
        )}</section>`;
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
                      `<li class="is-level-${entry.level}"><a href="#${entry.id}">${escapeHtml(
                          entry.text
                      )}</a></li>`
              )
              .join('')}</ol></nav>`
        : '';

    const banner = `<div class="banner no-print"><strong>آمادهٔ ذخیره به PDF</strong>در پنجرهٔ چاپ، مقصد را «Save as PDF / ذخیره به PDF» انتخاب کنید. اگر پنجره باز نشد، Ctrl+P بزنید.</div>`;
    const printScript = options.autoPrint
        ? `<script>window.addEventListener('load',function(){setTimeout(function(){window.print();},700);});</script>`
        : '';

    return (
        `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<title>${escapeHtml(doc.title)}</title><style>${fonts}\n${HTML_STYLES}</style></head>` +
        `<body>${banner}${coverHtml(doc)}${tocHtml}${pageParts.join('')}${printScript}</body></html>`
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
    pageBreakBefore?: boolean;
    spacingAfter?: number;
}

function paragraph(content: string, options: ParagraphOptions = {}): string {
    const props: string[] = [];
    if (options.style) props.push(`<w:pStyle w:val="${options.style}"/>`);
    if (options.pageBreakBefore) props.push('<w:pageBreakBefore/>');
    if (options.border) {
        props.push(
            '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="CBD5E1"/></w:pBdr>'
        );
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

function tableXml(token: MdToken): string {
    const header = token.header ?? [];
    const rows = token.rows ?? [];
    const cell = (content: { text: string; tokens?: MdToken[] }) =>
        `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${paragraph(
            inlineRuns(content.tokens ?? [{ type: 'text', text: content.text }])
        )}</w:tc>`;
    const rowXml = (cells: { text: string; tokens?: MdToken[] }[], bold: boolean) =>
        `<w:tr>${bold ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells
            .map((content) =>
                bold
                    ? `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>` +
                      '<w:shd w:val="clear" w:color="auto" w:fill="EEF2FF"/></w:tcPr>' +
                      paragraph(
                          inlineRuns(content.tokens ?? [{ type: 'text', text: content.text }], {
                              bold: true,
                              color: '312E81'
                          })
                      ) +
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
                const runs = inlineRuns(child.tokens ?? [{ type: 'text', text: child.text ?? '' }]);
                out.push(paragraph((first ? run(prefix) : '') + runs, { indent: nestedIndent }));
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
                out.push(paragraph(inlineRuns(token.tokens), { style: `Heading${depth}` }));
                break;
            }
            case 'paragraph':
            case 'text': {
                const runs = inlineRuns(token.tokens ?? [{ type: 'text', text: token.text ?? '' }]);
                out.push(paragraph(runs, { style: options.quote ? 'Quote' : undefined }));
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
                const text = stripTags(token.text ?? token.raw ?? '').trim();
                if (text) out.push(paragraph(run(text)));
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
                body.push(
                    paragraph(
                        run(`${note.label}) `, { bold: true, size: 18 }) +
                            inlineRuns(
                                marked.lexer(note.text) as unknown as MdToken[]
                            ),
                        { style: 'Quote' }
                    )
                );
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
    format: ExportFormat
): Promise<ExportResult> {
    const filePath = resolveBookPath(filename);
    if (!filePath) throw new HttpError('فایل کتاب برای خروجی معتبر نیست.');

    const content = await fs.promises.readFile(filePath, 'utf8');
    const doc = parseDocument(content, String(filename));
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
