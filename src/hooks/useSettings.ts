import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { ThemeName } from '../types';

export const FONT_OPTIONS = [
    { value: 'Vazirmatn', label: 'وزیرمتن', stack: "'Vazirmatn Variable', 'Vazirmatn', sans-serif" },
    { value: 'Tahoma', label: 'تاهوما', stack: 'Tahoma, sans-serif' },
    { value: 'Segoe UI', label: 'سگوئی', stack: "'Segoe UI', sans-serif" }
] as const;

export const THEME_OPTIONS: { value: ThemeName; label: string; hint: string }[] = [
    { value: 'dark', label: 'تاریک', hint: 'شبانه و کم‌نور' },
    { value: 'light', label: 'روشن', hint: 'روزانه و شفاف' },
    { value: 'sepia', label: 'مطالعه', hint: 'کاغذی و گرم' },
    { value: 'glass', label: 'شیشه‌ای', hint: 'رنگی و شفاف' }
];

const STORAGE_KEY = 'md-library:preferences';

interface StoredPreferences {
    theme: ThemeName;
    font: string;
    zoom: number;
    cornerRadius: number;
}

const defaults: StoredPreferences = {
    theme: 'dark',
    font: 'Vazirmatn',
    zoom: 100,
    cornerRadius: 22
};

function readPreferences(): StoredPreferences {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return defaults;
        const parsed = JSON.parse(raw) as Partial<StoredPreferences>;
        return {
            theme: THEME_OPTIONS.some((option) => option.value === parsed.theme)
                ? (parsed.theme as ThemeName)
                : defaults.theme,
            font: FONT_OPTIONS.some((option) => option.value === parsed.font)
                ? String(parsed.font)
                : defaults.font,
            zoom: Number.isFinite(Number(parsed.zoom))
                ? Math.min(140, Math.max(80, Number(parsed.zoom)))
                : defaults.zoom,
            cornerRadius: Number.isFinite(Number(parsed.cornerRadius))
                ? Math.min(36, Math.max(0, Number(parsed.cornerRadius)))
                : defaults.cornerRadius
        };
    } catch {
        return defaults;
    }
}

export function useSettings() {
    const [preferences, setPreferences] = useState<StoredPreferences>(readPreferences);
    const [ready, setReady] = useState(false);
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    }, [preferences]);

    useEffect(() => {
        const root = document.documentElement;
        root.dataset.theme = preferences.theme;
        root.style.fontSize = `${preferences.zoom}%`;
        root.style.setProperty('--panel-radius', `${preferences.cornerRadius}px`);
        const font = FONT_OPTIONS.find((option) => option.value === preferences.font) || FONT_OPTIONS[0];
        root.style.setProperty('--app-font', font.stack);
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) {
            meta.setAttribute(
                'content',
                preferences.theme === 'dark'
                    ? '#060812'
                    : preferences.theme === 'light'
                        ? '#f4f6fc'
                        : preferences.theme === 'sepia'
                            ? '#f5efe2'
                            : '#4f46e5'
            );
        }
    }, [preferences]);

    useEffect(() => {
        let active = true;
        api.settings()
            .then((settings) => {
                if (!active) return;
                const savedRadius = Number(settings.panelStyle?.cornerRadius);
                if (Number.isFinite(savedRadius) && !localStorage.getItem(STORAGE_KEY)) {
                    setPreferences((current) => ({ ...current, cornerRadius: savedRadius }));
                }
            })
            .catch(() => {})
            .finally(() => {
                if (active) setReady(true);
            });
        return () => {
            active = false;
        };
    }, []);

    const setTheme = useCallback((theme: ThemeName) => {
        setPreferences((current) => ({ ...current, theme }));
    }, []);

    const setFont = useCallback((font: string) => {
        setPreferences((current) => ({ ...current, font }));
    }, []);

    const setZoom = useCallback((zoom: number) => {
        setPreferences((current) => ({
            ...current,
            zoom: Math.min(140, Math.max(80, Math.round(zoom)))
        }));
    }, []);

    const setCornerRadius = useCallback((cornerRadius: number) => {
        const value = Math.min(36, Math.max(0, Math.round(cornerRadius)));
        setPreferences((current) => ({ ...current, cornerRadius: value }));
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
            api.savePanelStyle(value).catch(() => {});
        }, 350);
    }, []);

    const cycleTheme = useCallback(() => {
        setPreferences((current) => {
            const index = THEME_OPTIONS.findIndex((option) => option.value === current.theme);
            const next = THEME_OPTIONS[(index + 1) % THEME_OPTIONS.length];
            return { ...current, theme: next.value };
        });
    }, []);

    return {
        ...preferences,
        ready,
        setTheme,
        setFont,
        setZoom,
        setCornerRadius,
        cycleTheme
    };
}
