const Applet = imports.ui.applet;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Cairo = imports.cairo;
const Main = imports.ui.main;
const Settings = imports.ui.settings;
const Mainloop = imports.mainloop;

class KappaYashiSeparator extends Applet.Applet {
    constructor(orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this._orientation = orientation;
        this._signalIds = [];
        this._updateQueued = false;

        // Settings
        this.settings = new Settings.AppletSettings(this, "separator@kappayashi", instance_id);
        this.settings.bind("size-mode", "size_mode", () => this._queueUpdate());
        this.settings.bind("width-percent", "width_percent", () => this._queueUpdate());
        this.settings.bind("min-pixels", "min_pixels", () => this._queueUpdate());
        this.settings.bind("edge-left", "edge_left", () => this._queueUpdate());
        this.settings.bind("edge-right", "edge_right", () => this._queueUpdate());
        this.settings.bind("edge-size-left", "edge_size_left", () => this._queueUpdate());
        this.settings.bind("edge-size-right", "edge_size_right", () => this._queueUpdate());
        this.settings.bind("fill-type", "fill_type", () => this._queueUpdate());
        this.settings.bind("separator-color", "separator_color", () => this._queueUpdate());
        this.settings.bind("gradient-color", "gradient_color", () => this._queueUpdate());
        this.settings.bind("gradient-angle", "gradient_angle", () => this._queueUpdate());
        this.settings.bind("show-fill", "show_fill", () => this._queueUpdate());
        this.settings.bind("fill-opacity", "fill_opacity", () => this._queueUpdate());

        this.actor.add_style_class_name("kappayashi-separator-box");
        // A separator has no interactive state, so suppress the panel's
        // default applet hover highlight.
        this.actor.set_track_hover(false);

        // In-panel block: used by the fixed-size modes, where the separator is
        // meant to occupy real space in its zone.
        this._sep = new St.DrawingArea({ style_class: "kappayashi-separator" });
        this._sep.connect("repaint", (area) => this._onRepaint(area));
        this.actor.add_child(this._sep);

        // Overlay block: used by dynamic mode. It lives outside the panel's
        // box layout and is positioned absolutely, so it can never push any
        // other applet around - it only paints over space that is already free.
        this._overlay = null;

        this._connectSignals();
        this._queueUpdate();
    }

    _isHorizontal() {
        return this._orientation === St.Side.TOP || this._orientation === St.Side.BOTTOM;
    }

    _getPanelActor() {
        if (this.panel && this.panel.actor)
            return this.panel.actor;
        return null;
    }

    _panelLength(horizontal) {
        let p = this._getPanelActor();
        if (p)
            return horizontal ? p.width : p.height;

        let a = this.actor, best = 0;
        while (a) {
            let v = horizontal ? a.width : a.height;
            if (v > best) best = v;
            a = a.get_parent();
        }
        return best;
    }

    // Absolute start/end of an actor on the main axis, relative to the panel.
    _absSpan(actor, horizontal, panelBase) {
        let pos = actor.get_transformed_position();
        let base = (horizontal ? pos[0] : pos[1]) - panelBase;
        let size = horizontal ? actor.width : actor.height;
        return { start: base, end: base + size };
    }

    // Finds the free gap around our (zero-width) anchor: from the right edge of
    // the nearest applet before us, to the left edge of the nearest applet
    // after us. Returns null if the panel internals are unavailable.
    _freeGap(horizontal) {
        let p = this.panel;
        let panelActor = this._getPanelActor();
        if (!p || !panelActor || !p._leftBox || !p._centerBox || !p._rightBox)
            return null;

        let ppos = panelActor.get_transformed_position();
        let panelBase = horizontal ? ppos[0] : ppos[1];
        let W = horizontal ? panelActor.width : panelActor.height;

        let me = this._absSpan(this.actor, horizontal, panelBase);
        let anchor = (me.start + me.end) / 2;

        let leftBound = 0;
        let rightBound = W;
        const EPS = 1;

        for (let box of [p._leftBox, p._centerBox, p._rightBox]) {
            for (let c of box.get_children()) {
                if (c === this.actor) continue;
                if (c._kappayashiDynamic) continue;   // other springs are not bounds
                if (!c.visible) continue;
                let size = horizontal ? c.width : c.height;
                if (size <= 0) continue;

                let g = this._absSpan(c, horizontal, panelBase);
                if (g.end <= anchor + EPS) {
                    if (g.end > leftBound) leftBound = g.end;
                } else if (g.start >= anchor - EPS) {
                    if (g.start < rightBound) rightBound = g.start;
                }
            }
        }

        if (rightBound < leftBound) rightBound = leftBound;
        return { base: panelBase, start: leftBound, size: rightBound - leftBound };
    }

