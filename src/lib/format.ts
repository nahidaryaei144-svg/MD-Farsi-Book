const numberFormatter = new Intl.NumberFormat('fa-IR');

export function faNumber(value: number | string): string {
    const numeric = typeof value === 'string' ? Number(value.replace(/[^\d.-]/g, '')) : value;
    if (!Number.isFinite(numeric)) return String(value);
    return numberFormatter.format(numeric);
}

export function faDate(value: string | Date): string {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('fa-IR', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    }).format(date);
}

export function faDateTime(value: string | Date): string {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('fa-IR', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    }).format(date);
}

export function faBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '۰ بایت';
    const units = ['بایت', 'کیلوبایت', 'مگابایت', 'گیگابایت'];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, exponent);
    return `${new Intl.NumberFormat('fa-IR', { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value)} ${units[exponent]}`;
}

export function initials(value: string): string {
    const text = String(value || '').trim();
    if (!text) return 'ک';
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 1) return words[0].slice(0, 2);
    return `${words[0][0] ?? ''}${words[1][0] ?? ''}`;
}

export function hashString(value: string): number {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
        hash = (hash << 5) - hash + value.charCodeAt(index);
        hash |= 0;
    }
    return Math.abs(hash);
}

export function cn(...values: (string | false | null | undefined)[]): string {
    return values.filter(Boolean).join(' ');
}

export function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function debounce<T extends (...args: never[]) => void>(fn: T, delay = 220): (...args: Parameters<T>) => void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return (...args: Parameters<T>) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

export function relativeFolder(filename: string): string {
    const index = filename.lastIndexOf('/');
    return index < 0 ? '' : filename.slice(0, index);
}

export function basename(filename: string): string {
    const index = filename.lastIndexOf('/');
    return index < 0 ? filename : filename.slice(index + 1);
}
