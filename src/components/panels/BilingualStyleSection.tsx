import { useState } from 'react';
import {
    BILINGUAL_BOX_OPTIONS,
    BILINGUAL_DISPLAY_OPTIONS,
    BILINGUAL_FONT_OPTIONS
} from '../../hooks/useSettings';
import { cn, faNumber } from '../../lib/format';
import type { BilingualFontWeight, BilingualSettings, BilingualSideStyle } from '../../types';
import { Icon } from '../icons';
import { Button, Field } from '../ui/Controls';

interface BilingualStyleSectionProps {
    value: BilingualSettings;
    onChange: (next: BilingualSettings) => void;
    onReset: () => void;
}

const COLOR_SWATCHES: { color: string; label: string }[] = [
    { color: '', label: 'خودکار پوسته' },
    { color: '#64748b', label: 'خاکستری سنگی' },
    { color: '#0ea5e9', label: 'آبی فیروزه‌ای' },
    { color: '#6366f1', label: 'نیلی' },
    { color: '#10b981', label: 'زمردی' },
    { color: '#f59e0b', label: 'کهربایی' },
    { color: '#ec4899', label: 'سرخابی' },
    { color: '#e2e8f0', label: 'سفید ملایم' },
    { color: '#1e293b', label: 'سرمه‌ای تیره' }
];

const WEIGHT_OPTIONS: { value: BilingualFontWeight; label: string }[] = [
    { value: '400', label: 'معمولی' },
    { value: '500', label: 'نیمه‌ضخیم' },
    { value: '700', label: 'ضخیم' }
];

type SideRole = 'original' | 'translated';

