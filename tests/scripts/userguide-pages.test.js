'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var t = require('../runner');
var guide = require('../../scripts/userguide');

var ROOT = path.resolve(__dirname, '..', '..');
var VERSION = '9.9.9-test<&>';
var VERSION_HTML = '9.9.9-test&lt;&amp;&gt;';

// One build of the real tree is shared by every test below.
var outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-guide-real-'));
var result = guide.build({ outDir: outDir, version: VERSION });
var titles = guide.moduleTitles();
var modules = result.pages.filter(function (p) { return p.section === 'Modules'; });
var htmlCache = {};

function page(slug) {
    if (!htmlCache[slug]) htmlCache[slug] = fs.readFileSync(path.join(outDir, slug + '.html'), 'utf8');
    return htmlCache[slug];
}

function fragmentFile(p) {
    return p.section === 'Modules'
        ? path.join(ROOT, 'src', 'modules', p.slug, 'guide', 'page.html')
        : path.join(ROOT, 'docs', 'userguide', p.slug + '.html');
}

function count(haystack, needle) {
    return haystack.split(needle).length - 1;
}

function matches(re, text) {
    var out = [];
    var m;
    while ((m = re.exec(text))) out.push(m);
    return out;
}

function plain(html) {
    return html.replace(/<[^>]*>/g, '').trim();
}

t.test('the real tree builds and every module has a guide page', function () {
    t.assert.ok(result.pages.length >= 8);
    t.assert.ok(modules.length >= 1);
    modules.forEach(function (p) {
        t.assert.ok(fs.existsSync(fragmentFile(p)), p.slug);
    });
});

t.test('every page shows the escaped version in the nav and the footer', function () {
    result.pages.forEach(function (p) {
        var html = page(p.slug);
        t.assert.strictEqual(count(html, 'steward ' + VERSION_HTML), 2, p.slug);
        t.assert.ok(html.indexOf('<p class="ug-ver">steward ' + VERSION_HTML + '</p>') !== -1, p.slug);
        t.assert.ok(html.indexOf('<footer class="ug-foot">steward ' + VERSION_HTML + '</footer>') !== -1, p.slug);
    });
});

t.test('no token is left and an image only appears inside a screenshot figure', function () {
    result.pages.forEach(function (p) {
        var html = page(p.slug);
        t.assert.ok(html.indexOf('{{') === -1, p.slug);
        var bare = html.replace(/<figure class="ug-shot"[\s\S]*?<\/figure>/g, '');
        t.assert.ok(!/<img\b/i.test(bare), p.slug + ' has an image outside a ug-shot figure');
    });
});

t.test('every relative href and src resolves, fragments included', function () {
    result.pages.forEach(function (p) {
        matches(/\b(?:href|src)="([^"]*)"/g, page(p.slug)).forEach(function (m) {
            var url = m[1];
            if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.indexOf('//') === 0) return;
            var hash = url.indexOf('#');
            var file = hash === -1 ? url : url.slice(0, hash);
            var frag = hash === -1 ? '' : url.slice(hash + 1);
            var target = file ? path.join(outDir, file) : path.join(outDir, p.slug + '.html');
            t.assert.ok(fs.existsSync(target), p.slug + ': ' + url + ' does not resolve');
            if (frag) {
                var body = fs.readFileSync(target, 'utf8');
                t.assert.ok(body.indexOf('id="' + frag + '"') !== -1, p.slug + ': ' + url + ' has no target id');
            }
        });
    });
});

t.test('a module page title and nav summary equal the registered title', function () {
    modules.forEach(function (p) {
        var title = titles[p.slug];
        t.assert.ok(title, p.slug);
        t.assert.strictEqual(p.title, title);
        var html = page(p.slug);
        t.assert.ok(html.indexOf('<h1>' + guide.escapeHtml(title) + '</h1>') !== -1, p.slug + ' h1');
        var nav = matches(/<li class="l2[^"]*"><details[^>]*><summary[^>]*>([^<]*)<\/summary>/g, html)
            .map(function (m) { return m[1]; });
        t.assert.ok(nav.indexOf(guide.escapeHtml(title)) !== -1, p.slug + ' nav summary');
    });
});

