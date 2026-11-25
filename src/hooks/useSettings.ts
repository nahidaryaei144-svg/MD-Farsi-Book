import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type {
    BilingualBoxStyle,
    BilingualDisplayMode,
    BilingualFontWeight,
    BilingualSettings,
    BilingualSideStyle,
    ThemeName
} from '../types';

export const FONT_OPTIONS = [
    { value: 'Vazirmatn', label: 'وزیرمتن', stack: "'Vazirmatn Variable', 'Vazirmatn', sans-serif" },
    { value: 'Tahoma', label: 'تاهوما', stack: 'Tahoma, sans-serif' },
    { value: 'Segoe UI', label: 'سگوئی', stack: "'Segoe UI', sans-serif" }
] as const;

export const BILINGUAL_FONT_OPTIONS = [
    { value: 'inherit', label: 'فونت پیش‌فرض کتاب', stack: 'inherit' },
    { value: 'Vazirmatn', label: 'وزیرمتن', stack: "'Vazirmatn Variable', 'Vazirmatn', sans-serif" },
    { value: 'Traditional Arabic', label: 'Traditional Arabic / نسخ', stack: "'Traditional Arabic', 'Amiri', 'Scheherazade New', Tahoma, serif" },
    { value: 'Tahoma', label: 'تاهوما', stack: 'Tahoma, sans-serif' },
    { value: 'Segoe UI', label: 'سگوئی', stack: "'Segoe UI', sans-serif" }
] as const;

export const BILINGUAL_BOX_OPTIONS: { value: BilingualBoxStyle; label: string }[] = [
    { value: 'none', label: 'بدون کادر' },
    { value: 'border', label: 'خط کناری' },
    { value: 'subtle', label: 'پس‌زمینهٔ ملایم' },
    { value: 'card', label: 'کارت کامل' }
];

export const BILINGUAL_DISPLAY_OPTIONS: { value: BilingualDisplayMode; label: string }[] = [
    { value: 'both', label: 'دوزبانه (هر دو)' },
    { value: 'translated', label: 'فقط ترجمه' },
    { value: 'original', label: 'فقط زبان اصلی' }
];

export const DEFAULT_BILINGUAL_SETTINGS: BilingualSettings = {
    display: 'both',
    original: {
        color: '',
        fontSize: 92,
        weight: '400',
        opacity: 84,
        font: 'inherit',
        italic: false,
        box: 'border'
    },
    translated: {
        color: '',
        fontSize: 104,
        weight: '500',
        opacity: 100,
        font: 'inherit',
        italic: false,
        box: 'subtle'
    }
};

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
    bilingual: BilingualSettings;
}

const defaults: StoredPreferences = {
    theme: 'dark',
    font: 'Vazirmatn',
    zoom: 100,
    cornerRadius: 22,
    bilingual: DEFAULT_BILINGUAL_SETTINGS
};

function normalizeSideStyle(raw: unknown, fallback: BilingualSideStyle): BilingualSideStyle {
    const data = raw && typeof raw === 'object' ? (raw as Partial<BilingualSideStyle>) : {};
    const validColor = typeof data.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(data.color.trim())
        ? data.color.trim()
        : '';
    const fontSize = Number(data.fontSize);
    const opacity = Number(data.opacity);
    const weight: BilingualFontWeight =
        data.weight === '400' || data.weight === '500' || data.weight === '700'
            ? data.weight
            : fallback.weight;
    const box: BilingualBoxStyle =
        data.box === 'none' || data.box === 'subtle' || data.box === 'border' || data.box === 'card'
            ? data.box
            : fallback.box;
    const font = BILINGUAL_FONT_OPTIONS.some((item) => item.value === data.font)
        ? String(data.font)
        : fallback.font;
    return {
        color: validColor,
        fontSize: Number.isFinite(fontSize) ? Math.min(135, Math.max(75, Math.round(fontSize))) : fallback.fontSize,
        weight,
        opacity: Number.isFinite(opacity) ? Math.min(100, Math.max(50, Math.round(opacity))) : fallback.opacity,
        font,
        italic: typeof data.italic === 'boolean' ? data.italic : fallback.italic,
        box
    };
}

