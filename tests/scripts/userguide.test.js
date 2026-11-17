'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var t = require('../runner');
var guide = require('../../scripts/userguide');

var LAYOUT = '<title>{{title}}</title><a href="{{repo}}">gh</a><nav>{{nav}}</nav>' +
    '<main>{{content}}</main><footer>steward {{version}}</footer>';

var TITLES = { alpha: 'Zeta Alpha', beta: 'Beta Thing' };

function general(title, extra) {
    return '<h1>' + title + '</h1>\n<h2>Part</h2>\n<p>Text.</p>\n' + (extra || '');
}

function shot(name) {
    return '<figure class="ug-shot" data-shot="' + name + '">\n' +
        '<div class="ug-shot-box">Screenshot to come</div>\n' +
        '<figcaption>A <b>caption</b></figcaption>\n</figure>\n';
}

var STORY = '<div class="ug-story">\n<p class="ug-want">You want to x.</p>\n' +
    '<dl><dt>Steps</dt><dd><ol><li>Go.</li></ol></dd><dt>Result</dt><dd>Done.</dd></dl>\n</div>\n';

function setting(key) {
    return '<div class="ug-set">\n<h3><code>' + key + '</code></h3>\n' +
        '<p class="ug-def">Default: 1</p>\n<p>Meaning.</p>\n</div>\n';
}

// A valid module fragment; parts lets a test swap the pieces.
function modFrag(parts) {
    parts = parts || {};
    return '<p class="ug-lead">Lead.</p>\n' +
        (parts.use !== undefined ? parts.use : '<h2>What you can do</h2>\n' + STORY) +
        (parts.extra || '') +
        (parts.settings !== undefined ? parts.settings : '<h2>Settings</h2>\n<p>Intro.</p>\n' + setting('speed')) +
        (parts.notes !== undefined ? parts.notes : '<h2>Notes</h2>\n<p>Note.</p>\n');
}

function write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
}

// Builds a fixture tree and returns the opts for build(); mutate(root, src,
// mods) runs before the build so a test can break one thing.
function fixture(mutate) {
    var root = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-guide-'));
    var src = path.join(root, 'src');
    var mods = path.join(root, 'modules');
    write(path.join(src, '_layout.html'), LAYOUT);
    write(path.join(src, 'guide.css'), 'body{}');
    write(path.join(src, 'guide.js'), '//js');
    write(path.join(src, 'img', 'general-shot.png'), 'png');
    write(path.join(src, 'img', 'README.md'), 'readme');
    write(path.join(src, 'index.html'), general('Overview', shot('index-shot.png')));
    write(path.join(src, 'install.html'), general('Installing'));
    write(path.join(src, 'ui.html'), general('The UI'));
    write(path.join(src, 'logs.html'), general('Logs and data'));
    write(path.join(src, 'troubleshooting.html'), general('Troubleshooting'));
    write(path.join(mods, 'alpha', 'guide', 'page.html'),
        modFrag({ extra: '<h2>Extra part</h2>\n<p>More.</p>\n' }) + shot('alpha-shot.png'));
    write(path.join(mods, 'alpha', 'guide', 'img', 'alpha-shot.png'), 'png');
    write(path.join(mods, 'alpha', 'settings.js'), '');
    write(path.join(mods, 'beta', 'guide', 'page.html'),
        modFrag({ settings: '<h2>Settings</h2>\n<p>None.</p>\n' }) + shot('beta-shot.png'));
    if (mutate) mutate(root, src, mods);
    return {
        root: root,
        src: src,
        mods: mods,
        opts: {
            srcDir: src,
            modulesDir: mods,
            outDir: path.join(root, 'out'),
            version: '1.0.0',
            repoUrl: 'https://example.test/repo',
            moduleTitles: TITLES
        }
    };
}

function read(fx, slug) {
    return fs.readFileSync(path.join(fx.opts.outDir, slug + '.html'), 'utf8');
}

// settings.js text for alpha: the key "speed" is present.
function alphaSettings(mods) {
    write(path.join(mods, 'alpha', 'settings.js'), 'var speed = 1;');
}

function alphaPage(fx) {
    return path.join(fx.mods, 'alpha', 'guide', 'page.html');
}

