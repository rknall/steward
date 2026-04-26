#!/usr/bin/env node
/*
 * Steward lint wrapper.
 *
 * Runs ESLint with the AIR-compatible ruleset (defined in .eslintrc.json) over
 * src/. Exists so `npm run lint` and the husky pre-commit hook share a single
 * code path, and so we can extend with extra checks later (e.g. bundle size,
 * dual-namespace collisions) without touching package.json.
 *
 * Usage:
 *   node scripts/lint-air.js              # check src/
 *   node scripts/lint-air.js --fix        # auto-fix where possible
 *   node scripts/lint-air.js path/to/file.js [...]   # check explicit files
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');

const args = process.argv.slice(2);
const explicitTargets = args.filter(function (a) { return a !== '--fix'; });
const fix = args.indexOf('--fix') !== -1;

const eslintBin = path.join(REPO_ROOT, 'node_modules', '.bin', 'eslint');
if (!fs.existsSync(eslintBin)) {
    process.stderr.write('lint-air: eslint not installed. Run `npm install` first.\n');
    process.exit(1);
}

const targets = explicitTargets.length > 0 ? explicitTargets : [SRC_DIR];
const eslintArgs = [];
if (fix) eslintArgs.push('--fix');
eslintArgs.push('--no-error-on-unmatched-pattern');
Array.prototype.push.apply(eslintArgs, targets);

const result = spawnSync(eslintBin, eslintArgs, { cwd: REPO_ROOT, stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
