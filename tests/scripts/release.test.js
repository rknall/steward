'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var t = require('../runner');
var version = require('../../scripts/version');
var release = require('../../scripts/release');

t.test('parseSemver accepts a v prefix and drops a pre-release suffix', function () {
    t.assert.deepStrictEqual(release.parseSemver('v0.10.2'), { major: 0, minor: 10, patch: 2 });
    t.assert.deepStrictEqual(release.parseSemver('0.5.0-alpha3'), { major: 0, minor: 5, patch: 0 });
    t.assert.strictEqual(release.parseSemver('x'), null);
});

t.test('nextVersion bumps patch, minor and major', function () {
    t.assert.strictEqual(release.nextVersion('v0.10.2', 'patch'), '0.10.3');
    t.assert.strictEqual(release.nextVersion('v0.10.2', 'minor'), '0.11.0');
    t.assert.strictEqual(release.nextVersion('v0.10.2', 'major'), '1.0.0');
});

t.test('bumpLevel defaults to patch and takes the highest trailer', function () {
    t.assert.strictEqual(release.bumpLevel([]), 'patch');
    t.assert.strictEqual(release.bumpLevel(['fix a thing']), 'patch');
    t.assert.strictEqual(release.bumpLevel(['x\n\nBump: minor']), 'minor');
    t.assert.strictEqual(release.bumpLevel(['x\n\nBump: minor', 'y\n\nBump: major']), 'major');
    t.assert.strictEqual(release.bumpLevel(['x\n\nbump: MINOR\n']), 'minor');
});

t.test('bumpLevel finds a trailer mid-body and ignores inline mentions', function () {
    t.assert.strictEqual(release.bumpLevel(['x\n\nBump: minor\n\nFixes #3\nAssisted-by: Claude']), 'minor');
    t.assert.strictEqual(release.bumpLevel(['x\n\nnot a Bump: minor line']), 'patch');
    t.assert.strictEqual(release.bumpLevel(['x\n\nRebump: minor']), 'patch');
});

t.test('cleanSubject strips a legacy version suffix', function () {
    t.assert.strictEqual(release.cleanSubject('adventures: top up short takes; v0.10.13'), 'adventures: top up short takes');
    t.assert.strictEqual(release.cleanSubject('core: plain subject'), 'core: plain subject');
});

t.test('issueRefs takes Fixes and Refs lines once each', function () {
    t.assert.deepStrictEqual(
        release.issueRefs('text\nFixes #12\nRefs #7\nfixes #12\nAssisted-by: Claude'),
        ['12', '7']
    );
    t.assert.deepStrictEqual(release.issueRefs(''), []);
});

t.test('formatNotes writes one line per commit and handles an empty list', function () {
    var out = release.formatNotes([
        { sha: 'abcdef1234567', subject: 'mining: x; v0.1.2', body: 'Fixes #4\nRefs #5' },
        { sha: '1234567abcdef', subject: 'core: y', body: '' }
    ]);
    t.assert.strictEqual(out, '- mining: x (abcdef1) #4, #5\n- core: y (1234567)\n');
    t.assert.strictEqual(release.formatNotes([]), 'No changes.\n');
});

// Integration cases run against a throwaway repo, never the real one.
var tmpProbe = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-release-'));
var gitAvailable = version.git(['--version'], tmpProbe) !== null;
fs.rmSync(tmpProbe, { recursive: true, force: true });

function makeRepo() {
    var root = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-release-'));
    version.git(['init', '-q'], root);
    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.1.0"}');
    return root;
}

function commit(root, args) {
    var base = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
    return version.git(base.concat(args), root);
}

function emptyCommit(root, subject, body) {
    var args = ['commit', '-q', '--allow-empty', '-m', subject];
    if (body) args.push('-m', body);
    commit(root, args);
}

t.test('release plan without any tag uses the package version', function () {
    if (!gitAvailable) { console.log('  (skipped: git not available)'); return; }
    var root = makeRepo();
    try {
        emptyCommit(root, 'first');
        var p = release.plan(root, {});
        t.assert.strictEqual(p.base, null);
        t.assert.strictEqual(p.version, '0.1.0');
        t.assert.strictEqual(p.headTagged, false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

t.test('release plan from a tag counts commits and reads the bump trailer', function () {
    if (!gitAvailable) { console.log('  (skipped: git not available)'); return; }
    var root = makeRepo();
    try {
        emptyCommit(root, 'first');
        version.git(['tag', 'v0.1.0'], root);
        emptyCommit(root, 'mining: add a thing; v0.1.1', 'Fixes #9');
        emptyCommit(root, 'core: new module', 'Bump: minor');
        var p = release.plan(root, {});
        t.assert.strictEqual(p.base, 'v0.1.0');
        t.assert.strictEqual(p.version, '0.2.0');
        t.assert.strictEqual(p.level, 'minor');
        t.assert.strictEqual(p.pending, true);
        t.assert.strictEqual(p.count, 2);
        t.assert.ok(p.notes.indexOf('mining: add a thing (') !== -1);
        t.assert.ok(p.notes.indexOf('#9') !== -1);
        t.assert.ok(p.notes.indexOf('core: new module') !== -1);

        version.git(['tag', 'v0.2.0'], root);
        var tagged = release.plan(root, {});
        t.assert.strictEqual(tagged.headTagged, true);
        var at = release.plan(root, { at: 'v0.2.0' });
        t.assert.strictEqual(at.base, 'v0.1.0');
        t.assert.strictEqual(at.version, '0.2.0');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

t.test('release plan reads a bump from a merge commit but leaves it out of the notes', function () {
    if (!gitAvailable) { console.log('  (skipped: git not available)'); return; }
    var root = makeRepo();
    try {
        emptyCommit(root, 'first');
        version.git(['tag', 'v0.1.0'], root);
        var main = version.git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
        version.git(['checkout', '-q', '-b', 'topic'], root);
        emptyCommit(root, 'topic: work');
        version.git(['checkout', '-q', main], root);
        emptyCommit(root, 'main: other work');
        commit(root, ['merge', '--no-ff', '-q', 'topic', '-m', 'Merge x', '-m', 'Bump: major']);
        var p = release.plan(root, {});
        t.assert.strictEqual(p.level, 'major');
        t.assert.strictEqual(p.version, '1.0.0');
        t.assert.ok(p.notes.indexOf('topic: work') !== -1);
        t.assert.ok(p.notes.indexOf('Merge x') === -1);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