export function BilingualStyleSection({ value, onChange, onReset }: BilingualStyleSectionProps) {
    const [activeSide, setActiveSide] = useState<SideRole>('original');
    const side = value[activeSide];

    const updateSide = (patch: Partial<BilingualSideStyle>) => {
        onChange({
            ...value,
            [activeSide]: {
                ...value[activeSide],
                ...patch
            }
        });
    };

    return (
        <section className="settings-section bilingual-settings" aria-label="ظاهر و تفکیک متن دوزبانه">
            <h3 className="settings-section__title">
                <Icon name="palette" size={16} /> ظاهر و تفکیک متن دوزبانه
            </h3>

            <p className="settings-section__description">
                برای کتاب‌هایی که به‌صورت دوزبانه ترجمه می‌شوند، می‌توانید شیوهٔ نمایش، رنگ، فونت، اندازه و کادر متن
                زبان اصلی و متن ترجمه‌شده را جداگانه تنظیم کنید تا به‌راحتی از هم متمایز شوند.
            </p>

            <div className="settings-block">
                <span className="settings-block__label">حالت نمایش در کتاب‌خوان</span>
                <div className="bilingual-segmented" role="group" aria-label="حالت نمایش متن دوزبانه">
                    {BILINGUAL_DISPLAY_OPTIONS.map((option) => (
                        <button
                            key={option.value}
                            type="button"
                            className={cn('bilingual-segmented__btn', value.display === option.value && 'is-active')}
                            onClick={() => onChange({ ...value, display: option.value })}
                            aria-pressed={value.display === option.value}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="bilingual-preview" aria-label="پیش‌نمایش زندهٔ متن دوزبانه">
                <div className="bilingual-preview__head">
                    <span>پیش‌نمایش زنده</span>
                    <small>
                        {value.display === 'both'
                            ? 'نمایش هم‌زمان اصلی و ترجمه'
                            : value.display === 'translated'
                              ? 'فقط ترجمه نمایش داده می‌شود'
                              : 'فقط زبان اصلی نمایش داده می‌شود'}
                    </small>
                </div>
                <div className="book-page__body bilingual-preview__body">
                    <p>
                        <span className="bi-orig">
                            اَلْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ وَالصَّلَاةُ وَالسَّلَامُ عَلَى سَيِّدِنَا مُحَمَّدٍ.
                        </span>
                    </p>
                    <p>
                        <span className="bi-trans">
                            ستایش خدایی را سزاست که پروردگار جهانیان است، و درود و سلام بر سرور ما محمد باد.
                        </span>
                    </p>
                </div>
            </div>

            <div className="bilingual-side-tabs" role="tablist" aria-label="انتخاب بخش برای شخصی‌سازی">
                <button
                    type="button"
                    role="tab"
                    aria-selected={activeSide === 'original'}
                    className={cn('bilingual-side-tab', activeSide === 'original' && 'is-active')}
                    onClick={() => setActiveSide('original')}
                >
                    <span>متن زبان اصلی</span>
                    <small>{BILINGUAL_BOX_OPTIONS.find((item) => item.value === value.original.box)?.label}</small>
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={activeSide === 'translated'}
                    className={cn('bilingual-side-tab', activeSide === 'translated' && 'is-active')}
                    onClick={() => setActiveSide('translated')}
                >
                    <span>متن ترجمه‌شده</span>
                    <small>{BILINGUAL_BOX_OPTIONS.find((item) => item.value === value.translated.box)?.label}</small>
                </button>
            </div>

            <div className="bilingual-side-editor" role="tabpanel">
                <div className="settings-block">
                    <div className="settings-block__row">
                        <span className="settings-block__label">
                            رنگ {activeSide === 'original' ? 'متن اصلی' : 'متن ترجمه'}
                        </span>
                        <span className="settings-block__value">
                            {side.color ? <bdi dir="ltr">{side.color}</bdi> : 'خودکار پوسته'}
                        </span>
                    </div>
                    <div className="bilingual-colors">
                        {COLOR_SWATCHES.map((swatch) => (
                            <button
                                key={swatch.color || 'auto'}
                                type="button"
                                className={cn(
                                    'bilingual-swatch',
                                    !swatch.color && 'is-auto',
                                    side.color.toLowerCase() === swatch.color.toLowerCase() && 'is-active'
                                )}
                                title={swatch.label}
                                aria-label={swatch.label}
                                style={swatch.color ? { backgroundColor: swatch.color } : undefined}
                                onClick={() => updateSide({ color: swatch.color })}
                            >
                                {!swatch.color ? 'خودکار' : null}
                            </button>
                        ))}
                        <label className="bilingual-color-picker" title="انتخاب رنگ دلخواه">
                            <input
                                type="color"
                                value={side.color || (activeSide === 'original' ? '#94a3b8' : '#818cf8')}
                                onChange={(event) => updateSide({ color: event.target.value })}
                                aria-label="انتخاب رنگ دلخواه"
                            />
                            <span>دلخواه</span>
                        </label>
                    </div>
                </div>

                <div className="settings-block">
                    <span className="settings-block__label">سبک کادر و تفکیک</span>
                    <div className="bilingual-segmented">
                        {BILINGUAL_BOX_OPTIONS.map((option) => (
                            <button
                                key={option.value}
                                type="button"
                                className={cn('bilingual-segmented__btn', side.box === option.value && 'is-active')}
                                onClick={() => updateSide({ box: option.value })}
                                aria-pressed={side.box === option.value}
                            >
                                {option.label}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="translate__row">
                    <Field label="فونت">
                        <select
                            className="input select"
                            value={side.font}
                            onChange={(event) => updateSide({ font: event.target.value })}
                        >
                            {BILINGUAL_FONT_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                    </Field>

                    <Field label="ضخامت قلم">
                        <div className="bilingual-segmented">
                            {WEIGHT_OPTIONS.map((option) => (
                                <button
                                    key={option.value}
                                    type="button"
                                    className={cn(
                                        'bilingual-segmented__btn',
                                        side.weight === option.value && 'is-active'
                                    )}
                                    onClick={() => updateSide({ weight: option.value })}
                                    aria-pressed={side.weight === option.value}
                                >
                                    {option.label}
                                </button>
                            ))}
                        </div>
                    </Field>
                </div>

                <div className="translate__row">
                    <div className="settings-block">
                        <div className="settings-block__row">
                            <span className="settings-block__label">اندازهٔ متن</span>
                            <span className="settings-block__value">{faNumber(side.fontSize)}٪</span>
                        </div>
                        <input
                            type="range"
                            min={75}
                            max={135}
                            step={2}
                            value={side.fontSize}
                            onChange={(event) => updateSide({ fontSize: Number(event.target.value) })}
                            aria-label="اندازه متن"
                        />
                    </div>

                    <div className="settings-block">
                        <div className="settings-block__row">
                            <span className="settings-block__label">شفافیت / پررنگی</span>
                            <span className="settings-block__value">{faNumber(side.opacity)}٪</span>
                        </div>
                        <input
                            type="range"
                            min={50}
                            max={100}
                            step={2}
                            value={side.opacity}
                            onChange={(event) => updateSide({ opacity: Number(event.target.value) })}
                            aria-label="شفافیت متن"
                        />
                    </div>
                </div>

                <div className="bilingual-footer-row">
                    <button
                        type="button"
                        className={cn('bilingual-italic-btn', side.italic && 'is-active')}
                        onClick={() => updateSide({ italic: !side.italic })}
                        aria-pressed={side.italic}
                    >
                        <span>متن کج (ایتالیک)</span>
                    </button>

                    <Button variant="soft" size="sm" icon="refresh" onClick={onReset}>
                        بازگشت به پیش‌فرض دوزبانه
                    </Button>
                </div>
            </div>
        </section>
    );
}
