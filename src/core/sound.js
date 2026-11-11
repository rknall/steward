/*
 * Pause alert sound.
 *
 * One short sound that tells the user a run has paused and needs a look. The
 * primary source is the client's own air.Sound playing images/drop.mp3, which
 * plays regardless of the game's effect mute. If the API or the file is not
 * there, the game's sound manager plays the QuestComplete effect instead. The
 * call never throws: a missing sound must not break the pause that asked for it.
 *
 * alert() returns true when a play was started and false when neither source
 * worked. Neither source worked is logged at most once per load, so a client
 * without sound does not flood the log on every pause.
 *
 * Bundle slot: core, after resources.js and before specialists.js (core files
 * load in name order). Nothing here runs at load time beyond assigning
 * S.core.sound; air and game are read at call time.
 */

(function (S) {

    // Path relative to the client's application directory, and the host's effect
    // name for the fallback.
    var FILE   = 'images/drop.mp3';
    var EFFECT = 'QuestComplete';

    // A reload re-runs this file and resets the flag.
    var warned = false;

    function viaAir() {
        try {
            if (typeof air === 'undefined' || !air || typeof air.Sound !== 'function' ||
                typeof air.URLRequest !== 'function') return false;
            var sound = new air.Sound(new air.URLRequest(FILE));
            // A missing file reports through the event, not a throw; swallow it so
            // it never surfaces as an unhandled error.
            if (typeof sound.addEventListener === 'function') {
                var ioError = (air.IOErrorEvent && air.IOErrorEvent.IO_ERROR) || 'ioError';
                sound.addEventListener(ioError, function () {});
            }
            sound.play();
            return true;
        } catch (e) {
            return false;
        }
    }

    function viaGame() {
        try {
            if (typeof game === 'undefined' || !game || typeof game.def !== 'function') return false;
            var cls = game.def('Sound::cSoundManager');
            var mgr = cls && typeof cls.getInstance === 'function' ? cls.getInstance() : null;
            if (!mgr || typeof mgr.playEffect !== 'function') return false;
            mgr.playEffect(EFFECT);
            return true;
        } catch (e) {
            return false;
        }
    }

    function alert() {
        if (viaAir() || viaGame()) return true;
        if (!warned) {
            warned = true;
            S.kernel.log('sound', 'no way to play the pause sound');
        }
        return false;
    }

    if (!S.core.sound) S.core.sound = {};

    S.core.sound.FILE   = FILE;
    S.core.sound.EFFECT = EFFECT;
    S.core.sound.alert  = alert;

}(Steward));
