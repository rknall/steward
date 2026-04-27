#!/usr/bin/env node
/*
 * Steward test runner.
 *
 * Discovers tests/<area>/*.test.js, executes each with a flat test(name, fn)
 * API, reports pass/fail counts. Zero deps; assertions via Node's built-in
 * assert.strict.
 *
 *   var t = require('../runner');
 *   t.test('description', function () { ... });
 *   t.test('async description', function (done) { ...; done(); });
 *
 * Exit code: 0 if all pass, 1 on any failure or load error.
 *
 * CLI:
 *   node tests/runner.js                      # discover all
 *   node tests/runner.js tests/core/x.test.js # single file
 */

'use strict';

var fs     = require('fs');
var path   = require('path');
var assert = require('assert').strict;

var REPO_ROOT = path.resolve(__dirname, '..');
var TESTS_DIR = path.join(REPO_ROOT, 'tests');

var color = (process.stdout.isTTY && !process.env.NO_COLOR);
function red(s)    { return color ? '[31m' + s + '[0m' : s; }
function green(s)  { return color ? '[32m' + s + '[0m' : s; }
function yellow(s) { return color ? '[33m' + s + '[0m' : s; }
function dim(s)    { return color ? '[2m'  + s + '[0m' : s; }

// Mutable per-file collection. Each .test.js file calls test(...) at top
// level; runFile drains the bucket between files.
var current = null;

function test(name, fn) {
    if (!current) {
        throw new Error('test() called outside a discovered file — require runner only from .test.js');
    }
    current.tests.push({ name: name, fn: fn });
}

function discover(rootDir) {
    var out = [];
    if (!fs.existsSync(rootDir)) return out;
    var entries = fs.readdirSync(rootDir, { withFileTypes: true });
    entries.sort(function (a, b) { return a.name.localeCompare(b.name); });
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var full = path.join(rootDir, e.name);
        if (e.isDirectory()) {
            Array.prototype.push.apply(out, discover(full));
        } else if (e.isFile() && /\.test\.js$/.test(e.name)) {
            out.push(full);
        }
    }
    return out;
}

function runOne(spec) {
    return new Promise(function (resolve) {
        var done = false;
        var t0 = Date.now();
        function finish(err) {
            if (done) return;
            done = true;
            resolve({ err: err || null, ms: Date.now() - t0 });
        }
        try {
            if (spec.fn.length === 0) {
                spec.fn();
                finish();
            } else {
                spec.fn(function (err) { finish(err); });
                setTimeout(function () { finish(new Error('timeout (5s)')); }, 5000).unref();
            }
        } catch (e) { finish(e); }
    });
}

async function runFile(absPath) {
    current = { tests: [] };
    var rel = path.relative(REPO_ROOT, absPath);
    try {
        delete require.cache[require.resolve(absPath)];
        require(absPath);
    } catch (e) {
        process.stdout.write('  ' + red('FAIL') + '  ' + rel + dim('  (load error)') + '\n');
        process.stdout.write(dim('         ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n         ')) + '\n');
        current = null;
        return { rel: rel, passed: 0, failed: 1, ms: 0 };
    }
    var passed = 0, failed = 0, ms = 0, errors = [];
    var tests = current.tests;
    current = null;
    for (var i = 0; i < tests.length; i++) {
        var r = await runOne(tests[i]);
        ms += r.ms;
        if (r.err) {
            failed++;
            errors.push({ name: tests[i].name, err: r.err });
        } else {
            passed++;
        }
    }
    var label = (failed === 0) ? green('PASS') : red('FAIL');
    process.stdout.write('  ' + label + '  ' + rel +
        '  ' + dim('(' + (passed + failed) + ' tests, ' + ms + 'ms)') + '\n');
    for (var j = 0; j < errors.length; j++) {
        process.stdout.write('        ' + red('x ') + errors[j].name + '\n');
        var stack = errors[j].err.stack || errors[j].err.message;
        var lines = stack.split('\n').slice(0, 5);
        for (var k = 0; k < lines.length; k++) {
            process.stdout.write(dim('          ' + lines[k]) + '\n');
        }
    }
    return { rel: rel, passed: passed, failed: failed, ms: ms };
}

async function main() {
    var args = process.argv.slice(2);
    var files;
    if (args.length) {
        files = args.map(function (a) { return path.resolve(a); });
    } else {
        files = discover(TESTS_DIR);
    }
    if (files.length === 0) {
        process.stdout.write(yellow('No tests found.\n'));
        process.exit(0);
    }
    process.stdout.write('Steward tests\n');
    var totals = { passed: 0, failed: 0, files: 0, failedFiles: 0, ms: 0 };
    for (var i = 0; i < files.length; i++) {
        var r = await runFile(files[i]);
        totals.files++;
        if (r.failed > 0) totals.failedFiles++;
        totals.passed += r.passed;
        totals.failed += r.failed;
        totals.ms     += r.ms;
    }
    process.stdout.write('\n');
    process.stdout.write('Files: ' + totals.files + ' (' + totals.failedFiles + ' failed)\n');
    process.stdout.write('Tests: ' + green(totals.passed + ' passed') + ', ' +
        (totals.failed ? red(totals.failed + ' failed') : '0 failed') + '\n');
    process.stdout.write('Time:  ' + totals.ms + 'ms\n');
    process.exit(totals.failed === 0 ? 0 : 1);
}

module.exports = { test: test, assert: assert };

if (require.main === module) {
    main().catch(function (e) {
        process.stderr.write(red('Runner crashed: ') + (e.stack || e.message) + '\n');
        process.exit(1);
    });
}
