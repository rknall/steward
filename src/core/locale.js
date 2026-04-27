/*
 * Localization wrapper.
 *
 * Thin layer over the host loca.GetText. Centralises category strings
 * ('BUI', 'RES', …) so a typo doesn't ship, and provides a string formatter
 * that survives the AIR-32 ban on template literals.
 */

(function (S) {

    function safeText(category, key) {
        if (!key) return '';
        try {
            if (typeof loca !== 'undefined' && loca && typeof loca.GetText === 'function') {
                var v = loca.GetText(category, key);
                if (v && typeof v === 'string' && v.length > 0) return v;
            }
        } catch (e) {
            S.kernel.warn('locale', 'GetText threw for', category + ':' + key, ':', e);
        }
        return key;
    }

    function format(template, args) {
        if (typeof template !== 'string') return '';
        if (!args || !args.length) return template;
        var out = template;
        for (var i = 0; i < args.length; i++) {
            // Use indexOf-loop replace to avoid RegExp creation per arg.
            var token = '{' + i + '}';
            var idx = out.indexOf(token);
            while (idx !== -1) {
                out = out.substring(0, idx) + String(args[i]) + out.substring(idx + token.length);
                idx = out.indexOf(token, idx + String(args[i]).length);
            }
        }
        return out;
    }

    S.core.locale = {
        text:   safeText,
        bui:    function (k) { return safeText('BUI', k); },
        res:    function (k) { return safeText('RES', k); },
        lab:    function (k) { return safeText('LAB', k); },
        adn:    function (k) { return safeText('ADN', k); },
        qul:    function (k) { return safeText('QUL', k); },
        mel:    function (k) { return safeText('MEL', k); },
        alt:    function (k) { return safeText('ALT', k); },
        spe:    function (k) { return safeText('SPE', k); },
        format: format
    };

}(Steward));
