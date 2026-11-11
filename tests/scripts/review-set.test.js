'use strict';

var fs = require('fs');
var path = require('path');
var t = require('../runner');
var harness = require('../harness');
var rs = require('../../scripts/review-set');

var SHELL = path.join(__dirname, '..', '..', '.claude', 'skills', 'so-pipeline',
    'review-shell', 'shell.html');
var shell = fs.readFileSync(SHELL, 'utf8');

function errorsOf(html) { return rs.check(html); }

function has(errs, re) {
    return errs.some(function (e) { return re.test(e); });
}

// Replaces the first occurrence; fails loudly when the shell no longer has it.
function swap(html, from, to) {
    t.assert.ok(html.indexOf(from) >= 0, 'shell lacks: ' + from);
    return html.replace(from, function () { return to; });
}

function withSet(mutate) {
    var m = /(<script type="application\/json" id="review-set">)([\s\S]*?)(<\/script>)/.exec(shell);
    var set = JSON.parse(m[2]);
    mutate(set);
    return shell.replace(m[0], function () { return m[1] + JSON.stringify(set) + m[3]; });
}

t.test('stewardCss contains scopeCss of STYLE_RULES for rv-content', function () {
    var ui = harness.boot({ sections: ['kernel'] }).Steward.kernel.ui;
    var css = rs.stewardCss();
    t.assert.strictEqual(css.indexOf(ui.scopeCss(ui.STYLE_RULES, ['rv-content'])), 0);
    t.assert.ok(css.indexOf('#rv-content .rv-frame{') > 0);
});

t.test('every generated selector is scoped to #rv-content', function () {
    rs.stewardCss().split('}').forEach(function (rule) {
        var brace = rule.indexOf('{');
        if (brace < 0) return;
        rule.slice(0, brace).split(',').forEach(function (sel) {
            t.assert.ok(sel.trim().indexOf('#rv-content ') === 0, 'unscoped: ' + sel);
        });
    });
});

t.test('inject replaces between markers and is idempotent', function () {
    var html = 'a ' + rs.BEGIN + ' old ' + rs.END + ' b';
    var once = rs.inject(html, '.x{}');
    t.assert.strictEqual(once, 'a ' + rs.BEGIN + '\n.x{}\n' + rs.END + ' b');
    t.assert.strictEqual(rs.inject(once, '.x{}'), once);
});

t.test('inject throws without markers', function () {
    t.assert.throws(function () { rs.inject('<p>x</p>', '.x{}'); }, /found 0 times/);
    var twice = rs.BEGIN + rs.END + rs.BEGIN;
    t.assert.throws(function () { rs.inject(twice, '.x{}'); }, /found 2 times/);
});

t.test('check accepts the committed shell template', function () {
    t.assert.deepStrictEqual(errorsOf(shell), []);
});

t.test('check rejects a doctype', function () {
    t.assert.ok(has(errorsOf('<!DOCTYPE html>' + shell), /doctype/));
});

t.test('check rejects a title of five words', function () {
    var html = swap(shell, '<title>Review Set</title>', '<title>One Two Three Four Five</title>');
    t.assert.ok(has(errorsOf(html), /2-4 words/));
});

t.test('check rejects a title after 8 KB', function () {
    var html = swap(shell, '<title>Review Set</title>', '<!--' + new Array(9000).join('x') + '--><title>Review Set</title>');
    t.assert.ok(has(errorsOf(html), /after the first 8192/));
});

t.test('check rejects bad JSON', function () {
    var html = swap(shell, 'id="review-set">', 'id="review-set">{');
    t.assert.ok(has(errorsOf(html), /does not parse/));
});

t.test('check rejects the reserved page id settings', function () {
    var html = withSet(function (s) { s.pages[0].id = 'settings'; });
    t.assert.ok(has(errorsOf(html), /reserved/));
});

t.test('check rejects a duplicate page id', function () {
    var html = withSet(function (s) { s.pages.push(JSON.parse(JSON.stringify(s.pages[0]))); });
    t.assert.ok(has(errorsOf(html), /duplicate id/));
});

t.test('check rejects a page without a section', function () {
    var html = withSet(function (s) {
        var p = JSON.parse(JSON.stringify(s.pages[0]));
        p.id = 'page-2';
        s.pages.push(p);
    });
    t.assert.ok(has(errorsOf(html), /page page-2: expected one section, found 0/));
});

t.test('check rejects a section without a page', function () {
    var html = swap(shell, '<!-- review-set:pages:end -->',
        '<section data-page="ghost"><p>x</p></section>\n<!-- review-set:pages:end -->');
    t.assert.ok(has(errorsOf(html), /section ghost has no page/));
});

// The extra element must sit inside the page-1 section, so insert before its end tag.
function withContent(html, content) {
    var i = html.indexOf('</section>', html.indexOf('<section data-page="page-1">'));
    return html.slice(0, i) + content + html.slice(i);
}

t.test('check accepts a data-when naming a real option and value', function () {
    var html = withSet(function (s) {
        s.pages[0].options = [{ id: 'state', label: 'State', values: [{ id: 'on', label: 'On' }] }];
    });
    t.assert.deepStrictEqual(errorsOf(withContent(html, '<div data-when="state=on">x</div>')), []);
});

t.test('check rejects a data-when with an unknown option', function () {
    var html = withContent(shell, '<div data-when="mode=on">x</div>');
    t.assert.ok(has(errorsOf(html), /unknown option mode/));
});

