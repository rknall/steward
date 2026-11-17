'use strict';

var fs = require('fs');
var path = require('path');

var t = require('../runner');
var harness = require('../harness');

var FILE = path.resolve(__dirname, '..', '..', 'src', 'kernel', '16_text.js');

function plain(s) {
    var H = harness.boot({ sections: ['kernel'] });
    return H.Steward.kernel.text.plain(s);
}

t.test('text.plain strips the host name markup', function () {
    var raw = "<b>Ghost #2</b> <font size='-3'>(Ghost General)</font>";
    t.assert.strictEqual(plain(raw), 'Ghost #2 (Ghost General)');
    t.assert.strictEqual(plain(' ' + raw), 'Ghost #2 (Ghost General)');
    t.assert.strictEqual(plain('<b>The Smuggler</b>'), 'The Smuggler');
});

t.test('text.plain leaves plain names and collapses whitespace', function () {
    t.assert.strictEqual(plain('Hans'), 'Hans');
    t.assert.strictEqual(plain('A  B'), 'A B');
});

t.test('text.plain decodes entities once', function () {
    t.assert.strictEqual(plain('A &amp; B'), 'A & B');
    t.assert.strictEqual(plain('Camp &lt;1&gt;'), 'Camp <1>');
    t.assert.strictEqual(plain('&amp;lt;'), '&lt;');
    t.assert.strictEqual(plain('&quot; &#39; &apos; &#x27;'), '" \' \' \'');
});

t.test('text.plain turns non-breaking spaces into plain spaces', function () {
    t.assert.strictEqual(plain('A&nbsp;B'), 'A B');
    t.assert.strictEqual(plain('A&#160;B'), 'A B');
    t.assert.strictEqual(plain('A\u00A0B'), 'A B');
});

t.test('text.plain keeps what is not markup or a known entity', function () {
    t.assert.strictEqual(plain('&unknown;'), '&unknown;');
    t.assert.strictEqual(plain('&#0;'), '&#0;');
    t.assert.strictEqual(plain('a<>b'), 'a<>b');
});

t.test('text.plain gives an empty string for tag-only and non-string input', function () {
    t.assert.strictEqual(plain('<b></b>'), '');
    t.assert.strictEqual(plain(null), '');
    t.assert.strictEqual(plain(undefined), '');
    t.assert.strictEqual(plain(5), '');
});

t.test('16_text.js holds no literal non-breaking space character', function () {
    var src = fs.readFileSync(FILE, 'utf8');
    t.assert.strictEqual(src.indexOf(String.fromCharCode(0xA0)), -1);
});

// ---- Time, duration and count formatters --------------------------------------

function text() {
    return harness.boot({ sections: ['kernel'] }).Steward.kernel.text;
}

// Local fields only, so the expectations hold in any time zone.
var DAY = new Date(2024, 0, 2, 7, 5, 9, 45);

t.test('text.pad2 pads below ten and leaves the rest alone', function () {
    var x = text();
    t.assert.strictEqual(x.pad2(0), '00');
    t.assert.strictEqual(x.pad2(7), '07');
    t.assert.strictEqual(x.pad2(10), '10');
    t.assert.strictEqual(x.pad2(59), '59');
    t.assert.strictEqual(x.pad2(2024), '2024');
});

t.test('text.date joins year, month and day with the separator', function () {
    var x = text();
    t.assert.strictEqual(x.date(DAY), '2024-01-02');
    t.assert.strictEqual(x.date(DAY, ''), '20240102');
    t.assert.strictEqual(x.date(new Date(NaN)), 'NaN-NaN-NaN');
});

t.test('text.clock builds HH:MM and the optional seconds and milliseconds', function () {
    var x = text();
    t.assert.strictEqual(x.clock(DAY), '07:05');
    t.assert.strictEqual(x.clock(DAY, { seconds: true }), '07:05:09');
    t.assert.strictEqual(x.clock(DAY, { seconds: true, ms: true }), '07:05:09.045');
    t.assert.strictEqual(x.clock(new Date(2024, 0, 2, 7, 5, 9, 5), { seconds: true, ms: true }), '07:05:09.005');
    t.assert.strictEqual(x.clock(new Date(2024, 0, 2, 7, 5, 9, 450), { seconds: true, ms: true }), '07:05:09.450');
    t.assert.strictEqual(x.clock(DAY, { seconds: true, sep: '' }), '070509');
});

