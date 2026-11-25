import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'portable');

function copyDirectory(source, destination) {
    if (!fs.existsSync(source)) {
        throw new Error(`مسیر موردنیاز برای بسته‌بندی پیدا نشد: ${source}`);
    }
    fs.mkdirSync(destination, { recursive: true });
    fs.cpSync(source, destination, { recursive: true, force: false });
}

const mode = process.argv[2];
if (!['--obfuscate', '--plain'].includes(mode)) {
    throw new Error('روش ساخت را مشخص کنید: --obfuscate یا --plain');
}

for (const requiredPath of ['server.mjs', 'dist', 'data']) {
    if (!fs.existsSync(path.join(root, requiredPath))) {
        throw new Error(`ابتدا خروجی ساخت را ایجاد کنید؛ مسیر پیدا نشد: ${requiredPath}`);
    }
}

fs.mkdirSync(output, { recursive: true });
fs.rmSync(path.join(output, 'dist'), { recursive: true, force: true });
fs.copyFileSync(path.join(root, 'server.mjs'), path.join(output, 'server.mjs'));
copyDirectory(path.join(root, 'dist'), path.join(output, 'dist'));
copyDirectory(path.join(root, 'data'), path.join(output, 'data'));
fs.mkdirSync(path.join(output, 'storage'), { recursive: true });

const sourceSettings = path.join(root, 'storage', 'settings.json');
const outputSettings = path.join(output, 'storage', 'settings.json');
if (fs.existsSync(sourceSettings) && !fs.existsSync(outputSettings)) {
    fs.copyFileSync(sourceSettings, outputSettings);
}

fs.copyFileSync(path.join(root, 'start.bat'), path.join(output, 'start.bat'));
if (mode === '--obfuscate') {
    const { obfuscatePortable } = await import('./obfuscate-portable.mjs');
    await obfuscatePortable(output);
}
console.log(`نسخهٔ قابل‌حمل ${mode === '--obfuscate' ? 'مبهم‌سازی‌شده' : 'عادی'} ساخته شد: ${output}`);