t.test('check rejects a data-when with an unknown value', function () {
    var html = withSet(function (s) {
        s.pages[0].options = [{ id: 'state', label: 'State', values: [{ id: 'on', label: 'On' }] }];
    });
    t.assert.ok(has(errorsOf(withContent(html, '<div data-when="state=off">x</div>')), /unknown value state=off/));
});

t.test('check rejects a mockup with an empty steward block', function () {
    var html = withSet(function (s) { s.kind = 'mockup'; });
    var a = html.indexOf(rs.BEGIN) + rs.BEGIN.length;
    html = html.slice(0, a) + '\n' + html.slice(html.indexOf(rs.END));
    t.assert.ok(has(errorsOf(html), /non-empty steward block/));
});

t.test('check accepts a mockup once the steward block is injected', function () {
    var html = rs.inject(withSet(function (s) { s.kind = 'mockup'; }), rs.stewardCss());
    t.assert.deepStrictEqual(errorsOf(html), []);
});

t.test('check rejects alert( in content', function () {
    t.assert.ok(has(errorsOf(withContent(shell, '<button onclick="alert(1)">x</button>')), /alert/));
});

t.test('check rejects an external script from a non-allowlisted host', function () {
    var bad = withContent(shell, '<script src="https://evil.example.com/x.js"></script>');
    t.assert.ok(has(errorsOf(bad), /non-allowlisted/));
    var ok = withContent(shell, '<script src="https://cdnjs.cloudflare.com/ajax/libs/x/1.0.0/x.js"></script>');
    t.assert.deepStrictEqual(errorsOf(ok), []);
});

t.test('check rejects duplicated shell chrome', function () {
    var dupNav = withContent(shell, '<nav id="rv-nav"></nav>');
    t.assert.ok(has(errorsOf(dupNav), /duplicate id="rv-nav"/));
    var dupShell = withContent(shell, '<div class="x rv-shell"></div>');
    t.assert.ok(has(errorsOf(dupShell), /rv-shell appears 2 times/));
    var otherId = withContent(shell, '<i id="rv-content"></i>');
    t.assert.ok(has(errorsOf(otherId), /duplicate id="rv-content"/));
    // A longer class token is not the shell class.
    t.assert.deepStrictEqual(errorsOf(withContent(shell, '<div class="rv-shell-note"></div>')), []);
});

t.test('check does not mistake <header> for the document skeleton', function () {
    t.assert.deepStrictEqual(errorsOf(withContent(shell, '<header>h</header>')), []);
    t.assert.ok(has(errorsOf(withContent(shell, '<head>')), /contains <head/));
    t.assert.ok(has(errorsOf(withContent(shell, '<body class="a">')), /contains <body/));
});

t.test('check validates data-when after a nested section', function () {
    var nested = '<section><p>in</p></section><div data-when="mode=on">x</div>';
    t.assert.ok(has(errorsOf(withContent(shell, nested)), /unknown option mode/));
    var html = withSet(function (s) {
        s.pages[0].options = [{ id: 'state', label: 'State', values: [{ id: 'on', label: 'On' }] }];
    });
    var ok = '<section><p>in</p></section><div data-when="state=on">x</div>';
    t.assert.deepStrictEqual(errorsOf(withContent(html, ok)), []);
});

t.test('check rejects a set without the Submit button', function () {
    var html = swap(shell, 'id="rv-submit"', 'id="rv-gone"');
    t.assert.ok(has(errorsOf(html), /missing id="rv-submit"/));
});

t.test('checkFeedback accepts the page shape and rejects others', function () {
    var ok = { set: 'demo', task: 'x', rev: 1, general: '', verdicts: [], pending: 0, at: 'T' };
    t.assert.strictEqual(rs.checkFeedback(ok), null);
    t.assert.ok(rs.checkFeedback([]));
    t.assert.ok(rs.checkFeedback({ set: '../x', rev: 1, general: '', verdicts: [] }));
    t.assert.ok(rs.checkFeedback({ set: 'demo', rev: 1, general: '', verdicts: {} }));
});

function post(port, origin, body, cb) {
    var http = require('http');
    var req = http.request({ host: '127.0.0.1', port: port, method: 'POST', path: rs.SUBMIT_PATH,
        headers: { 'Content-Type': 'application/json', Origin: origin } }, function (res) {
        res.resume();
        res.on('end', function () { cb(res.statusCode); });
    });
    req.on('error', function () { cb(0); });
    req.end(body);
}

t.test('serve writes posted feedback next to the set and refuses a foreign origin', function (done) {
    var os = require('os');
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-serve-'));
    var file = path.join(dir, 'demo.html');
    fs.writeFileSync(file, '<title>Demo Set</title>');
    var server = rs.serve(file, 0, null);
    server.on('listening', function () {
        var port = server.address().port;
        var body = JSON.stringify({ set: 'demo', task: 'x', rev: 1, general: 'g', verdicts: [], pending: 0, at: 'T' });
        post(port, 'http://evil.example', body, function (code) {
            t.assert.strictEqual(code, 403);
            post(port, 'http://127.0.0.1:' + port, body, function (code2) {
                server.close();
                try {
                    t.assert.strictEqual(code2, 200);
                    var written = JSON.parse(fs.readFileSync(path.join(dir, 'demo-feedback.json'), 'utf8'));
                    t.assert.strictEqual(written.general, 'g');
                    done();
                } catch (e) { done(e); }
            });
        });
    });
});
