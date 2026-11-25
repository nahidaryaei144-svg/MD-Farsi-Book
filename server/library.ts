import fs from 'node:fs';
import path from 'node:path';
import { LIBRARY_DIR } from './config.js';

export interface BookMetadata {
    'نام کتاب': string;
    'نویسنده': string;
    'مترجم': string;
    'بخش': string;
    'معلومات نویسنده'?: string;
    'جلد'?: string;
    'تعداد جلدها'?: number;
    'برچسب ها': string[];
    'امتیاز': number;
    'خوانده شده': boolean;
    [key: string]: unknown;
}

export function cleanValue(value: unknown): string {
    let text = String(value == null ? '' : value).trim();
    if (text.length >= 2) {
        const first = text[0];
        const last = text[text.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            text = text.slice(1, -1).trim();
        }
    }
    return text;
}

export function cleanList(values: unknown): string[] {
    if (!Array.isArray(values)) return [];
    return values.map((value) => cleanValue(value)).filter((value) => value !== '');
}

export function parseFrontmatter(content: string): Record<string, unknown> {
    const match = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return {};

    const data: Record<string, unknown> = {};
    const lines = match[1].split('\n');
    let currentKey: string | null = null;
    let isArray = false;
    /* A value written as a YAML block (`|` or `>`) keeps its lines joined with
       newlines, so multi-line fields such as the author's information survive
       a read and write round trip. */
    let blockKey: string | null = null;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (blockKey) {
            if (/^\s+\S/.test(rawLine)) {
                (data[blockKey] as string[]).push(line);
                continue;
            }
            data[blockKey] = (data[blockKey] as string[]).join('\n');
            blockKey = null;
            if (!line) continue;
        } else if (!line) {
            continue;
        }

        const colonIndex = line.indexOf(':');
        if (colonIndex !== -1) {
            currentKey = line.substring(0, colonIndex).trim();
            const value = line.substring(colonIndex + 1).trim();

            if (value === '' || value.startsWith('-') || value.startsWith('[')) {
                isArray = true;
                data[currentKey] = [];
                if (value.startsWith('-')) {
                    const itemValue = value.substring(1).trim();
                    if (itemValue) (data[currentKey] as string[]).push(cleanValue(itemValue));
                }
            } else if (/^[|>][-+]?$/.test(value)) {
                isArray = false;
                blockKey = currentKey;
                data[currentKey] = [];
            } else {
                isArray = false;
                data[currentKey] = cleanValue(value);
            }
        } else if (currentKey && isArray && line.startsWith('-')) {
            const itemValue = line.substring(1).trim();
            if (itemValue) (data[currentKey] as string[]).push(cleanValue(itemValue));
        }
    }

    if (blockKey) data[blockKey] = (data[blockKey] as string[]).join('\n');

    for (const key of Object.keys(data)) {
        if (data[key] === 'true') data[key] = true;
        if (data[key] === 'false') data[key] = false;
    }
    return data;
}

export function normalizeBookMetadata(source: unknown, filename = ''): BookMetadata {
    const metadata = source && typeof source === 'object' ? (source as Record<string, unknown>) : {};
    const asList = (value: unknown): string[] => {
        if (Array.isArray(value)) return value.map((item) => cleanValue(item)).filter(Boolean);
        return value ? String(value).split(/[،,]/).map((item) => cleanValue(item)).filter(Boolean) : [];
    };
    const ratingValue = metadata['امتیاز'] ?? metadata.rating;
    const numericRating = Number(ratingValue);
    const rating = Number.isFinite(numericRating)
        ? Math.max(0, Math.min(5, Math.round(numericRating)))
        : metadata['کتاب های منتخب'] === true
            ? 5
            : 0;
    const volumeCountValue = Number(metadata['تعداد جلدها'] ?? metadata['تعداد جلد']);
    const volumeCount =
        Number.isFinite(volumeCountValue) && volumeCountValue > 0 ? Math.round(volumeCountValue) : undefined;
    const tags = [
        ...asList(metadata['برچسب ها']),
        ...asList(metadata['تگ ها']),
        ...asList(metadata.tags),
        ...asList(metadata['کلمات کلیدی']),
        ...asList(metadata.keywords)
    ].filter(
        (value, index, all) =>
            value && all.findIndex((item) => item.toLocaleLowerCase() === value.toLocaleLowerCase()) === index
    );

    return {
        ...metadata,
        'نام کتاب': String(
            metadata['نام کتاب'] ||
                metadata['عنوان کتاب'] ||
                metadata.title ||
                path.basename(filename, path.extname(filename))
        ),
        'نویسنده': String(metadata['نویسنده'] || metadata.author || ''),
        'مترجم': String(metadata['مترجم'] || metadata.translator || ''),
        'بخش': String(metadata['بخش'] || metadata.category || metadata['موضوع'] || ''),
        'معلومات نویسنده': String(
            metadata['معلومات نویسنده'] ??
                metadata['درباره نویسنده'] ??
                metadata['معرفی نویسنده'] ??
                metadata.authorInfo ??
                ''
        ),
        'جلد': metadata['جلد'] == null ? '' : cleanValue(metadata['جلد']),
        'تعداد جلدها': volumeCount,
        'برچسب ها': tags,
        'امتیاز': rating,
        'خوانده شده':
            metadata['خوانده شده'] === true ||
            metadata['وضعیت خواندن'] === true ||
            metadata.read === true
    };
}

