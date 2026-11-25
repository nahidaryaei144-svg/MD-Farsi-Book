import { useState } from 'react';
import { cn, faBytes, faNumber } from '../../lib/format';
import { FONT_OPTIONS, THEME_OPTIONS } from '../../hooks/useSettings';
import type { ThemeName } from '../../types';
import { Icon, type IconName } from '../icons';
import { Button, Field, TextInput } from '../ui/Controls';
import { DataFolderSection } from './DataFolderSection';
import { TranslationSettingsSection } from './TranslationSettingsSection';

interface SettingsPanelProps {
    theme: ThemeName;
    font: string;
    zoom: number;
    cornerRadius: number;
    libraryDir: string;
    folders: string[];
    bookCount: number;
    libraryBytes: number;
    onTheme: (theme: ThemeName) => void;
    onFont: (font: string) => void;
    onZoom: (zoom: number) => void;
    onCornerRadius: (value: number) => void;
    onAddBook: () => void;
    onCreateFolder: (parent: string, name: string) => Promise<unknown>;
    notify: (message: string, tone?: 'success' | 'error' | 'info') => void;
}

const SHORTCUTS: [string, string][] = [
    ['/', 'جست‌وجو در کتابخانه'],
    ['F', 'پنل فیلترها'],
    ['S', 'پنل تنظیمات'],
    ['G', 'گزارش کتابخانه'],
    ['T', 'ابزارهای گروهی'],
    ['R', 'تازه‌سازی کتابخانه'],
    ['Esc', 'بستن پنل‌ها و پنجره‌ها']
];

type SettingsTab = 'appearance' | 'library' | 'translation' | 'about';

const TABS: { id: SettingsTab; label: string; icon: IconName }[] = [
    { id: 'appearance', label: 'ظاهر و خواندن', icon: 'palette' },
    { id: 'library', label: 'کتابخانه و داده', icon: 'books' },
    { id: 'translation', label: 'ترجمه', icon: 'globe' },
    { id: 'about', label: 'درباره', icon: 'info' }
];

