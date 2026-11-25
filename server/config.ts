import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const bundledAtRoot =
    fs.existsSync(path.join(moduleDir, 'server.mjs')) ||
    fs.existsSync(path.join(moduleDir, 'package.json'));

export const APP_ROOT = bundledAtRoot ? moduleDir : path.resolve(moduleDir, '..');
export const DIST_DIR = path.join(APP_ROOT, 'dist');

const defaultStorageDir = process.env.APP_STORAGE_DIR
    ? path.resolve(process.env.APP_STORAGE_DIR)
    : path.join(APP_ROOT, 'storage');
const defaultBackupDir = process.env.APP_BACKUP_DIR
    ? path.resolve(process.env.APP_BACKUP_DIR)
    : path.join(APP_ROOT, 'backups');
const localLibrary = path.join(APP_ROOT, 'data');
const siblingLibrary = path.resolve(APP_ROOT, '..', 'data');
const defaultLibraryDir = process.env.LIBRARY_DIR
    ? path.resolve(process.env.LIBRARY_DIR)
    : fs.existsSync(localLibrary)
        ? localLibrary
        : siblingLibrary;

/**
 * Home of the data-location pointer. It always lives next to the current
 * storage folder (the app folder, or Electron's userData) so it stays put
 * even when the data folders themselves are moved elsewhere.
 */
export const CONFIG_HOME = path.dirname(defaultStorageDir);
export const LOCATION_FILE = path.join(CONFIG_HOME, 'data-location.json');

function readSavedDataRoot(): string | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(LOCATION_FILE, 'utf8')) as { root?: unknown };
        if (!parsed || typeof parsed.root !== 'string' || !path.isAbsolute(parsed.root)) return null;
        const root = path.resolve(parsed.root);
        // A removed drive or an unplugged folder must not break startup.
        return fs.existsSync(root) ? root : null;
    } catch {
        return null;
    }
}

const savedRoot = readSavedDataRoot();

/** Folder that currently holds `data`, `storage` and `backups`. */
export const DATA_ROOT = savedRoot ?? CONFIG_HOME;
/** Folder the app uses when no custom data folder was chosen. */
export const DEFAULT_DATA_ROOT = CONFIG_HOME;

export const LIBRARY_DIR = savedRoot ? path.join(savedRoot, 'data') : defaultLibraryDir;
export const STORAGE_DIR = savedRoot ? path.join(savedRoot, 'storage') : defaultStorageDir;
export const BACKUP_DIR = savedRoot ? path.join(savedRoot, 'backups') : defaultBackupDir;
export const SETTINGS_FILE = path.join(STORAGE_DIR, 'settings.json');
export const BACKUP_INDEX_FILE = path.join(BACKUP_DIR, 'index.json');

export const PORT = Number(process.env.PORT) || 3000;
export const MAX_BACKUPS = 50;
export const CRITICAL_FIELDS = ['نام کتاب', 'نویسنده'] as const;
export const PANEL_IDS = ['filter', 'search', 'settings', 'report', 'batch', 'backups'] as const;
export type PanelId = (typeof PANEL_IDS)[number];
