import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { context } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const processes = new Set();

function readArg(flag) {
    const idx = process.argv.indexOf(flag);
    return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

const devEnv = {
    ...process.env,
    NODE_ENV: 'development',
    ...(readArg('--port') ? { PORT: readArg('--port') } : {}),
    ...(readArg('--host') ? { HOST: readArg('--host') } : {})
};

function run(command, args, name) {
    const child = spawn(command, args, {
        cwd: root,
        stdio: 'inherit',
        env: devEnv
    });
    processes.add(child);
    child.on('exit', (code) => {
        processes.delete(child);
        if (code && code !== 0) {
            console.error(`[${name}] exited with code ${code}`);
        }
    });
    return child;
}

function shutdown() {
    for (const child of processes) {
        child.kill('SIGTERM');
    }
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const serverContext = await context({
    entryPoints: [path.join(root, 'server.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['vite'],
    banner: {
        js: "import { createRequire as __bundleCreateRequire } from 'node:module'; var require = __bundleCreateRequire(import.meta.url);"
    },
    outfile: path.join(root, 'server.mjs'),
    logLevel: 'info'
});
await serverContext.rebuild();
await serverContext.watch();

run(process.execPath, [path.join(root, 'server.mjs')], 'server');

console.log(`\n  کتابخانه فارسی MD\n  ───────────────────\n  App & API → http://localhost:${devEnv.PORT || 3000}\n`);
