/*
 * Value checks.
 *
 * The one home of the small type guards core and modules share. Each contract
 * has its own name and must not be widened: num lets Infinity through while
 * finite does not, str gives '' for anything that is not a string, and has
 * throws on a null or undefined object exactly like hasOwnProperty.call does.
 * The bodies keep the toString and regex forms used on AIR, where bridged
 * objects and old JavaScriptCore make Array.isArray and String.trim a
 * behaviour question. The functions are pure, so a reload just replaces the
 * slot.
 */

(function (S) {

    function has(o, k) {
        return Object.prototype.hasOwnProperty.call(o, k);
    }

    function array(v) {
        return Object.prototype.toString.call(v) === '[object Array]';
    }

    function plainObject(v) {
        return v !== null && typeof v === 'object' && Object.prototype.toString.call(v) === '[object Object]';
    }

    function str(v) {
        return typeof v === 'string' ? v : '';
    }

    // Coerces first, so null gives 'null' and 5 gives '5'.
    function trim(v) {
        return String(v).replace(/^\s+|\s+$/g, '');
    }

    // A number that is not NaN; booleans fail, Infinity passes.
    function num(v) {
        return typeof v === 'number' && !isNaN(v);
    }

    // A finite number; Infinity and NaN fail.
    function finite(v) {
        return typeof v === 'number' && isFinite(v);
    }

    S.kernel.is = {
        has:         has,
        array:       array,
        plainObject: plainObject,
        str:         str,
        trim:        trim,
        num:         num,
        finite:      finite
    };

}(Steward));
