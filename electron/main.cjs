const { app, BrowserWindow, Menu, dialog, screen, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/**
 * Windows desktop shell.
 *
 * The window is created hidden and only shown once the page has painted, so
 * opening the app never flashes a white frame. The size and position are
 * remembered between runs, a second launch focuses the existing window instead
 * of starting another server, and the first launch copies the bundled library
 * with visible progress instead of appearing frozen for minutes.
 */

const APP_ID = 'ir.mdfarsibook.library';
const APP_TITLE = 'کتابخانه فارسی MD';
const DEFAULT_BOUNDS = { width: 1440, height: 960, minWidth: 960, minHeight: 640 };

let mainWindow = null;
let serverPort = 0;

const userPath = (...parts) => path.join(app.getPath('userData'), ...parts);

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

function writeJson(file, value) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(value));
    } catch {
        // A missing window state only costs the next launch its position.
    }
}

function loadWindowState() {
    const saved = readJson(userPath('window-state.json'), null);
    const state = { ...DEFAULT_BOUNDS, maximized: false };
    if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height)) {
        state.width = Math.max(DEFAULT_BOUNDS.minWidth, Math.round(saved.width));
        state.height = Math.max(DEFAULT_BOUNDS.minHeight, Math.round(saved.height));
        state.maximized = saved.maximized === true;
        if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
            const onScreen = screen.getAllDisplays().some(({ workArea }) =>
                saved.x < workArea.x + workArea.width - 80 &&
                saved.x + state.width > workArea.x + 80 &&
                saved.y < workArea.y + workArea.height - 80 &&
                saved.y + state.height > workArea.y + 80
            );
            if (onScreen) {
                state.x = Math.round(saved.x);
                state.y = Math.round(saved.y);
            }
        }
    }
    return state;
}

function saveWindowState(window) {
    if (!window || window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
    const bounds = window.getNormalBounds();
    writeJson(userPath('window-state.json'), {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        maximized: window.isMaximized()
    });
}

function splashPage() {
    const html = `<!doctype html>
<html lang="fa" dir="rtl"><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    display: flex; flex-direction: column; justify-content: center; gap: 14px;
    padding: 26px 32px; font-family: 'Segoe UI', Tahoma, sans-serif; color: #eef1f8;
    background: radial-gradient(circle at 18% 12%, #1e2465 0%, #060812 62%);
    border: 1px solid rgba(255,255,255,.08); border-radius: 16px; overflow: hidden;
    -webkit-app-region: drag; user-select: none;
  }
  h1 { margin: 0; font-size: 17px; font-weight: 700; letter-spacing: .2px; }
  p { margin: 0; font-size: 12.5px; color: #9aa6bf; }
  .track { height: 6px; border-radius: 99px; background: rgba(255,255,255,.1); overflow: hidden; }
  .fill { height: 100%; width: 0; border-radius: 99px; background: linear-gradient(90deg, #6366f1, #22d3ee); transition: width .2s ease; }
  .meta { display: flex; justify-content: space-between; font-size: 11.5px; color: #7d8aa5; }
</style></head>
<body>
  <h1>${APP_TITLE}</h1>
  <p id="label">در حال آماده‌سازی کتابخانه…</p>
  <div class="track"><div class="fill" id="fill"></div></div>
  <div class="meta"><span id="done">۰٪</span><span id="size"></span></div>
  <script>
    window.update = function (percent, copied, total) {
      document.getElementById('fill').style.width = percent.toFixed(1) + '%';
      document.getElementById('done').textContent = Math.floor(percent) + '٪';
      document.getElementById('size').textContent = copied + ' از ' + total;
    };
  </script>
</body></html>`;
    return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

const megabyte = (bytes) => `${(bytes / (1024 * 1024)).toFixed(0)} مگابایت`;

async function measureDirectory(directory) {
    let files = 0;
    let bytes = 0;
    const stack = [directory];
    while (stack.length) {
        const current = stack.pop();
        for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else if (entry.isFile()) {
                files += 1;
                bytes += (await fs.promises.stat(full)).size;
            }
        }
    }
    return { files, bytes };
}

async function listFiles(directory, base = '') {
    const results = [];
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
        const relative = base ? path.join(base, entry.name) : entry.name;
        if (entry.isDirectory()) {
            results.push(...(await listFiles(path.join(directory, entry.name), relative)));
        } else if (entry.isFile()) {
            results.push({ relative, size: (await fs.promises.stat(path.join(directory, entry.name))).size });
        }
    }
    return results;
}

/**
 * First launch copies the library the installer shipped into the user's data
 * folder. A 13 GB silent copy looks like a hang, so a small progress window
 * reports the real numbers while it happens.
 */
