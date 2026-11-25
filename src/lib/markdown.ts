import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

function findHighlightStart(source: string): number | undefined {
    let index = 0;
    let codeDelimiter = '';
    while (index < source.length) {
        if (source[index] === '\\') {
            index += 2;
            continue;
        }
        if (source[index] === '`') {
            const delimiter = source.slice(index).match(/^`+/)?.[0] || '';
            if (!codeDelimiter) {
                let closing = source.indexOf(delimiter, index + delimiter.length);
                while (
                    closing >= 0 &&
                    (source[closing - 1] === '`' || source[closing + delimiter.length] === '`')
                ) {
                    closing = source.indexOf(delimiter, closing + delimiter.length);
                }
                if (closing >= 0) codeDelimiter = delimiter;
            } else if (delimiter === codeDelimiter) {
                codeDelimiter = '';
            }
            index += delimiter.length;
            continue;
        }
        if (!codeDelimiter && source.startsWith('==', index)) return index;
        index += 1;
    }
    return undefined;
}

marked.use({
    extensions: [
        {
            name: 'highlight',
            level: 'inline',
            start: findHighlightStart,
            tokenizer(source) {
                const match = source.match(/^==([^=\n]+)==/);
                if (!match) return;
                return { type: 'highlight', raw: match[0], text: match[1] };
            },
            renderer(token) {
                return `<mark class="book-highlight">${escapeHtml(token.text || '')}</mark>`;
            }
        }
    ]
});

export interface BookFootnote {
    id?: string;
    num?: number;
    label?: string;
    text: string;
}

export interface BookPage {
    index: number;
    marker: string;
    html: string;
    footnotes: BookFootnote[];
}

const PAGE_MARKER = /^\s*(?:بخش\s*:\s*[\d\u06F0-\u06F9\u0660-\u0669]+(?:\s*-\s*صفحه\s*:\s*[\d\u06F0-\u06F9\u0660-\u0669]+)?|الجزء\s*:.*|صفحه\s*:.*|\*\*قسمت\s+[\d\u06F0-\u06F9\u0660-\u0669].*(?:صفحه|ص\.)\s*[\d\u06F0-\u06F9\u0660-\u0669]+.*\*\*)$/;
const FOOTNOTE_START = /^(?:¬\s*_+|>\s*پاورقی.*|\*{3,})$/;
const FOOTNOTE_LINE = /^\(?¬?\s*([\d\u06F0-\u06F9]+)\)?\s*(.*)$/;

export function normalizeDigits(value: string): string {
    return String(value).replace(/[\u06F0-\u06F9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

export function escapeHtml(value: string): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function stripFrontmatter(content: string): string {
    const text = String(content || '');
    const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    return match ? text.slice(match[0].length) : text.replace(/^\uFEFF/, '');
}

export function renderMarkdown(markdown: string): string {
    const html = marked.parse(markdown, { async: false }) as string;
    return wrapTables(sanitizeHtml(html));
}

/** A wide table gets its own horizontal scroller, so a long row never pushes
    the reading column sideways or gets clipped by the page card. */
function wrapTables(html: string): string {
    if (typeof window === 'undefined' || !html.includes('<table')) return html;
    const template = document.createElement('template');
    template.innerHTML = html;
    template.content.querySelectorAll('table').forEach((table) => {
        if (table.parentElement?.classList.contains('book-table-scroll')) return;
        const wrapper = document.createElement('div');
        wrapper.className = 'book-table-scroll';
        table.replaceWith(wrapper);
        wrapper.appendChild(table);
    });
    return template.innerHTML;
}

function sanitizeHtml(html: string): string {
    if (typeof window === 'undefined') return html;
    const template = document.createElement('template');
    template.innerHTML = html;
    template.content.querySelectorAll('script, iframe, object, embed').forEach((node) => node.remove());
    template.content.querySelectorAll('*').forEach((element) => {
        for (const attribute of [...element.attributes]) {
            const name = attribute.name.toLowerCase();
            const value = attribute.value.trim().toLowerCase();
            if (name.startsWith('on')) element.removeAttribute(attribute.name);
            if ((name === 'href' || name === 'src') && value.startsWith('javascript:')) {
                element.removeAttribute(attribute.name);
            }
        }
    });
    return template.innerHTML;
}

function footnoteKey(value: string): string {
    return encodeURIComponent(value).replace(/%/g, '_');
}

function renderFootnotes(pageIndex: number, footnotes: BookFootnote[]): string {
    if (!footnotes.length) return '';
    const items = footnotes
        .map((footnote) => {
            const noteId = footnote.id == null ? String(footnote.num) : footnoteKey(footnote.id);
            const label = footnote.label == null ? String(footnote.num) : footnote.label;
            return `<li class="book-footnote" id="fn-p${pageIndex}-${noteId}"><span class="book-footnote-num">${escapeHtml(label)}</span><div class="book-footnote-text">${escapeHtml(footnote.text)}</div><a class="book-footnote-back" href="#ref-p${pageIndex}-${noteId}" title="بازگشت به متن">↩</a></li>`;
        })
        .join('');
    return `<div class="book-footnotes"><div class="book-footnotes-title">پاورقی‌ها</div><ol class="book-footnotes-list">${items}</ol></div>`;
}

function parseSections(raw: string): BookPage[] {
    const sections = raw.split(/\n\s*---\s*\n/);
    const pages: BookPage[] = [];

    sections.forEach((section) => {
        const trimmed = section.trim();
        if (!trimmed) return;

        const lines = trimmed.split('\n');
        let marker = '';
        const contentLines: string[] = [];
        const footnoteLines: string[] = [];
        let inFootnotes = false;

        for (const line of lines) {
            const lineText = line.trim();
            if (PAGE_MARKER.test(lineText)) {
                marker = lineText;
                continue;
            }
            if (FOOTNOTE_START.test(lineText)) {
                inFootnotes = true;
                continue;
            }
            if (inFootnotes) footnoteLines.push(line);
            else contentLines.push(line);
        }

        const footnotes: BookFootnote[] = [];
        let current: BookFootnote | null = null;
        for (const line of footnoteLines) {
            const text = line.trim();
            if (!text) continue;
            const match = text.match(FOOTNOTE_LINE);
            if (match) {
                if (current) footnotes.push(current);
                current = {
                    num: Number(normalizeDigits(match[1])) || footnotes.length + 1,
                    text: match[2] || ''
                };
            } else if (current) {
                current.text += ` ${text}`;
            } else if (!text.startsWith('>')) {
                footnotes.push({ num: footnotes.length + 1, text });
            }
        }
        if (current) footnotes.push(current);

        const pageIndex = pages.length;
        let body = contentLines.join('\n');
        body = body.replace(/\(¬\s*([\d\u06F0-\u06F9]+)\)/g, (_match, number: string) => {
            const numeric = Number(normalizeDigits(number));
            return `<sup class="fn-ref" id="ref-p${pageIndex}-${numeric}"><a href="#fn-p${pageIndex}-${numeric}">[${number}]</a></sup>`;
        });

        pages.push({
            index: pageIndex,
            marker,
            html: renderMarkdown(body) + renderFootnotes(pageIndex, footnotes),
            footnotes
        });
    });

    return pages;
}

function findStandardFootnotesStart(lines: string[]): number {
    let start = lines.findIndex((line) => /^\s*#{1,6}\s+پاورقی‌ها\s*$/i.test(line));
    if (start < 0) start = lines.findIndex((line) => /^\s*\[\^[^\]\n]+:/.test(line));
    return start;
}

function splitStandardPages(contentLines: string[]): string[] {
    const pages: string[] = [];
    let pageLines: string[] = [];
    let pageLength = 0;
    const maxLength = 9000;

    const flush = () => {
        const markdown = pageLines.join('\n').trim();
        if (markdown) pages.push(markdown);
        pageLines = [];
        pageLength = 0;
    };

    contentLines.forEach((line, index) => {
        const isHeading = /^\s*#{1,6}\s+/.test(line);
        if (isHeading && pageLength > maxLength * 0.35) flush();
        pageLines.push(line);
        pageLength += line.length + 1;
        if (!line.trim() && pageLength >= maxLength) flush();
        if (index === contentLines.length - 1) flush();
    });

    return pages;
}

function parseStandardFootnotes(raw: string): BookPage[] {
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    const footnotesStart = findStandardFootnotesStart(lines);
    const contentLines = footnotesStart < 0 ? lines : lines.slice(0, footnotesStart);
    const noteLines = footnotesStart < 0 ? [] : lines.slice(footnotesStart + 1);

    const notes = new Map<string, BookFootnote>();
    let current: BookFootnote | null = null;
    for (const line of noteLines) {
        const match = line.match(/^\s*\[\^([^\]\n]+)\]:\s*(.*)$/);
        if (match) {
            current = { id: match[1].trim(), label: match[1].trim(), text: match[2].trim() };
            notes.set(current.id!, current);
        } else if (current && line.trim()) {
            current.text += ` ${line.trim()}`;
        }
    }

    const pages: BookPage[] = [];
    for (const markdown of splitStandardPages(contentLines)) {
        const pageIndex = pages.length;
        const used = new Set<string>();
        const body = markdown.replace(/\[\^([^\]\n]+)\]/g, (match, rawId: string) => {
            const id = rawId.trim();
            if (!notes.has(id)) return match;
            used.add(id);
            return `<sup class="fn-ref" id="ref-p${pageIndex}-${footnoteKey(id)}"><a href="#fn-p${pageIndex}-${footnoteKey(id)}">[${escapeHtml(id)}]</a></sup>`;
        });
        const footnotes = [...used].map((id) => notes.get(id)!).filter(Boolean);
        pages.push({
            index: pageIndex,
            marker: '',
            html: renderMarkdown(body) + renderFootnotes(pageIndex, footnotes),
            footnotes
        });
    }

    return pages.length ? pages : [{ index: 0, marker: '', html: '<p></p>', footnotes: [] }];
}

export function parseBookPages(content: string): BookPage[] {
    const raw = stripFrontmatter(content).replace(/\r\n/g, '\n');
    if (!raw.trim()) return [];
    const pages = /^\s*\[\^[^\]\n]+\]:/m.test(raw) ? parseStandardFootnotes(raw) : parseSections(raw);
    return pages.length ? pages : [{ index: 0, marker: '', html: renderMarkdown(raw), footnotes: [] }];
}

export interface BookSearchPage {
    index: number;
    marker: string;
    body: string;
    footnotes: string[];
}

/**
 * Splits a book into the exact same pages the reader renders, so a search hit can
 * always be mapped back to a real page and occurrence in the document.
 */
export function bookSearchPages(content: string): BookSearchPage[] {
    const raw = stripFrontmatter(content).replace(/\r\n/g, '\n');
    if (!raw.trim()) return [];

    if (/^\s*\[\^[^\]\n]+\]:/m.test(raw)) {
        const lines = raw.split('\n');
        const footnotesStart = findStandardFootnotesStart(lines);
        const contentLines = footnotesStart < 0 ? lines : lines.slice(0, footnotesStart);
        const noteLines = footnotesStart < 0 ? [] : lines.slice(footnotesStart + 1);
        const notes = new Map<string, string>();
        let current: string | null = null;
        for (const line of noteLines) {
            const match = line.match(/^\s*\[\^([^\]\n]+)\]:\s*(.*)$/);
            if (match) {
                current = match[1].trim();
                notes.set(current, match[2].trim());
            } else if (current && line.trim()) {
                notes.set(current, `${notes.get(current) || ''} ${line.trim()}`.trim());
            }
        }
        const reference = /\[\^([^\]\n]+)\]/g;
        return splitStandardPages(contentLines).map((body, index) => {
            // Only the notes this page actually references belong to it, exactly
            // like the reader renders them. Attaching the whole book's notes to
            // every page multiplied each footnote hit by the number of pages.
            const used = new Set<string>();
            for (const match of body.matchAll(reference)) {
                const id = match[1].trim();
                if (notes.has(id)) used.add(id);
            }
            return {
                index,
                marker: '',
                body,
                footnotes: [...used].map((id) => notes.get(id) as string)
            };
        });
    }

    return raw
        .split(/\n\s*---\s*\n/)
        .map((section) => section.trim())
        .filter(Boolean)
        .map((section, index) => {
            const lines = section.split('\n');
            let marker = '';
            const body: string[] = [];
            const footnotes: string[] = [];
            let inFootnotes = false;
            for (const line of lines) {
                const trimmed = line.trim();
                if (PAGE_MARKER.test(trimmed)) {
                    marker = trimmed;
                    continue;
                }
                if (FOOTNOTE_START.test(trimmed)) {
                    inFootnotes = true;
                    continue;
                }
                if (inFootnotes) footnotes.push(trimmed);
                else body.push(line);
            }
            return { index, marker, body: body.join('\n'), footnotes };
        });
}
