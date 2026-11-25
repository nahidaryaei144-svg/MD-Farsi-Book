import fs from 'node:fs';
import path from 'node:path';
import { MAX_BACKUPS, BACKUP_DIR, BACKUP_INDEX_FILE, LIBRARY_DIR } from './config.js';
import { listMarkdownFiles, resolveBookPath } from './library.js';

export interface SnapshotEntry {
    id: string;
    createdAt: string;
    reason: string;
    books: number;
    scope?: 'library' | 'book';
    filename?: string;
}

async function copyDirectoryTree(source: string, destination: string): Promise<void> {
    await fs.promises.mkdir(destination, { recursive: true });
    const entries = await fs.promises.readdir(source, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const from = path.join(source, entry.name);
        const to = path.join(destination, entry.name);
        if (entry.isDirectory()) await copyDirectoryTree(from, to);
        else if (entry.isFile()) await fs.promises.copyFile(from, to);
    }
}

export async function readBackupIndex(): Promise<SnapshotEntry[]> {
    try {
        const contents = await fs.promises.readFile(BACKUP_INDEX_FILE, 'utf8');
        const data = JSON.parse(contents);
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

async function writeBackupIndex(list: SnapshotEntry[]): Promise<void> {
    await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
    await fs.promises.writeFile(BACKUP_INDEX_FILE, JSON.stringify(list, null, 2) + '\n', 'utf8');
}

function snapshotId(date: Date): string {
    return date.toISOString().replace(/[:.]/g, '-');
}

export async function createSnapshot(reason = 'manual'): Promise<SnapshotEntry> {
    const createdAt = new Date().toISOString();
    const id = snapshotId(new Date(createdAt));
    const target = path.join(BACKUP_DIR, id);
    await copyDirectoryTree(LIBRARY_DIR, target);
    const books = await listMarkdownFiles(target).catch(() => []);
    const entry: SnapshotEntry = { id, createdAt, reason, books: books.length, scope: 'library' };
    const index = await readBackupIndex();
    await writeBackupIndex([entry, ...index.filter((item) => item && item.id !== id)].slice(0, MAX_BACKUPS));
    return entry;
}

export async function createBookSnapshot(filename: string, reason: string): Promise<SnapshotEntry> {
    const filePath = resolveBookPath(filename);
    if (!filePath) throw new Error('Invalid book path');
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) throw new Error('Book file is not a regular file');

    const createdAt = new Date().toISOString();
    const id = snapshotId(new Date(createdAt));
    const target = path.join(BACKUP_DIR, id);
    const relativePath = path.relative(LIBRARY_DIR, filePath);
    const snapshotPath = path.resolve(target, relativePath);
    if (!snapshotPath.startsWith(target + path.sep)) throw new Error('Invalid snapshot path');
    await fs.promises.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fs.promises.copyFile(filePath, snapshotPath);

    const entry: SnapshotEntry = {
        id,
        createdAt,
        reason,
        books: 1,
        scope: 'book',
        filename
    };
    const index = await readBackupIndex();
    await writeBackupIndex([entry, ...index.filter((item) => item && item.id !== id)].slice(0, MAX_BACKUPS));
    return entry;
}

export async function deleteSnapshot(id: unknown): Promise<boolean> {
    if (typeof id !== 'string' || !/^[0-9A-Za-z-]{1,60}$/.test(id)) return false;
    const index = await readBackupIndex();
    if (!index.some((item) => item && item.id === id)) return false;

    const backupRoot = path.resolve(BACKUP_DIR);
    const target = path.resolve(backupRoot, id);
    if (!target.startsWith(backupRoot + path.sep)) return false;

    await fs.promises.rm(target, { recursive: true, force: true });
    await writeBackupIndex(index.filter((item) => item && item.id !== id));
    return true;
}

export async function restoreSnapshot(
    id: unknown
): Promise<{ restored: number; safety: string; filename: string | null } | null> {
    if (typeof id !== 'string' || !/^[0-9A-Za-z-]{1,60}$/.test(id)) return null;
    const index = await readBackupIndex();
    const snapshot = index.find((item) => item && item.id === id);
    if (!snapshot) return null;

    const source = path.join(BACKUP_DIR, id);
    let stat: fs.Stats;
    try {
        stat = await fs.promises.stat(source);
    } catch {
        return null;
    }
    if (!stat.isDirectory()) return null;

    const bookSnapshot = snapshot.scope === 'book' && typeof snapshot.filename === 'string';
    if (bookSnapshot && !resolveBookPath(snapshot.filename)) return null;

    if (bookSnapshot) {
        const expectedFile = path.resolve(source, ...snapshot.filename!.split('/'));
        if (!expectedFile.startsWith(source + path.sep)) return null;
        try {
            if (!(await fs.promises.stat(expectedFile)).isFile()) return null;
        } catch {
            return null;
        }
    }

    const safety = bookSnapshot
        ? await createBookSnapshot(snapshot.filename!, 'before-restore')
        : await createSnapshot('before-restore');

    const books = bookSnapshot ? [snapshot.filename!] : await listMarkdownFiles(source);
    let restored = 0;
    for (const relative of books) {
        const from = path.resolve(source, ...relative.split('/'));
        const to = path.resolve(LIBRARY_DIR, ...relative.split('/'));
        if (!from.startsWith(source + path.sep) || !to.startsWith(LIBRARY_DIR + path.sep)) continue;
        await fs.promises.mkdir(path.dirname(to), { recursive: true });
        await fs.promises.copyFile(from, to);
        restored += 1;
    }
    return { restored, safety: safety.id, filename: bookSnapshot ? snapshot.filename! : null };
}