function normalizeBilingual(raw: unknown): BilingualSettings {
    const data = raw && typeof raw === 'object' ? (raw as Partial<BilingualSettings>) : {};
    const display: BilingualDisplayMode =
        data.display === 'both' || data.display === 'translated' || data.display === 'original'
            ? data.display
            : DEFAULT_BILINGUAL_SETTINGS.display;
    return {
        display,
        original: normalizeSideStyle(data.original, DEFAULT_BILINGUAL_SETTINGS.original),
        translated: normalizeSideStyle(data.translated, DEFAULT_BILINGUAL_SETTINGS.translated)
    };
}

function applyBilingualSideVars(root: HTMLElement, role: 'orig' | 'trans', side: BilingualSideStyle): void {
    const tint = side.color || (role === 'orig' ? 'var(--muted)' : 'var(--acc)');
    const font = BILINGUAL_FONT_OPTIONS.find((item) => item.value === side.font) || BILINGUAL_FONT_OPTIONS[0];
    root.style.setProperty(`--bi-${role}-color`, side.color || 'inherit');
    root.style.setProperty(`--bi-${role}-size`, `${side.fontSize}%`);
    root.style.setProperty(`--bi-${role}-weight`, side.weight);
    root.style.setProperty(`--bi-${role}-opacity`, (side.opacity / 100).toFixed(2));
    root.style.setProperty(`--bi-${role}-font`, font.stack);
    root.style.setProperty(`--bi-${role}-style`, side.italic ? 'italic' : 'normal');

    if (side.box === 'none') {
        root.style.setProperty(`--bi-${role}-bg`, 'transparent');
        root.style.setProperty(`--bi-${role}-border`, '0px solid transparent');
        root.style.setProperty(`--bi-${role}-border-start`, '0px solid transparent');
        root.style.setProperty(`--bi-${role}-pad`, '0px');
        root.style.setProperty(`--bi-${role}-radius`, '0px');
    } else if (side.box === 'border') {
        root.style.setProperty(`--bi-${role}-bg`, `color-mix(in srgb, ${tint} 5%, transparent)`);
        root.style.setProperty(`--bi-${role}-border`, '0px solid transparent');
        root.style.setProperty(`--bi-${role}-border-start`, `3px solid ${tint}`);
        root.style.setProperty(`--bi-${role}-pad`, '4px 12px');
        root.style.setProperty(`--bi-${role}-radius`, '6px');
    } else if (side.box === 'subtle') {
        root.style.setProperty(`--bi-${role}-bg`, `color-mix(in srgb, ${tint} 8%, transparent)`);
        root.style.setProperty(`--bi-${role}-border`, '0px solid transparent');
        root.style.setProperty(`--bi-${role}-border-start`, '0px solid transparent');
        root.style.setProperty(`--bi-${role}-pad`, '6px 12px');
        root.style.setProperty(`--bi-${role}-radius`, '10px');
    } else {
        root.style.setProperty(`--bi-${role}-bg`, `color-mix(in srgb, ${tint} 9%, var(--surface))`);
        root.style.setProperty(`--bi-${role}-border`, `1px solid color-mix(in srgb, ${tint} 32%, var(--border))`);
        root.style.setProperty(`--bi-${role}-border-start`, `1px solid color-mix(in srgb, ${tint} 32%, var(--border))`);
        root.style.setProperty(`--bi-${role}-pad`, '8px 13px');
        root.style.setProperty(`--bi-${role}-radius`, '11px');
    }
}

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
                : defaults.cornerRadius,
            bilingual: normalizeBilingual(parsed.bilingual)
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
        root.dataset.bilingualDisplay = preferences.bilingual.display;
        root.style.fontSize = `${preferences.zoom}%`;
        root.style.setProperty('--panel-radius', `${preferences.cornerRadius}px`);
        const font = FONT_OPTIONS.find((option) => option.value === preferences.font) || FONT_OPTIONS[0];
        root.style.setProperty('--app-font', font.stack);
        applyBilingualSideVars(root, 'orig', preferences.bilingual.original);
        applyBilingualSideVars(root, 'trans', preferences.bilingual.translated);
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

    const setBilingual = useCallback((bilingual: BilingualSettings) => {
        setPreferences((current) => ({
            ...current,
            bilingual: normalizeBilingual(bilingual)
        }));
    }, []);

    const resetBilingual = useCallback(() => {
        setPreferences((current) => ({
            ...current,
            bilingual: DEFAULT_BILINGUAL_SETTINGS
        }));
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
        setBilingual,
        resetBilingual,
        cycleTheme
    };
}
