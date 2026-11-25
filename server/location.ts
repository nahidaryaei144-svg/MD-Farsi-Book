import fs from 'node:fs';
import path from 'node:path';
import {
    BACKUP_DIR,
    CONFIG_HOME,
    DATA_ROOT,
    DEFAULT_DATA_ROOT,
    LIBRARY_DIR,
    LOCATION_FILE,
    STORAGE_DIR
} from './config.js';

export interface DataLocationInfo {
    root: string;
    defaultRoot: string;
    libraryDir: string;
    storageDir: string;
    backupDir: string;
    configFile: string;
}

export interface RelocateResult {
    root: string;
    moved: string[];
    untouched: boolean;
    requiresRestart: true;
}

export function currentDataLocation(): DataLocationInfo {
    return {
        root: DATA_ROOT,
        defaultRoot: DEFAULT_DATA_ROOT,
        libraryDir: LIBRARY_DIR,
        storageDir: STORAGE_DIR,
        backupDir: BACKUP_DIR,
        configFile: LOCATION_FILE
    };
}

function isInside(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Accepts an absolute folder path and rejects the current data folders. */
export function validateTargetRoot(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim().replace(/^"(.*)"$/, '$1').trim();
    if (!trimmed || trimmed.length > 400 || !path.isAbsolute(trimmed)) return null;

    const resolved = path.resolve(trimmed);
    if (resolved === path.parse(resolved).root) return null;
    if (resolved === DATA_ROOT || resolved === LIBRARY_DIR) return null;
    if (isInside(LIBRARY_DIR, resolved)) return null;
    if (isInside(STORAGE_DIR, resolved) || isInside(BACKUP_DIR, resolved)) return null;
    return resolved;
}

async function statOrNull(target: string): Promise<fs.Stats | null> {
    try {
        return await fs.promises.stat(target);
    } catch {
        return null;
    }
}

async function copyDirectoryTree(source: string, destination: string): Promise<void> {
    await fs.promises.mkdir(destination, { recursive: true });
    const entries = await fs.promises.readdir(source, { withFileTypes: true });
    for (const entry of entries) {
        const from = path.join(source, entry.name);
        const to = path.join(destination, entry.name);
        if (entry.isDirectory()) await copyDirectoryTree(from, to);
        else if (entry.isFile()) await fs.promises.copyFile(from, to);
    }
}

async function assertMovable(from: string, to: string): Promise<void> {
    if (path.resolve(from) === path.resolve(to)) return;
    const source = await statOrNull(from);
    if (!source) return;
    if (!source.isDirectory()) throw new Error(`مسیر فعلی یک پوشه نیست: ${from}`);
    const target = await statOrNull(to);
    if (!target) return;
    if (!target.isDirectory()) throw new Error(`در مقصد فایلی هم‌نام وجود دارد: ${to}`);
    const entries = await fs.promises.readdir(to);
    if (entries.length) {
        throw new Error(
            `پوشهٔ مقصد از قبل پر است: ${to} — پوشهٔ خالی یا تازه انتخاب کنید تا داده‌ها روی هم نیفتند.`
        );
    }
}

async function moveDirectory(from: string, to: string): Promise<void> {
    if (path.resolve(from) === path.resolve(to)) return;
    const source = await statOrNull(from);
    if (!source || !source.isDirectory()) return;

    await fs.promises.mkdir(path.dirname(to), { recursive: true });
    const target = await statOrNull(to);
    if (target) await fs.promises.rm(to, { recursive: true, force: true });

    try {
        await fs.promises.rename(from, to);
        return;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    }

    // Different drive: copy everything first, then drop the old folder.
    await copyDirectoryTree(from, to);
    await fs.promises.rm(from, { recursive: true, force: true });
}

async function writeLocationPointer(root: string): Promise<void> {
    await fs.promises.mkdir(CONFIG_HOME, { recursive: true });
    const temp = `${LOCATION_FILE}.${process.pid}.tmp`;
    await fs.promises.writeFile(
        temp,
        JSON.stringify({ root, updatedAt: new Date().toISOString() }, null, 2) + '\n',
        'utf8'
    );
    await fs.promises.rename(temp, LOCATION_FILE);
}

export async function relocateDataRoot(root: string, move: boolean): Promise<RelocateResult> {
    const pairs: [string, string][] = [
        [LIBRARY_DIR, path.join(root, 'data')],
        [STORAGE_DIR, path.join(root, 'storage')],
        [BACKUP_DIR, path.join(root, 'backups')]
    ];

    await fs.promises.mkdir(root, { recursive: true });

    if (move) {
        // Check every destination first so a conflict cannot leave data half moved.
        for (const [from, to] of pairs) await assertMovable(from, to);
        for (const [from, to] of pairs) await moveDirectory(from, to);
    }

    await fs.promises.mkdir(path.join(root, 'data'), { recursive: true });
    await writeLocationPointer(root);

    return {
        root,
        moved: move ? pairs.map(([, to]) => to) : [],
        untouched: !move,
        requiresRestart: true
    };
}