t.test('every documented setting key occurs in the module settings.js', function () {
    modules.forEach(function (p) {
        var settings = path.join(ROOT, 'src', 'modules', p.slug, 'settings.js');
        var fragment = fs.readFileSync(fragmentFile(p), 'utf8');
        var keys = matches(/<div class="ug-set"[^>]*>\s*<h3[^>]*>\s*<code>([^<]*)<\/code>/g, fragment)
            .map(function (m) { return m[1].trim(); });
        if (!fs.existsSync(settings)) {
            t.assert.strictEqual(keys.length, 0, p.slug + ' documents settings without a settings.js');
            return;
        }
        var src = fs.readFileSync(settings, 'utf8');
        keys.forEach(function (key) {
            key.split('.').forEach(function (seg) {
                var esc = seg.replace(/[^\w]/g, '');
                t.assert.ok(esc.length > 0, p.slug + ': ' + key);
                t.assert.ok(new RegExp('\\b' + esc + '\\b').test(src), p.slug + ': ' + key + ' not in settings.js');
            });
        });
    });
});

t.test('every data-shot starts with its page slug', function () {
    result.pages.forEach(function (p) {
        matches(/data-shot="([^"]*)"/g, page(p.slug)).forEach(function (m) {
            t.assert.ok(m[1].indexOf(p.slug + '-') === 0, p.slug + ': ' + m[1]);
        });
    });
});

t.test('general pages name modules by title, never by id as link text', function () {
    var ids = modules.map(function (p) { return p.slug; });
    result.pages.filter(function (p) { return p.section !== 'Modules'; }).forEach(function (p) {
        var fragment = fs.readFileSync(fragmentFile(p), 'utf8');
        matches(/<a\b[^>]*href="([^"#]*)[^"]*"[^>]*>([\s\S]*?)<\/a>/g, fragment).forEach(function (m) {
            var slug = m[1].replace(/\.html$/, '');
            if (ids.indexOf(slug) === -1) return;
            t.assert.notStrictEqual(plain(m[2]), slug, p.slug + ' links to ' + slug + ' by id');
        });
    });
});

t.test('the nav has the three sections in order and each module page starts at Use cases', function () {
    var byslug = {};
    result.pages.forEach(function (p) { byslug[p.slug] = p; });
    t.assert.strictEqual(byslug.logs.section, 'Reference');
    t.assert.strictEqual(byslug.logs.title, 'Logs and data folder');
    t.assert.strictEqual(byslug.troubleshooting.section, 'Reference');
    t.assert.strictEqual(byslug.troubleshooting.title, 'Troubleshooting');
    result.pages.forEach(function (p) {
        var l1 = matches(/<details class="l1"[^>]*><summary>([^<]*)<\/summary>/g, page(p.slug))
            .map(function (m) { return m[1]; });
        t.assert.deepStrictEqual(l1, ['Getting started', 'Modules', 'Reference'], p.slug);
    });
    modules.forEach(function (p) {
        var own = new RegExp('<li class="l2 cur"><details[^>]*><summary[^>]*>[^<]*</summary><ul class="l3">' +
            '<li><a href="([^"]*)"[^>]*>([^<]*)</a>').exec(page(p.slug));
        t.assert.ok(own, p.slug + ' has no current l3 list');
        t.assert.strictEqual(own[1], p.slug + '.html#use-cases');
        t.assert.strictEqual(own[2], 'Use cases');
    });
});

t.test('every fragment passes checkFragment', function () {
    result.pages.forEach(function (p) {
        var checked = guide.checkFragment(fragmentFile(p), { moduleTitles: titles });
        t.assert.strictEqual(checked.slug, p.slug);
        t.assert.strictEqual(checked.title, p.title);
        t.assert.strictEqual(checked.section, p.section);
    });
});

t.test('cleanup removes the temp dir', function () {
    fs.rmSync(outDir, { recursive: true, force: true });
    t.assert.ok(!fs.existsSync(outDir));
});
