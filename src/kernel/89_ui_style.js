/*
 * Shared UI stylesheet.
 *
 * The first UI file in the bundle: it creates S.kernel.ui and the
 * S.kernel.ui.views registry the dashboard and Settings views add
 * themselves to, so 90-93 can assume both exist.
 *
 * One rule set styles every steward screen (dashboard, Settings, module
 * dialogs). The rules carry no scope prefix; scopeCss() prefixes every
 * selector with each modal id that shares the look, so the rules exist
 * once. ensureStyle(modalId) adds a modal id to that scope list.
 *
 * Every colour and size comes from TOKENS, every panel and column
 * dimension from S.kernel.ui.layout; buildRules() only concatenates them,
 * so a colour or width is changed in one place and the views never pick
 * their own. Views emit only the steward-* classes defined here.
 *
 * The host's bootstrap.min.css forces .modal-body { height:60% } and its
 * own padding; both need !important to override. The wood chrome images on
 * the modal header, body and footer are the host's and stay untouched.
 *
 * AIR 32 WebKit is old: the rules use floats with overflow:hidden
 * clearing, inline-block, display:table, percentage widths,
 * table-layout:fixed, flat colours, rgba, box-shadow, border-radius,
 * :nth-child, -webkit-transition and :focus. They never use flex or grid
 * layout, gradients, calc(), sticky positioning, :focus-visible, custom
 * properties or viewport and root-relative units.
 */