function setAlpha(mods, text) {
    write(path.join(mods, 'alpha', 'guide', 'page.html'), text);
}

var SLUGS = ['index', 'install', 'ui', 'beta', 'alpha', 'logs', 'troubleshooting'];

function buildFx(mutate) {
    var fx = fixture(function (root, src, mods) {
        alphaSettings(mods);
        if (mutate) mutate(root, src, mods);
    });
    guide.build(fx.opts);
    return fx;
}

t.test('every page carries the escaped version', function () {
    var fx = fixture(function (r, s, mods) { alphaSettings(mods); });
    fx.opts.version = '1.0<x>&"';
    guide.build(fx.opts);
    SLUGS.forEach(function (s) {
        t.assert.ok(read(fx, s).indexOf('steward 1.0&lt;x&gt;&amp;&quot;') !== -1, s);
    });
});

t.test('without opts.version the STEWARD_VERSION env is used', function () {
    var fx = fixture(function (r, s, mods) { alphaSettings(mods); });
    delete fx.opts.version;
    var saved = process.env.STEWARD_VERSION;
    process.env.STEWARD_VERSION = '7.7.7-env';
    try {
        var res = guide.build(fx.opts);
        t.assert.strictEqual(res.version, '7.7.7-env');
        t.assert.ok(read(fx, 'index').indexOf('steward 7.7.7-env') !== -1);
    } finally {
        if (saved === undefined) delete process.env.STEWARD_VERSION;
        else process.env.STEWARD_VERSION = saved;
    }
});

t.test('the nav order is sections, then pages, with modules by display name', function () {
    var fx = fixture(function (r, s, mods) { alphaSettings(mods); });
    var res = guide.build(fx.opts);
    t.assert.deepStrictEqual(res.pages.map(function (p) { return p.slug; }), SLUGS);
    var html = read(fx, 'index');
    var l1 = [];
    html.replace(/<details class="l1"[^>]*><summary>([^<]*)<\/summary>/g, function (m, s) {
        l1.push(s);
        return m;
    });
    t.assert.deepStrictEqual(l1, ['Getting started', 'Modules', 'Reference']);
    var at = SLUGS.map(function (s) { return html.indexOf('href="' + s + '.html'); });
    for (var i = 1; i < at.length; i++) t.assert.ok(at[i] > at[i - 1], SLUGS[i]);
    t.assert.ok(html.indexOf('<summary>Beta Thing</summary>') !== -1);
    t.assert.ok(html.indexOf('<summary>Zeta Alpha</summary>') !== -1);
    t.assert.ok(html.indexOf('>alpha<') === -1 && html.indexOf('>beta<') === -1);
});

t.test('a module page gets its title, crumb and a title tag from the registry', function () {
    var fx = buildFx();
    var html = read(fx, 'alpha');
    t.assert.ok(html.indexOf('<h1>Zeta Alpha</h1>') !== -1);
    t.assert.ok(html.indexOf('<p class="ug-crumb">Modules &rsaquo; Zeta Alpha</p>\n<h1>') !== -1);
    t.assert.ok(html.indexOf('<title>Zeta Alpha</title>') !== -1);
});

t.test('a module fragment with its own h1 throws', function () {
    var fx = fixture(function (r, s, mods) {
        alphaSettings(mods);
        setAlpha(mods, '<h1>Mine</h1>' + modFrag());
    });
    t.assert.throws(function () { guide.build(fx.opts); }, /no <h1>/);
});

t.test('a module directory without guide/page.html throws and names the id', function () {
    var fx = fixture(function (r, s, mods) {
        fs.unlinkSync(path.join(mods, 'beta', 'guide', 'page.html'));
    });
    t.assert.throws(function () { guide.build(fx.opts); }, /module beta: missing guide\/page\.html/);
});

t.test('a module missing from moduleTitles throws', function () {
    var fx = fixture(function (r, s, mods) { alphaSettings(mods); });
    fx.opts.moduleTitles = { alpha: 'Zeta Alpha' };
    t.assert.throws(function () { guide.build(fx.opts); }, /module beta: not registered/);
});

