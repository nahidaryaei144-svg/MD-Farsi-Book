import fs from 'node:fs';
import path from 'node:path';
import { PANEL_IDS, SETTINGS_FILE, STORAGE_DIR, type PanelId } from './config.js';

export interface PanelLayout {
    left: number;
    top: number;
    width: number;
    height: number;
    maximized: boolean;
}

export interface AppSettings {
    panelLayouts: Partial<Record<PanelId, PanelLayout>>;
    panelStyle: { cornerRadius?: number };
    panels?: Partial<Record<PanelId, { open: boolean; minimized: boolean }>>;
}

let writeQueue: Promise<void> = Promise.resolve();

export async function readAppSettings(): Promise<AppSettings> {
    try {
        const contents = await fs.promises.readFile(SETTINGS_FILE, 'utf8');
        const settings = JSON.parse(contents);
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
            return { panelLayouts: {}, panelStyle: {} };
        }
        return {
            panelLayouts:
                settings.panelLayouts && typeof settings.panelLayouts === 'object'
                    ? settings.panelLayouts
                    : {},
            panelStyle:
                settings.panelStyle && typeof settings.panelStyle === 'object'
                    ? settings.panelStyle
                    : {},
            panels:
                settings.panels && typeof settings.panels === 'object' ? settings.panels : {}
        };
    } catch {
        return { panelLayouts: {}, panelStyle: {} };
    }
}

export function normalizePanelLayout(layout: unknown): PanelLayout | null {
    if (!layout || typeof layout !== 'object' || Array.isArray(layout)) return null;
    const source = layout as Record<string, unknown>;
    const values = ['left', 'top', 'width', 'height'].map((key) => Number(source[key]));
    if (!values.every(Number.isFinite)) return null;
    const [left, top, width, height] = values;
    if (
        Math.abs(left) > 10000 ||
        Math.abs(top) > 10000 ||
        width < 280 ||
        width > 4000 ||
        height < 240 ||
        height > 4000
    ) {
        return null;
    }
    return {
        left: Math.round(left),
        top: Math.round(top),
        width: Math.round(width),
        height: Math.round(height),
        maximized: source.maximized === true
    };
}

export function updateSettings(mutator: (settings: AppSettings) => void): Promise<AppSettings> {
    writeQueue = writeQueue
        .catch(() => {})
        .then(async () => {
            const settings = await readAppSettings();
            mutator(settings);
            await fs.promises.mkdir(STORAGE_DIR, { recursive: true });
            const tempFile = `${SETTINGS_FILE}.${process.pid}.tmp`;
            await fs.promises.writeFile(tempFile, JSON.stringify(settings, null, 2) + '\n', 'utf8');
            await fs.promises.rename(tempFile, SETTINGS_FILE);
        });
    return writeQueue.then(readAppSettings);
}

export function isPanelId(value: unknown): value is PanelId {
    return typeof value === 'string' && (PANEL_IDS as readonly string[]).includes(value);
}

export function settingsFilePath(): string {
    return path.resolve(SETTINGS_FILE);
}
