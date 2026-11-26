import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import {
    APP_ROOT,
    BACKUP_DIR,
    BACKUP_INDEX_FILE,
    DIST_DIR,
    LIBRARY_DIR,
    PANEL_IDS,
    PORT,
    STORAGE_DIR,
    type PanelId
} from './server/config.js';
import {
    isSafeLibraryName,
    listLibraryFolders,
    listMarkdownFiles,
    normalizeBookMetadata,
    parseFrontmatter,
    resolveBookPath,
    resolveLibraryFolder,
    serializeBookFrontmatter
} from './server/library.js';
import {
    getLibrarySnapshot,
    invalidateCachedBook
} from './server/library-index.js';
import {
    beginInteractiveRequest,
    endInteractiveRequest,
    ensureSearchIndex,
    getSearchIndexStatusAsync
} from './server/search-index.js';
import { streamLibrarySearch } from './server/search-service.js';
import {
    HttpError,
    readJsonBody,
    sendJson,
    sendJsonCached,
    serveLibraryFile,
    serveStatic
} from './server/http.js';
import { buildLibraryReport, reportToCsv } from './server/report.js';
import { applyBookMetadataChanges, applyReplacement, buildReplacePattern } from './server/batch.js';
import {
    createBookSnapshot,
    createSnapshot,
    deleteSnapshot,
    readBackupIndex,
    restoreSnapshot
} from './server/backups.js';
import {
    isPanelId,
    normalizePanelLayout,
    readAppSettings,
    updateSettings
} from './server/settings.js';
import {
    currentDataLocation,
    relocateDataRoot,
    validateTargetRoot
} from './server/location.js';
import {
    cancelTranslation,
    clearTranslationQueue,
    discoverBookGlossary,
    enqueueTranslations,
    estimateTranslation,
    getTranslationJob,
    getTranslationQueue,
    pauseTranslation,
    previewTranslationPage,
    removeQueuedTranslation,
    resumeTranslation,
    retranslateSegment,
    saveMemoryEntry,
    startTranslation,
    subscribeTranslationEvents,
    testTranslationProvider
} from './server/translate.js';
import {
    publicTranslateConfig,
    readTranslateConfig,
    translateCatalogs,
    updateTranslateConfig
} from './server/translate-config.js';
import { buildExport, type ExportFormat } from './server/export.js';

async function readBookContent(filename: unknown): Promise<{
    filename: string;
    content: string;
    revision: string;
    frontmatter: Record<string, unknown>;
} | null> {
    const filePath = resolveBookPath(filename);
    if (!filePath) return null;
    try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) return null;
        const content = await fs.promises.readFile(filePath, 'utf8');
        return {
            filename: String(filename),
            content,
            revision: `${stat.size}-${Math.floor(stat.mtimeMs)}`,
            frontmatter: normalizeBookMetadata(parseFrontmatter(content), String(filename))
        };
    } catch {
        return null;
    }
}

async function handleSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET') {
        const settings = await readAppSettings();
        sendJson(res, 200, settings);
        return;
    }
    if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
    }

    const data = await readJsonBody<Record<string, unknown>>(req, 16 * 1024);

    if (data.panelStyle && typeof data.panelStyle === 'object' && !Array.isArray(data.panelStyle)) {
        const cornerRadius = Number((data.panelStyle as Record<string, unknown>).cornerRadius);
        if (!Number.isFinite(cornerRadius) || cornerRadius < 0 || cornerRadius > 36) {
            throw new HttpError('مقدار گردی گوشه‌ها معتبر نیست.');
        }
        const settings = await updateSettings((draft) => {
            draft.panelStyle = { ...draft.panelStyle, cornerRadius: Math.round(cornerRadius) };
        });
        sendJson(res, 200, { success: true, settings });
        return;
    }

    if (data.panels && typeof data.panels === 'object' && !Array.isArray(data.panels)) {
        const incoming = data.panels as Record<string, unknown>;
        const settings = await updateSettings((draft) => {
            draft.panels = draft.panels || {};
            for (const [key, value] of Object.entries(incoming)) {
                if (!isPanelId(key) || !value || typeof value !== 'object') continue;
                const state = value as Record<string, unknown>;
                draft.panels[key] = {
                    open: state.open === true,
                    minimized: state.minimized === true
                };
            }
        });
        sendJson(res, 200, { success: true, settings });
        return;
    }

    const panel = data.panel;
    if (!isPanelId(panel)) {
        throw new HttpError('شناسهٔ پنل معتبر نیست.');
    }
    const layout = normalizePanelLayout(data.layout);
    if (!layout) {
        throw new HttpError('اندازه یا موقعیت پنل معتبر نیست.');
    }
    await updateSettings((draft) => {
        draft.panelLayouts = draft.panelLayouts || {};
        draft.panelLayouts[panel as PanelId] = layout;
    });
    sendJson(res, 200, { success: true, layout });
}