(function (S) {
    'use strict';

    if (!S.kernel.ui) S.kernel.ui = {};
    if (!S.kernel.ui.views) S.kernel.ui.views = {};

    // The dashboard's modal id. It lives here because this file loads first
    // and the stylesheet scopes the dashboard before any other screen.
    var DASHBOARD_MODAL_ID = 'StewardDashboard';

    // -----------------------------------------------------------------
    // Tokens: every colour and every non-layout size the rules use.
    // Colour names say the role, not the hue. The first twelve are the
    // palette's named roles; the rest are the shades derived from them.
    // -----------------------------------------------------------------

    var TOKENS = {
        // named roles
        ink:          '#1f1a10',   // text on the band colour
        band:         '#b2a589',   // card heads, strips (host .tblHeader)
        text:         '#ece4cf',
        muted:        '#bdb39b',
        dim:          '#a69d87',
        brass:        '#d9a441',   // the only accent
        brassOn:      '#c8963a',   // switch on
        ok:           '#a8d98c',
        busy:         '#f0cf8a',
        bad:          '#f3a299',
        field:        '#f1e6c9',   // input background
        fieldLine:    '#5a4a30',   // input border

        // further solid shades
        white:        '#fff',
        soft:         '#d8cfb6',   // tab, nav, table head and chip text
        bandText:     '#3b3220',   // secondary text on the band colour
        tableHead:    '#2a251c',
        fieldInk:     '#2a2418',   // text inside inputs
        closeInk:     '#f3ead2',
        dotOff:       '#7d7462',
        switchOff:    '#6b6455',
        knob:         '#f6f0e0',
        disabledInk:  '#8d8571',
        scrollThumb:  '#8b8b8b',
        btnInk:       '#1d160b',
        btnInkOff:    '#6e6555',
        invalidLine:  '#c0392b',
        confirmBg:    '#9b3b2e',
        bannerInk:    '#f3e2b8',
        okInk:        '#c4e8ad',
        busyInk:      '#f3d796',
        offInk:       '#cfc6b0',
        pausedInk:    '#f7b5ab',
        phaseInk:     '#eaf7df',
        avatarBg:     '#7a6a4c',
        avatarLine:   '#c3a978',

        // translucent shades
        shadeCard:    'rgba(0,0,0,.2)',
        shadeLine:    'rgba(0,0,0,.4)',
        shadeFoot:    'rgba(0,0,0,.35)',
        shadeTitle:   'rgba(0,0,0,.7)',
        shadeTotal:   'rgba(0,0,0,.15)',
        shadeIcon:    'rgba(0,0,0,.25)',
        rowLine:      'rgba(255,255,255,.06)',
        bandTab:      'rgba(178,165,137,.12)',
        bandNav:      'rgba(178,165,137,.16)',
        bandEdge:     'rgba(178,165,137,.28)',
        bandSub:      'rgba(178,165,137,.2)',
        bandChip:     'rgba(178,165,137,.4)',
        bandIcon:     'rgba(178,165,137,.45)',
        bandZebra:    'rgba(178,165,137,.06)',
        brassRing:    'rgba(217,164,65,.7)',
        brassDirty:   'rgba(217,164,65,.55)',
        brassTint:    'rgba(217,164,65,.14)',
        brassEdge:    'rgba(217,164,65,.45)',
        brassBusy:    'rgba(217,164,65,.22)',
        brassTag:     'rgba(217,164,65,.6)',
        badRing:      'rgba(214,96,80,.6)',
        badTint:      'rgba(214,96,80,.3)',
        okTint:       'rgba(127,174,90,.25)',
        offTint:      'rgba(125,116,98,.35)',
        phaseBg:      'rgba(70,110,50,.85)',

        // type steps (px)
        fontXs:       11,
        fontBadge:    11.5,
        fontSm:       12,
        fontNote:     12.5,
        fontBase:     13,
        fontMd:       14,
        fontLg:       18,
        fontTitle:    19,
        fontClose:    22,

        // radius steps (px)
        radiusInput:  3,
        radiusSm:     4,
        radiusNav:    6,
        radiusLg:     8,
        radiusPill:   10,
        radiusChip:   12,

        // control and row sizes (px)
        tileMin:      118,
        btnH:         33,
        btnSmH:       26,
        scrollbar:    5,
        switchW:      36,
        switchH:      19,
        knobSize:     15,
        inputH:       26,
        inputW:       64,
        headH:        32,
        thH:          28,
        tdH:          31
    };

    // Panel and column dimensions. compactMaxHeight, minPanel and chrome
    // are read by the shell when it sizes a compact screen, not by the CSS.
    var layout = {
        modal:            1000,
        panel:            480,
        settingsPanel:    524,
        side:             318,
        sideWide:         360,
        sideEdit:         440,
        snav:             190,
        narrow:           620,
        fieldCtl:         122,
        fieldCtlWide:     220,
        compactMaxHeight: 700,
        minPanel:         240,
        chrome:           { dashboard: 270, settings: 226 }
    };

    // -----------------------------------------------------------------
    // Rule set
    // -----------------------------------------------------------------

    function px(n) { return n + 'px'; }

    // Builds the unscoped rule list from tokens and layout only. No colour
    // or layout number is written here: changing a token or a layout value
    // changes every rule that uses it.
    function buildRules(t, l) {
        var bb = '-webkit-box-sizing:border-box;box-sizing:border-box;';
        var clear = '{content:"";display:block;clear:both;height:0;}';
        var line = '1px solid ' + t.rowLine;
        var thumb = '{background:' + t.scrollThumb + ';border-radius:7px;}';
        var bar = '{width:' + px(t.scrollbar) + ';}';
        var dirtyRing = 'border-color:' + t.brass + ';box-shadow:0 0 0 2px ' + t.brassDirty + ';';

        return [
            '*{' + bb + '}',

            // ---- modal frame (host wood chrome kept) ----
            '.modal-dialog{width:' + px(l.modal) + ';max-width:96%;}',
            '.modal-content{color:' + t.text + ';}',
            '.modal-header{padding:14px 24px 12px !important;' +
                'border-bottom:1px solid ' + t.shadeLine + ';}',
            '.modal-header .modal-title,.modal-header h4{display:inline-block;' +
                'vertical-align:middle;color:' + t.white + ';font-size:' + px(t.fontTitle) + ';' +
                'font-weight:600;margin:0;text-shadow:0 1px 2px ' + t.shadeTitle + ';}',
            '.modal-header .close{color:' + t.closeInk + ';opacity:1;text-shadow:none;' +
                'font-size:' + px(t.fontClose) + ';line-height:1;}',
            '.modal-header .close:hover{color:' + t.white + ';}',
            '.steward-head-extra{display:inline-block;vertical-align:middle;margin-left:12px;}',
            '.steward-head-sum{color:' + t.soft + ';font-size:' + px(t.fontNote) + ';' +
                'margin-left:8px;vertical-align:middle;}',
            '.modal-body{padding:0 !important;height:auto !important;' +
                'overflow:visible;color:' + t.text + ';font-size:' + px(t.fontBase) + ';' +
                'line-height:1.4;}',
            // The host sizes the footer frame image with 'contain'; in this wider
            // footer that draws it narrower than the footer, so its rounded edge
            // shows as vertical lines (one through Save). Stretch that frame layer to the full
            // width; the second layer (the tiled wood) keeps the host's contain.
            '.modal-footer{padding:12px 24px !important;margin:0;text-align:left;' +
                'background-size:100% 100%,contain;border-top:1px solid ' + t.shadeFoot + ';}',
            '.modal-footer:after' + clear,
            '.modal-footer .btn{margin:0;vertical-align:middle;}',
            '.steward-foot-note,.steward-foot-dirty,.steward-foot-need{display:inline-block;' +
                'vertical-align:middle;margin-left:12px;}',
            '.steward-foot-note{color:' + t.muted + ';font-size:' + px(t.fontSm) + ';}',
            '.steward-foot-dirty,.steward-foot-need{color:' + t.busy + ';' +
                'font-size:' + px(t.fontNote) + ';font-weight:600;}',
            '.steward-foot-right{float:right;}',

            // ---- tab bar ----
            '.steward-tabs{padding:0 22px;border-bottom:1px solid ' + t.shadeLine + ';}',
            '.steward-tabs:after' + clear,
            '.steward-tab{float:left;display:block;margin-right:2px;padding:11px 16px 9px;' +
                'color:' + t.soft + ';font-size:' + px(t.fontMd) + ';background:none;' +
                'border:0;border-bottom:3px solid transparent;text-decoration:none;cursor:pointer;}',
            '.steward-tab:hover,.steward-tab:focus{color:' + t.white + ';text-decoration:none;outline:0;}',
            '.steward-tab.active{color:' + t.white + ';font-weight:600;' +
                'border-bottom-color:' + t.brass + ';background:' + t.bandTab + ';}',
            '.steward-tab-cnt{display:inline-block;margin-left:6px;padding:0 6px;' +
                'font-size:' + px(t.fontXs) + ';font-weight:600;line-height:16px;' +
                'color:' + t.ink + ';background:' + t.band + ';border-radius:' + px(t.radiusLg) + ';}',
            '.steward-tab-dot{display:inline-block;width:7px;height:7px;border-radius:50%;' +
                'margin-left:6px;vertical-align:1px;background:' + t.dotOff + ';}',
            '.steward-tab-dot.steward-live{background:' + t.ok + ';}',
            '.steward-tab-chg{color:' + t.busy + ';margin-left:4px;font-weight:700;}',

            // ---- panel ----
            '.steward-panel{height:' + px(l.panel) + ';overflow:hidden;padding:16px 22px;}',
            '.steward-panel.steward-set{height:' + px(l.settingsPanel) + ';' +
                'border-top:1px solid ' + t.shadeLine + ';}',
            '.steward-panel.steward-compact{overflow-y:auto;}',
            '.steward-panel::-webkit-scrollbar,.steward-fill::-webkit-scrollbar,' +
                '.steward-side::-webkit-scrollbar,.steward-main::-webkit-scrollbar,' +
                '.steward-snav::-webkit-scrollbar' + bar,
            '.steward-panel::-webkit-scrollbar-thumb,.steward-fill::-webkit-scrollbar-thumb,' +
                '.steward-side::-webkit-scrollbar-thumb,.steward-main::-webkit-scrollbar-thumb,' +
                '.steward-snav::-webkit-scrollbar-thumb' + thumb,

            // ---- layout: a floated column beside a main column that takes
            // the rest (overflow makes it a block formatting context) ----
            '.steward-cols{height:100%;overflow:hidden;}',
            '.steward-side{float:left;width:' + px(l.side) + ';height:100%;' +
                'margin-right:16px;overflow-x:hidden;overflow-y:auto;}',
            '.steward-side.steward-wide{width:' + px(l.sideWide) + ';}',
            '.steward-side.steward-edit{width:' + px(l.sideEdit) + ';}',
            '.steward-main{height:100%;overflow-x:hidden;overflow-y:auto;}',
            '.steward-main.steward-narrow{max-width:' + px(l.narrow) + ';}',
            '.steward-side > * + *,.steward-main > * + *{margin-top:14px;}',
            '.steward-stack > * + *{margin-top:12px;}',
            '.steward-compact .steward-cols,.steward-compact .steward-side,' +
                '.steward-compact .steward-main{height:auto;}',

            // ---- settings side nav ----
            '.steward-snav{float:left;width:' + px(l.snav) + ';height:100%;margin-right:16px;' +
                'padding-top:2px;overflow-x:hidden;overflow-y:auto;}',
            '.steward-snav-item{display:block;width:100%;margin-bottom:2px;padding:9px 12px;' +
                'text-align:left;color:' + t.soft + ';background:none;border:0;' +
                'border-left:3px solid transparent;border-radius:' + px(t.radiusNav) + ';' +
                'font-size:' + px(t.fontMd) + ';font-family:inherit;text-decoration:none;cursor:pointer;}',
            '.steward-snav-item:hover,.steward-snav-item:focus{color:' + t.white + ';' +
                'text-decoration:none;outline:0;}',
            '.steward-snav-item.active{background:' + t.bandNav + ';color:' + t.white + ';' +
                'font-weight:600;border-left-color:' + t.brass + ';}',
            '.steward-snav-grp{padding:12px 12px 4px;font-size:' + px(t.fontXs) + ';' +
                'color:' + t.dim + ';letter-spacing:.6px;}',
            '.steward-snav-dot{color:' + t.busy + ';margin-left:4px;font-weight:700;}',

            // ---- card ----
            '.steward-card{background:' + t.shadeCard + ';border:1px solid ' + t.bandEdge + ';' +
                'border-radius:' + px(t.radiusLg) + ';overflow:hidden;}',
            '.steward-card-h{min-height:' + px(t.headH) + ';line-height:' + px(t.headH) + ';' +
                'padding:0 12px;background:' + t.band + ';color:' + t.ink + ';' +
                'font-size:' + px(t.fontMd) + ';font-weight:600;overflow:hidden;}',
            '.steward-card-meta{float:right;margin-left:10px;font-size:' + px(t.fontSm) + ';' +
                'font-weight:400;color:' + t.bandText + ';}',
            '.steward-card-h .steward-link{float:right;margin-left:10px;line-height:' + px(t.headH) + ';' +
                'color:' + t.bandText + ';font-size:' + px(t.fontSm) + ';font-weight:600;}',
            '.steward-card-h .btn,.steward-card-h .switch{float:right;margin:3px 0 0 10px;}',
            '.steward-card-badge{margin-left:10px;}',
            '.steward-inline{padding:9px 12px;}',
            '.steward-inline-item{display:inline-block;margin-right:22px;}',
            '.steward-note{padding:0 12px 8px;}',
            '.steward-card-foot{padding:8px 12px;}',
            '.steward-icon{display:inline-block;min-width:16px;margin-right:8px;text-align:center;}',
            '.steward-subhead{padding:8px 12px 6px;font-size:' + px(t.fontSm) + ';font-weight:600;' +
                'color:' + t.soft + ';letter-spacing:.3px;border-bottom:1px solid ' + t.bandSub + ';' +
                'overflow:hidden;}',
            '.steward-subhead-meta{float:right;font-weight:400;color:' + t.muted + ';letter-spacing:0;}',

            // ---- field: control column floated right, label takes the rest ----
            '.steward-field{padding:9px 12px;border-top:' + line + ';overflow:hidden;}',
            '.steward-card-h + .steward-field,.steward-subhead + .steward-field{border-top:0;}',
            '.steward-field-ctl{float:right;width:' + px(l.fieldCtl) + ';margin-left:12px;' +
                'text-align:right;white-space:nowrap;}',
            '.steward-field-ctl.steward-wide{width:' + px(l.fieldCtlWide) + ';}',
            '.steward-field-lbl{display:block;overflow:hidden;}',
            '.steward-field-name{display:block;font-weight:400;color:' + t.text + ';}',
            '.steward-field-help{display:block;margin-top:1px;color:' + t.muted + ';' +
                'font-size:' + px(t.fontSm) + ';}',
            '.steward-field.steward-sub{padding-left:30px;}',
            '.steward-field.steward-dis .steward-field-name,' +
                '.steward-field.steward-dis .steward-field-help{color:' + t.disabledInk + ';}',
            '.steward-field.steward-wrap .steward-field-ctl{float:none;display:block;width:auto;' +
                'margin:6px 0 0;text-align:left;}',
            '.steward-field-ctl .steward-dropdown,' +
                '.steward-field-ctl.steward-wide .steward-input{width:100%;}',
            '.steward-field-ctl.steward-wide .steward-input{text-align:left;}',

            // ---- host switch, restyled ----
            '.switch{position:relative;display:inline-block;width:' + px(t.switchW) + ';' +
                'height:' + px(t.switchH) + ';margin:0;vertical-align:middle;}',
            '.switch input{position:absolute;opacity:0;width:0;height:0;margin:0;}',
            '.switch .slider{position:absolute;top:0;left:0;right:0;bottom:0;cursor:pointer;' +
                'background:' + t.switchOff + ';border-radius:' + px(t.radiusPill) + ';' +
                '-webkit-transition:background .2s;transition:background .2s;}',
            '.switch .slider:before{content:"";position:absolute;left:2px;top:2px;bottom:auto;' +
                'width:' + px(t.knobSize) + ';height:' + px(t.knobSize) + ';border-radius:50%;' +
                'background:' + t.knob + ';-webkit-transform:none;transform:none;' +
                '-webkit-transition:-webkit-transform .2s;transition:transform .2s;}',
            '.switch input:checked + .slider{background:' + t.brassOn + ';}',
            '.switch input:checked + .slider:before{' +
                '-webkit-transform:translateX(' + px(t.switchW - t.knobSize - 4) + ');' +
                'transform:translateX(' + px(t.switchW - t.knobSize - 4) + ');}',
            '.switch.steward-dirty .slider,.switch .slider.steward-dirty{' +
                'box-shadow:0 0 0 2px ' + t.brassRing + ';}',
            '.switch.steward-disabled .slider,.switch input:disabled + .slider{' +
                'opacity:.4;cursor:default;}',

            // ---- inputs ----
            '.steward-input,.steward-dropdown{height:' + px(t.inputH) + ';' +
                'border:1px solid ' + t.fieldLine + ';border-radius:' + px(t.radiusInput) + ';' +
                'background:' + t.field + ';color:' + t.fieldInk + ';' +
                'font-size:' + px(t.fontBase) + ';font-family:inherit;line-height:normal;' +
                'box-shadow:none;vertical-align:middle;}',
            '.steward-input{width:' + px(t.inputW) + ';padding:0 7px;text-align:right;}',
            '.steward-dropdown{max-width:100%;padding:0 5px;cursor:pointer;}',
            '.steward-input:focus,.steward-dropdown:focus{outline:0;border-color:' + t.brass + ';}',
            '.steward-input.steward-dirty,.steward-dropdown.steward-dirty{' + dirtyRing + '}',
            '.steward-input.steward-invalid,.steward-dropdown.steward-invalid{' +
                'border-color:' + t.invalidLine + ';box-shadow:0 0 0 2px ' + t.badRing + ';}',
            '.steward-unit{display:inline-block;min-width:24px;margin-left:6px;text-align:left;' +
                'color:' + t.muted + ';font-size:' + px(t.fontSm) + ';vertical-align:middle;}',

            // ---- host image button with steward sizes ----
            '.btn.steward-btn{height:' + px(t.btnH) + ';line-height:' + px(t.btnH) + ';' +
                'padding:0 22px;color:' + t.btnInk + ';font-size:' + px(t.fontBase) + ';' +
                'font-weight:600;white-space:nowrap;vertical-align:middle;}',
            '.btn.steward-btn[disabled]{color:' + t.btnInkOff + ';cursor:default;}',
            '.btn.steward-btn.steward-btn-sm{height:' + px(t.btnSmH) + ';' +
                'line-height:' + px(t.btnSmH) + ';padding:0 14px;font-size:' + px(t.fontSm) + ';' +
                'background-size:14px ' + px(t.btnSmH) + ',14px ' + px(t.btnSmH) + ',1px ' +
                px(t.btnSmH) + ';}',
            '.btn.steward-btn.steward-primary{box-shadow:0 0 0 2px ' + t.brass + ';' +
                'border-radius:' + px(t.radiusNav) + ';}',
            '.steward-link{background:none;border:0;padding:0;color:' + t.busy + ';' +
                'text-decoration:underline;font-size:' + px(t.fontNote) + ';font-family:inherit;' +
                'cursor:pointer;}',
            '.steward-link:hover,.steward-link:focus{color:' + t.busy + ';text-decoration:underline;}',
            '.steward-link.steward-danger{color:' + t.bad + ';padding:3px 6px;}',
            '.steward-link.steward-danger.steward-confirm{background:' + t.confirmBg + ';' +
                'color:' + t.white + ';text-decoration:none;border-radius:' + px(t.radiusSm) + ';' +
                'padding:4px 10px;font-weight:600;}',
            '.steward-now{display:inline-block;font-size:' + px(t.fontXs) + ';font-weight:600;' +
                'color:' + t.busy + ';white-space:nowrap;vertical-align:middle;}',
            '.steward-iconbtn{width:26px;height:24px;padding:0;margin-left:4px;' +
                'border:1px solid ' + t.bandIcon + ';border-radius:' + px(t.radiusSm) + ';' +
                'background:' + t.shadeIcon + ';color:' + t.text + ';font-size:' + px(t.fontBase) + ';' +
                'line-height:1;cursor:pointer;vertical-align:middle;}',
            '.steward-iconbtn:hover{border-color:' + t.brass + ';color:' + t.white + ';}',
            '.steward-iconbtn[disabled]{opacity:.3;cursor:default;}',

            // ---- badges ----
            '.steward-badge{display:inline-block;padding:1px 8px;border-radius:' + px(t.radiusPill) + ';' +
                'font-size:' + px(t.fontBadge) + ';font-weight:600;line-height:1.4;' +
                'white-space:nowrap;vertical-align:middle;}',
            '.steward-b-ok{background:' + t.okTint + ';color:' + t.okInk + ';}',
            '.steward-b-busy{background:' + t.brassBusy + ';color:' + t.busyInk + ';}',
            '.steward-b-off{background:' + t.offTint + ';color:' + t.offInk + ';}',
            '.steward-b-paused{background:' + t.badTint + ';color:' + t.pausedInk + ';}',
            '.steward-b-tag{background:transparent;border:1px solid ' + t.brassTag + ';' +
                'color:' + t.busy + ';font-weight:500;padding:0 6px;}',
            '.steward-b-phase{background:' + t.phaseBg + ';color:' + t.phaseInk + ';}',

            // ---- tables ----
            // The host page has no doctype, so WebKit runs in quirks mode and a
            // table does not inherit color, font-size, font-weight or
            // line-height; set them here so cells match the surrounding card.
            '.steward-tbl{width:100%;border-collapse:collapse;table-layout:fixed;margin:0;' +
                'color:' + t.text + ';font-size:' + px(t.fontBase) + ';font-weight:400;' +
                'line-height:normal;}',
            '.steward-tbl th{height:' + px(t.thH) + ';padding:0 10px;text-align:left;' +
                'font-size:' + px(t.fontSm) + ';font-weight:600;color:' + t.soft + ';' +
                'background:' + t.tableHead + ';white-space:nowrap;overflow:hidden;' +
                'text-overflow:ellipsis;}',
            '.steward-tbl td{height:' + px(t.tdH) + ';padding:0 10px;border-top:' + line + ';' +
                'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
            '.steward-tbl tbody tr:nth-child(even) td{background:' + t.bandZebra + ';}',
            '.steward-tbl .steward-num{text-align:right;}',
            '.steward-tbl .steward-c{text-align:center;}',
            '.steward-tbl tfoot td{font-weight:600;border-top:1px solid ' + t.bandChip + ';' +
                'background:' + t.shadeTotal + ';}',
            '.steward-fill{height:' + px(Math.round(l.panel * 0.6)) + ';' +
                'overflow-x:hidden;overflow-y:auto;}',
            '.steward-who{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}',
            '.steward-who img{width:22px;height:22px;margin-right:8px;border-radius:50%;' +
                'background:' + t.avatarBg + ';border:1px solid ' + t.avatarLine + ';' +
                'vertical-align:middle;}',
            '.steward-under{color:' + t.brass + ';font-weight:600;}',

            // ---- filter chips ----
            '.steward-chips{padding:8px 12px 4px;}',
            '.steward-chip{display:inline-block;margin:0 6px 4px 0;padding:2px 10px;' +
                'border:1px solid ' + t.bandChip + ';border-radius:' + px(t.radiusChip) + ';' +
                'background:none;color:' + t.soft + ';font-size:' + px(t.fontSm) + ';' +
                'font-family:inherit;line-height:normal;cursor:pointer;}',
            '.steward-chip:hover,.steward-chip:focus{border-color:' + t.brass + ';outline:0;}',
            '.steward-chip.active{background:' + t.band + ';color:' + t.ink + ';' +
                'border-color:' + t.band + ';font-weight:600;}',

            // ---- stats: equal floated cells, width by item count ----
            '.steward-stats{overflow:hidden;}',
            '.steward-stat{float:left;padding:10px 14px;}',
            '.steward-stat + .steward-stat{border-left:1px solid ' + t.bandSub + ';}',
            '.steward-stat.steward-stat-w1{width:100%;}',
            '.steward-stat.steward-stat-w2{width:50%;}',
            '.steward-stat.steward-stat-w3{width:33.333%;}',
            '.steward-stat.steward-stat-w4{width:25%;}',
            '.steward-stat-k{display:block;font-size:' + px(t.fontSm) + ';color:' + t.muted + ';}',
            '.steward-stat-v{display:block;margin-top:2px;font-size:' + px(t.fontLg) + ';' +
                'font-weight:600;color:' + t.white + ';}',
            '.steward-stat-v small,.steward-stat-v .steward-muted{font-size:' + px(t.fontSm) + ';font-weight:400;color:' + t.muted + ';}',

            // ---- grid of floated cells; a row's first cell clears so an
            // uneven tile height cannot snag the next row ----
            '.steward-grid{overflow:hidden;margin-right:-12px;}',
            '.steward-cell{float:left;padding:0 12px 12px 0;}',
            '.steward-cell.steward-cell-2{width:50%;}',
            '.steward-cell.steward-cell-3{width:33.333%;}',
            '.steward-cell-2:nth-child(2n+1),.steward-cell-3:nth-child(3n+1){clear:left;}',

            // ---- overview tiles: the foot sits at the bottom edge ----
            '.steward-tile{position:relative;min-height:' + px(t.tileMin) + ';' +
                'padding:11px 12px 40px;background:' + t.shadeCard + ';' +
                'border:1px solid ' + t.bandEdge + ';border-radius:' + px(t.radiusLg) + ';}',
            '.steward-tile-h{overflow:hidden;line-height:20px;font-size:' + px(t.fontMd) + ';' +
                'font-weight:600;color:' + t.white + ';}',
            '.steward-tile-h .switch{float:right;}',
            '.steward-tile-line{margin-top:6px;color:' + t.soft + ';overflow:hidden;' +
                'white-space:nowrap;text-overflow:ellipsis;}',
            '.steward-tile-foot{position:absolute;left:12px;right:12px;bottom:10px;overflow:hidden;}',
            '.steward-tile-foot .steward-badge{margin-right:8px;}',
            '.steward-tile-foot .steward-link{float:right;margin-left:8px;}',

            // ---- banner, empty state, compact strip ----
            '.steward-banner{padding:9px 12px;overflow:hidden;border-radius:' + px(t.radiusLg) + ';' +
                'background:' + t.brassTint + ';border:1px solid ' + t.brassEdge + ';' +
                'color:' + t.bannerInk + ';font-size:' + px(t.fontNote) + ';}',
            '.steward-banner .btn,.steward-banner .steward-link{float:right;margin-left:10px;}',
            '.steward-empty{padding:28px 12px;text-align:center;color:' + t.muted + ';}',
            '.steward-empty-title{margin-bottom:4px;font-size:' + px(t.fontMd) + ';' +
                'font-weight:600;color:' + t.text + ';}',
            '.steward-strip{position:relative;padding:7px 120px 7px 12px;line-height:20px;' +
                'font-size:' + px(t.fontNote) + ';font-weight:600;color:' + t.ink + ';' +
                'background:' + t.band + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
            '.steward-strip .switch{margin-left:10px;}',
            '.steward-strip-sum{margin-left:10px;font-weight:400;}',
            '.steward-strip-link{position:absolute;right:12px;top:7px;background:none;border:0;' +
                'padding:0;color:' + t.bandText + ';font-size:' + px(t.fontSm) + ';font-weight:600;' +
                'text-decoration:underline;white-space:nowrap;cursor:pointer;}',
            '.steward-strip-link:hover{color:' + t.bandText + ';}',

            // ---- tool rows: the text cell takes the width, the button
            // gets an anonymous table cell beside it ----
            '.steward-tool{display:table;width:100%;padding:7px 12px;border-top:' + line + ';}',
            '.steward-card-h + .steward-tool,.steward-subhead + .steward-tool{border-top:0;}',
            '.steward-tool > span{display:table-cell;width:100%;padding-right:10px;' +
                'vertical-align:middle;}',
            '.steward-tool small{display:block;color:' + t.muted + ';font-size:' + px(t.fontSm) + ';}',

            // ---- adventure template window ----
            '.steward-crumb{height:' + px(t.inputH) + ';line-height:' + px(t.inputH) + ';' +
                'margin-bottom:10px;font-size:' + px(t.fontBase) + ';color:' + t.muted + ';' +
                'white-space:nowrap;}',
            '.steward-crumb > *{margin-right:8px;vertical-align:middle;}',
            '.steward-crumb b{color:' + t.white + ';}',
            '.steward-waves{list-style:none;margin:0;padding:0;}',
            '.steward-waves li{display:table;width:100%;padding:6px 12px;border-top:' + line + ';}',
            '.steward-waves li:first-child{border-top:0;}',
            '.steward-waves li.steward-moved{background:' + t.brassTint + ';}',
            '.steward-wave-n{display:inline-block;width:26px;height:22px;margin-right:10px;' +
                'border-radius:11px;background:' + t.band + ';color:' + t.ink + ';' +
                'font-size:' + px(t.fontSm) + ';font-weight:700;line-height:22px;text-align:center;' +
                'vertical-align:middle;}',
            '.steward-wave-f{display:table-cell;width:100%;padding-right:10px;vertical-align:middle;}',
            '.steward-wave-f small{display:block;color:' + t.muted + ';font-size:' + px(t.fontSm) + ';}',
            '.steward-handle{display:inline-block;margin-right:10px;color:' + t.disabledInk + ';' +
                'cursor:move;font-size:' + px(t.fontBase) + ';letter-spacing:-2px;vertical-align:middle;}',
            '.ui-sortable-placeholder{visibility:visible !important;background:' + t.brassTint + ';}',

            // ---- text colours (last, so they win over a base colour) ----
            '.steward-muted{color:' + t.dim + ';}',
            '.steward-ok{color:' + t.ok + ';}',
            '.steward-warn{color:' + t.busy + ';}',
            '.steward-bad{color:' + t.bad + ';}'
        ];
    }

    var STYLE_ID = 'steward-dashboard-style';
    var STYLE_RULES = buildRules(TOKENS, layout);

    // Short checksum of the rule text. The <style> element records it so a
    // script reload that ships new rules rewrites the element even when the
    // scope list is unchanged.
    function checksum(text) {
        var h = 5381;
        for (var i = 0; i < text.length; i++) {
            h = ((h << 5) + h + text.charCodeAt(i)) | 0;
        }
        return (h >>> 0).toString(36);
    }

    var styleChecksum = checksum(STYLE_RULES.join(''));

    // Prefix every selector of every rule with '#<id> ' for each id. Only
    // the selector part (before the first '{') is split on ',', so commas
    // inside a body such as linear-gradient(...) stay intact.
    function scopeCss(rules, ids) {
        var out = [];
        for (var r = 0; r < rules.length; r++) {
            var rule = rules[r];
            var brace = rule.indexOf('{');
            if (brace < 0) continue;
            var sels = rule.substring(0, brace).split(',');
            var scoped = [];
            for (var i = 0; i < ids.length; i++) {
                for (var j = 0; j < sels.length; j++) {
                    var sel = sels[j].replace(/^\s+|\s+$/g, '');
                    if (sel) scoped.push('#' + ids[i] + ' ' + sel);
                }
            }
            out.push(scoped.join(',') + rule.substring(brace));
        }
        return out.join('');
    }

    // Scope list for the shared stylesheet: the dashboard first, then the
    // ids already recorded in `attr` (comma-separated) in order, then
    // modalId when new. Empties and duplicates are dropped.
    function mergeScopes(attr, modalId) {
        var list = [DASHBOARD_MODAL_ID];
        var parts = attr ? String(attr).split(',') : [];
        parts.push(modalId || '');
        for (var i = 0; i < parts.length; i++) {
            var id = parts[i].replace(/^\s+|\s+$/g, '');
            if (id && list.indexOf(id) < 0) list.push(id);
        }
        return list;
    }

    // Make the shared stylesheet cover modalId. The scope list lives on the
    // <style> element (data-scopes), not in this closure: after a script
    // reload the new bundle starts with fresh closures while the old element
    // and any open dialog stay in the page, so a closure list would drop a
    // dialog's scope. The element is looked up by id on every call and only
    // rewritten when its scope list or its rule checksum (data-rules)
    // changes.
    function ensureStyle(modalId) {
        var el = document.getElementById(STYLE_ID);
        var current = el ? el.getAttribute('data-scopes') : '';
        var rules = el ? el.getAttribute('data-rules') : '';
        var key = mergeScopes(current, modalId).join(',');
        if (el && current === key && rules === styleChecksum) return;
        var css = scopeCss(STYLE_RULES, key.split(','));
        if (!el) {
            var $style = $('<style>', { type: 'text/css', id: STYLE_ID });
            el = $style[0];
            if (el.styleSheet) el.styleSheet.cssText = css;
            else               el.appendChild(document.createTextNode(css));
            $('head').append($style);
        } else if (el.styleSheet) {
            el.styleSheet.cssText = css;
        } else {
            while (el.firstChild) el.removeChild(el.firstChild);
            el.appendChild(document.createTextNode(css));
        }
        el.setAttribute('data-scopes', key);
        el.setAttribute('data-rules', styleChecksum);
    }

    S.kernel.ui.DASHBOARD_MODAL_ID = DASHBOARD_MODAL_ID;
    S.kernel.ui.tokens        = TOKENS;
    S.kernel.ui.layout        = layout;
    S.kernel.ui.buildRules    = buildRules;
    S.kernel.ui.STYLE_RULES   = STYLE_RULES;
    S.kernel.ui.styleChecksum = styleChecksum;
    S.kernel.ui.scopeCss      = scopeCss;
    S.kernel.ui.mergeScopes   = mergeScopes;
    S.kernel.ui.ensureStyle   = ensureStyle;

}(Steward));