async function seedLibrary(seedDirectory, libraryDirectory) {
    const splash = new BrowserWindow({
        width: 420,
        height: 190,
        frame: false,
        resizable: false,
        show: false,
        transparent: false,
        backgroundColor: '#060812',
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    splash.once('ready-to-show', () => splash.show());
    await splash.loadURL(splashPage());

    const files = await listFiles(seedDirectory);
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    let copiedBytes = 0;
    let lastUpdate = 0;

    const report = (force) => {
        const now = Date.now();
        if (!force && now - lastUpdate < 120) return;
        lastUpdate = now;
        const percent = totalBytes ? (copiedBytes / totalBytes) * 100 : 100;
        void splash.webContents
            .executeJavaScript(
                `window.update(${percent.toFixed(2)}, ${JSON.stringify(megabyte(copiedBytes))}, ${JSON.stringify(megabyte(totalBytes))})`
            )
            .catch(() => {});
    };

    report(true);
    for (const file of files) {
        const target = path.join(libraryDirectory, file.relative);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.copyFile(path.join(seedDirectory, file.relative), target);
        copiedBytes += file.size;
        report(false);
    }
    report(true);

    if (!splash.isDestroyed()) splash.destroy();
}

async function startServer(appRoot) {
    const runtimeUrl = pathToFileURL(path.join(appRoot, 'server.mjs')).href;
    const module = await import(runtimeUrl);
    if (!(await module.serverReady)) {
        throw new Error('سرور داخلی برنامه راه‌اندازی نشد.');
    }
    const address = module.server.address();
    if (!address || typeof address === 'string') {
        throw new Error('نشانی سرور داخلی برنامه در دسترس نیست.');
    }
    serverPort = address.port;
    return address.port;
}

function createWindow(appRoot) {
    const state = loadWindowState();
    const iconPath = path.join(appRoot, 'build', 'icon.png');

    const window = new BrowserWindow({
        width: state.width,
        height: state.height,
        ...(Number.isFinite(state.x) ? { x: state.x } : {}),
        ...(Number.isFinite(state.y) ? { y: state.y } : {}),
        minWidth: DEFAULT_BOUNDS.minWidth,
        minHeight: DEFAULT_BOUNDS.minHeight,
        show: false,
        title: APP_TITLE,
        backgroundColor: '#060812',
        autoHideMenuBar: true,
        ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false
        }
    });

    window.once('ready-to-show', () => {
        if (state.maximized) window.maximize();
        window.show();
        window.focus();
    });

    window.on('close', () => saveWindowState(window));
    window.on('closed', () => {
        mainWindow = null;
    });

    const origin = `http://127.0.0.1:${serverPort}`;

    // Links that point outside the app open in the user's browser instead of
    // replacing the library window.
    window.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) void shell.openExternal(url);
        return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
        if (url.startsWith(origin)) return;
        event.preventDefault();
        if (/^https?:/i.test(url)) void shell.openExternal(url);
    });

    window.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown' || input.control || input.alt || input.meta) return;
        if (input.key === 'F12') {
            window.webContents.toggleDevTools();
            event.preventDefault();
        }
    });

    window.webContents.on('did-fail-load', (_event, code, description) => {
        if (code === -3) return;
        dialog.showErrorBox(APP_TITLE, `بارگذاری برنامه ناموفق بود.\n${description}`);
    });

    void window.loadURL(`${origin}/`);
    return window;
}

function reportFatal(error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    try {
        fs.mkdirSync(userPath('logs'), { recursive: true });
        fs.appendFileSync(userPath('logs', 'main.log'), `[${new Date().toISOString()}] ${message}\n`);
    } catch {
        // Reporting must never throw.
    }
    dialog.showErrorBox(APP_TITLE, `اجرای برنامه ممکن نشد.\n${error instanceof Error ? error.message : String(error)}`);
}

async function startApplication() {
    app.setAppUserModelId(APP_ID);
    Menu.setApplicationMenu(null);

    const appRoot = app.getAppPath();
    const userData = app.getPath('userData');

    // The library lives in the user's data folder so it stays writable and
    // survives updates; an explicit LIBRARY_DIR (development, portable or a
    // custom location) always wins.
    if (!process.env.LIBRARY_DIR) {
        const libraryDir = path.join(userData, 'data');
        const seedLibraryDir = app.isPackaged
            ? path.join(process.resourcesPath, 'data')
            : path.join(appRoot, 'data');
        if (!fs.existsSync(libraryDir) && fs.existsSync(seedLibraryDir)) {
            await seedLibrary(seedLibraryDir, libraryDir);
        }
        process.env.LIBRARY_DIR = libraryDir;
    }
    process.env.APP_STORAGE_DIR = process.env.APP_STORAGE_DIR || path.join(userData, 'storage');
    process.env.APP_BACKUP_DIR = process.env.APP_BACKUP_DIR || path.join(userData, 'backups');
    process.env.APP_NO_BROWSER = '1';
    process.env.HOST = process.env.HOST || '127.0.0.1';

    await startServer(appRoot);
    mainWindow = createWindow(appRoot);
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    });

    app.whenReady()
        .then(startApplication)
        .catch((error) => {
            reportFatal(error);
            app.quit();
        });

    app.on('window-all-closed', () => {
        app.quit();
    });
}