async function handleBatchMetadata(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const data = await readJsonBody<{
        files?: unknown;
        changes?: Record<string, unknown>;
        dryRun?: boolean;
    }>(req, 512 * 1024);

    if (!Array.isArray(data.files) || !data.files.length || data.files.length > 10000) {
        throw new HttpError('فهرست کتاب‌ها معتبر نیست.');
    }
    if (!data.changes || typeof data.changes !== 'object' || Array.isArray(data.changes)) {
        throw new HttpError('تغییرات معتبر نیست.');
    }

    const dryRun = data.dryRun === true;
    const updated: string[] = [];
    const unchanged: string[] = [];
    const failed: string[] = [];
    const writes: { filename: string; filePath: string; content: string }[] = [];

    for (const filename of data.files) {
        const filePath = resolveBookPath(filename);
        if (!filePath) {
            failed.push(String(filename));
            continue;
        }
        try {
            const content = await fs.promises.readFile(filePath, 'utf8');
            const result = applyBookMetadataChanges(content, data.changes, filePath ? String(filename) : '');
            if (!result.changed) {
                unchanged.push(String(filename));
                continue;
            }
            updated.push(String(filename));
            if (!dryRun) writes.push({ filename: String(filename), filePath, content: result.content });
        } catch {
            failed.push(String(filename));
        }
    }

    if (!dryRun) {
        for (const item of writes) await fs.promises.writeFile(item.filePath, item.content, 'utf8');
    }
    const snapshot: string | null = null;

    sendJson(res, 200, {
        success: true,
        dryRun,
        updated: updated.length,
        files: updated,
        unchanged: unchanged.length,
        failed,
        snapshot
    });
}

async function handleBatchReplace(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const data = await readJsonBody<{
        files?: unknown;
        search?: string;
        replace?: string;
        options?: Record<string, unknown>;
        dryRun?: boolean;
    }>(req, 512 * 1024);

    if (!Array.isArray(data.files) || !data.files.length || data.files.length > 10000) {
        throw new HttpError('فهرست کتاب‌ها معتبر نیست.');
    }
    const search = typeof data.search === 'string' ? data.search : '';
    if (!search) throw new HttpError('متن جست‌وجو خالی است.');

    const requested = data.options && typeof data.options === 'object' ? data.options : {};
    const options = {
        regex: requested.regex === true,
        caseSensitive: requested.caseSensitive === true,
        scope: (['body', 'metadata', 'both'] as const).includes(
            requested.scope as 'body' | 'metadata' | 'both'
        )
            ? (requested.scope as 'body' | 'metadata' | 'both')
            : 'both'
    } as const;

    try {
        buildReplacePattern(search, options);
    } catch {
        throw new HttpError('الگوی جست‌وجوی regex معتبر نیست.');
    }

    const dryRun = data.dryRun !== false;
    const results: {
        filename: string;
        matches: number;
        metadata: number;
        body: number;
        samples: string[];
    }[] = [];
    const writes: { filename: string; filePath: string; content: string }[] = [];
    const failed: string[] = [];
    let totalMatches = 0;

    for (const filename of data.files) {
        const filePath = resolveBookPath(filename);
        if (!filePath) {
            failed.push(String(filename));
            continue;
        }
        try {
            const content = await fs.promises.readFile(filePath, 'utf8');
            const outcome = applyReplacement(content, search, String(data.replace ?? ''), options);
            if (!outcome.count) continue;
            totalMatches += outcome.count;
            results.push({
                filename: String(filename),
                matches: outcome.count,
                metadata: outcome.counts.metadata,
                body: outcome.counts.body,
                samples: outcome.samples
            });
            if (!dryRun) writes.push({ filename: String(filename), filePath, content: outcome.content });
        } catch {
            failed.push(String(filename));
        }
    }

    if (!dryRun) {
        for (const item of writes) await fs.promises.writeFile(item.filePath, item.content, 'utf8');
    }
    const snapshot: string | null = null;

    sendJson(res, 200, {
        success: true,
        dryRun,
        totalMatches,
        updated: writes.length,
        results,
        failed,
        snapshot
    });
}

