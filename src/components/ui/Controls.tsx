import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { useState } from 'react';
import { cn } from '../../lib/format';
import { Icon, type IconName } from '../icons';

type ButtonVariant = 'primary' | 'soft' | 'ghost' | 'danger' | 'outline';
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    size?: ButtonSize;
    icon?: IconName;
    trailingIcon?: IconName;
}

export function Button({
    variant = 'soft',
    size = 'md',
    icon,
    trailingIcon,
    className,
    children,
    type = 'button',
    ...rest
}: ButtonProps) {
    return (
        <button type={type} className={cn('btn', `btn--${variant}`, `btn--${size}`, className)} {...rest}>
            {icon ? <Icon name={icon} size={size === 'sm' ? 15 : 17} /> : null}
            {children ? <span>{children}</span> : null}
            {trailingIcon ? <Icon name={trailingIcon} size={size === 'sm' ? 14 : 16} /> : null}
        </button>
    );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    icon: IconName;
    label: string;
    active?: boolean;
    size?: number;
}

export function IconButton({ icon, label, active, size = 18, className, type = 'button', ...rest }: IconButtonProps) {
    return (
        <button
            type={type}
            className={cn('icon-btn', active && 'is-active', className)}
            title={label}
            aria-label={label}
            aria-pressed={active}
            {...rest}
        >
            <Icon name={icon} size={size} />
        </button>
    );
}

interface FieldProps {
    label: string;
    hint?: string;
    htmlFor?: string;
    children: ReactNode;
    className?: string;
}

export function Field({ label, hint, htmlFor, children, className }: FieldProps) {
    return (
        <label className={cn('field', className)} htmlFor={htmlFor}>
            <span className="field__label">{label}</span>
            {children}
            {hint ? <span className="field__hint">{hint}</span> : null}
        </label>
    );
}

interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
    icon?: IconName;
}

export function TextInput({ icon, className, ...rest }: TextInputProps) {
    if (!icon) return <input className={cn('input', className)} {...rest} />;
    return (
        <span className="input-wrap">
            <Icon name={icon} size={16} className="input-wrap__icon" />
            <input className={cn('input', 'input--with-icon', className)} {...rest} />
        </span>
    );
}

interface SegmentedProps<T extends string> {
    value: T;
    options: { value: T; label: string; icon?: IconName; count?: number }[];
    onChange: (value: T) => void;
    ariaLabel?: string;
}

export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: SegmentedProps<T>) {
    return (
        <div className="segmented" role="tablist" aria-label={ariaLabel}>
            {options.map((option) => (
                <button
                    key={option.value}
                    type="button"
                    role="tab"
                    aria-selected={value === option.value}
                    className={cn('segmented__item', value === option.value && 'is-active')}
                    onClick={() => onChange(option.value)}
                >
                    {option.icon ? <Icon name={option.icon} size={15} /> : null}
                    <span>{option.label}</span>
                    {typeof option.count === 'number' ? (
                        <em className="segmented__count">{option.count}</em>
                    ) : null}
                </button>
            ))}
        </div>
    );
}

interface ToggleProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    label: string;
    hint?: string;
}

export function Toggle({ checked, onChange, label, hint }: ToggleProps) {
    return (
        <label className={cn('toggle', checked && 'is-on')}>
            <input
                type="checkbox"
                checked={checked}
                onChange={(event) => onChange(event.target.checked)}
            />
            <span className="toggle__track" aria-hidden="true">
                <span className="toggle__thumb" />
            </span>
            <span className="toggle__copy">
                <strong>{label}</strong>
                {hint ? <small>{hint}</small> : null}
            </span>
        </label>
    );
}

interface RatingProps {
    value: number;
    onChange?: (value: number) => void;
    readOnly?: boolean;
    size?: number;
}

export function Rating({ value, onChange, readOnly = false, size = 16 }: RatingProps) {
    return (
        <div className={cn('rating', readOnly && 'rating--readonly')} aria-label={`امتیاز ${value} از ۵`}>
            {[1, 2, 3, 4, 5].map((star) => (
                <button
                    key={star}
                    type="button"
                    className={cn('rating__star', star <= value && 'is-on')}
                    disabled={readOnly}
                    aria-label={`${star} ستاره`}
                    onClick={() => onChange?.(star === value && !readOnly ? 0 : star)}
                >
                    <Icon name="star" size={size} />
                </button>
            ))}
        </div>
    );
}

interface TagInputProps {
    tags: string[];
    onChange: (tags: string[]) => void;
    placeholder?: string;
    /** When false, only Enter commits a tag (commas stay part of the text). */
    commitOnComma?: boolean;
}

export function TagInput({
    tags,
    onChange,
    placeholder = 'برچسب بنویسید و Enter بزنید',
    commitOnComma = true
}: TagInputProps) {
    const [draft, setDraft] = useState('');

    const commit = (value: string) => {
        const tag = value.trim().replace(/[,،]+$/g, '').trim();
        if (tag && !tags.some((item) => item.toLocaleLowerCase() === tag.toLocaleLowerCase())) {
            onChange([...tags, tag]);
        }
        setDraft('');
    };

    return (
        <div className="tag-input">
            <div className="tag-input__list">
                {tags.map((tag) => (
                    <span key={tag} className="chip chip--removable">
                        {tag}
                        <button
                            type="button"
                            aria-label={`حذف ${tag}`}
                            onClick={() => onChange(tags.filter((item) => item !== tag))}
                        >
                            ×
                        </button>
                    </span>
                ))}
            </div>
            <input
                className="input"
                value={draft}
                placeholder={placeholder}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                    const commaKey = event.key === ',' || event.key === '،';
                    if (event.key === 'Enter' || (commitOnComma && commaKey)) {
                        event.preventDefault();
                        commit(draft);
                    } else if (event.key === 'Backspace' && !draft && tags.length) {
                        onChange(tags.slice(0, -1));
                    }
                }}
                onBlur={() => draft && commit(draft)}
            />
        </div>
    );
}

interface EmptyStateProps {
    icon?: IconName;
    title: string;
    description?: string;
    action?: ReactNode;
}

export function EmptyState({ icon = 'books', title, description, action }: EmptyStateProps) {
    return (
        <div className="empty-state">
            <span className="empty-state__icon">
                <Icon name={icon} size={26} />
            </span>
            <h3>{title}</h3>
            {description ? <p>{description}</p> : null}
            {action}
        </div>
    );
}