function ownTitleFx(frag) {
    return fixture(function (r, s, mods) {
        alphaSettings(mods);
        write(path.join(mods, 'beta', 'guide', 'page.html'), frag);
    });
}

t.test('a module with no ui section takes its title from its own h1', function () {
    var fx = ownTitleFx('<h1>Beta Own</h1>\n' + modFrag({ settings: '<h2>Settings</h2>\n<p>None.</p>\n' }));
    fx.opts.moduleTitles = { alpha: 'Zeta Alpha', beta: null };
    guide.build(fx.opts);
    var html = read(fx, 'beta');
    t.assert.ok(html.indexOf('<p class="ug-crumb">Modules &rsaquo; Beta Own</p>\n<h1') !== -1);
    t.assert.ok(html.indexOf('<title>Beta Own</title>') !== -1);
    t.assert.ok(read(fx, 'alpha').indexOf('<summary>Beta Own</summary>') !== -1);
});

t.test('a module with no ui section and no h1 throws', function () {
    var fx = ownTitleFx(modFrag({ settings: '<h2>Settings</h2>\n<p>None.</p>\n' }));
    fx.opts.moduleTitles = { alpha: 'Zeta Alpha', beta: null };
    t.assert.throws(function () { guide.build(fx.opts); }, /no <h1> title/);
});

t.test('heading ids and the nav levels', function () {
    var fx = buildFx();
    var alpha = read(fx, 'alpha');
    t.assert.ok(alpha.indexOf('<h2 id="use-cases">What you can do</h2>') !== -1);
    t.assert.ok(alpha.indexOf('<h2 id="extra-part">Extra part</h2>') !== -1);
    t.assert.ok(alpha.indexOf('<h3 id="speed"><code>speed</code></h3>') !== -1);
    t.assert.ok(alpha.indexOf('<li class="l2 cur"><details open><summary aria-current="page">Zeta Alpha</summary>') !== -1);
    t.assert.ok(alpha.indexOf('<a href="alpha.html#use-cases" class="on">Use cases</a>') !== -1);
    var l3 = [];
    var block = /<li class="l2 cur">[\s\S]*?<\/li><\/ul><\/details><\/li>/.exec(alpha)[0];
    block.replace(/<li><a [^>]*>([^<]*)<\/a><\/li>/g, function (m, s) { l3.push(s); return m; });
    t.assert.deepStrictEqual(l3, ['Use cases', 'Extra part', 'Settings', 'Notes']);
    t.assert.ok(alpha.indexOf('<li class="l2"><details><summary>Beta Thing</summary>') !== -1);
    t.assert.ok(alpha.indexOf('<a href="beta.html#use-cases">Use cases</a>') !== -1);
    t.assert.ok(alpha.indexOf('<details class="l1"><summary>Getting started') !== -1);
    t.assert.ok(alpha.indexOf('<details class="l1"><summary>Reference') !== -1);
    var index = read(fx, 'index');
    t.assert.ok(index.indexOf('<details class="l1" open><summary>Getting started') !== -1);
    t.assert.ok(index.indexOf('<details class="l1" open><summary>Modules') !== -1);
    t.assert.ok(index.indexOf('<details class="l1"><summary>Reference') !== -1);
    t.assert.ok(index.indexOf('class="l3"') !== -1, 'modules still list l3 links');
    var logs = read(fx, 'logs');
    t.assert.ok(logs.indexOf('<details class="l1" open><summary>Reference') !== -1);
    t.assert.ok(logs.indexOf('<details class="l1" open><summary>Modules') !== -1);
    t.assert.ok(logs.indexOf('<details class="l1"><summary>Getting started') !== -1);
    t.assert.ok(logs.indexOf('<p class="ug-crumb">Reference &rsaquo; Logs and data</p>\n<h1>') !== -1);
    t.assert.ok(logs.indexOf('<li class="l2"><a href="logs.html" class="on" aria-current="page">') !== -1);
    t.assert.ok(!/<li class="l2"><a[^>]*>[^<]*<\/a><ul class="l3"/.test(logs), 'general pages have no l3 list');
});