t.test('text.clock guards an invalid date only when asked to', function () {
    var x = text();
    t.assert.strictEqual(x.clock(new Date(NaN)), 'NaN:NaN');
    t.assert.strictEqual(x.clock(new Date(NaN), { invalid: '' }), '');
    t.assert.strictEqual(x.clock(DAY, { invalid: '' }), '07:05');
});

t.test('text.dateTime joins the date and the clock', function () {
    var x = text();
    t.assert.strictEqual(x.dateTime(DAY), '2024-01-02 07:05');
    t.assert.strictEqual(x.dateTime(DAY, { seconds: true }), '2024-01-02 07:05:09');
    t.assert.strictEqual(x.dateTime(new Date(NaN), { invalid: '' }), 'NaN-NaN-NaN ');
});

t.test('text.seconds rounds half up', function () {
    var x = text();
    t.assert.strictEqual(x.seconds(0), 0);
    t.assert.strictEqual(x.seconds(1499), 1);
    t.assert.strictEqual(x.seconds(1500), 2);
});

t.test('text.minutes rounds per mode and applies the minimum', function () {
    var x = text();
    t.assert.strictEqual(x.minutes(89999), 1);
    t.assert.strictEqual(x.minutes(90000), 2);
    t.assert.strictEqual(x.minutes(59999, { round: 'floor' }), 0);
    t.assert.strictEqual(x.minutes(119999, { round: 'floor' }), 1);
    t.assert.strictEqual(x.minutes(60001, { round: 'ceil' }), 2);
    t.assert.strictEqual(x.minutes(0, { round: 'ceil', min: 1 }), 1);
    t.assert.strictEqual(x.minutes(-5, { round: 'ceil', min: 1 }), 1);
    t.assert.strictEqual(x.minutes(0, { min: 1 }), 1);
});

t.test('text.minText appends the unit', function () {
    var x = text();
    t.assert.strictEqual(x.minText(59999, { round: 'floor' }), '0 min');
    t.assert.strictEqual(x.minText(300000), '5 min');
});

t.test('text.hoursMinutes gives Hh MMm and, with days, Dd Hh MMm', function () {
    var x = text();
    t.assert.strictEqual(x.hoursMinutes(65 * 60000), '1h 05m');
    t.assert.strictEqual(x.hoursMinutes(0), '0h 00m');
    t.assert.strictEqual(x.hoursMinutes(30000), '0h 01m');
    t.assert.strictEqual(x.hoursMinutes(6 * 86400000, { round: 'ceil', days: true }), '6d 0h 00m');
    t.assert.strictEqual(x.hoursMinutes(1, { round: 'ceil', days: true }), '0h 01m');
    t.assert.strictEqual(x.hoursMinutes(1500 * 60000), '25h 00m');
});

t.test('text.plural counts and picks the word form', function () {
    var x = text();
    t.assert.strictEqual(x.plural(1, 'item'), '1 item');
    t.assert.strictEqual(x.plural(0, 'item'), '0 items');
    t.assert.strictEqual(x.plural(2, 'item'), '2 items');
    t.assert.strictEqual(x.plural(1, 'entry', 'entries'), '1 entry');
    t.assert.strictEqual(x.plural(0, 'entry', 'entries'), '0 entries');
    t.assert.strictEqual(x.plural(2, 'entry', 'entries'), '2 entries');
});

// ---- Equivalence with the code the helpers replaced ---------------------------
//
// Each reference below is the old inline expression. The composition is what
// the caller now writes. They must agree for every input, so no logged or
// shown text changes.

function refPad2(n) { return n < 10 ? '0' + n : '' + n; }

function refTimestamp(d) {
    return d.getFullYear() + '-' + refPad2(d.getMonth() + 1) + '-' + refPad2(d.getDate()) +
           ' ' + refPad2(d.getHours()) + ':' + refPad2(d.getMinutes()) + ':' + refPad2(d.getSeconds());
}

function refDuration(ms) {
    var totalMinutes = Math.round(ms / 60000);
    var hours = Math.floor(totalMinutes / 60);
    var minutes = totalMinutes % 60;
    return hours + 'h ' + (minutes < 10 ? '0' + minutes : minutes) + 'm';
}

function refDaysHoursMinutes(ms) {
    var total = Math.ceil(ms / 60000);
    var d = Math.floor(total / 1440);
    var hh = Math.floor((total % 1440) / 60);
    var m = total % 60;
    return (d ? d + 'd ' : '') + hh + 'h ' + (m < 10 ? '0' + m : m) + 'm';
}

