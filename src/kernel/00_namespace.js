/*
 * Steward namespace bootstrap.
 *
 * Declares the single global object every other source file attaches to. Must
 * run before any other Steward file, hence the 00_ prefix.
 *
 * The IIFE pattern is intentional: it keeps locals out of the global scope
 * while making the public surface explicit through assignments to Steward.*.
 */

var Steward = (typeof Steward !== 'undefined' && Steward) || {};

(function () {
    if (!Steward.kernel)  Steward.kernel  = {};
    if (!Steward.core)    Steward.core    = {};
    if (!Steward.modules) Steward.modules = {};
}());
