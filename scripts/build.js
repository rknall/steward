#!/usr/bin/env node
/*
 * Steward build script.
 *
 * Concatenates every JS file under src/ (in deterministic, prefix-driven order)
 * into a single bundle at build/user_steward.js. Output is a plain script — no
 * modules, no transpilation — because the target runtime (Adobe AIR 32) does
 * not support ES modules.
 *
 * Load order:
 *   1. src/kernel/<NN>_*.js   (lexicographic, numeric prefix drives order)
 *   2. src/core/**\/*.js       (lexicographic per directory)
 *   3. src/modules/**\/*.js    (lexicographic per directory)
 *   4. src/vendor/**\/*.js     (lexicographic, optional)
 *
 * Usage:
 *   node scripts/build.js
 *   STEWARD_VERSION=0.1.0 node scripts/build.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const BUILD_DIR = path.join(REPO_ROOT, 'build');
const OUTPUT_FILE = path.join(BUILD_DIR, 'user_steward.js');

const SECTIONS = [
    { label: 'kernel',  dir: path.join(SRC_DIR, 'kernel'),  recursive: false },
    { label: 'core',    dir: path.join(SRC_DIR, 'core'),    recursive: true  },
    { label: 'modules', dir: path.join(SRC_DIR, 'modules'), recursive: true  },
    { label: 'vendor',  dir: path.join(SRC_DIR, 'vendor'),  recursive: true  }
];

function collectFiles(dir, recursive) {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (recursive) Array.prototype.push.apply(out, collectFiles(full, true));
            continue;
        }
        if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

function gitShortSha() {
    try {
        return execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
            .toString().trim();
    } catch (e) {
        return 'unknown';
    }
}

function isoDate() {
    return new Date().toISOString().slice(0, 10);
}

function readVersion() {
    if (process.env.STEWARD_VERSION) return process.env.STEWARD_VERSION;
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
        return pkg.version || '0.0.0';
    } catch (e) {
        return '0.0.0';
    }
}

function banner(version, sha, date, fileCount, byteCount) {
    return [
        '/*',
        ' * Steward v' + version,
        ' * Built ' + date + ' from commit ' + sha,
        ' * Files: ' + fileCount + '  Size: ' + byteCount + ' bytes',
        ' *',
        ' * Modular automation framework for The Settlers Online.',
        ' * Source: https://github.com/rknall/steward',
        ' * License: GPL-3.0-or-later',
        ' *',
        ' * THIS FILE IS GENERATED. Do not edit by hand — change source under',
        ' * src/ and run `npm run build`.',
        ' */',
        ''
    ].join('\n');
}

function build() {
    if (!fs.existsSync(BUILD_DIR)) fs.mkdirSync(BUILD_DIR, { recursive: true });

    const parts = [];
    let totalFiles = 0;

    for (let i = 0; i < SECTIONS.length; i++) {
        const section = SECTIONS[i];
        const files = collectFiles(section.dir, section.recursive);
        if (files.length === 0) continue;

        parts.push('/* ===== ' + section.label + ' ===== */');
        for (let j = 0; j < files.length; j++) {
            const rel = path.relative(REPO_ROOT, files[j]);
            const body = fs.readFileSync(files[j], 'utf8').replace(/\r\n/g, '\n');
            parts.push('/* --- ' + rel + ' --- */');
            parts.push(body.endsWith('\n') ? body : body + '\n');
            totalFiles++;
        }
    }

    const body = parts.join('\n');
    const version = readVersion();
    const sha = gitShortSha();
    const date = isoDate();
    const head = banner(version, sha, date, totalFiles, Buffer.byteLength(body, 'utf8'));

    fs.writeFileSync(OUTPUT_FILE, head + body, 'utf8');

    process.stdout.write(
        'Steward built: ' + path.relative(REPO_ROOT, OUTPUT_FILE) +
        ' (' + totalFiles + ' files, ' + Buffer.byteLength(head + body, 'utf8') + ' bytes, v' + version + ' / ' + sha + ')\n'
    );
}

build();