export function yamlString(value: unknown): string {
    return String(value == null ? '' : value)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r?\n/g, ' ');
}

export function renderFrontmatterEntry(key: string, value: unknown): string[] {
    if (Array.isArray(value)) {
        return [`${key}:`].concat(value.map((item) => `  - "${yamlString(item)}"`));
    }
    if (typeof value === 'boolean') return [`${key}: ${value}`];
    if (typeof value === 'number' && Number.isFinite(value)) return [`${key}: ${value}`];
    const text = String(value == null ? '' : value).replace(/\r\n/g, '\n');
    if (text.includes('\n')) {
        const lines = text.split('\n').map((line) => line.replace(/\r/g, ''));
        return [`${key}: |`, ...lines.map((line) => `  ${line}`)];
    }
    return [`${key}: "${yamlString(value)}"`];
}

const CANONICAL_FIELDS = [
    'نام کتاب',
    'نویسنده',
    'معلومات نویسنده',
    'مترجم',
    'بخش',
    'جلد',
    'تعداد جلدها',
    'برچسب ها',
    'امتیاز',
    'خوانده شده'
] as const;

/** Alias keys are read from imported files but never written back, so a book
    never ends up carrying both `نویسنده` and `author`. */
const ALIAS_FIELDS = new Set([
    'عنوان کتاب',
    'title',
    'author',
    'authorInfo',
    'درباره نویسنده',
    'معرفی نویسنده',
    'translator',
    'category',
    'موضوع',
    'تعداد جلد',
    'تگ ها',
    'tags',
    'کلمات کلیدی',
    'keywords',
    'rating',
    'read',
    'وضعیت خواندن',
    'کتاب های منتخب'
]);

export function serializeBookFrontmatter(source: unknown, newline = '\n', filename = ''): string {
    const metadata = normalizeBookMetadata(source, filename);
    const sourceObject: Record<string, unknown> =
        source && typeof source === 'object' ? (source as Record<string, unknown>) : {};
    const known = new Set<string>(CANONICAL_FIELDS);

    const entries: string[][] = [
        renderFrontmatterEntry('نام کتاب', metadata['نام کتاب']),
        renderFrontmatterEntry('نویسنده', metadata['نویسنده'])
    ];

    const authorInfo = String(metadata['معلومات نویسنده'] ?? '').trim();
    if (authorInfo) entries.push(renderFrontmatterEntry('معلومات نویسنده', authorInfo));

    entries.push(
        renderFrontmatterEntry('مترجم', metadata['مترجم']),
        renderFrontmatterEntry('بخش', metadata['بخش'])
    );

    const volume = String(metadata['جلد'] ?? '').trim();
    if (volume) entries.push(renderFrontmatterEntry('جلد', volume));
    const volumeCount = metadata['تعداد جلدها'];
    if (typeof volumeCount === 'number' && volumeCount > 0) {
        entries.push(renderFrontmatterEntry('تعداد جلدها', volumeCount));
    }

    entries.push(
        renderFrontmatterEntry('برچسب ها', metadata['برچسب ها']),
        renderFrontmatterEntry('امتیاز', metadata['امتیاز']),
        renderFrontmatterEntry('خوانده شده', metadata['خوانده شده'])
    );

    /** Any other properties already present in the markdown file are kept, so
        editing a book never silently drops custom fields. */
    for (const key of Object.keys(sourceObject)) {
        if (known.has(key) || ALIAS_FIELDS.has(key)) continue;
        const value = sourceObject[key];
        if (value === undefined || value === null || value === '') continue;
        if (Array.isArray(value) && !value.length) continue;
        entries.push(renderFrontmatterEntry(key, value));
    }

    return ['---', ...entries.flat(), '---', ''].join(newline);
}

