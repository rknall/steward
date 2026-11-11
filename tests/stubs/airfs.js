/*
 * In-memory Adobe AIR file system stub.
 *
 * make(opts) returns { air, disk, bytes, dirs, mtime, fail, now, appDir,
 * storageDir, docsDir, stats, browses, fire, file }. Pass `host: { air: fs.air }` to harness.boot so the
 * kernel file API (src/kernel/17_files.js) and the logger run against it.
 *
 *   disk:  nativePath -> text   (files)
 *   bytes: nativePath -> Buffer (exact content of files written through
 *          FileStream.writeBytes; the real file system is binary, `disk` is
 *          the text view). A byte write also sets disk[path] to the utf8
 *          decode of the whole file, so text readers keep working. A text
 *          write (writeUTFBytes) or a WRITE-mode open deletes bytes[path].
 *          moveTo carries both maps to the destination and deleteFile clears
 *          both. A file with no bytes entry reads as the utf8 bytes of disk.
 *   dirs:  nativePath -> true   (directories; the three roots exist)
 *   mtime: nativePath -> Date   (modification dates; a test may seed these)
 *   now:   null for the real clock, else a ms timestamp. Every modification
 *          date the stub writes (an append, a created directory, a moved file
 *          without a date) is stamped with it, so a test that fakes the
 *          process clock keeps the fake disk on the same day.
 *   fail:  { write: {}, move: {}, read: {}, remove: {} } keyed by nativePath; a
 *          truthy entry makes the matching call throw:
 *            write[path]  writeUTFBytes / writeBytes on a stream opened for that file
 *            move[path]   moveTo where path is the source or the destination
 *            read[path]   readUTFBytes / readBytes on a stream opened for that file
 *            remove[path] deleteFile on that file
 *   stats: { opens, closes, moves } FileStream and moveTo counters; moves
 *          counts every call, failed or not
 *   browses: one record per browseForOpen / browseForOpenMultiple call,
 *          { file, title, filters, multiple }
 *   fire(file, type, event): calls the listeners `file` holds for `type`
 *          (event.target defaults to file).
 *
 * air.ByteArray: a Buffer-backed stand-in with length, position,
 * readUTFBytes(n), readMultiByte(n, charset) (latin1 for 'iso-8859-1', else
 * utf8), readUnsignedByte(), writeBytes(ba, off, len), writeUTFBytes(s) and
 * toBuffer(); ByteArray.fromBuffer(buf) wraps a copy for tests. Reads past the
 * end throw, as AIR's EOFError does. FileStream.readBytes(ba, off, len) fills
 * ba at off from the stream position (len 0 means everything available) and
 * FileStream.writeBytes(ba, off, len) appends ba's bytes (len 0 means to the
 * end).
 *
 * Paths are forward-slashed (`C:/client/steward/logs`). A path without a
 * slash is a drive root and always exists as a directory.
 *
 * App-content rule, as on AIR: a File obtained from
 * air.File.applicationDirectory carries an app-content flag. Opening it for
 * write, creating it as a directory, deleting it or moving onto it throws
 * `SecurityError: fileWriteResource`. The flag propagates through
 * resolvePath(rel) and parent of a flagged File only, never of an unflagged
 * one; `new air.File(nativePath)` drops it. So after the round trip, children
 * of the round-tripped directory (console.log, console.log.N) stay writable.
 *
 * opts:
 *   appDir       client install directory (default 'C:/client')
 *   appReadOnly  every path under appDir is unwritable even after the round
 *                trip, to drive the storage / documents fallback
 */

'use strict';

function noop() {}

function norm(p) {
    var s = String(p === undefined || p === null ? '' : p).replace(/\\/g, '/');
    var parts = s.split('/');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
        var seg = parts[i];
        if (seg === '' && i > 0) continue;
        if (seg === '.') continue;
        if (seg === '..') { if (out.length > 1) out.pop(); continue; }
        out.push(seg);
    }
    return out.join('/');
}

function dirname(p) {
    var i = p.lastIndexOf('/');
    return i < 0 ? null : p.substr(0, i);
}