function refHelperClock(date) {
    if (isNaN(date.getTime())) return '';
    return refPad2(date.getHours()) + ':' + refPad2(date.getMinutes());
}

function refFormatDate(ms) {
    if (typeof ms !== 'number' || isNaN(ms)) return '—';
    var d = new Date(ms);
    return d.getFullYear() + '-' + refPad2(d.getMonth() + 1) + '-' + refPad2(d.getDate()) +
           ' ' + refHelperClock(d);
}

function refDateText(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '';
    var d = new Date(ms);
    return String(d.getFullYear()) + '-' + refPad2(d.getMonth() + 1) + '-' + refPad2(d.getDate());
}

function refDateTimeText(ms) {
    var day = refDateText(ms);
    if (day === '') return '';
    return day + ' ' + refHelperClock(new Date(ms));
}

function refStamp(ms) {
    var d = new Date(ms);
    return String(d.getFullYear()) + refPad2(d.getMonth() + 1) + refPad2(d.getDate()) + '-' +
           refPad2(d.getHours()) + refPad2(d.getMinutes()) + refPad2(d.getSeconds());
}

function refClockMs(ms) {
    var d = new Date(ms);
    var m = d.getMilliseconds();
    return refPad2(d.getHours()) + ':' + refPad2(d.getMinutes()) + ':' + refPad2(d.getSeconds()) + '.' +
        (m < 10 ? '00' : (m < 100 ? '0' : '')) + m;
}

function refClockSec(d) {
    return refPad2(d.getHours()) + ':' + refPad2(d.getMinutes()) + ':' + refPad2(d.getSeconds());
}

var INPUTS = [0, -1, 1, 59999, 60000, 89999, 90000, 3600000, 86399999, 86400000, 6 * 86400000, NaN];

t.test('text equals the old logger timestamp, backups stamp, buffs and production clocks', function () {
    var x = text();
    var dates = [DAY, new Date(2030, 11, 31, 23, 59, 59, 999), new Date(2030, 0, 1, 0, 0, 0, 0), new Date(NaN)];
    INPUTS.forEach(function (ms) { dates.push(new Date(ms)); });
    dates.forEach(function (d) {
        var ms = d.getTime();
        t.assert.strictEqual(x.dateTime(d, { seconds: true }), refTimestamp(d));
        t.assert.strictEqual(x.date(d, '') + '-' + x.clock(d, { seconds: true, sep: '' }), refStamp(ms));
        t.assert.strictEqual(x.clock(new Date(ms), { seconds: true, ms: true }), refClockMs(ms));
        t.assert.strictEqual(x.clock(d, { seconds: true }), refClockSec(d));
    });
});

t.test('text equals the old h.duration fallback and collect daysHoursMinutes', function () {
    var x = text();
    INPUTS.forEach(function (ms) {
        t.assert.strictEqual(x.hoursMinutes(ms), refDuration(ms));
        t.assert.strictEqual(x.hoursMinutes(ms, { round: 'ceil', days: true }), refDaysHoursMinutes(ms));
    });
});

t.test('text equals the old eventcalc and updater date texts', function () {
    var x = text();
    var inputs = INPUTS.concat([Infinity, -Infinity, 'x', null, undefined, Date.UTC(2024, 0, 2, 7, 5)]);
    inputs.forEach(function (ms) {
        var formatDate = (typeof ms !== 'number' || isNaN(ms)) ? '—'
            : x.dateTime(new Date(ms), { invalid: '' });
        t.assert.strictEqual(formatDate, refFormatDate(ms));

        var guarded = (typeof ms !== 'number' || !isFinite(ms) || ms <= 0);
        var dateText = guarded ? '' : x.date(new Date(ms));
        t.assert.strictEqual(dateText, refDateText(ms));
        var dateTimeText = dateText === '' ? '' : dateText + ' ' + x.clock(new Date(ms), { invalid: '' });
        t.assert.strictEqual(dateTimeText, refDateTimeText(ms));
    });
});

t.test('text equals the old waitDetail and updater every() minute numbers', function () {
    var x = text();
    INPUTS.forEach(function (ms) {
        t.assert.strictEqual(x.minText(ms, { round: 'ceil', min: 1 }), Math.max(1, Math.ceil(ms / 60000)) + ' min');
        t.assert.strictEqual(x.minutes(ms, { min: 1 }), Math.max(1, Math.round(ms / 60000)));
    });
});
