import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import JavaScriptObfuscator from 'javascript-obfuscator';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { transform } from 'esbuild';

const jsOptions = {
    compact: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,
    selfDefending: false,
    simplify: true,
    stringArray: true,
    stringArrayEncoding: [],
    stringArrayThreshold: 0.5,
    target: 'browser'
};

function findFiles(directory, extensions) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return findFiles(fullPath, extensions);
        return extensions.has(path.extname(entry.name).toLowerCase()) ? [fullPath] : [];
    });
}

function walk(node, visit, parent = null) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        node.forEach((item) => walk(item, visit, parent));
        return;
    }
    if (typeof node.type === 'string') visit(node, parent);
    for (const [key, value] of Object.entries(node)) {
        if (key !== 'loc' && key !== 'start' && key !== 'end' && key !== 'extra') {
            walk(value, visit, node);
        }
    }
}

function classAttributeValues(value) {
    const values = [];
    const pattern = /\bclass(?:Name)?\s*=\s*(["'])(.*?)\1/g;
    for (const match of value.matchAll(pattern)) values.push(match[2]);
    return values;
}

function stringValues(source) {
    const ast = parse(source, { sourceType: 'unambiguous' });
    const values = [];
    walk(ast, (node, parent) => {
        if (node.type === 'StringLiteral' && parent?.type === 'ObjectProperty') {
            const key = parent.key;
            if (!parent.computed && key?.type === 'Identifier' && key.name === 'className' && parent.value === node) {
                values.push(node.value);
            }
        }
    });
    return values;
}

function collectUsedClasses(values, cssClasses) {
    const used = new Set();
    for (const value of values) {
        for (const classValue of classAttributeValues(value)) {
            for (const name of classValue.split(/\s+/)) {
                if (cssClasses.has(name)) used.add(name);
            }
        }
        const trimmed = value.trim();
        if (trimmed && /^[\w-]+(?:\s+[\w-]+)*$/.test(trimmed)) {
            for (const name of trimmed.split(/\s+/)) {
                if (cssClasses.has(name)) used.add(name);
            }
        }
    }
    return used;
}

function replaceClassTokens(value, mapping, replaceClassList = false) {
    let updated = value.replace(/\bclass(?:Name)?\s*=\s*(["'])(.*?)\1/g, (match, quote, names) => {
        const renamed = names.replace(/[\w-]+/g, (name) => mapping.get(name) || name);
        return match.replace(names, renamed);
    });
    const trimmed = updated.trim();
    if (replaceClassList && trimmed && /^[\w-]+(?:\s+[\w-]+)*$/.test(trimmed)) {
        updated = updated.replace(/[\w-]+/g, (name) => mapping.get(name) || name);
    }
    return updated;
}

function renameCssClasses(css, mapping) {
    const root = postcss.parse(css);
    root.walkRules((rule) => {
        rule.selector = selectorParser((selectors) => {
            selectors.walkClasses((classNode) => {
                classNode.value = mapping.get(classNode.value) || classNode.value;
            });
        }).processSync(rule.selector);
    });
    return root.toString();
}

function renameJavaScriptClasses(source, mapping) {
    if (!mapping.size) return source;
    const ast = parse(source, { sourceType: 'unambiguous' });
    const edits = [];
    walk(ast, (node, parent) => {
        if (node.type === 'StringLiteral') {
            const isClassName = parent?.type === 'ObjectProperty' &&
                !parent.computed &&
                parent.key?.type === 'Identifier' &&
                parent.key.name === 'className' &&
                parent.value === node;
            const value = replaceClassTokens(node.value, mapping, isClassName);
            if (value !== node.value) edits.push({ start: node.start, end: node.end, text: JSON.stringify(value) });
        }
    });
    edits.sort((a, b) => b.start - a.start);
    for (const edit of edits) {
        source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
    }
    return source;
}

async function minifyHtml(html) {
    const { minify } = await import('html-minifier-terser');
    return minify(html, {
        collapseBooleanAttributes: true,
        collapseWhitespace: true,
        minifyCSS: true,
        removeComments: true,
        removeEmptyAttributes: true,
        removeOptionalTags: false
    });
}

export async function obfuscatePortable(portableRoot) {
    const dist = path.join(portableRoot, 'dist');
    const cssFiles = findFiles(dist, new Set(['.css']));
    const jsFiles = [...findFiles(dist, new Set(['.js'])), path.join(portableRoot, 'server.mjs')];
    const htmlFiles = findFiles(dist, new Set(['.html']));
    const cssClasses = new Set();

    for (const file of cssFiles) {
        const root = postcss.parse(fs.readFileSync(file, 'utf8'));
        root.walkRules((rule) => {
            selectorParser((selectors) => {
                selectors.walkClasses((classNode) => cssClasses.add(classNode.value));
            }).processSync(rule.selector);
        });
    }

    const sourceValues = [
        ...jsFiles.flatMap((file) => stringValues(fs.readFileSync(file, 'utf8'))),
        ...htmlFiles.flatMap((file) => classAttributeValues(fs.readFileSync(file, 'utf8')))
    ];
    const usedClasses = [...collectUsedClasses(sourceValues, cssClasses)].sort();
    const mapping = new Map(usedClasses.map((name, index) => [name, `_${index.toString(36)}`]));

    for (const file of cssFiles) {
        const css = renameCssClasses(fs.readFileSync(file, 'utf8'), mapping);
        const result = await transform(css, { loader: 'css', minify: true });
        fs.writeFileSync(file, result.code, 'utf8');
    }

    for (const file of htmlFiles) {
        const html = fs.readFileSync(file, 'utf8').replace(/\bclass=(["'])(.*?)\1/g, (match, quote, names) => {
            const renamed = names.replace(/[\w-]+/g, (name) => mapping.get(name) || name);
            return match.replace(names, renamed);
        });
        fs.writeFileSync(file, await minifyHtml(html), 'utf8');
    }

    for (const file of jsFiles) {
        const source = renameJavaScriptClasses(fs.readFileSync(file, 'utf8'), mapping);
        const target = file === path.join(portableRoot, 'server.mjs') ? 'node' : 'browser';
        const result = JavaScriptObfuscator.obfuscate(source, { ...jsOptions, target }).getObfuscatedCode();
        fs.writeFileSync(file, result, 'utf8');
    }

    console.log(`مبهم‌سازی متوسط انجام شد: ${jsFiles.length} فایل JavaScript، ${cssFiles.length} فایل CSS و ${htmlFiles.length} فایل HTML؛ ${mapping.size} نام کلاس تغییر کرد.`);
}