async function handleTranslationSave(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const data = await readJsonBody<{
        filename?: string;
        content?: string;
        snapshot?: string;
        revision?: string;
    }>(req, 32 * 1024 * 1024);

    const filePath = resolveBookPath(data.filename);
    if (!filePath || typeof data.content !== 'string' || typeof data.snapshot !== 'string' || typeof data.revision !== 'string') {
        throw new HttpError('اطلاعات ذخیرهٔ ترجمه معتبر نیست.');
    }

    const snapshots = await readBackupIndex();
    const snapshot = snapshots.find(
        (item) =>
            item &&
            item.id === data.snapshot &&
            item.reason === 'before-translation' &&
            item.scope === 'book' &&
            item.filename === data.filename
    );
    if (!snapshot) throw new HttpError('نسخهٔ پشتیبانِ همین کتاب پیدا نشد؛ ترجمه را دوباره آغاز کنید.');

    try {
        const currentStat = await fs.promises.stat(filePath);
        const currentRevision = `${currentStat.size}-${Math.floor(currentStat.mtimeMs)}`;
        if (data.revision !== currentRevision) {
            throw new HttpError('فایل کتاب از جای دیگری تغییر کرده است. صفحه را تازه کنید.', 409);
        }

        const tempPath = path.join(
            path.dirname(filePath),
            `.${path.basename(filePath)}.translation-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`
        );
        try {
            await fs.promises.writeFile(tempPath, data.content, { encoding: 'utf8', flag: 'wx' });
            await fs.promises.rename(tempPath, filePath);
        } catch (error) {
            await fs.promises.rm(tempPath, { force: true }).catch(() => {});
            throw error;
        }

        const savedStat = await fs.promises.stat(filePath);
        invalidateCachedBook(String(data.filename));
        sendJson(res, 200, {
            success: true,
            revision: `${savedStat.size}-${Math.floor(savedStat.mtimeMs)}`
        });
    } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError('ذخیرهٔ ترجمه روی فایل اصلی انجام نشد.', 500);
    }
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const route = url.pathname;

    if (route === '/api/health') {
        sendJson(res, 200, { ok: true, libraryDir: LIBRARY_DIR, version: '2.0.0' });
        return true;
    }

    if (route === '/api/library' && req.method === 'GET') {
        const snapshot = await getLibrarySnapshot();
        sendJsonCached(
            req,
            res,
            200,
            {
                generatedAt: snapshot.scannedAt,
                libraryDir: snapshot.libraryDir,
                books: snapshot.books,
                folders: snapshot.folders
            },
            { etag: snapshot.etag, cacheControl: 'private, max-age=0, must-revalidate' }
        );
        return true;
    }

    if (route === '/api/search' && req.method === 'POST') {
        const data = await readJsonBody<Record<string, unknown>>(req, 8 * 1024 * 1024);
        await streamLibrarySearch(req, res, {
            query: String(data.query || ''),
            options: data.options as never,
            filenames: Array.isArray(data.filenames)
                ? data.filenames.filter((item): item is string => typeof item === 'string')
                : undefined
        });
        return true;
    }

    if (route === '/api/search/status' && req.method === 'GET') {
        sendJson(res, 200, await getSearchIndexStatusAsync());
        return true;
    }

    if (route === '/api/books' && req.method === 'GET') {
        sendJson(res, 200, await listMarkdownFiles());
        return true;
    }

    if (route === '/api/books-meta' && req.method === 'GET') {
        const snapshot = await getLibrarySnapshot();
        sendJson(res, 200, snapshot.books.map((book) => ({ filename: book.filename, frontmatter: book.frontmatter })));
        return true;
    }

    if (route === '/api/books/content' && req.method === 'GET') {
        const book = await readBookContent(url.searchParams.get('filename'));
        if (!book) {
            sendJson(res, 404, { error: 'کتاب پیدا نشد.' });
            return true;
        }
        sendJson(res, 200, book);
        return true;
    }

    if (route === '/api/export' && req.method === 'GET') {
        const requested = String(url.searchParams.get('format') || 'md').toLowerCase();
        const allowed: ExportFormat[] = ['md', 'html', 'docx', 'pdf'];
        if (!allowed.includes(requested as ExportFormat)) {
            throw new HttpError('قالب خروجی پشتیبانی نمی‌شود.');
        }
        const rawDisplay = String(
            url.searchParams.get('display') || url.searchParams.get('mode') || 'both'
        ).toLowerCase();
        const display =
            rawDisplay === 'translated' || rawDisplay === 'original' ? rawDisplay : 'both';
        const result = await buildExport(
            url.searchParams.get('filename'),
            requested as ExportFormat,
            display
        );
        const headers: Record<string, string | number> = {
            'Content-Type': result.contentType,
            'Cache-Control': 'no-store'
        };
        if (!result.inline) {
            headers['Content-Disposition'] =
                `attachment; filename="${result.asciiName}"; ` +
                `filename*=UTF-8''${encodeURIComponent(result.fileName)}`;
            headers['Content-Length'] = result.data.length;
        }
        res.writeHead(200, headers);
        res.end(result.data);
        return true;
    }

    if (route === '/api/folders' && req.method === 'GET') {
        sendJson(res, 200, await listLibraryFolders());
        return true;
    }

    if (route === '/api/settings') {
        await handleSettings(req, res);
        return true;
    }

    if (route === '/api/location') {
        if (req.method === 'GET') {
            sendJson(res, 200, currentDataLocation());
            return true;
        }
        if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'Method not allowed' });
            return true;
        }
        const data = await readJsonBody<{ root?: unknown; move?: unknown }>(req, 16 * 1024);
        const root = validateTargetRoot(data.root);
        if (!root) {
            throw new HttpError(
                'مسیر پوشهٔ داده معتبر نیست؛ یک مسیر کامل و مطلق بنویسید (مثلاً D:\\Ketabkhane).'
            );
        }
        try {
            const result = await relocateDataRoot(root, data.move === true);
            sendJson(res, 200, { success: true, ...result });
        } catch (error) {
            throw new HttpError(
                error instanceof Error && error.message
                    ? error.message
                    : 'تغییر پوشهٔ داده انجام نشد.'
            );
        }
        return true;
    }

    if (route === '/api/create-folder' && req.method === 'POST') {
        const data = await readJsonBody<{ parent?: string; name?: string }>(req, 8 * 1024);
        const parentPath = resolveLibraryFolder(data.parent || '');
        const folderName = typeof data.name === 'string' ? data.name.trim() : '';
        if (!parentPath || !isSafeLibraryName(folderName)) {
            throw new HttpError('نام یا مسیر پوشه معتبر نیست.');
        }
        const folderPath = path.join(parentPath, folderName);
        if (!folderPath.startsWith(LIBRARY_DIR + path.sep)) {
            throw new HttpError('مسیر پوشه معتبر نیست.');
        }
        try {
            await fs.promises.mkdir(folderPath);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EEXIST') throw new HttpError('این پوشه از قبل وجود دارد.', 409);
            throw new HttpError('ساخت پوشه انجام نشد.');
        }
        const relativePath = path.relative(LIBRARY_DIR, folderPath).split(path.sep).join('/');
        sendJson(res, 201, { success: true, path: relativePath });
        return true;
    }

    if (route === '/api/add-book' && req.method === 'POST') {
        const data = await readJsonBody<{
            folder?: string;
            filename?: string;
            content?: string;
        }>(req, 32 * 1024 * 1024);
        const folderPath = resolveLibraryFolder(data.folder || '');
        const filename = typeof data.filename === 'string' ? data.filename.trim() : '';
        const content = data.content;
        if (
            !folderPath ||
            !isSafeLibraryName(filename) ||
            path.basename(filename) !== filename ||
            path.extname(filename).toLowerCase() !== '.md' ||
            typeof content !== 'string'
        ) {
            throw new HttpError('فایل یا پوشهٔ انتخاب‌شده معتبر نیست.');
        }
        const filePath = resolveBookPath(data.folder ? `${data.folder}/${filename}` : filename);
        if (!filePath || !filePath.startsWith(folderPath + path.sep)) {
            throw new HttpError('مسیر فایل معتبر نیست.');
        }
        const hasBom = content.charCodeAt(0) === 0xfeff;
        const normalizedContent = hasBom ? content.slice(1) : content;
        const newline = normalizedContent.includes('\r\n') ? '\r\n' : '\n';
        const existingFrontmatter = normalizedContent.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
        const bookBody = existingFrontmatter
            ? normalizedContent.slice(existingFrontmatter[0].length)
            : normalizedContent;
        const canonicalContent =
            (hasBom ? '\uFEFF' : '') +
            serializeBookFrontmatter(parseFrontmatter(normalizedContent), newline, filename) +
            bookBody;
        try {
            await fs.promises.writeFile(filePath, canonicalContent, { encoding: 'utf8', flag: 'wx' });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EEXIST') throw new HttpError('کتابی با این نام در این پوشه وجود دارد.', 409);
            throw new HttpError('افزودن کتاب انجام نشد.');
        }
        invalidateCachedBook(data.folder ? `${data.folder}/${filename}` : filename);
        sendJson(res, 201, { success: true, filename: data.folder ? `${data.folder}/${filename}` : filename });
        return true;
    }

    if (route === '/api/save-book' && req.method === 'POST') {
        const data = await readJsonBody<{ filename?: string; frontmatter?: Record<string, unknown> }>(
            req,
            256 * 1024
        );
        const filePath = resolveBookPath(data.filename);
        if (!filePath || !data.frontmatter || typeof data.frontmatter !== 'object') {
            throw new HttpError('نام فایل یا مشخصات کتاب معتبر نیست.');
        }
        let content: string;
        try {
            content = await fs.promises.readFile(filePath, 'utf8');
        } catch {
            throw new HttpError('فایل کتاب پیدا نشد.', 404);
        }
        const newline = content.includes('\r\n') ? '\r\n' : '\n';
        const existingFrontmatter = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
        const bookBody = existingFrontmatter
            ? content.slice(existingFrontmatter[0].length)
            : content.replace(/^\uFEFF/, '');
        const newContent =
            serializeBookFrontmatter(data.frontmatter, newline, String(data.filename)) + bookBody;
        await fs.promises.writeFile(filePath, newContent, 'utf8');
        invalidateCachedBook(String(data.filename));
        sendJson(res, 200, {
            success: true,
            frontmatter: normalizeBookMetadata(data.frontmatter, String(data.filename))
        });
        return true;
    }

    if (route === '/api/save-content' && req.method === 'POST') {
        const data = await readJsonBody<{ filename?: unknown; content?: unknown; revision?: unknown }>(
            req,
            32 * 1024 * 1024
        );
        const filePath = resolveBookPath(data.filename);
        if (!filePath || typeof data.content !== 'string' || typeof data.revision !== 'string') {
            throw new HttpError('اطلاعات ویرایش متن کتاب معتبر نیست.');
        }

        try {
            const currentStat = await fs.promises.stat(filePath);
            const currentRevision = `${currentStat.size}-${Math.floor(currentStat.mtimeMs)}`;
            if (data.revision && data.revision !== currentRevision) {
                throw new HttpError('فایل کتاب از جای دیگری تغییر کرده است. کتاب را دوباره باز کنید.', 409);
            }

            const tempPath = path.join(
                path.dirname(filePath),
                `.${path.basename(filePath)}.edit-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`
            );
            try {
                await fs.promises.writeFile(tempPath, data.content, { encoding: 'utf8', flag: 'wx' });
                await fs.promises.rename(tempPath, filePath);
            } catch (error) {
                await fs.promises.rm(tempPath, { force: true }).catch(() => {});
                throw error;
            }

            const savedStat = await fs.promises.stat(filePath);
            invalidateCachedBook(String(data.filename));
            sendJson(res, 200, {
                success: true,
                revision: `${savedStat.size}-${Math.floor(savedStat.mtimeMs)}`,
                frontmatter: normalizeBookMetadata(parseFrontmatter(data.content), String(data.filename))
            });
        } catch (error) {
            if (error instanceof HttpError) throw error;
            throw new HttpError('ذخیرهٔ متن کتاب انجام نشد.', 500);
        }
        return true;
    }

    if (route === '/api/translate/status' && req.method === 'GET') {
        sendJson(res, 200, { job: getTranslationJob(), queue: getTranslationQueue() });
        return true;
    }

    if (route === '/api/translate/events' && req.method === 'GET') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        const writeEvent = (payload: unknown) => {
            if (res.writableEnded || res.destroyed) return;
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };
        writeEvent({ job: getTranslationJob(), queue: getTranslationQueue() });
        const unsubscribe = subscribeTranslationEvents((payload) => {
            writeEvent(payload);
        });
        const heartbeat = setInterval(() => {
            if (!res.writableEnded && !res.destroyed) {
                res.write(': ping\n\n');
            }
        }, 25_000);
        heartbeat.unref?.();
        const cleanup = () => {
            clearInterval(heartbeat);
            unsubscribe();
            if (!res.writableEnded) res.end();
        };
        req.on('close', cleanup);
        req.on('error', cleanup);
        return true;
    }

    if (route === '/api/translate/config') {
        if (req.method === 'GET') {
            const config = await readTranslateConfig();
            sendJson(res, 200, { config: publicTranslateConfig(config), ...translateCatalogs() });
            return true;
        }
        if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'Method not allowed' });
            return true;
        }
        const data = await readJsonBody<Record<string, unknown>>(req, 512 * 1024);
        const config = await updateTranslateConfig(data);
        sendJson(res, 200, { success: true, config: publicTranslateConfig(config) });
        return true;
    }

    if (route === '/api/translate/test' && req.method === 'POST') {
        sendJson(res, 200, await testTranslationProvider());
        return true;
    }

    if (route === '/api/translate/estimate' && req.method === 'POST') {
        const data = await readJsonBody<Record<string, unknown>>(req, 64 * 1024);
        sendJson(res, 200, await estimateTranslation(data.filename, data));
        return true;
    }

    if (route === '/api/translate/preview' && req.method === 'POST') {
        const data = await readJsonBody<Record<string, unknown>>(req, 64 * 1024);
        sendJson(res, 200, await previewTranslationPage(data.filename, data));
        return true;
    }

    if (route === '/api/translate/discover-glossary' && req.method === 'POST') {
        const data = await readJsonBody<Record<string, unknown>>(req, 64 * 1024);
        const result = await discoverBookGlossary(data.filename, data);
        if (data.saveToConfig === true && result.mergedCount > 0) {
            await updateTranslateConfig({ glossary: result.glossary });
        }
        sendJson(res, 200, result);
        return true;
    }

    if (route === '/api/translate/segment' && req.method === 'POST') {
        const data = await readJsonBody<{ text?: unknown; target?: unknown }>(req, 128 * 1024);
        sendJson(res, 200, await retranslateSegment(data));
        return true;
    }

    if (route === '/api/translate/tm-update' && req.method === 'POST') {
        const data = await readJsonBody<{ source?: unknown; translated?: unknown; target?: unknown }>(
            req,
            128 * 1024
        );
        sendJson(res, 200, await saveMemoryEntry(data));
        return true;
    }

    if (route === '/api/translate/queue') {
        if (req.method === 'GET') {
            sendJson(res, 200, { queue: getTranslationQueue() });
            return true;
        }
        if (req.method === 'POST') {
            const data = await readJsonBody<Record<string, unknown>>(req, 256 * 1024);
            const rawItems = Array.isArray(data.items)
                ? (data.items as Array<Record<string, unknown>>)
                : [data];
            const result = await enqueueTranslations(rawItems);
            sendJson(res, 200, { success: true, ...result });
            return true;
        }
        if (req.method === 'DELETE') {
            const id = url.searchParams.get('id');
            const queue = id ? removeQueuedTranslation(id) : clearTranslationQueue();
            sendJson(res, 200, { success: true, queue });
            return true;
        }
        sendJson(res, 405, { error: 'Method not allowed' });
        return true;
    }

    if (route === '/api/translate/queue/remove' && req.method === 'POST') {
        const data = await readJsonBody<{ id?: unknown }>(req, 16 * 1024);
        sendJson(res, 200, { success: true, queue: removeQueuedTranslation(data.id) });
        return true;
    }

    if (route === '/api/translate/queue/clear' && req.method === 'POST') {
        sendJson(res, 200, { success: true, queue: clearTranslationQueue() });
        return true;
    }

    if (route === '/api/translate/start' && req.method === 'POST') {
        const data = await readJsonBody<Record<string, unknown>>(req, 64 * 1024);
        const job = await startTranslation(data.filename, data);
        sendJson(res, 202, { success: true, job });
        return true;
    }

    if (route === '/api/translate/pause' && req.method === 'POST') {
        sendJson(res, 200, { success: true, job: pauseTranslation() });
        return true;
    }

    if (route === '/api/translate/resume' && req.method === 'POST') {
        sendJson(res, 200, { success: true, job: resumeTranslation() });
        return true;
    }

    if (route === '/api/translate/cancel' && req.method === 'POST') {
        sendJson(res, 200, { success: true, job: cancelTranslation() });
        return true;
    }

    if (route === '/api/translation-snapshot' && req.method === 'POST') {
        const data = await readJsonBody<{ filename?: string }>(req, 64 * 1024);
        if (!resolveBookPath(data.filename)) {
            throw new HttpError('فایل کتاب برای پشتیبان معتبر نیست.');
        }
        const snapshot = await createBookSnapshot(String(data.filename), 'before-translation');
        sendJson(res, 201, { success: true, snapshot });
        return true;
    }

    if (route === '/api/save-translation' && req.method === 'POST') {
        await handleTranslationSave(req, res);
        return true;
    }

    if (route === '/api/report' && req.method === 'GET') {
        const report = await buildLibraryReport();
        sendJsonCached(req, res, 200, report, { cacheControl: 'private, max-age=0, must-revalidate' });
        return true;
    }

    if (route === '/api/report/download' && req.method === 'GET') {
        const format = (url.searchParams.get('format') || 'csv').toLowerCase();
        const report = await buildLibraryReport();
        const stamp = new Date().toISOString().slice(0, 10);
        if (format === 'json') {
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Disposition': `attachment; filename="library-report-${stamp}.json"`
            });
            res.end(JSON.stringify(report, null, 2), 'utf-8');
            return true;
        }
        res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="library-report-${stamp}.csv"`
        });
        res.end('\uFEFF' + reportToCsv(report), 'utf-8');
        return true;
    }

    if (route === '/api/batch-metadata' && req.method === 'POST') {
        await handleBatchMetadata(req, res);
        return true;
    }

    if (route === '/api/batch-replace' && req.method === 'POST') {
        await handleBatchReplace(req, res);
        return true;
    }

    if (route === '/api/snapshots' && req.method === 'GET') {
        sendJson(res, 200, { snapshots: await readBackupIndex(), storage: path.dirname(BACKUP_INDEX_FILE) });
        return true;
    }

    if (route === '/api/snapshot' && req.method === 'POST') {
        sendJson(res, 201, { success: true, snapshot: await createSnapshot('manual') });
        return true;
    }

    if (route === '/api/delete-snapshot' && req.method === 'POST') {
        const data = await readJsonBody<{ id?: unknown }>(req, 64 * 1024);
        const deleted = await deleteSnapshot(data.id);
        if (!deleted) throw new HttpError('نسخهٔ پشتیبان انتخاب‌شده پیدا نشد.');
        sendJson(res, 200, { success: true, id: data.id });
        return true;
    }

    if (route === '/api/restore-snapshot' && req.method === 'POST') {
        const data = await readJsonBody<{ id?: string }>(req, 64 * 1024);
        const result = await restoreSnapshot(data.id);
        if (!result) throw new HttpError('نسخهٔ پشتیبان انتخاب‌شده پیدا نشد.');
        sendJson(res, 200, { success: true, restored: result.restored, safety: result.safety });
        return true;
    }

    if (route.startsWith('/api/')) {
        sendJson(res, 404, { error: 'مسیر API پیدا نشد.' });
        return true;
    }
    return false;
}

export const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    // Indexing parks between books while any request is being served, so the
    // app never waits on a background build.
    beginInteractiveRequest();

    try {
        if (url.pathname.startsWith('/api/')) {
            await handleApi(req, res, url);
            return;
        }

        if (url.pathname.startsWith('/data/')) {
            serveLibraryFile(req, res, url.pathname);
            return;
        }

        if (viteMiddleware) {
            viteMiddleware(req, res, () => {
                if (!res.headersSent) {
                    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end('Not Found');
                }
            });
            return;
        }

        serveStatic(req, res, DIST_DIR, url.pathname, {
            spaFallback: req.method === 'GET' && !path.extname(url.pathname)
        });
    } catch (error) {
        const status = error instanceof HttpError ? error.statusCode : 500;
        if (!(error instanceof HttpError)) console.error('Request failed:', error);
        if (!res.headersSent) {
            sendJson(res, status, {
                error:
                    error instanceof HttpError
                        ? error.message
                        : 'خطای غیرمنتظره در سرور رخ داد.'
            });
        } else {
            res.end();
        }
    } finally {
        endInteractiveRequest();
    }
});

for (const folder of [LIBRARY_DIR, STORAGE_DIR, BACKUP_DIR]) {
    try {
        fs.mkdirSync(folder, { recursive: true });
    } catch {
        console.warn(`ساخت پوشه ممکن نشد: ${folder}`);
    }
}

function openInChrome(target: string): void {
    if (process.env.APP_NO_BROWSER || process.env.NODE_ENV === 'development') return;
    if (process.platform === 'win32') {
        exec(`start chrome "${target}"`, (error) => {
            if (error) exec(`start "" "${target}"`);
        });
    } else if (process.platform === 'darwin') {
        exec(`open -a "Google Chrome" "${target}"`, (error) => {
            if (error) exec(`open "${target}"`);
        });
    } else {
        exec(`google-chrome "${target}"`, (error) => {
            if (error) exec(`xdg-open "${target}"`);
        });
    }
}

function listen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const onListening = () => {
            const address = server.address();
            const actualPort = typeof address === 'object' && address ? address.port : port;
            const url = `http://localhost:${actualPort}/`;
            console.log(`\n  کتابخانه فارسی MD — سرور فعال است\n  ${url}\n  کتابخانه: ${LIBRARY_DIR}\n`);
            if (process.env.NODE_ENV !== 'development') openInChrome(url);

            // Warm the metadata cache, then build the content index in the
            // background so the first full-text search is already fast. Both
            // steps are optional: the app works normally while they run.
            if (process.env.SEARCH_INDEX !== 'off') {
                const timer = setTimeout(() => {
                    void getLibrarySnapshot()
                        .then(() => ensureSearchIndex())
                        .catch(() => {});
                }, 20000);
                timer.unref?.();
            }
            resolve(true);
        };

        const onError = (error: NodeJS.ErrnoException) => {
            server.removeListener('listening', onListening);
            if (error.code === 'EADDRINUSE' && !process.env.PORT && port < 65535) {
                console.warn(`پورت ${port} مشغول است؛ تلاش با پورت ${port + 1}…`);
                void listen(port + 1).then(resolve);
                return;
            }
            console.error(`راه‌اندازی سرور ناموفق بود: ${error.message}`);
            process.exitCode = 1;
            resolve(false);
        };

        server.once('listening', onListening);
        server.once('error', onError);
        if (process.env.HOST) server.listen(port, process.env.HOST);
        else server.listen(port);
    });
}

let viteMiddleware:
    | ((req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void)
    | null = null;

async function startServer(): Promise<boolean> {
    if (process.env.NODE_ENV === 'development') {
        const { createServer: createViteServer } = await import('vite');
        const vite = await createViteServer({
            server: { middlewareMode: true, hmr: false },
            appType: 'spa'
        });
        viteMiddleware = vite.middlewares;
    }
    return listen(PORT);
}

void PANEL_IDS;
void APP_ROOT;
export const serverReady = startServer();