t.test('an explicit id is kept and a duplicate id throws', function () {
    var fx = fixture(function (r, s, mods) {
        alphaSettings(mods);
        setAlpha(mods, modFrag({ extra: '<h2 id="mine">Extra</h2>\n' }));
    });
    guide.build(fx.opts);
    t.assert.ok(read(fx, 'alpha').indexOf('<h2 id="mine">Extra</h2>') !== -1);
    var dup = fixture(function (r, s, mods) {
        alphaSettings(mods);
        setAlpha(mods, modFrag({ extra: '<h2>Extra</h2>\n<h2>Extra</h2>\n' }));
    });
    t.assert.throws(function () { guide.build(dup.opts); }, /duplicate heading id extra/);
});

t.test('each page has exactly one aria-current page', function () {
    var fx = buildFx();
    SLUGS.forEach(function (s) {
        t.assert.strictEqual(read(fx, s).split('aria-current="page"').length - 1, 1, s);
    });
});

t.test('module structure violations throw', function () {
    function throwsFor(parts, re) {
        var fx = fixture(function (r, s, mods) {
            alphaSettings(mods);
            setAlpha(mods, modFrag(parts));
        });
        t.assert.throws(function () { guide.build(fx.opts); }, re);
    }
    throwsFor({ use: '<h2>Extra</h2>\n<h2>What you can do</h2>\n' + STORY }, /first h2/);
    throwsFor({ use: '<h2>What you can do</h2>\n<p>No story.</p>\n' }, /ug-story/);
    throwsFor({ settings: '' }, /Settings/);
    throwsFor({ notes: '<h2>Notes</h2>\n<h2>Late</h2>\n' }, /Notes/);
    var fx = fixture(function (r, s, mods) {
        setAlpha(mods, modFrag());
        fs.unlinkSync(path.join(mods, 'alpha', 'settings.js'));
    });
    t.assert.throws(function () { guide.build(fx.opts); }, /no settings\.js/);
});

t.test('unknown token, missing h1, unlisted general fragment and extra guide html throw', function () {
    var tok = fixture(function (r, s, mods) {
        alphaSettings(mods);
        write(path.join(s, 'ui.html'), general('The UI', '<p>{{foo}}</p>'));
    });
    t.assert.throws(function () { guide.build(tok.opts); }, /\{\{foo\}\}/);
    var h1 = fixture(function (r, s, mods) {
        alphaSettings(mods);
        write(path.join(s, 'install.html'), '<p>no title</p>');
    });
    t.assert.throws(function () { guide.build(h1.opts); }, /no <h1>/);
    var unl = fixture(function (r, s, mods) {
        alphaSettings(mods);
        write(path.join(s, 'gamma.html'), general('gamma'));
    });
    t.assert.throws(function () { guide.build(unl.opts); }, /unlisted page fragment.*gamma/);
    var extra = fixture(function (r, s, mods) {
        alphaSettings(mods);
        write(path.join(mods, 'alpha', 'guide', 'other.html'), '<p>x</p>');
    });
    t.assert.throws(function () { guide.build(extra.opts); }, /unlisted page fragment.*other/);
});

t.test('shots resolve per page kind and bad names throw', function () {
    var fx = buildFx(function (r, s) {
        write(path.join(s, 'index.html'), general('Overview', shot('index-shot.png')));
        write(path.join(s, 'img', 'index-shot.png'), 'png');
    });
    var alpha = read(fx, 'alpha');
    t.assert.ok(alpha.indexOf('<img src="img/alpha-shot.png" alt="A caption">') !== -1);
    t.assert.ok(alpha.indexOf('ug-shot-box') === -1);
    t.assert.ok(read(fx, 'index').indexOf('<img src="img/index-shot.png"') !== -1);
    t.assert.ok(read(fx, 'beta').indexOf('ug-shot-box') !== -1);
    var bad = fixture(function (r, s, mods) {
        alphaSettings(mods);
        setAlpha(mods, modFrag() + shot('Bad Name.gif'));
    });
    t.assert.throws(function () { guide.build(bad.opts); }, /bad data-shot/);
    var pre = fixture(function (r, s, mods) {
        alphaSettings(mods);
        setAlpha(mods, modFrag() + shot('beta-x.png'));
    });
    t.assert.throws(function () { guide.build(pre.opts); }, /must start with "alpha-"/);
});

