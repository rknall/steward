/*
 * Element-tree jQuery fake.
 *
 * Just enough of jQuery for the kernel UI code to build and inspect real
 * element trees in a test: creation (`$('<div>', attrs)`), selector lookup
 * inside a context, the manipulation, attribute, class, event and traversal
 * methods the views and helpers call, and `$(window)` with a settable
 * height. Layout is not simulated: `height()`, `outerHeight()` and
 * `offset()` answer plain numbers a test may set on a node.
 *
 * install(H) puts the fake on H.ctx.$ and the shared document fake on
 * H.ctx.document (see ensureDocument in host.js, which this file and
 * installModal both use, so the order they run in does not matter). It
 * creates H.ctx.window = {} only when no window exists, so ui-menu's
 * `{ nativeWindow: ... }` stays the same object.
 *
 *   var jq = require('../stubs/jq');
 *   var $ = jq.install(H);
 *   var $row = $('<div>', { 'class': 'a' }).append($('<span>').text('x'));
 *   $row.find('span').text();          // 'x'
 *   jq.setWindowHeight(640);           // what $(window).height() answers
 */

'use strict';

var hostStubs = require('./host');

var DEFAULT_WINDOW_HEIGHT = 860;
var windowHeight = DEFAULT_WINDOW_HEIGHT;

function setWindowHeight(n) { windowHeight = n; }

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

function Node(tag) {
    this.tag = tag;
    this.attrs = {};
    this.props = {};
    this.cls = [];
    this.style = {};
    this.children = [];
    this.parent = null;
    this.handlers = {};
    this.dataStore = {};
    this.textValue = '';
    this.htmlStr = null;
    this.value = undefined;
    // A boolean, or a function returning one, so a rig can drive it.
    this.visible = true;
    this.h = 0;
    this.top = 0;
    this.w = 0;
    this.nodeType = 1;
}

Object.defineProperty(Node.prototype, 'firstChild', {
    get: function () { return this.children.length ? this.children[0] : null; }
});

Node.prototype.appendChild = function (child) {
    detach(child);
    child.parent = this;
    this.children.push(child);
    return child;
};

Node.prototype.removeChild = function (child) {
    var i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parent = null;
    return child;
};

Node.prototype.setAttribute = function (name, value) { setAttr(this, name, value); };
Node.prototype.getAttribute = function (name) {
    var v = getAttr(this, name);
    return v === undefined ? null : v;
};

function makeText(data) {
    var n = new Node('#text');
    n.nodeType = 3;
    n.data = String(data);
    return n;
}

function detach(node) {
    if (node.parent) node.parent.removeChild(node);
}

function setAttr(node, name, value) {
    if (name === 'class') {
        node.cls = String(value).split(/\s+/).filter(function (c) { return c; });
    } else if (name === 'value') {
        node.value = String(value);
    } else {
        node.attrs[name] = String(value);
    }
}

function getAttr(node, name) {
    if (name === 'class') return node.cls.length ? node.cls.join(' ') : undefined;
    if (name === 'value') return node.value;
    return Object.prototype.hasOwnProperty.call(node.attrs, name) ? node.attrs[name] : undefined;
}

function isVisible(node) {
    return typeof node.visible === 'function' ? !!node.visible() : !!node.visible;
}

function textOf(node) {
    if (node.nodeType === 3) return node.data;
    var out = node.textValue;
    for (var i = 0; i < node.children.length; i++) out += textOf(node.children[i]);
    return out;
}

function clearContent(node) {
    for (var i = 0; i < node.children.length; i++) node.children[i].parent = null;
    node.children = [];
    node.textValue = '';
    node.htmlStr = null;
}

// ---------------------------------------------------------------------------
// Selectors: tag, #id, .class, [attr], [attr="v"], compounds, descendant
// combinator and comma lists.
// ---------------------------------------------------------------------------

