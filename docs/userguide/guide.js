/* steward user guide: phone menu, theme toggle and a scroll spy for the nav.
   Every feature degrades: without this script the pages read fine, the nav
   details still open and close, and the system colour scheme applies. */
(function () {
	'use strict';

	var doc = document;
	var root = doc.documentElement;
	var body = doc.body;
	var KEY = 'steward-guide-theme';

	function effectiveTheme() {
		var t = root.getAttribute('data-theme');
		if (t === 'light' || t === 'dark') { return t; }
		return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
	}

	/* The button always offers the opposite of what is showing. */
	function labelTheme(btn) {
		var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
		btn.setAttribute('aria-label', 'Switch to ' + next + ' theme');
	}

	function initTheme() {
		var btn = doc.querySelector('.ug-theme');
		if (!btn) { return; }
		labelTheme(btn);
		btn.addEventListener('click', function () {
			var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
			root.setAttribute('data-theme', next);
			try { localStorage.setItem(KEY, next); } catch (e) { /* not persisted */ }
			labelTheme(btn);
		});
	}

	function initMenu() {
		var btn = doc.querySelector('.ug-menu');
		var nav = doc.getElementById('ug-nav');
		var scrim = doc.querySelector('.ug-scrim');
		if (!btn || !nav) { return; }

		function setOpen(open) {
			if (open) { body.classList.add('ug-open'); } else { body.classList.remove('ug-open'); }
			btn.setAttribute('aria-expanded', open ? 'true' : 'false');
		}

		btn.addEventListener('click', function () {
			setOpen(!body.classList.contains('ug-open'));
		});
		if (scrim) { scrim.addEventListener('click', function () { setOpen(false); }); }
		nav.addEventListener('click', function (ev) {
			var el = ev.target;
			while (el && el !== nav) {
				if (el.tagName === 'A') { setOpen(false); return; }
				el = el.parentNode;
			}
		});
		doc.addEventListener('keydown', function (ev) {
			if (ev.key === 'Escape' || ev.keyCode === 27) { setOpen(false); }
		});
	}

	/* Moves the "on" class to the l3 link of the section in view. */
	function initSpy() {
		var main = doc.querySelector('.ug-main');
		var links = doc.querySelectorAll('.ug-nav .l3 a');
		if (!main || !links.length) { return; }
		var byId = {};
		var i;
		for (i = 0; i < links.length; i++) {
			var href = links[i].getAttribute('href') || '';
			var at = href.indexOf('#');
			if (at >= 0) { byId[href.slice(at + 1)] = links[i]; }
		}
		var heads = main.querySelectorAll('h2[id]');
		var tops = [];
		for (i = 0; i < heads.length; i++) {
			if (byId[heads[i].id]) { tops.push(heads[i]); }
		}
		if (!tops.length) { return; }

		function update() {
			var edge = main.getBoundingClientRect().top + 80;
			var current = tops[0];
			var j;
			for (j = 0; j < tops.length; j++) {
				if (tops[j].getBoundingClientRect().top <= edge) { current = tops[j]; }
			}
			for (j = 0; j < links.length; j++) { links[j].classList.remove('on'); }
			byId[current.id].classList.add('on');
		}
		main.addEventListener('scroll', update);
		update();
	}

	initTheme();
	initMenu();
	initSpy();
}());
