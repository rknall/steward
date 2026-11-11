'use strict';

var crypto = require('crypto');
var t = require('../runner');
var harness = require('../harness');
var airfs = require('../stubs/airfs');

var assert = t.assert;

function setup() {
    var fs = airfs.make();
    var H = harness.boot({ sections: ['kernel'], host: { air: fs.air } });
    return { fs: fs, sha: H.Steward.kernel.sha256 };
}

function nodeHex(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

t.test('sha256 NIST vectors', function () {
    var sha = setup().sha;
    assert.strictEqual(sha.binary(''),
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.strictEqual(sha.binary('abc'),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.strictEqual(sha.binary('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

t.test('sha256 utf8 matches Node on non-ASCII text', function () {
    var sha = setup().sha;
    var text = 'Siedler äöüß € 中文 😀';
    assert.strictEqual(sha.utf8(text), nodeHex(Buffer.from(text, 'utf8')));
});

t.test('sha256 matches Node across padding boundaries', function () {
    var sha = setup().sha;
    [1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000].forEach(function (n) {
        var buf = crypto.randomBytes(n);
        assert.strictEqual(sha.binary(buf.toString('latin1')), nodeHex(buf), 'length ' + n);
    });
});

t.test('sha256 matches Node on a 500 KB random buffer', function () {
    var sha = setup().sha;
    var buf = crypto.randomBytes(500 * 1024);
    assert.strictEqual(sha.binary(buf.toString('latin1')), nodeHex(buf));
});

t.test('sha256 bytes over a ByteArray, readMultiByte path', function () {
    var s = setup();
    var buf = crypto.randomBytes(5000);
    var ba = s.fs.air.ByteArray.fromBuffer(buf);
    ba.position = 17;
    assert.strictEqual(s.sha.bytes(ba), nodeHex(buf));
    assert.strictEqual(ba.position, 17, 'position restored');
});

t.test('sha256 bytes falls back to readUnsignedByte when readMultiByte throws', function () {
    var s = setup();
    var buf = crypto.randomBytes(10000);
    var ba = s.fs.air.ByteArray.fromBuffer(buf);
    ba.readMultiByte = function () { throw new Error('no charset'); };
    ba.position = 5;
    assert.strictEqual(s.sha.bytes(ba), nodeHex(buf));
    assert.strictEqual(ba.position, 5);
});

t.test('sha256 toBinary falls back when readMultiByte returns a wrong-length string', function () {
    var s = setup();
    var buf = crypto.randomBytes(300);
    var ba = s.fs.air.ByteArray.fromBuffer(buf);
    ba.readMultiByte = function (n) {
        // As a utf8 decode would: high bytes collapse.
        return Buffer.from(buf).toString('utf8').slice(0, n);
    };
    assert.strictEqual(s.sha.toBinary(ba), buf.toString('latin1'));
});

t.test('sha256 bytes is null when both read paths fail', function () {
    var s = setup();
    var ba = s.fs.air.ByteArray.fromBuffer(Buffer.from('abc'));
    ba.readMultiByte = function () { throw new Error('x'); };
    ba.readUnsignedByte = function () { throw new Error('y'); };
    assert.strictEqual(s.sha.toBinary(ba), null);
    assert.strictEqual(s.sha.bytes(ba), null);
});

t.test('sha256 bytes of an empty ByteArray is the empty hash', function () {
    var s = setup();
    var ba = new s.fs.air.ByteArray();
    assert.strictEqual(s.sha.bytes(ba),
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
