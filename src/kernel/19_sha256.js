/*
 * SHA-256 (FIPS 180-4).
 *
 * Bundle place: 19_, after 18_semver.js and before 20_logger.js. Pure: it
 * only assigns Steward.kernel.sha256, with no timer, no IO and no state.
 *
 * The update flow verifies a downloaded bundle against a published digest, so
 * the hash has to run on raw bytes. Input is a "binary string" (every char
 * code is a byte 0-255). toBinary() converts an AIR ByteArray into one. Plain
 * arrays and `>>> 0` are used instead of typed arrays, which AIR 32 does not
 * guarantee.
 */

(function (S) {

    var K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];

    var CHUNK = 4096;
    var SPOT_HEAD = 64;
    var SPOT_SPREAD = 256;

    function rotr(x, n) {
        return ((x >>> n) | (x << (32 - n))) >>> 0;
    }

    function hex8(n) {
        var h = (n >>> 0).toString(16);
        return '00000000'.substring(h.length) + h;
    }

    function binary(str) {
        var len = str.length;
        var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
        var padLen = ((len + 9 + 63) >> 6) << 6;
        var words = [];
        var w = [];
        var i, j, off;

        for (i = 0; i < padLen / 4; i++) words[i] = 0;
        for (i = 0; i < len; i++) {
            words[i >> 2] |= (str.charCodeAt(i) & 0xFF) << (24 - (i & 3) * 8);
        }
        words[len >> 2] |= 0x80 << (24 - (len & 3) * 8);
        // 64-bit big-endian bit length; the high word is len / 2^29.
        words[padLen / 4 - 2] = Math.floor(len / 0x20000000);
        words[padLen / 4 - 1] = (len << 3) >>> 0;

        for (off = 0; off < words.length; off += 16) {
            for (j = 0; j < 16; j++) w[j] = words[off + j] >>> 0;
            for (j = 16; j < 64; j++) {
                var s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
                var s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
                w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
            }
            var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
            for (j = 0; j < 64; j++) {
                var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
                var ch = (e & f) ^ (~e & g);
                var t1 = (hh + S1 + ch + K[j] + w[j]) >>> 0;
                var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
                var maj = (a & b) ^ (a & c) ^ (b & c);
                var t2 = (S0 + maj) >>> 0;
                hh = g; g = f; f = e;
                e = (d + t1) >>> 0;
                d = c; c = b; b = a;
                a = (t1 + t2) >>> 0;
            }
            h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
            h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
            h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
            h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
        }

        var out = '';
        for (i = 0; i < 8; i++) out += hex8(h[i]);
        return out;
    }

    function utf8(text) {
        return binary(unescape(encodeURIComponent(String(text))));
    }

    // readMultiByte is fast but its charset handling is unverified on every AIR
    // build, so its result is spot-checked against readUnsignedByte before use.
    function fastRead(ba) {
        var s = ba.readMultiByte(ba.length, 'iso-8859-1');
        if (s.length !== ba.length) return null;
        var n = ba.length;
        var i, k;
        for (i = 0; i < n && i < SPOT_HEAD; i++) {
            ba.position = i;
            if (ba.readUnsignedByte() !== s.charCodeAt(i)) return null;
        }
        for (k = 0; k < SPOT_SPREAD; k++) {
            i = Math.floor(k * n / SPOT_SPREAD);
            ba.position = i;
            if (ba.readUnsignedByte() !== s.charCodeAt(i)) return null;
        }
        return s;
    }

    function slowRead(ba) {
        var n = ba.length;
        var parts = [];
        var chunk, i;
        ba.position = 0;
        while (ba.position < n) {
            chunk = [];
            for (i = 0; i < CHUNK && ba.position < n; i++) chunk.push(ba.readUnsignedByte());
            parts.push(String.fromCharCode.apply(null, chunk));
        }
        return parts.join('');
    }

    function toBinary(ba) {
        if (!ba || typeof ba.length !== 'number') return null;
        var saved = ba.position;
        var s = null;
        try {
            ba.position = 0;
            s = fastRead(ba);
        } catch (e1) {
            s = null;
        }
        if (s === null) {
            try {
                s = slowRead(ba);
            } catch (e2) {
                s = null;
            }
        }
        try { ba.position = saved; } catch (e3) { /* position is best effort */ }
        return s;
    }

    function bytes(ba) {
        var s = toBinary(ba);
        return s === null ? null : binary(s);
    }

    S.kernel.sha256 = { binary: binary, utf8: utf8, bytes: bytes, toBinary: toBinary };

}(Steward));
