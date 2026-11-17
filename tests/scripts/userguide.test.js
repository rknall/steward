'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var t = require('../runner');
var guide = require('../../scripts/userguide');

var LAYOUT = '<title>{{title}}</title><a href="{{repo}}">gh</a><nav>{{nav}}</nav>' +
    '<main>{{content}}</main><footer>steward {{version}}</footer>';

function frag(title, extra) {
    return '<h1>' + title + '</h1>\n<p class="ug-lead">Lead.</p>\n' + (extra || '');
}

function shot(name) {
    return '<figure class="ug-shot" data-shot="' + name + '">\n' +
        '<div class="ug-shot-box">Screenshot to come</div>\n' +
        '<figcaption>A <b>caption</b></figcaption>\n</figure>\n';
}

function write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
}

// Builds a fixture tree and returns the opts for build(); mutate(root) runs
// before the build so a test can break one thing.
function fixture(mutate) {
    var root = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-guide-'));
    var src = path.join(root, 'src');
    var mods = path.join(root, 'modules');
    write(path.join(src, '_layout.html'), LAYOUT);
    write(path.join(src, 'guide.css'), 'body{}');
    write(path.join(src, 'guide.js'), '//js');
    write(path.join(src, 'img', 'alpha-shot.png'), 'png');
    write(path.join(src, 'img', 'README.md'), 'readme');
    write(path.join(src, 'index.html'), frag('Overview'));
    write(path.join(src, 'install.html'), frag('Installing'));
    write(path.join(src, 'ui.html'), frag('The UI'));
    write(path.join(src, 'modules', 'alpha.html'), frag('alpha', shot('alpha-shot.png')));
    write(path.join(src, 'modules', 'beta.html'), frag('beta', shot('beta-shot.png')));
    fs.mkdirSync(path.join(mods, 'alpha'), { recursive: true });
    fs.mkdirSync(path.join(mods, 'beta'), { recursive: true });
    if (mutate) mutate(root, src, mods);
    return {
        root: root,
        opts: {
            srcDir: src,
            modulesDir: mods,
            outDir: path.join(root, 'out'),
            version: '1.0.0',
            repoUrl: 'https://example.test/repo'
        }
    };
}

function read(fx, slug) {
    return fs.readFileSync(path.join(fx.opts.outDir, slug + '.html'), 'utf8');
}

var SLUGS = ['index', 'install', 'ui', 'alpha', 'beta'];

t.test('every page carries the escaped version', function () {
    var fx = fixture();
    fx.opts.version = '1.0<x>&"';
    guide.build(fx.opts);
    SLUGS.forEach(function (s) {
        t.assert.ok(read(fx, s).indexOf('steward 1.0&lt;x&gt;&amp;&quot;') !== -1, s);
    });
});

t.test('without opts.version the STEWARD_VERSION env is used', function () {
    var fx = fixture();
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

t.test('each page marks exactly its own nav link as current', function () {
    var fx = fixture();
    guide.build(fx.opts);
    SLUGS.forEach(function (s) {
        var html = read(fx, s);
        t.assert.strictEqual(html.split('class="on"').length - 1, 1, s);
        t.assert.ok(html.indexOf('<a href="' + s + '.html" class="on" aria-current="page">') !== -1, s);
    });
});

t.test('the nav lists general pages, then modules alphabetically', function () {
    var fx = fixture();
    var res = guide.build(fx.opts);
    t.assert.deepStrictEqual(res.pages.map(function (p) { return p.slug; }), SLUGS);
    var html = read(fx, 'index');
    var at = SLUGS.map(function (s) { return html.indexOf('href="' + s + '.html"'); });
    for (var i = 1; i < at.length; i++) t.assert.ok(at[i] > at[i - 1], SLUGS[i]);
    t.assert.ok(html.indexOf('<p class="ug-group">Modules</p>') > at[2]);
    t.assert.ok(html.indexOf('<title>Overview</title>') !== -1);
});

t.test('a missing module fragment throws and names the id', function () {
    var fx = fixture(function (root, src) {
        fs.unlinkSync(path.join(src, 'modules', 'beta.html'));
    });
    t.assert.throws(function () { guide.build(fx.opts); }, /beta/);
});

t.test('an unlisted fragment throws', function () {
    var fx = fixture(function (root, src) {
        write(path.join(src, 'modules', 'gamma.html'), frag('gamma'));
    });
    t.assert.throws(function () { guide.build(fx.opts); }, /unlisted page fragment.*gamma/);
});

t.test('an unknown token throws', function () {
    var fx = fixture(function (root, src) {
        write(path.join(src, 'ui.html'), frag('The UI', '<p>{{foo}}</p>'));
    });
    t.assert.throws(function () { guide.build(fx.opts); }, /\{\{foo\}\}/);
});

t.test('a fragment without an h1 throws', function () {
    var fx = fixture(function (root, src) {
        write(path.join(src, 'install.html'), '<p>no title</p>');
    });
    t.assert.throws(function () { guide.build(fx.opts); }, /no <h1>/);
});

t.test('an existing shot becomes an img and a missing one keeps its box', function () {
    var fx = fixture();
    guide.build(fx.opts);
    var alpha = read(fx, 'alpha');
    t.assert.ok(alpha.indexOf('<img src="img/alpha-shot.png" alt="A caption">') !== -1);
    t.assert.ok(alpha.indexOf('ug-shot-box') === -1);
    t.assert.ok(read(fx, 'beta').indexOf('ug-shot-box') !== -1);
});

t.test('a bad data-shot value throws', function () {
    var fx = fixture(function (root, src) {
        write(path.join(src, 'modules', 'alpha.html'), frag('alpha', shot('Bad Name.gif')));
    });
    t.assert.throws(function () { guide.build(fx.opts); }, /bad data-shot/);
});

t.test('an output dir holding the repo root or the sources throws', function () {
    var fx = fixture();
    var repoRoot = path.resolve(__dirname, '..', '..');
    fx.opts.outDir = repoRoot;
    t.assert.throws(function () { guide.build(fx.opts); }, /refusing output dir/);
    fx.opts.outDir = fx.root;
    t.assert.throws(function () { guide.build(fx.opts); }, /refusing output dir/);
});

t.test('css and js are copied, the img README is not', function () {
    var fx = fixture();
    guide.build(fx.opts);
    var out = fx.opts.outDir;
    t.assert.ok(fs.existsSync(path.join(out, 'guide.css')));
    t.assert.ok(fs.existsSync(path.join(out, 'guide.js')));
    t.assert.ok(fs.existsSync(path.join(out, 'img', 'alpha-shot.png')));
    t.assert.ok(!fs.existsSync(path.join(out, 'img', 'README.md')));
});