var TOKEN = /^(?:(\*|[a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\])/;

function parseCompound(text) {
    var out = { tag: null, id: null, cls: [], attrs: [] };
    var rest = text;
    while (rest) {
        var m = TOKEN.exec(rest);
        if (!m) throw new Error('jq fake: unsupported selector "' + text + '"');
        if (m[1]) out.tag = m[1].toLowerCase();
        else if (m[2]) out.id = m[2];
        else if (m[3]) out.cls.push(m[3]);
        else {
            var v = m[5] !== undefined ? m[5] : (m[6] !== undefined ? m[6] : m[7]);
            out.attrs.push({ name: m[4], value: v });
        }
        rest = rest.substring(m[0].length);
    }
    return out;
}

function parseSelector(sel) {
    var groups = String(sel).split(',');
    var out = [];
    for (var i = 0; i < groups.length; i++) {
        var parts = groups[i].replace(/^\s+|\s+$/g, '').split(/\s+/);
        if (parts.length === 1 && parts[0] === '') continue;
        out.push(parts.map(parseCompound));
    }
    return out;
}

function matchesCompound(node, c) {
    if (node.nodeType !== 1) return false;
    if (c.tag && c.tag !== '*' && node.tag !== c.tag) return false;
    if (c.id && node.attrs.id !== c.id) return false;
    for (var i = 0; i < c.cls.length; i++) {
        if (node.cls.indexOf(c.cls[i]) < 0) return false;
    }
    for (var j = 0; j < c.attrs.length; j++) {
        var a = getAttr(node, c.attrs[j].name);
        if (a === undefined) return false;
        if (c.attrs[j].value !== undefined && String(a) !== c.attrs[j].value) return false;
    }
    return true;
}

function matchesChain(node, chain) {
    if (!matchesCompound(node, chain[chain.length - 1])) return false;
    var at = node.parent;
    for (var i = chain.length - 2; i >= 0; i--) {
        while (at && !matchesCompound(at, chain[i])) at = at.parent;
        if (!at) return false;
        at = at.parent;
    }
    return true;
}

function matches(node, sel) {
    var groups = parseSelector(sel);
    for (var i = 0; i < groups.length; i++) {
        if (matchesChain(node, groups[i])) return true;
    }
    return false;
}

function collect(root, groups, out) {
    for (var i = 0; i < root.children.length; i++) {
        var ch = root.children[i];
        if (ch.nodeType !== 1) continue;
        for (var g = 0; g < groups.length; g++) {
            if (matchesChain(ch, groups[g])) { out.push(ch); break; }
        }
        collect(ch, groups, out);
    }
}

function findIn(roots, sel) {
    var groups = parseSelector(sel);
    var out = [];
    for (var i = 0; i < roots.length; i++) collect(roots[i], groups, out);
    return out;
}

// ---------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------

function create(H) {
    var doc = hostStubs.ensureDocument(H);

    var headNode = (doc.head && doc.head instanceof Node) ? doc.head : null;
    if (!headNode) {
        headNode = new Node('head');
        doc.head = headNode;
    }
    var bodyNode = (doc.body && doc.body instanceof Node) ? doc.body : null;
    if (!bodyNode) {
        bodyNode = new Node('body');
        doc.body = bodyNode;
    }
    doc._search = function (id) {
        var found = findIn([headNode, bodyNode], '#' + id);
        return found.length ? found[0] : null;
    };

    function J(nodes) {
        this.length = nodes.length;
        for (var i = 0; i < nodes.length; i++) this[i] = nodes[i];
    }
    J.prototype.jquery = 'steward-fake';

    function wrap(nodes) { return new J(nodes); }

    function nodesOf(x) {
        var out = [];
        if (x === null || x === undefined) return out;
        if (x instanceof J) {
            for (var i = 0; i < x.length; i++) out.push(x[i]);
        } else if (x instanceof Node) {
            out.push(x);
        } else if (Array.isArray(x)) {
            for (var j = 0; j < x.length; j++) out = out.concat(nodesOf(x[j]));
        } else {
            out.push(makeText(x));
        }
        return out;
    }

    function create1(markup, attrs) {
        var tag = String(markup).replace(/^<\s*/, '').replace(/\s*\/?>\s*$/, '').toLowerCase();
        var node = new Node(tag);
        var $n = wrap([node]);
        if (attrs) {
            for (var k in attrs) {
                if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
                if (k === 'text') $n.text(attrs[k]);
                else if (k === 'html') $n.html(attrs[k]);
                else if (k === 'css') $n.css(attrs[k]);
                else setAttr(node, k, attrs[k]);
            }
        }
        return $n;
    }

    function $(arg, context) {
        if (arg instanceof J) return arg;
        if (typeof arg === 'string') {
            if (/^\s*</.test(arg)) return create1(arg, context);
            var roots = context ? nodesOf(context) : [headNode, bodyNode];
            if (!context && arg === 'head') return wrap([headNode]);
            if (!context && arg === 'body') return wrap([bodyNode]);
            return wrap(findIn(roots, arg));
        }
        if (arg && arg === H.ctx.window) {
            var w = new Node('#window');
            w.isWindow = true;
            return wrap([w]);
        }
        if (arg instanceof Node) return wrap([arg]);
        if (arg === doc) return wrap([bodyNode]);
        if (arg && typeof arg === 'object') {
            var o = new Node('#object');
            o.ref = arg;
            return wrap([o]);
        }
        return wrap([]);
    }

    var fn = J.prototype;
    $.fn = fn;
    $._jqFake = true;

    function each(self, f) {
        for (var i = 0; i < self.length; i++) f(self[i], i);
    }

    function placeChildren(self, args, atStart) {
        var added = [];
        for (var a = 0; a < args.length; a++) added = added.concat(nodesOf(args[a]));
        var target = self[0];
        if (!target) return self;
        if (atStart) added.reverse();
        for (var i = 0; i < added.length; i++) {
            detach(added[i]);
            added[i].parent = target;
            if (atStart) target.children.unshift(added[i]);
            else target.children.push(added[i]);
        }
        return self;
    }

    fn.append  = function () { return placeChildren(this, arguments, false); };
    fn.prepend = function () { return placeChildren(this, arguments, true); };
    fn.empty = function () { each(this, clearContent); return this; };
    fn.remove = function () { each(this, detach); return this; };

    fn.text = function (v) {
        if (v === undefined) return this.length ? textOf(this[0]) : '';
        each(this, function (n) {
            clearContent(n);
            n.textValue = String(v);
        });
        return this;
    };
    fn.html = function (v) {
        if (v === undefined) return this.length && this[0].htmlStr !== null ? this[0].htmlStr : '';
        each(this, function (n) {
            clearContent(n);
            n.htmlStr = String(v);
        });
        return this;
    };
    fn.val = function (v) {
        if (v === undefined) {
            var n = this[0];
            if (!n) return undefined;
            if (n.value !== undefined) return n.value;
            if (n.tag === 'select') {
                var opts = n.children.filter(function (c) { return c.tag === 'option'; });
                for (var i = 0; i < opts.length; i++) {
                    if (opts[i].attrs.selected !== undefined) return opts[i].value;
                }
                return opts.length ? opts[0].value : '';
            }
            return '';
        }
        each(this, function (node) { node.value = String(v); });
        return this;
    };

    fn.attr = function (name, v) {
        if (typeof name === 'object' && name !== null) {
            var self = this;
            for (var k in name) {
                if (Object.prototype.hasOwnProperty.call(name, k)) self.attr(k, name[k]);
            }
            return this;
        }
        if (v === undefined) return this.length ? getAttr(this[0], name) : undefined;
        each(this, function (n) { setAttr(n, name, v); });
        return this;
    };
    fn.removeAttr = function (name) {
        each(this, function (n) {
            if (name === 'class') n.cls = [];
            else delete n.attrs[name];
        });
        return this;
    };
    fn.prop = function (name, v) {
        if (v === undefined) {
            var n = this[0];
            if (!n) return undefined;
            if (Object.prototype.hasOwnProperty.call(n.props, name)) return n.props[name];
            return n.attrs[name] !== undefined && n.attrs[name] !== 'false';
        }
        each(this, function (node) { node.props[name] = v; });
        return this;
    };
    fn.data = function (name, v) {
        if (v === undefined) return this.length ? this[0].dataStore[name] : undefined;
        each(this, function (n) { n.dataStore[name] = v; });
        return this;
    };
    fn.css = function (name, v) {
        if (typeof name === 'object' && name !== null) {
            each(this, function (n) {
                for (var k in name) {
                    if (Object.prototype.hasOwnProperty.call(name, k)) n.style[k] = name[k];
                }
            });
            return this;
        }
        if (v === undefined) return this.length ? this[0].style[name] : undefined;
        each(this, function (n) { n.style[name] = v; });
        return this;
    };

    fn.addClass = function (c) {
        var add = String(c).split(/\s+/).filter(function (x) { return x; });
        each(this, function (n) {
            for (var i = 0; i < add.length; i++) {
                if (n.cls.indexOf(add[i]) < 0) n.cls.push(add[i]);
            }
        });
        return this;
    };
    fn.removeClass = function (c) {
        var rm = String(c).split(/\s+/);
        each(this, function (n) {
            n.cls = n.cls.filter(function (x) { return rm.indexOf(x) < 0; });
        });
        return this;
    };
    fn.hasClass = function (c) {
        return this.length > 0 && this[0].cls.indexOf(c) >= 0;
    };
    fn.toggleClass = function (c, state) {
        each(this, function (n) {
            var on = state === undefined ? n.cls.indexOf(c) < 0 : !!state;
            if (on) fn.addClass.call(wrap([n]), c);
            else fn.removeClass.call(wrap([n]), c);
        });
        return this;
    };

    function events(text) {
        return String(text).split(/\s+/).filter(function (e) { return e; })
            .map(function (e) { return e.split('.')[0]; });
    }
    fn.on = function (evt, f) {
        var names = events(evt);
        each(this, function (n) {
            for (var i = 0; i < names.length; i++) {
                (n.handlers[names[i]] = n.handlers[names[i]] || []).push(f);
            }
        });
        return this;
    };
    fn.off = function (evt) {
        var names = evt === undefined ? null : events(evt);
        each(this, function (n) {
            if (!names) { n.handlers = {}; return; }
            for (var i = 0; i < names.length; i++) delete n.handlers[names[i]];
        });
        return this;
    };
    fn.trigger = function (evt, extra) {
        var name = events(evt)[0];
        each(this, function (n) {
            var list = (n.handlers[name] || []).slice();
            for (var i = 0; i < list.length; i++) {
                var e = {
                    type: name, target: n, which: 0,
                    preventDefault: function () {}, stopPropagation: function () {}
                };
                list[i].call(n, e, extra);
            }
        });
        return this;
    };
    ['click', 'change', 'input', 'blur', 'focus'].forEach(function (name) {
        fn[name] = function (f) {
            return typeof f === 'function' ? this.on(name, f) : this.trigger(name);
        };
    });

    fn.find = function (sel) { return wrap(findIn(nodesOf(this), sel)); };
    fn.children = function (sel) {
        var out = [];
        each(this, function (n) {
            for (var i = 0; i < n.children.length; i++) {
                if (n.children[i].nodeType !== 1) continue;
                if (!sel || matches(n.children[i], sel)) out.push(n.children[i]);
            }
        });
        return wrap(out);
    };
    fn.parent = function () {
        var out = [];
        each(this, function (n) {
            if (n.parent && out.indexOf(n.parent) < 0) out.push(n.parent);
        });
        return wrap(out);
    };
    fn.closest = function (sel) {
        var out = [];
        each(this, function (n) {
            var at = n;
            while (at && !matches(at, sel)) at = at.parent;
            if (at && out.indexOf(at) < 0) out.push(at);
        });
        return wrap(out);
    };
    fn.each = function (f) {
        for (var i = 0; i < this.length; i++) {
            if (f.call(this[i], i, this[i]) === false) break;
        }
        return this;
    };
    fn.eq = function (i) {
        var idx = i < 0 ? this.length + i : i;
        return wrap(idx >= 0 && idx < this.length ? [this[idx]] : []);
    };
    fn.first = function () { return this.eq(0); };
    fn.last = function () { return this.eq(-1); };
    fn.get = function (i) { return this[i]; };
    fn.is = function (sel) {
        if (!this.length) return false;
        if (sel === ':visible') return isVisible(this[0]);
        if (sel === ':hidden') return !isVisible(this[0]);
        return matches(this[0], sel);
    };

    function metric(key) {
        return function (v) {
            if (v === undefined) {
                if (!this.length) return undefined;
                if (this[0].isWindow && key === 'h') return windowHeight;
                return this[0][key];
            }
            each(this, function (n) { n[key] = v; });
            return this;
        };
    }
    fn.height = metric('h');
    fn.outerHeight = metric('h');
    fn.width = metric('w');
    fn.offset = function () {
        return this.length ? { top: this[0].top, left: 0 } : undefined;
    };

    $.Node = Node;
    $.matches = matches;
    return $;
}

// Installs the fake and the shared document on H.ctx. Returns `$`.
function install(H) {
    windowHeight = DEFAULT_WINDOW_HEIGHT;
    var $ = create(H);
    H.ctx.$ = $;
    if (!H.ctx.window) H.ctx.window = {};
    return $;
}

module.exports = {
    install:         install,
    setWindowHeight: setWindowHeight
};