    // Parse "rgb(...)", "rgba(...)" or "#hex" into {r,g,b}. Version-independent.
    _parseRgb(str) {
        let r = 128, g = 128, b = 128;
        if (str) {
            str = ("" + str).trim();
            let m = str.match(/rgba?\(([^)]+)\)/i);
            if (m) {
                let parts = m[1].split(",").map(s => s.trim());
                r = parseInt(parts[0], 10);
                g = parseInt(parts[1], 10);
                b = parseInt(parts[2], 10);
            } else if (str[0] === "#") {
                let hex = str.slice(1);
                if (hex.length === 3) hex = hex.split("").map(c => c + c).join("");
                r = parseInt(hex.substr(0, 2), 16);
                g = parseInt(hex.substr(2, 2), 16);
                b = parseInt(hex.substr(4, 2), 16);
            }
        }
        if (isNaN(r)) r = 128;
        if (isNaN(g)) g = 128;
        if (isNaN(b)) b = 128;
        return { r, g, b };
    }

    // Sets the Cairo source: either a flat color or a two-stop linear gradient
    // whose direction is given in degrees (0 = left to right, 90 = top to
    // bottom). The gradient line is projected so it always spans the whole
    // drawn area no matter the angle.
    _setFillSource(cr, w, h) {
        let c1 = this._parseRgb(this.separator_color);

        if (this.fill_type !== "gradient") {
            cr.setSourceRGBA(c1.r / 255, c1.g / 255, c1.b / 255, 1);
            return;
        }

        let c2 = this._parseRgb(this.gradient_color);
        let deg = ((this.gradient_angle % 360) + 360) % 360;
        let rad = deg * Math.PI / 180;
        let dx = Math.cos(rad);
        let dy = Math.sin(rad);   // screen space: y grows downwards

        let cx = w / 2, cy = h / 2;
        // Half-length of the gradient line so both ends clear the rectangle.
        let half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;

        try {
            let g = new Cairo.LinearGradient(
                cx - dx * half, cy - dy * half,
                cx + dx * half, cy + dy * half
            );
            g.addColorStopRGBA(0, c1.r / 255, c1.g / 255, c1.b / 255, 1);
            g.addColorStopRGBA(1, c2.r / 255, c2.g / 255, c2.b / 255, 1);
            cr.setSource(g);
        } catch (e) {
            // Fall back to the first color if gradients are unavailable.
            cr.setSourceRGBA(c1.r / 255, c1.g / 255, c1.b / 255, 1);
        }
    }

    _fillOpacityByte() {
        if (!this.show_fill)
            return 0;
        let pct = Math.max(0, Math.min(100, this.fill_opacity));
        return Math.round(pct / 100 * 255);
    }

    // Size (px) of every sibling in our zone except this separator.
    _otherAppletsLength(horizontal) {
        let zone = this.actor.get_parent();
        if (!zone)
            return 0;
        let zoneSize = horizontal ? zone.width : zone.height;
        let selfSize = horizontal ? this.actor.width : this.actor.height;
        return Math.max(0, zoneSize - selfSize);
    }

    _queueUpdate() {
        if (this._updateQueued)
            return;
        this._updateQueued = true;
        Mainloop.idle_add(() => {
            this._updateQueued = false;
            this._updateSeparator();
            return false;
        });
    }

    _ensureOverlay() {
        if (this._overlay)
            return this._overlay;
        this._overlay = new St.DrawingArea({
            style_class: "kappayashi-separator",
            reactive: true,
            track_hover: false
        });
        this._overlay.connect("repaint", (area) => this._onRepaint(area));
        // The in-panel anchor is zero-width in dynamic mode, so the painted
        // bar itself has to be the click target: right-clicking it opens the
        // applet's context menu (settings / remove) just like a normal applet.
        // The menu is toggled on RELEASE, not press - opening it on press
        // would let the following release reach the menu's grab, which reads
        // it as a click outside and closes the menu again straight away.
        this._overlay.connect("button-press-event", () => true);
        this._overlay.connect("button-release-event", (actor, event) => {
            let button = event.get_button();
            if (button === 3) {
                if (this._menu && this._menu.isOpen)
                    this._menu.toggle();
                if (this._applet_context_menu)
                    this._applet_context_menu.toggle();
                return true;
            }
            if (button === 1) {
                if (this._applet_context_menu && this._applet_context_menu.isOpen)
                    this._applet_context_menu.toggle();
                try { this.on_applet_clicked(event); } catch (e) {}
                return true;
            }
            return false;
        });
        Main.uiGroup.add_actor(this._overlay);
        return this._overlay;
    }

    _destroyOverlay() {
        if (this._overlay) {
            this._overlay.destroy();
            this._overlay = null;
        }
    }

    _updateSeparator() {
        if (!this._sep)
            return;

        let horizontal = this._isHorizontal();
        let dynamic = (this.size_mode === "dynamic");

        // Let sibling separators recognise (and skip) us as a spring.
        this.actor._kappayashiDynamic = dynamic;

        if (dynamic) {
            // In panel edit mode give the anchor a real, grabbable size so the
            // separator can be selected, dragged and removed like any applet.
            let editMode = false;
            try {
                editMode = global.settings.get_boolean("panel-edit-mode");
            } catch (e) {}

            if (editMode) {
                const HANDLE = 24;
                this._sep.show();
                if (horizontal) {
                    this._sep.set_width(HANDLE);
                    this._sep.set_height(-1);
                } else {
                    this._sep.set_height(HANDLE);
                    this._sep.set_width(-1);
                }
                this._sep.set_x_align(Clutter.ActorAlign.FILL);
                this._sep.set_y_align(Clutter.ActorAlign.FILL);
                this._sep.set_opacity(this._fillOpacityByte());
                this._sep.queue_repaint();
            } else {
                // The in-panel block requests no space at all, so the layout of
                // every other applet is left completely untouched.
                this._sep.hide();
                this._sep.set_width(0);
                this._sep.set_height(0);
            }

            let gap = this._freeGap(horizontal);
            if (!gap || gap.size <= 0) {
                this._destroyOverlay();
                return;
            }

            let panelActor = this._getPanelActor();
            let ppos = panelActor.get_transformed_position();
            let thickness = horizontal ? panelActor.height : panelActor.width;

            let ov = this._ensureOverlay();
            if (horizontal) {
                ov.set_position(Math.round(gap.base + gap.start), Math.round(ppos[1]));
                ov.set_size(Math.round(gap.size), Math.round(thickness));
            } else {
                ov.set_position(Math.round(ppos[0]), Math.round(gap.base + gap.start));
                ov.set_size(Math.round(thickness), Math.round(gap.size));
            }
            ov.set_opacity(this._fillOpacityByte());
            ov.show();
            ov.queue_repaint();
            return;
        }

        // --- Fixed-size modes: occupy real space inside the zone ---
        this._destroyOverlay();
        this._sep.show();

        let p = Math.max(0, Math.min(95, this.width_percent)) / 100;
        let size;
        if (this.size_mode === "panel") {
            size = this._panelLength(horizontal) * p;
        } else {
            let others = this._otherAppletsLength(horizontal);
            size = (p < 1) ? others * (p / (1 - p)) : others;
        }

        size = Math.round(size);
        if (this.min_pixels > 0 && size < this.min_pixels)
            size = this.min_pixels;
        if (size < 0)
            size = 0;

        if (horizontal) {
            this._sep.set_width(size);
            this._sep.set_height(-1);
            this._sep.set_x_expand(false);
            this._sep.set_y_expand(true);
        } else {
            this._sep.set_height(size);
            this._sep.set_width(-1);
            this._sep.set_x_expand(true);
            this._sep.set_y_expand(false);
        }
        this._sep.set_x_align(Clutter.ActorAlign.FILL);
        this._sep.set_y_align(Clutter.ActorAlign.FILL);

        this._sep.set_opacity(this._fillOpacityByte());
        this._sep.queue_repaint();
    }

    // Points for one end, from the top edge (across=0) to the bottom edge
    // (across=C), in (along, across) space.
    _endPoints(side, shape, L, C, sizeSetting) {
        const N = 18;
        const inw = (side === "right") ? -1 : 1;
        const A = (side === "right") ? L : 0;
        const f = (x) => A + inw * x;
        const m = C / 2;

        let aAng = (sizeSetting > 0) ? sizeSetting : Math.min(C / 2, L / 2);
        aAng = Math.max(0, Math.min(aAng, L / 2));

        let pts = [];

        switch (shape) {
            case "point":
                pts = [[f(aAng), 0], [A, m], [f(aAng), C]];
                break;
            case "notch":
                pts = [[A, 0], [f(aAng), m], [A, C]];
                break;
            case "slant-up":
                pts = [[f(aAng), 0], [A, C]];
                break;
            case "slant-down":
                pts = [[A, 0], [f(aAng), C]];
                break;
            case "round": {
                let r = Math.min(C / 2, L / 2);
                let cA = A + inw * r;
                for (let i = 0; i <= N; i++) {
                    let t = -Math.PI / 2 + Math.PI * i / N;
                    pts.push([cA - inw * r * Math.cos(t), m + r * Math.sin(t)]);
                }
                break;
            }
            case "round-notch": {
                let base = (sizeSetting > 0) ? sizeSetting : C / 2;
                let r = Math.min(base, C / 2, L / 2);
                for (let i = 0; i <= N; i++) {
                    let t = -Math.PI / 2 + Math.PI * i / N;
                    pts.push([A + inw * r * Math.cos(t), m + r * Math.sin(t)]);
                }
                break;
            }
            default:
                pts = [[A, 0], [A, C]];
        }
        return pts;
    }

    _onRepaint(area) {
        let cr = area.get_context();
        let [w, h] = area.get_surface_size();
        if (w <= 0 || h <= 0) {
            cr.$dispose();
            return;
        }

        this._setFillSource(cr, w, h);

        let horizontal = this._isHorizontal();
        let L = horizontal ? w : h;
        let C = horizontal ? h : w;

        let leftPts = this._endPoints("left", this.edge_left || "flat", L, C, this.edge_size_left);
        let rightPts = this._endPoints("right", this.edge_right || "flat", L, C, this.edge_size_right);

        let seq = [];
        seq.push(leftPts[0]);
        seq.push(rightPts[0]);
        for (let i = 1; i < rightPts.length; i++)
            seq.push(rightPts[i]);
        seq.push(leftPts[leftPts.length - 1]);
        for (let i = leftPts.length - 2; i >= 1; i--)
            seq.push(leftPts[i]);

        for (let i = 0; i < seq.length; i++) {
            let along = seq[i][0], across = seq[i][1];
            let x = horizontal ? along : across;
            let y = horizontal ? across : along;
            if (i === 0) cr.moveTo(x, y);
            else cr.lineTo(x, y);
        }
        cr.closePath();
        cr.fill();
        cr.$dispose();
    }

    _connect(obj, signal) {
        if (!obj)
            return;
        let id = obj.connect(signal, () => this._queueUpdate());
        this._signalIds.push([obj, id]);
    }

    _connectSignals() {
        let panelActor = this._getPanelActor();
        this._connect(panelActor, "notify::width");
        this._connect(panelActor, "notify::height");
        this._connect(panelActor, "notify::x");
        this._connect(panelActor, "notify::y");

        // Toggle the grabbable handle when the panel enters/leaves edit mode.
        try {
            this._connect(global.settings, "changed::panel-edit-mode");
        } catch (e) {}

        // Watch all three zones so dynamic mode reacts to any applet in any
        // zone changing size or position.
        let p = this.panel;
        if (p) {
            for (let b of [p._leftBox, p._centerBox, p._rightBox]) {
                this._connect(b, "notify::width");
                this._connect(b, "notify::height");
                this._connect(b, "notify::x");
                this._connect(b, "notify::y");
                this._connect(b, "actor-added");
                this._connect(b, "actor-removed");
            }
        }
    }

    _disconnectSignals() {
        for (let [obj, id] of this._signalIds) {
            try { obj.disconnect(id); } catch (e) {}
        }
        this._signalIds = [];
    }

    // --- Cinnamon applet lifecycle hooks ---

    on_orientation_changed(orientation) {
        this._orientation = orientation;
        this._disconnectSignals();
        this._connectSignals();
        this._queueUpdate();
    }

    on_panel_height_changed() {
        this._queueUpdate();
    }

    on_applet_added_to_panel() {
        this._disconnectSignals();
        this._connectSignals();
        this._queueUpdate();
    }

    on_applet_removed_from_panel() {
        this._disconnectSignals();
        this._destroyOverlay();
        if (this.settings)
            this.settings.finalize();
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new KappaYashiSeparator(orientation, panel_height, instance_id);
}