function basename(p) {
    var i = p.lastIndexOf('/');
    return i < 0 ? p : p.substr(i + 1);
}

function securityError() {
    var e = new Error('SecurityError: fileWriteResource');
    e.name = 'SecurityError';
    return e;
}

function make(opts) {
    opts = opts || {};
    var appDir     = norm(opts.appDir || 'C:/client');
    var storageDir = 'C:/store';
    var docsDir    = 'C:/docs';

    var disk  = {};
    var bytes = {};
    var dirs  = {};
    var mtime = {};
    var fail  = { write: {}, move: {}, read: {}, remove: {} };
    var stats = { opens: 0, closes: 0, moves: 0 };
    var browses = [];

    dirs[appDir] = true;
    dirs[storageDir] = true;
    dirs[docsDir] = true;

    function has(map, key) { return Object.prototype.hasOwnProperty.call(map, key); }
    function isRoot(p) { return p.indexOf('/') < 0; }
    function isDirPath(p) { return isRoot(p) || has(dirs, p); }
    function isFilePath(p) { return has(disk, p); }

    // Exact content of a file: the byte entry when one exists, else the utf8
    // bytes of the text view.
    function fileBuf(p) {
        return has(bytes, p) ? bytes[p] : Buffer.from(disk[p], 'utf8');
    }

    function underApp(p) {
        return p === appDir || p.indexOf(appDir + '/') === 0;
    }

    function unwritable(file) {
        return file._app || (opts.appReadOnly && underApp(file._path));
    }

    // Filled in below, once the returned object exists: the clock lives on it.
    var api = null;

    function stamp() {
        return (api && api.now !== null) ? new Date(api.now) : new Date();
    }

    function touch(p) { mtime[p] = stamp(); }

    function File(path) {
        this._path = norm(path);
        this._app = false;
        this._listeners = {};
    }

    function mk(path, app) {
        var f = new File(path);
        f._app = !!app;
        return f;
    }

    Object.defineProperty(File.prototype, 'nativePath', { get: function () { return this._path; } });
    Object.defineProperty(File.prototype, 'name',       { get: function () { return basename(this._path); } });
    Object.defineProperty(File.prototype, 'exists', {
        get: function () { return isDirPath(this._path) || isFilePath(this._path); }
    });
    Object.defineProperty(File.prototype, 'isDirectory', {
        get: function () { return isDirPath(this._path); }
    });
    Object.defineProperty(File.prototype, 'size', {
        get: function () {
            if (!isFilePath(this._path)) throw new Error('IOError: file does not exist');
            return fileBuf(this._path).length;
        }
    });
    Object.defineProperty(File.prototype, 'modificationDate', {
        get: function () {
            if (!this.exists) throw new Error('IOError: file does not exist');
            return mtime[this._path] || new Date(0);
        }
    });
    Object.defineProperty(File.prototype, 'parent', {
        get: function () {
            var d = dirname(this._path);
            return d === null ? null : mk(d, this._app);
        }
    });

    File.prototype.resolvePath = function (rel) {
        return mk(this._path + '/' + rel, this._app);
    };

    File.prototype.createDirectory = function () {
        var p = this._path;
        if (isDirPath(p)) return;
        if (unwritable(this)) throw securityError();
        if (isFilePath(p)) throw new Error('IOError: a file exists at ' + p);
        var d = dirname(p);
        if (d !== null && !isDirPath(d)) throw new Error('IOError: parent missing for ' + p);
        dirs[p] = true;
        touch(p);
    };

    File.prototype.getDirectoryListing = function () {
        var p = this._path;
        if (!isDirPath(p)) throw new Error('IOError: not a directory ' + p);
        var out = [];
        var self = this;
        function add(map) {
            Object.keys(map).forEach(function (k) {
                if (dirname(k) === p) out.push(mk(k, self._app));
            });
        }
        add(dirs);
        add(disk);
        return out;
    };

    File.prototype.deleteFile = function () {
        var p = this._path;
        if (!isFilePath(p)) throw new Error('IOError: file does not exist ' + p);
        if (fail.remove[p]) throw new Error('IOError: delete fault ' + p);
        if (unwritable(this)) throw securityError();
        delete disk[p];
        delete bytes[p];
        delete mtime[p];
    };

    File.prototype.moveTo = function (dest, overwrite) {
        var src = this._path;
        var dst = dest._path;
        stats.moves++;
        if (fail.move[src] || fail.move[dst]) throw new Error('IOError: move fault ' + src + ' -> ' + dst);
        if (!isFilePath(src)) throw new Error('IOError: source missing ' + src);
        if (unwritable(this) || unwritable(dest)) throw securityError();
        if (dest.exists && !overwrite) throw new Error('IOError: destination exists ' + dst);
        if (isDirPath(dst)) throw new Error('IOError: destination is a directory ' + dst);
        disk[dst] = disk[src];
        if (has(bytes, src)) bytes[dst] = bytes[src]; else delete bytes[dst];
        mtime[dst] = mtime[src] || stamp();
        delete disk[src];
        delete bytes[src];
        delete mtime[src];
    };

    File.prototype.addEventListener = function (type, fn) {
        (this._listeners[type] = this._listeners[type] || []).push(fn);
    };

    File.prototype.removeEventListener = function (type, fn) {
        var list = this._listeners[type] || [];
        var i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
    };

    File.prototype.listenerCount = function (type) {
        return (this._listeners[type] || []).length;
    };

    File.prototype.browseForOpen = function (title, filters) {
        browses.push({ file: this, title: title, filters: filters, multiple: false });
    };

    File.prototype.browseForOpenMultiple = function (title, filters) {
        browses.push({ file: this, title: title, filters: filters, multiple: true });
    };

    // AIR's static directory getters return a fresh File on each access.
    Object.defineProperty(File, 'applicationDirectory',        { get: function () { return mk(appDir, true); } });
    Object.defineProperty(File, 'applicationStorageDirectory', { get: function () { return mk(storageDir, false); } });
    Object.defineProperty(File, 'documentsDirectory',          { get: function () { return mk(docsDir, false); } });

    var FileMode = { READ: 'read', WRITE: 'write', APPEND: 'append', UPDATE: 'update' };

    function FileStream() {
        this._file = null;
        this._mode = null;
        this.bytesAvailable = 0;
        this._pos = 0;
    }

    FileStream.prototype.open = function (file, mode) {
        var p = file._path;
        if (mode === FileMode.READ) {
            if (!isFilePath(p)) throw new Error('IOError: file does not exist ' + p);
            this.bytesAvailable = fileBuf(p).length;
            this._pos = 0;
        } else {
            if (unwritable(file)) throw securityError();
            if (isDirPath(p)) throw new Error('IOError: is a directory ' + p);
            var d = dirname(p);
            if (d !== null && !isDirPath(d)) throw new Error('IOError: parent missing for ' + p);
            // WRITE creates or truncates at open, as on AIR.
            if (mode === FileMode.WRITE || !isFilePath(p)) {
                disk[p] = '';
                delete bytes[p];
            }
            touch(p);
        }
        this._file = file;
        this._mode = mode;
        stats.opens++;
    };

    FileStream.prototype.readUTFBytes = function () {
        var p = this._file._path;
        if (fail.read[p]) throw new Error('IOError: read fault ' + p);
        this.bytesAvailable = 0;
        return disk[p];
    };

    FileStream.prototype.writeUTFBytes = function (s) {
        var p = this._file._path;
        if (fail.write[p]) throw new Error('IOError: write fault ' + p);
        disk[p] += String(s);
        delete bytes[p];
        touch(p);
    };

    FileStream.prototype.readBytes = function (ba, off, len) {
        var p = this._file._path;
        if (fail.read[p]) throw new Error('IOError: read fault ' + p);
        var buf = fileBuf(p);
        var avail = buf.length - this._pos;
        if (len && len > avail) throw new Error('EOFError: read past end of ' + p);
        var n = len ? len : avail;
        ba._put(off || 0, buf.slice(this._pos, this._pos + n));
        this._pos += n;
        this.bytesAvailable = buf.length - this._pos;
    };

    FileStream.prototype.writeBytes = function (ba, off, len) {
        var p = this._file._path;
        if (fail.write[p]) throw new Error('IOError: write fault ' + p);
        var src = ba.toBuffer();
        var start = off || 0;
        var chunk = src.slice(start, len ? start + len : src.length);
        var whole = Buffer.concat([fileBuf(p), chunk]);
        bytes[p] = whole;
        disk[p] = whole.toString('utf8');
        touch(p);
    };

    FileStream.prototype.close = function () {
        stats.closes++;
    };

    function ByteArray() {
        this._buf = Buffer.alloc(0);
        this.position = 0;
    }

    ByteArray.fromBuffer = function (buf) {
        var ba = new ByteArray();
        ba._buf = Buffer.from(buf);
        return ba;
    };

    Object.defineProperty(ByteArray.prototype, 'length', {
        get: function () { return this._buf.length; }
    });

    // Overwrites from `off`, zero-filling any gap, as a ByteArray write does.
    ByteArray.prototype._put = function (off, chunk) {
        var end = off + chunk.length;
        var next = Buffer.alloc(Math.max(this._buf.length, end));
        this._buf.copy(next);
        chunk.copy(next, off);
        this._buf = next;
    };

    ByteArray.prototype._take = function (n) {
        if (this.position + n > this._buf.length) throw new Error('EOFError: read past end');
        var out = this._buf.slice(this.position, this.position + n);
        this.position += n;
        return out;
    };

    ByteArray.prototype.readUTFBytes = function (n) {
        return this._take(n).toString('utf8');
    };

    ByteArray.prototype.readMultiByte = function (n, charset) {
        var enc = String(charset).toLowerCase() === 'iso-8859-1' ? 'latin1' : 'utf8';
        return this._take(n).toString(enc);
    };

    ByteArray.prototype.readUnsignedByte = function () {
        return this._take(1)[0];
    };

    ByteArray.prototype.writeBytes = function (ba, off, len) {
        var src = ba.toBuffer();
        var start = off || 0;
        var chunk = src.slice(start, len ? start + len : src.length);
        this._put(this.position, chunk);
        this.position += chunk.length;
    };

    ByteArray.prototype.writeUTFBytes = function (s) {
        var chunk = Buffer.from(String(s), 'utf8');
        this._put(this.position, chunk);
        this.position += chunk.length;
    };

    ByteArray.prototype.toBuffer = function () {
        return Buffer.from(this._buf);
    };

    function FileFilter(description, extension) {
        this.description = description;
        this.extension = extension;
    }

    function Menu() {
        this.addItem    = noop;
        this.addSubmenu = function () { return new Menu(); };
    }

    var air = {
        File:          File,
        FileMode:      FileMode,
        FileStream:    FileStream,
        FileFilter:    FileFilter,
        ByteArray:     ByteArray,
        Event:         { SELECT: 'select', CANCEL: 'cancel', COMPLETE: 'complete' },
        FileListEvent: { SELECT_MULTIPLE: 'selectMultiple' },
        Introspector:  { Console: { log: noop, warn: noop, error: noop } },
        ui:            { Menu: Menu }
    };

    function fire(file, type, event) {
        var ev = event || {};
        if (!ev.target) ev.target = file;
        var list = (file._listeners[type] || []).slice();
        for (var i = 0; i < list.length; i++) list[i](ev);
    }

    api = {
        air:        air,
        disk:       disk,
        bytes:      bytes,
        dirs:       dirs,
        mtime:      mtime,
        now:        null,
        fail:       fail,
        appDir:     appDir,
        storageDir: storageDir,
        docsDir:    docsDir,
        stats:      stats,
        browses:    browses,
        fire:       fire,
        file:       function (path) { return new File(path); }
    };
    return api;
}

module.exports = { make: make };
