import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { LIBRARY_DIR } from './config.js';

const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm'
};

const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.mjs', '.json', '.md', '.txt', '.svg', '.woff', '.woff2']);

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    res.end(body, 'utf-8');
}

interface CachedJson {
    etag: string;
    json: Buffer;
    gzip: Buffer | null;
}

const jsonResponseCache = new Map<string, CachedJson>();
const MAX_JSON_CACHE_ENTRIES = 4;

/**
 * Sends JSON with an ETag, a 304 fast path and gzip compression. Library and
 * report payloads are several megabytes for a large library, so this is the
 * difference between a slow page and an instant one.
 */
export function sendJsonCached(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    payload: unknown,
    options: { etag?: string; cacheControl?: string } = {}
): void {
    const body = JSON.stringify(payload);
    const etag = options.etag || `W/"${crypto.createHash('sha1').update(body).digest('base64url')}"`;

    if (status === 200 && req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': options.cacheControl || 'no-cache' });
        res.end();
        return;
    }

    let cached = jsonResponseCache.get(etag);
    if (!cached) {
        const json = Buffer.from(body, 'utf-8');
        cached = { etag, json, gzip: null };
        if (jsonResponseCache.size >= MAX_JSON_CACHE_ENTRIES) {
            const oldest = jsonResponseCache.keys().next().value;
            if (oldest) jsonResponseCache.delete(oldest);
        }
        jsonResponseCache.set(etag, cached);
    }

    const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    const headers: Record<string, string | number> = {
        'Content-Type': 'application/json; charset=utf-8',
        ETag: etag,
        'Cache-Control': options.cacheControl || 'no-store',
        Vary: 'Accept-Encoding'
    };

    if (acceptsGzip && cached.json.length > 1024) {
        if (!cached.gzip) {
            cached.gzip = zlib.gzipSync(cached.json, { level: zlib.constants.Z_BEST_SPEED });
        }
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = cached.gzip.length;
        res.writeHead(status, headers);
        res.end(cached.gzip);
        return;
    }

    headers['Content-Length'] = cached.json.length;
    res.writeHead(status, headers);
    res.end(cached.json);
}

export class HttpError extends Error {
    statusCode: number;

    constructor(message: string, statusCode = 400) {
        super(message);
        this.statusCode = statusCode;
    }
}

export function readJsonBody<T = Record<string, unknown>>(req: IncomingMessage, limit: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge = false;

        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) tooLarge = true;
            else if (!tooLarge) chunks.push(chunk);
        });
        req.on('end', () => {
            if (tooLarge) return reject(new HttpError('Payload too large', 413));
            try {
                resolve((chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) as T);
            } catch {
                reject(new HttpError('Invalid JSON', 400));
            }
        });
        req.on('error', reject);
    });
}

interface StaticOptions {
    spaFallback?: boolean;
}

export function serveStatic(
    req: IncomingMessage,
    res: ServerResponse,
    rootDir: string,
    requestPath: string,
    options: StaticOptions = {}
): void {
    let decoded: string;
    try {
        decoded = decodeURIComponent(requestPath);
    } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
    }

    if (decoded === '/') decoded = '/index.html';
    const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
    const absPath = path.join(rootDir, normalized);

    if (!absPath.startsWith(rootDir)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
    }

    fs.stat(absPath, (error, stat) => {
        if (error || stat.isDirectory()) {
            if (options.spaFallback) {
                const indexFile = path.join(rootDir, 'index.html');
                fs.stat(indexFile, (indexError, indexStat) => {
                    if (indexError || !indexStat.isFile()) {
                        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                        res.end('Not Found');
                        return;
                    }
                    sendFile(req, res, indexFile, indexStat, '.html');
                });
                return;
            }
            res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h1>404 — یافت نشد</h1>');
            return;
        }
        sendFile(req, res, absPath, stat, path.extname(absPath).toLowerCase());
    });
}

function sendFile(
    req: IncomingMessage,
    res: ServerResponse,
    absPath: string,
    stat: fs.Stats,
    extension: string
): void {
    const etag = `"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
    if (req.headers['if-none-match'] === etag) {
        res.writeHead(304);
        res.end();
        return;
    }

    let contentType = MIME_TYPES[extension] || 'application/octet-stream';
    if (COMPRESSIBLE.has(extension)) contentType += '; charset=utf-8';
    if (extension === '.woff2') contentType = 'font/woff2';

    const headers: Record<string, string | number> = {
        'Content-Type': contentType,
        ETag: etag,
        'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=3600'
    };

    const stream = fs.createReadStream(absPath);
    stream.on('error', () => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
    });

    const acceptEncoding = String(req.headers['accept-encoding'] || '');
    if (COMPRESSIBLE.has(extension) && stat.size > 1024 && /\bgzip\b/.test(acceptEncoding)) {
        headers['Content-Encoding'] = 'gzip';
        headers.Vary = 'Accept-Encoding';
        res.writeHead(200, headers);
        stream.pipe(zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED })).pipe(res);
    } else {
        headers['Content-Length'] = stat.size;
        res.writeHead(200, headers);
        stream.pipe(res);
    }
}

export function serveLibraryFile(
    req: IncomingMessage,
    res: ServerResponse,
    requestPath: string
): void {
    const relative = requestPath.replace(/^\/data\/?/, '');
    if (!relative) {
        sendJson(res, 404, { error: 'فایل مشخص نشده است.' });
        return;
    }
    const decoded = decodeURIComponent(relative);
    const segments = decoded.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        sendJson(res, 400, { error: 'مسیر فایل معتبر نیست.' });
        return;
    }
    const absPath = path.resolve(LIBRARY_DIR, ...segments);
    if (!absPath.startsWith(LIBRARY_DIR + path.sep)) {
        sendJson(res, 403, { error: 'دسترسی به این مسیر مجاز نیست.' });
        return;
    }
    fs.stat(absPath, (error, stat) => {
        if (error || !stat.isFile()) {
            sendJson(res, 404, { error: 'فایل کتاب پیدا نشد.' });
            return;
        }
        sendFile(req, res, absPath, stat, path.extname(absPath).toLowerCase());
    });
}