export function SettingsPanel({
    theme,
    font,
    zoom,
    cornerRadius,
    libraryDir,
    folders,
    bookCount,
    libraryBytes,
    onTheme,
    onFont,
    onZoom,
    onCornerRadius,
    onAddBook,
    onCreateFolder,
    notify
}: SettingsPanelProps) {
    const [tab, setTab] = useState<SettingsTab>('appearance');
    const [folderParent, setFolderParent] = useState('');
    const [folderName, setFolderName] = useState('');
    const [busy, setBusy] = useState(false);

    const createFolder = async () => {
        if (!folderName.trim()) {
            notify('نام پوشه را وارد کنید.', 'error');
            return;
        }
        setBusy(true);
        try {
            await onCreateFolder(folderParent, folderName.trim());
            notify('پوشهٔ تازه ساخته شد.');
            setFolderName('');
        } catch (error) {
            notify(error instanceof Error ? error.message : 'ساخت پوشه انجام نشد.', 'error');
        } finally {
            setBusy(false);
        }
    };

    const themeLabel = THEME_OPTIONS.find((option) => option.value === theme)?.label ?? '';

    return (
        <div className="settings-panel">
            <div className="settings-hero">
                <span className="settings-hero__icon">
                    <Icon name="sparkles" size={20} />
                </span>
                <div className="settings-hero__copy">
                    <span>مرکز شخصی‌سازی</span>
                    <strong>کتابخانه‌تان را برای خودتان بسازید</strong>
                    <p>ظاهر، کتابخانه، مترجم و داده‌ها — هر بخش جداگانه و مرتب.</p>
                </div>
                <em className="settings-hero__badge">
                    <Icon name="check" size={11} /> ذخیرهٔ خودکار
                </em>
            </div>

            <nav className="settings-tabs" role="tablist" aria-label="بخش‌های تنظیمات">
                {TABS.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        role="tab"
                        aria-selected={tab === item.id}
                        className={cn('settings-tab', tab === item.id && 'is-active')}
                        onClick={() => setTab(item.id)}
                    >
                        <Icon name={item.icon} size={15} />
                        <span>{item.label}</span>
                    </button>
                ))}
            </nav>

            <div className="settings-group" role="tabpanel" aria-label="ظاهر و خواندن" hidden={tab !== 'appearance'}>
                <section className="settings-section">
                    <h3 className="settings-section__title">
                        <Icon name="palette" size={16} /> ظاهر کتابخانه
                    </h3>

                    <div className="settings-block">
                        <div className="settings-block__row">
                            <span className="settings-block__label">پوسته</span>
                            <span className="settings-block__value">{themeLabel}</span>
                        </div>
                        <div className="theme-grid">
                            {THEME_OPTIONS.map((option) => (
                                <button
                                    key={option.value}
                                    type="button"
                                    className={cn('theme-option', theme === option.value && 'is-active')}
                                    onClick={() => onTheme(option.value)}
                                    aria-pressed={theme === option.value}
                                >
                                    <span className={`theme-option__swatch theme-option__swatch--${option.value}`} />
                                    <span className="theme-option__copy">
                                        <strong>{option.label}</strong>
                                        <small>{option.hint}</small>
                                    </span>
                                    {theme === option.value ? <Icon name="check" size={13} /> : null}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="settings-block">
                        <span className="settings-block__label">فونت برنامه</span>
                        <div className="font-options">
                            {FONT_OPTIONS.map((option) => (
                                <button
                                    key={option.value}
                                    type="button"
                                    className={cn('font-option', font === option.value && 'is-active')}
                                    style={{ fontFamily: option.stack }}
                                    onClick={() => onFont(option.value)}
                                    aria-pressed={font === option.value}
                                >
                                    {option.label}
                                </button>
                            ))}
                        </div>
                    </div>
                </section>

                <section className="settings-section">
                    <h3 className="settings-section__title">
                        <Icon name="zoomIn" size={16} /> اندازه و چیدمان
                    </h3>

                    <div className="settings-block">
                        <div className="settings-block__row">
                            <span className="settings-block__label">بزرگ‌نمایی برنامه</span>
                            <span className="settings-block__value">{faNumber(zoom)}٪</span>
                        </div>
                        <div className="zoom-row">
                            <button type="button" onClick={() => onZoom(zoom - 5)} aria-label="کوچک‌تر">
                                <Icon name="zoomOut" size={17} />
                            </button>
                            <input
                                type="range"
                                min={80}
                                max={140}
                                step={5}
                                value={zoom}
                                onChange={(event) => onZoom(Number(event.target.value))}
                                aria-label="بزرگ‌نمایی برنامه"
                            />
                            <button type="button" onClick={() => onZoom(zoom + 5)} aria-label="بزرگ‌تر">
                                <Icon name="zoomIn" size={17} />
                            </button>
                        </div>
                    </div>

                    <div className="settings-block">
                        <div className="settings-block__row">
                            <span className="settings-block__label">گردی گوشهٔ پنل‌ها</span>
                            <span className="settings-block__value">{faNumber(cornerRadius)} پیکسل</span>
                        </div>
                        <input
                            type="range"
                            min={0}
                            max={36}
                            step={2}
                            value={cornerRadius}
                            onChange={(event) => onCornerRadius(Number(event.target.value))}
                            aria-label="گردی گوشه پنل‌ها"
                        />
                        <div className="radius-preview">پیش‌نمایش گوشه‌های پنل</div>
                    </div>
                </section>
            </div>

            <div className="settings-group" role="tabpanel" aria-label="کتابخانه و داده" hidden={tab !== 'library'}>
                <section className="settings-section">
                    <h3 className="settings-section__title">
                        <Icon name="books" size={16} /> مدیریت کتابخانه
                    </h3>
                    <div className="library-facts">
                        <div>
                            <strong>{faNumber(bookCount)}</strong>
                            <span>کتاب</span>
                        </div>
                        <div>
                            <strong>{faNumber(folders.length)}</strong>
                            <span>پوشه</span>
                        </div>
                        <div>
                            <strong>{faBytes(libraryBytes)}</strong>
                            <span>حجم کتابخانه</span>
                        </div>
                    </div>
                    <p className="library-path" title={libraryDir}>
                        <Icon name="folder" size={14} />
                        <span dir="ltr">{libraryDir || '—'}</span>
                    </p>

                    <div className="settings-actions">
                        <Button variant="primary" size="sm" icon="plus" onClick={onAddBook}>
                            افزودن کتاب
                        </Button>
                        <Button variant="soft" size="sm" icon="folder" onClick={() => setFolderName('')}>
                            پوشهٔ تازه
                        </Button>
                    </div>

                    <div className="folder-create">
                        <Field label="محل ایجاد پوشه">
                            <select
                                className="input select"
                                value={folderParent}
                                onChange={(event) => setFolderParent(event.target.value)}
                            >
                                <option value="">قفسهٔ اصلی</option>
                                {folders.map((folder) => (
                                    <option key={folder} value={folder}>
                                        {folder}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        <Field label="نام پوشهٔ جدید">
                            <TextInput
                                value={folderName}
                                maxLength={100}
                                placeholder="مثلاً: تفسیر و علوم قرآنی"
                                onChange={(event) => setFolderName(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') void createFolder();
                                }}
                            />
                        </Field>
                        <Button variant="soft" size="sm" icon="plus" disabled={busy} onClick={() => void createFolder()}>
                            ایجاد پوشه
                        </Button>
                    </div>
                </section>

                <DataFolderSection notify={notify} />
            </div>

            <div className="settings-group" role="tabpanel" aria-label="ترجمه و مترجم" hidden={tab !== 'translation'}>
                <TranslationSettingsSection notify={notify} />
            </div>

            <div className="settings-group" role="tabpanel" aria-label="درباره و میانبرها" hidden={tab !== 'about'}>
                <section className="settings-section dev-card" aria-label="دربارهٔ برنامه و توسعه‌دهنده">
                    <span className="dev-card__aurora dev-card__aurora--one" aria-hidden="true" />
                    <span className="dev-card__aurora dev-card__aurora--two" aria-hidden="true" />
                    <span className="dev-card__shine" aria-hidden="true" />

                    <div className="dev-card__head">
                        <div className="dev-avatar">
                            <span className="dev-avatar__glow" aria-hidden="true" />
                            <span className="dev-avatar__ring dev-avatar__ring--outer" aria-hidden="true" />
                            <span className="dev-avatar__ring dev-avatar__ring--inner" aria-hidden="true" />
                            <span className="dev-avatar__core">
                                <span className="dev-avatar__sheen" aria-hidden="true" />
                                <span className="dev-avatar__letter">م</span>
                            </span>
                            <span className="dev-avatar__dot dev-avatar__dot--a" aria-hidden="true" />
                            <span className="dev-avatar__dot dev-avatar__dot--b" aria-hidden="true" />
                        </div>
                        <div className="dev-identity">
                            <span className="dev-kicker">
                                <span className="dev-kicker__dot" aria-hidden="true" />
                                توسعه‌دهنده و پشتیبان فنی
                            </span>
                            <strong className="dev-name">محمد شعیب حبیبی</strong>
                            <p className="dev-role">ساخت، نگهداری و پشتیبانی فنی کتابخانهٔ فارسی MD</p>
                        </div>
                        <em className="dev-version">
                            <Icon name="sparkles" size={11} /> نسخهٔ ۲٫۰
                        </em>
                    </div>

                    <div className="dev-tags" aria-label="زمینه‌های فعالیت">
                        {['طراحی رابط کاربری', 'توسعهٔ وب', 'پشتیبانی فنی'].map((tag, index) => (
                            <span key={tag} className="dev-tag" style={{ animationDelay: `${0.16 + index * 0.08}s` }}>
                                {tag}
                            </span>
                        ))}
                    </div>

                    <div className="dev-app">
                        <span className="dev-app__icon">
                            <Icon name="books" size={15} />
                        </span>
                        <div>
                            <strong>کتابخانهٔ فارسی MD</strong>
                            <p>فضایی ساده و دلنشین برای نگهداری و مطالعهٔ کتاب‌های Markdown، آنلاین و آفلاین.</p>
                        </div>
                    </div>

                    <div className="dev-links">
                        <a
                            className="dev-link"
                            href="tel:0796146859"
                            aria-label="تماس تلفنی"
                            style={{ animationDelay: '0.26s' }}
                        >
                            <span className="dev-link__icon">
                                <Icon name="clock" size={15} />
                            </span>
                            <span className="dev-link__copy">
                                <small>تلفن</small>
                                <strong dir="ltr">0796 146 859</strong>
                            </span>
                            <span className="dev-link__arrow">
                                <Icon name="arrowLeft" size={13} />
                            </span>
                        </a>
                        <a
                            className="dev-link"
                            href="https://t.me/shoaib22011374"
                            target="_blank"
                            rel="noreferrer"
                            aria-label="تلگرام"
                            style={{ animationDelay: '0.34s' }}
                        >
                            <span className="dev-link__icon">
                                <Icon name="external" size={15} />
                            </span>
                            <span className="dev-link__copy">
                                <small>تلگرام</small>
                                <strong dir="ltr">@shoaib22011374</strong>
                            </span>
                            <span className="dev-link__arrow">
                                <Icon name="arrowLeft" size={13} />
                            </span>
                        </a>
                        <a
                            className="dev-link"
                            href="mailto:shoaibhabibi677@gmail.com"
                            aria-label="ایمیل"
                            style={{ animationDelay: '0.42s' }}
                        >
                            <span className="dev-link__icon">
                                <Icon name="link" size={15} />
                            </span>
                            <span className="dev-link__copy">
                                <small>ایمیل</small>
                                <strong dir="ltr">shoaibhabibi677@gmail.com</strong>
                            </span>
                            <span className="dev-link__arrow">
                                <Icon name="arrowLeft" size={13} />
                            </span>
                        </a>
                    </div>
                </section>

                <section className="settings-section">
                    <h3 className="settings-section__title">
                        <Icon name="bolt" size={16} /> کلیدهای میانبر
                    </h3>
                    <div className="shortcut-list">
                        {SHORTCUTS.map(([key, label]) => (
                            <div key={key} className="shortcut-row">
                                <kbd>{key}</kbd>
                                <span>{label}</span>
                            </div>
                        ))}
                    </div>
                </section>
            </div>
        </div>
    );
}
