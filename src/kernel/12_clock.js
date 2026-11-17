/*
 * The one wall clock.
 *
 * Steward.kernel.now() returns milliseconds since the epoch with Date.now()
 * semantics. Kernel timers and every core or module clock seam default to it,
 * so a test moves time for the whole bundle by replacing this one slot, and a
 * seam override still wins where a module needs its own clock. The body looks
 * up Date and Date.now on every call, so a test that patches Date.now or swaps
 * the global Date keeps working, and a reload reassigns the slot. Callers read
 * it as S.kernel.now() at the moment of use and never capture it. The file
 * needs only the namespace.
 */

(function (S) {

    S.kernel.now = function () {
        return Date.now();
    };

}(Steward));
