import { cn } from '../../lib/format';
import type { ThemeName } from '../../types';
import { Icon, type IconName } from '../icons';
import { IconButton } from '../ui/Controls';

interface TopBarProps {
    theme: ThemeName;
    filterCount: number;
    loading: boolean;
    onCycleTheme: () => void;
    onFilter: () => void;
    onSettings: () => void;
    onReport: () => void;
    onBatch: () => void;
    onBackups: () => void;
    onAdd: () => void;
    onRefresh: () => void;
    onHome: () => void;
}

interface NavActionProps {
    icon: IconName;
    label: string;
    onClick: () => void;
    badge?: number;
    primary?: boolean;
}

function NavAction({ icon, label, onClick, badge, primary }: NavActionProps) {
    return (
        <button
            type="button"
            className={cn('nav-action', primary && 'nav-action--primary')}
            onClick={onClick}
            title={label}
        >
            <Icon name={icon} size={17} />
            <span>{label}</span>
            {badge ? <em className="nav-action__badge">{badge}</em> : null}
        </button>
    );
}

export function TopBar({
    theme,
    filterCount,
    loading,
    onCycleTheme,
    onFilter,
    onSettings,
    onReport,
    onBatch,
    onBackups,
    onAdd,
    onRefresh,
    onHome
}: TopBarProps) {
    return (
        <header className="topbar">
            <div className="topbar__inner">
                <button type="button" className="brand" onClick={onHome} aria-label="خانهٔ کتابخانه">
                    <span className="brand__mark">
                        <Icon name="books" size={21} />
                    </span>
                    <span className="brand__text">
                        کتابخانه<b>MD</b>
                        <small>خانهٔ دانایی</small>
                    </span>
                </button>

                <nav className="topbar__nav" aria-label="دسترسی سریع">
                    <NavAction icon="books" label="کتابخانه" onClick={onHome} />
                    <NavAction icon="filter" label="فیلترها" onClick={onFilter} badge={filterCount} />
                    <NavAction icon="chart" label="گزارش" onClick={onReport} />
                    <NavAction icon="tools" label="ابزارهای گروهی" onClick={onBatch} />
                    <NavAction icon="shield" label="پشتیبان‌ها" onClick={onBackups} />
                </nav>

                <div className="topbar__actions">
                    <IconButton
                        icon="refresh"
                        label="تازه‌سازی کتابخانه"
                        onClick={onRefresh}
                        className={cn(loading && 'is-spinning')}
                    />
                    <IconButton
                        icon={theme === 'light' ? 'sun' : theme === 'sepia' ? 'book' : 'moon'}
                        label="تغییر پوسته"
                        onClick={onCycleTheme}
                    />
                    <IconButton icon="settings" label="تنظیمات" onClick={onSettings} />
                    <button type="button" className="btn btn--primary btn--sm topbar__add" onClick={onAdd}>
                        <Icon name="plus" size={16} />
                        <span>افزودن کتاب</span>
                    </button>
                </div>
            </div>
        </header>
    );
}