/** The closing delimiter of the frontmatter block, if it is present. */
function hasClosingDelimiter(text: string): boolean {
    if (!/^---\r?\n/.test(text)) return false;
    return /\r?\n---(?:\r?\n|$)/.test(text.slice(4));
}

/**
 * Reads only the frontmatter of a book.
 *
 * Most books have a frontmatter block of a few hundred bytes, so the first read
 * is 4 KB; the buffer only grows for the rare book with an exceptionally long
 * metadata block. This keeps a full library scan to a few megabytes instead of
 * 64 KB per book.
 */
export function readFrontmatterOnly(filePath: string): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
        fs.open(filePath, 'r', (error, fd) => {
            if (error) return resolve({});
            const STEPS = [4 * 1024, 16 * 1024, 64 * 1024];
            let buffer = Buffer.allocUnsafe(STEPS[0]);
            let filled = 0;
            let step = 0;

            const finish = (text: string) => {
                fs.close(fd, () => {});
                resolve(parseFrontmatter(text));
            };

            const readStep = () => {
                const target = STEPS[step];
                if (buffer.length < target) {
                    const grown = Buffer.allocUnsafe(target);
                    buffer.copy(grown, 0, 0, filled);
                    buffer = grown;
                }
                fs.read(fd, buffer, filled, buffer.length - filled, filled, (readError, bytesRead) => {
                    if (readError) return finish('');
                    filled += bytesRead;
                    if (filled === 0) return finish('');
                    const text = buffer.subarray(0, filled).toString('utf-8');
                    const complete = hasClosingDelimiter(text) || bytesRead === 0;
                    const last = step === STEPS.length - 1;
                    if (complete || last) return finish(text);
                    step += 1;
                    readStep();
                });
            };

            readStep();
        });
    });
}

export async function listMarkdownFiles(directory = LIBRARY_DIR, relativeDirectory = ''): Promise<string[]> {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
        entries.map(async (entry) => {
            const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
            const fullPath = path.join(directory, entry.name);
            if (entry.isDirectory()) return listMarkdownFiles(fullPath, relativePath);
            return entry.isFile() && entry.name.toLowerCase().endsWith('.md') ? [relativePath] : [];
        })
    );
    return nested.flat().sort((a, b) => a.localeCompare(b, 'fa'));
}

export async function listLibraryFolders(
    directory = LIBRARY_DIR,
    relativeDirectory = ''
): Promise<string[]> {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    const folders: string[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        folders.push(relativePath);
        folders.push(...(await listLibraryFolders(path.join(directory, entry.name), relativePath)));
    }
    return folders;
}

export function resolveBookPath(filename: unknown): string | null {
    if (typeof filename !== 'string' || !filename) return null;
    if (path.posix.isAbsolute(filename) || path.win32.isAbsolute(filename)) return null;
    const normalized = filename.replace(/\\/g, '/');
    const segments = normalized.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
    if (path.extname(normalized).toLowerCase() !== '.md') return null;
    const filePath = path.resolve(LIBRARY_DIR, ...segments);
    if (!filePath.startsWith(LIBRARY_DIR + path.sep)) return null;
    return filePath;
}

export function resolveLibraryFolder(folder: unknown = ''): string | null {
    if (typeof folder !== 'string' || folder.includes('\\')) return null;
    const normalized = folder.replace(/\/+$/g, '');
    if (!normalized) return LIBRARY_DIR;
    const segments = normalized.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
    const folderPath = path.resolve(LIBRARY_DIR, ...segments);
    return folderPath === LIBRARY_DIR || folderPath.startsWith(LIBRARY_DIR + path.sep)
        ? folderPath
        : null;
}

export function isSafeLibraryName(name: unknown): name is string {
    return (
        typeof name === 'string' &&
        name.trim().length > 0 &&
        name.trim().length <= 100 &&
        !/[<>:"/\\|?*\x00-\x1f]/.test(name) &&
        !/^\.+$/.test(name.trim())
    );
}

export function missingRequiredFields(frontmatter: BookMetadata): string[] {
    return ['نام کتاب', 'نویسنده'].filter((field) => {
        const value = frontmatter[field as keyof BookMetadata];
        if (Array.isArray(value)) return value.length === 0;
        if (typeof value === 'boolean') return true;
        return value === undefined || value === null || String(value).trim() === '';
    });
}

export function frontmatterEndOffset(text: string): number {
    const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    if (match) return match[0].length;
    return text.charCodeAt(0) === 0xfeff ? 1 : 0;
}
