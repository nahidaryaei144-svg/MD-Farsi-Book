import { Icon } from '../icons';

interface FooterProps {
    onReport: () => void;
    onBatch: () => void;
    onBackups: () => void;
    onTop: () => void;
}

export function Footer({ onReport, onBatch, onBackups, onTop }: FooterProps) {
    return (
        <footer className="footer">
            <div className="footer__grid">
                <div className="footer__brand">
                    <span className="brand__mark">
                        <Icon name="books" size={20} />
                    </span>
                    <div>
                        <strong>کتابخانهٔ فارسی MD</strong>
                        <p>
                            فضایی ساده، سریع و دلنشین برای نگهداری، دسته‌بندی و مطالعهٔ کتاب‌های Markdown — آنلاین و
                            آفلاین، بدون وابستگی به اینترنت.
                        </p>
                    </div>
                </div>

                <div className="footer__column">
                    <h4>دسترسی سریع</h4>
                    <button type="button" onClick={onReport}>
                        <Icon name="chart" size={14} /> گزارش کتابخانه
                    </button>
                    <button type="button" onClick={onBatch}>
                        <Icon name="tools" size={14} /> ابزارهای گروهی
                    </button>
                    <button type="button" onClick={onBackups}>
                        <Icon name="shield" size={14} /> نسخه‌های پشتیبان
                    </button>
                    <button type="button" onClick={onTop}>
                        <Icon name="arrowUp" size={14} /> بازگشت به بالا
                    </button>
                </div>

                <div className="footer__column footer__column--creator">
                    <h4>سازنده و پشتیبان فنی</h4>
                    <span className="footer__creator">
                        <span className="footer__avatar">م</span>
                        <span>
                            <strong>محمد شعیب حبیبی</strong>
                            <small>توسعه‌دهنده و پشتیبان فنی</small>
                        </span>
                    </span>
                    <div className="footer__links">
                        <a href="tel:0796146859" dir="ltr">
                            <Icon name="clock" size={14} />
                            <span>0796 146 859</span>
                        </a>
                        <a href="https://t.me/shoaib22011374" target="_blank" rel="noreferrer" dir="ltr">
                            <Icon name="external" size={14} />
                            <span>@shoaib22011374</span>
                        </a>
                        <a href="mailto:shoaibhabibi677@gmail.com" dir="ltr">
                            <Icon name="link" size={14} />
                            <span>shoaibhabibi677@gmail.com</span>
                        </a>
                    </div>
                </div>
            </div>
            <div className="footer__bottom">
                <span>ساخته‌شده با <span className="heart">♥</span> برای دوست‌داران کتاب</span>
                <span className="footer__version">نسخهٔ ۲٫۰ — پنل‌های شناور و گزارش حرفه‌ای</span>
            </div>
        </footer>
    );
}
