'use strict';

var t = require('../runner');
var harness = require('../harness');

// A fake air.Sound that records what it was built from and what was played.
function fakeAir(opts) {
    opts = opts || {};
    var made = [];
    function Sound(request) {
        this.request = request;
        this.listeners = [];
        this.played = 0;
        made.push(this);
    }
    Sound.prototype.addEventListener = function (type, fn) {
        this.listeners.push({ type: type, fn: fn });
    };
    Sound.prototype.play = function () {
        if (opts.playThrows) throw new Error('no audio device');
        this.played++;
    };
    function URLRequest(url) { this.url = url; }
    return {
        air: {
            Sound:        Sound,
            URLRequest:   URLRequest,
            IOErrorEvent: { IO_ERROR: 'ioError' }
        },
        made: made
    };
}

// A host game object whose sound manager records the effects it is asked to play.
function fakeGame(opts) {
    opts = opts || {};
    var effects = [];
    var manager = {
        playEffect: function (name) { effects.push(name); }
    };
    return {
        effects: effects,
        game: {
            def: function (name) {
                if (name !== 'Sound::cSoundManager') return null;
                return { getInstance: function () { return opts.noManager ? null : manager; } };
            }
        }
    };
}

function soundLogs(H) {
    return H.logs().filter(function (l) { return l.category === 'sound'; });
}

t.test('alert plays images/drop.mp3 through air.Sound', function () {
    var A = fakeAir();
    var H = harness.boot({ sections: ['kernel', 'core'], host: { air: A.air } });

    t.assert.strictEqual(H.Steward.core.sound.alert(), true);
    t.assert.strictEqual(A.made.length, 1);
    t.assert.strictEqual(A.made[0].request.url, 'images/drop.mp3');
    t.assert.strictEqual(A.made[0].played, 1);
});

t.test('alert attaches an IO error listener so a missing file does not surface', function () {
    var A = fakeAir();
    var H = harness.boot({ sections: ['kernel', 'core'], host: { air: A.air } });

    H.Steward.core.sound.alert();
    var listeners = A.made[0].listeners;
    t.assert.strictEqual(listeners.length, 1);
    t.assert.strictEqual(listeners[0].type, 'ioError');
    t.assert.doesNotThrow(function () { listeners[0].fn({ type: 'ioError' }); });
});

t.test('without air.Sound alert plays the QuestComplete effect', function () {
    var G = fakeGame();
    var H = harness.boot({ sections: ['kernel', 'core'], host: { game: G.game } });

    t.assert.strictEqual(H.Steward.core.sound.alert(), true);
    t.assert.deepStrictEqual(G.effects, ['QuestComplete']);
});

t.test('a throwing air.Sound.play falls back to the game effect', function () {
    var A = fakeAir({ playThrows: true });
    var G = fakeGame();
    var H = harness.boot({ sections: ['kernel', 'core'], host: { air: A.air, game: G.game } });

    t.assert.strictEqual(H.Steward.core.sound.alert(), true);
    t.assert.deepStrictEqual(G.effects, ['QuestComplete']);
});

t.test('with neither source alert returns false, does not throw and logs once', function () {
    var G = fakeGame({ noManager: true });
    var H = harness.boot({ sections: ['kernel', 'core'], host: { game: G.game } });

    var first, second;
    t.assert.doesNotThrow(function () { first = H.Steward.core.sound.alert(); });
    t.assert.doesNotThrow(function () { second = H.Steward.core.sound.alert(); });
    t.assert.strictEqual(first, false);
    t.assert.strictEqual(second, false);
    t.assert.strictEqual(soundLogs(H).length, 1);
});

t.test('a bare harness (no air.Sound, no sound manager) is silent and returns false', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });

    t.assert.strictEqual(H.Steward.core.sound.alert(), false);
});

t.test('the module exposes its file and effect names', function () {
    var H = harness.boot({ sections: ['kernel', 'core'] });

    t.assert.strictEqual(H.Steward.core.sound.FILE, 'images/drop.mp3');
    t.assert.strictEqual(H.Steward.core.sound.EFFECT, 'QuestComplete');
});