t.test('an output dir holding the repo root or the sources throws', function () {
    var fx = fixture();
    var repoRoot = path.resolve(__dirname, '..', '..');
    fx.opts.outDir = repoRoot;
    t.assert.throws(function () { guide.build(fx.opts); }, /refusing output dir/);
    fx.opts.outDir = fx.root;
    t.assert.throws(function () { guide.build(fx.opts); }, /refusing output dir/);
});

t.test('css, js and both img sources are copied, the img README is not', function () {
    var fx = buildFx();
    var out = fx.opts.outDir;
    t.assert.ok(fs.existsSync(path.join(out, 'guide.css')));
    t.assert.ok(fs.existsSync(path.join(out, 'guide.js')));
    t.assert.ok(fs.existsSync(path.join(out, 'img', 'general-shot.png')));
    t.assert.ok(fs.existsSync(path.join(out, 'img', 'alpha-shot.png')));
    t.assert.ok(!fs.existsSync(path.join(out, 'img', 'README.md')));
});

t.test('moduleTitles covers every module directory', function () {
    var titles = guide.moduleTitles();
    var dir = path.resolve(__dirname, '..', '..', 'src', 'modules');
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
        if (e.isDirectory()) {
            t.assert.ok(Object.prototype.hasOwnProperty.call(titles, e.name), e.name);
        }
    });
    t.assert.strictEqual(titles.collect, 'Collect Pickups');
    t.assert.strictEqual(titles.rebuild, null);
});

t.test('slugify lowercases and trims', function () {
    t.assert.strictEqual(guide.slugify('  What you can do! '), 'what-you-can-do');
});

t.test('checkFragment validates single fragments', function () {
    var fx = fixture(function (r, s, mods) { alphaSettings(mods); });
    var res = guide.checkFragment(alphaPage(fx), { moduleTitles: TITLES });
    t.assert.strictEqual(res.slug, 'alpha');
    t.assert.strictEqual(res.title, 'Zeta Alpha');
    t.assert.strictEqual(res.section, 'Modules');
    var gen = guide.checkFragment(path.join(fx.src, 'logs.html'));
    t.assert.deepStrictEqual([gen.slug, gen.title, gen.section], ['logs', 'Logs and data', 'Reference']);

    setAlpha(fx.mods, modFrag({ settings: '<h2>Settings</h2>\n' + setting('missingkey') }));
    t.assert.throws(function () {
        guide.checkFragment(alphaPage(fx), { moduleTitles: TITLES });
    }, /missingkey/);
    setAlpha(fx.mods, modFrag({ notes: '<h2>Notes</h2>\n<h2>Late</h2>\n' }));
    t.assert.throws(function () {
        guide.checkFragment(alphaPage(fx), { moduleTitles: TITLES });
    }, /page\.html.*Notes/);
    write(path.join(fx.src, 'other.html'), general('Other'));
    t.assert.throws(function () {
        guide.checkFragment(path.join(fx.src, 'other.html'));
    }, /not listed in SECTIONS/);
});

t.test('main --check reports a failing file and combining with --out throws', function () {
    var fx = fixture(function (r, s, mods) { alphaSettings(mods); });
    var good = path.join(fx.src, 'logs.html');
    var bad = path.join(fx.src, 'other.html');
    write(bad, general('Other'));
    var out = [];
    var err = [];
    var wOut = process.stdout.write;
    var wErr = process.stderr.write;
    process.stdout.write = function (s) { out.push(String(s)); return true; };
    process.stderr.write = function (s) { err.push(String(s)); return true; };
    var code;
    try {
        code = guide.main(['--check', good, bad]);
    } finally {
        process.stdout.write = wOut;
        process.stderr.write = wErr;
    }
    t.assert.strictEqual(code, 1);
    t.assert.ok(out.join('').indexOf('ok ' + good) !== -1);
    t.assert.ok(err.join('').indexOf('other.html') !== -1);
    t.assert.throws(function () { guide.main(['--check', good, '--out', 'x']); }, /cannot be combined/);
});
