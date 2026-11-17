/*
 * Text helpers.
 *
 * The client stores specialist and camp display names as HTML (bold and font
 * tags, entities such as &amp;). plain() is the one cleaner for those strings:
 * it returns plain text, so the result must be escaped before it reaches an
 * html() sink. Nothing else in the bundle strips markup on its own.
 *
 * This file also holds the single set of time, duration and count formatters.
 * They are pure and read the time only from the Date they are given. They do
 * not guard invalid input unless the caller passes `invalid`. h.clock and
 * h.duration are UI delegates to them. The file takes no dependency on other
 * kernel files.
 */

(function (S) {

    var ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&', nbsp: ' ' };

    // One pass over the string, so a decoded '&' never starts a second entity.
    function decodeEntity(match, body) {
        if (body.charAt(0) !== '#') {
            return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : match;
        }
        var isHex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
        var code = isHex ? parseInt(body.substring(2), 16) : parseInt(body.substring(1), 10);
        return (code > 0 && code <= 0xFFFF) ? String.fromCharCode(code) : match;
    }

    function plain(html) {
        if (typeof html !== 'string') return '';
        return html
            .replace(/<[^>]+>/g, '')
            .replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, decodeEntity)
            .replace(/[\s\u00A0]+/g, ' ')
            .replace(/^\s+|\s+$/g, '');
    }

    function pad2(n) {
        return n < 10 ? '0' + n : String(n);
    }

    function pad3(n) {
        return (n < 10 ? '00' : (n < 100 ? '0' : '')) + n;
    }

    function date(d, sep) {
        if (sep === undefined) sep = '-';
        return d.getFullYear() + sep + pad2(d.getMonth() + 1) + sep + pad2(d.getDate());
    }

    function clock(d, opts) {
        opts = opts || {};
        if (opts.invalid !== undefined && isNaN(d.getTime())) return opts.invalid;
        var sep = opts.sep === undefined ? ':' : opts.sep;
        var out = pad2(d.getHours()) + sep + pad2(d.getMinutes());
        if (opts.seconds) out += sep + pad2(d.getSeconds());
        if (opts.ms) out += '.' + pad3(d.getMilliseconds());
        return out;
    }

    function dateTime(d, opts) {
        return date(d) + ' ' + clock(d, opts);
    }

    function seconds(ms) {
        return Math.round(ms / 1000);
    }

    function minutes(ms, opts) {
        opts = opts || {};
        var f = opts.round === 'floor' ? Math.floor : (opts.round === 'ceil' ? Math.ceil : Math.round);
        var n = f(ms / 60000);
        return typeof opts.min === 'number' ? Math.max(opts.min, n) : n;
    }

    function minText(ms, opts) {
        return minutes(ms, opts) + ' min';
    }

    function hoursMinutes(ms, opts) {
        opts = opts || {};
        var total = minutes(ms, { round: opts.round });
        var dd = opts.days ? Math.floor(total / 1440) : 0;
        var rest = opts.days ? total % 1440 : total;
        return (dd ? dd + 'd ' : '') + Math.floor(rest / 60) + 'h ' + pad2(rest % 60) + 'm';
    }

    function plural(n, one, many) {
        return n + ' ' + (n === 1 ? one : (many === undefined ? one + 's' : many));
    }

    S.kernel.text = {
        plain: plain,
        pad2: pad2,
        date: date,
        clock: clock,
        dateTime: dateTime,
        seconds: seconds,
        minutes: minutes,
        minText: minText,
        hoursMinutes: hoursMinutes,
        plural: plural
    };

}(Steward));
