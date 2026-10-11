const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const GdkPixbuf = imports.gi.GdkPixbuf;
const Cogl = imports.gi.Cogl;

const Applet = imports.ui.applet;
const Settings = imports.ui.settings;
const Main = imports.ui.main;

const ScreenSaver = imports.misc.screenSaver;
const Util = imports.misc.util;
const Gettext = imports.gettext;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Tweener = imports.ui.tweener;

let button_path;
let has_console_kit, has_upower, has_systemd, display_manager;
let UUID;

function _(str) {
    let customTranslation = Gettext.dgettext(UUID, str);
    if (customTranslation != str) return customTranslation;
    return Gettext.gettext(str);
}

// --- Backend: the actual session actions (kept from the original applet) ---
let CommandDispatcher = {
    shutDown: function() {
        if ( has_systemd ) Util.spawnCommandLine("systemctl poweroff");
        else if ( has_console_kit ) Util.spawnCommandLine("dbus-send --system --print-reply --system --dest=org.freedesktop.ConsoleKit /org/freedesktop/ConsoleKit/Manager org.freedesktop.ConsoleKit.Manager.Stop");
    },
    restart: function() {
        if ( has_systemd ) Util.spawnCommandLine("systemctl reboot");
        else if ( has_console_kit ) Util.spawnCommandLine("dbus-send --system --print-reply --system --dest=org.freedesktop.ConsoleKit /org/freedesktop/ConsoleKit/Manager org.freedesktop.ConsoleKit.Manager.Restart");
    },
    hibernate: function() {
        if ( has_systemd ) Util.spawnCommandLine("systemctl hibernate");
        else if ( has_upower ) Util.spawnCommandLine("dbus-send --print-reply --system --dest=org.freedesktop.UPower /org/freedesktop/UPower org.freedesktop.UPower.Hibernate");
    },
    suspend: function() {
        if ( has_systemd ) Util.spawnCommandLine("systemctl suspend");
        else if ( has_upower ) Util.spawnCommandLine("dbus-send --print-reply --system --dest=org.freedesktop.UPower /org/freedesktop/UPower org.freedesktop.UPower.Suspend");
    },
    sleep: function() {
        if ( has_systemd ) Util.spawnCommandLine("systemctl hybrid-sleep");
    },
    logOff: function() {
        Util.spawnCommandLine("dbus-send --session --type=method_call --print-reply --dest=org.gnome.SessionManager /org/gnome/SessionManager org.gnome.SessionManager.Logout uint32:1");
    },
    uSwitch: function() {
        switch ( display_manager ) {
            case "mdm": Util.spawnCommandLine("mdmflexiserver"); break;
            case "gdm":
                Util.spawnCommandLine("cinnamon-screensaver-command --lock");
                Util.spawnCommandLine("gdmflexiserver");
                break;
            case "lxdm": Util.spawnCommandLine("lxdm -c USER_SWITCH"); break;
            case "lightdm":
                Util.spawnCommandLine("cinnamon-screensaver-command --lock");
                Util.spawnCommandLine("dm-tool switch-to-greeter");
        }
    },
    guest: function() {
        Util.spawnCommandLine("cinnamon-screensaver-command --lock");
        Util.spawnCommandLine("dm-tool switch-to-guest");
    },
    lock: function() {
        this._screenSaverProxy = new ScreenSaver.ScreenSaverProxy();
        let screensaver_settings = new Gio.Settings({ schema: "org.cinnamon.desktop.screensaver" });
        let screensaver_dialog = Gio.file_new_for_path("/usr/bin/cinnamon-screensaver-command");
        if ( screensaver_dialog.query_exists(null) ) {
            if ( screensaver_settings.get_boolean("ask-for-away-message") ) Util.spawnCommandLine("cinnamon-screensaver-lock-dialog");
            else Util.spawnCommandLine("cinnamon-screensaver-command --lock");
        }
        else this._screenSaverProxy.LockRemote();
    }
};

// Display order + metadata for each action.
const ACTIONS = [
    {id: 'shutDown',  show: 'showShutDown',    iconKey: 'iconShutDown',   colorKey: 'colorShutDown',   hoverKey: 'colorHoverShutDown',   label: 'Shut Down'},
    {id: 'restart',   show: 'showRestart',     iconKey: 'iconRestart',    colorKey: 'colorRestart',    hoverKey: 'colorHoverRestart',    label: 'Restart'},
    {id: 'lock',      show: 'showLockScreen',  iconKey: 'iconLock',       colorKey: 'colorLock',       hoverKey: 'colorHoverLock',       label: 'Lock'},
    {id: 'suspend',   show: 'showSuspend',     iconKey: 'iconSuspend',    colorKey: 'colorSuspend',    hoverKey: 'colorHoverSuspend',    label: 'Suspend'},
    {id: 'sleep',     show: 'showSleep',       iconKey: 'iconSleep',      colorKey: 'colorSleep',      hoverKey: 'colorHoverSleep',      label: 'Sleep', needsSystemd: true},
    {id: 'hibernate', show: 'showHibernate',   iconKey: 'iconHibernate',  colorKey: 'colorHibernate',  hoverKey: 'colorHoverHibernate',  label: 'Hibernate'},
    {id: 'logOff',    show: 'showLogOff',      iconKey: 'iconLogOff',     colorKey: 'colorLogOff',     hoverKey: 'colorHoverLogOff',     label: 'Log Off'},
    {id: 'uSwitch',   show: 'showSwitchUser',  iconKey: 'iconSwitchUser', colorKey: 'colorSwitchUser', hoverKey: 'colorHoverSwitchUser', label: 'Switch User'},
    {id: 'guest',     show: 'showGuestSession',iconKey: 'iconGuest',      colorKey: 'colorGuest',      hoverKey: 'colorHoverGuest',      label: 'Guest', needsLightdm: true}
];

function resolvePath(s) {
    s = ("" + (s || "")).trim();
    if (!s) return "";
    if (s.indexOf("file://") === 0) {
        try { return GLib.filename_from_uri(s)[0]; }
        catch (e) { s = s.replace(/^file:\/\//, ""); try { s = decodeURIComponent(s); } catch (e2) {} }
    }
    return s;
}

function toRgba(color, opacityPct) {
    let a = Math.max(0, Math.min(100, opacityPct)) / 100;
    let c = ("" + (color || "rgb(255,255,255)")).trim();
    let m = c.match(/rgba?\(([^)]+)\)/i);
    if (m) {
        let p = m[1].split(",").map(s => s.trim());
        return "rgba(" + p[0] + "," + p[1] + "," + p[2] + "," + a + ")";
    }
    if (c[0] === "#") {
        let hex = c.slice(1);
        if (hex.length === 3) hex = hex.split("").map(x => x + x).join("");
        let r = parseInt(hex.substr(0,2),16), g = parseInt(hex.substr(2,2),16), b = parseInt(hex.substr(4,2),16);
        return "rgba(" + r + "," + g + "," + b + "," + a + ")";
    }
    return "rgba(255,255,255," + a + ")";
}

// CSS-style cubic-bezier easing solver. Returns f(p) for p in [0,1].
function cubicBezier(x1, y1, x2, y2) {
    const A = (a1, a2) => 1 - 3 * a2 + 3 * a1;
    const B = (a1, a2) => 3 * a2 - 6 * a1;
    const C = (a1) => 3 * a1;
    const calc = (t, a1, a2) => ((A(a1, a2) * t + B(a1, a2)) * t + C(a1)) * t;
    const slope = (t, a1, a2) => 3 * A(a1, a2) * t * t + 2 * B(a1, a2) * t + C(a1);
    function tForX(x) {
        let t = x;
        for (let i = 0; i < 8; i++) {
            let xe = calc(t, x1, x2) - x;
            if (Math.abs(xe) < 1e-4) return t;
            let d = slope(t, x1, x2);
            if (Math.abs(d) < 1e-6) break;
            t -= xe / d;
        }
        let lo = 0, hi = 1, tt = x;
        for (let i = 0; i < 20; i++) {
            let xe = calc(tt, x1, x2);
            if (Math.abs(xe - x) < 1e-4) break;
            if (xe < x) lo = tt; else hi = tt;
            tt = (lo + hi) / 2;
        }
        return tt;
    }
    return function(p) {
        if (p <= 0) return 0;
        if (p >= 1) return 1;
        return calc(tForX(p), y1, y2);
    };
}

const EASING_PRESETS = {
    "ease":        [0.25, 0.10, 0.25, 1.00],
    "ease-in":     [0.42, 0.00, 1.00, 1.00],
    "ease-out":    [0.00, 0.00, 0.58, 1.00],
    "ease-in-out": [0.42, 0.00, 0.58, 1.00],
    "linear":      [0.00, 0.00, 1.00, 1.00],
    "sine":        [0.37, 0.00, 0.63, 1.00]
};

class MyApplet extends Applet.TextIconApplet {
    constructor(metadata, orientation, panel_height, instanceId) {
        super(orientation, panel_height);
        try {
            this.metadata = metadata;
            this.instanceId = instanceId;
            this.orientation = orientation;

            button_path = metadata.path + "/buttons/";
            UUID = metadata.uuid;
            Gettext.bindtextdomain(UUID, GLib.get_home_dir() + "/.local/share/locale");

            this._overlay = null;
            this._uptimeTimer = 0;

            this.bindSettings();
            this.setPanelIcon();
            this.setPanelText();
            this.set_applet_tooltip(_("Session"));

            this.checkSession();
        } catch (e) {
            global.logError(e);
        }
    }

    on_applet_clicked() {
        this.toggleOverlay();
    }

    checkSession() {
        let sessionSettings = new Gio.Settings({ schema_id: "org.cinnamon.desktop.session" });
        has_systemd = sessionSettings.get_boolean("session-manager-uses-logind");

        Util.spawn_async(["ps", "-C", "console-kit-dae"], Lang.bind(this, function (output) {
            if ( String(output).split("\n").length > 2 ) has_console_kit = true;
        }));
        Util.spawn_async(["ps", "-C", "upowerd"], Lang.bind(this, function (output) {
            if ( String(output).split("\n").length > 2 ) has_upower = true;
        }));

        if ( GLib.getenv("MDMSESSION") ) display_manager = "mdm";
        else if ( GLib.getenv("GDMSESSION") ) display_manager = "gdm";
        else if ( GLib.getenv("XDG_SEAT_PATH") ) display_manager = "lightdm";
        else if ( GLib.file_test("/etc/X11/default-display-manager", GLib.FileTest.EXISTS) ) {
            Util.spawn_async(["grep", "-oE", "\"[^/]+$\"", "/etc/X11/default-display-manager"], Lang.bind(this, function (output) {
                display_manager = String(output).split("\n")[0];
            }));
        }
    }

    bindSettings() {
        this.settings = new Settings.AppletSettings(this, this.metadata.uuid, this.instanceId);
        const IN = Settings.BindingDirection.IN;
        const b = (k, cb) => this.settings.bindProperty(IN, k, k, cb || null);

        b("panelIcon", this.setPanelIcon);
        b("panelText", this.setPanelText);

        [
            "showShutDown","showRestart","showLockScreen","showSuspend","showSleep",
            "showHibernate","showLogOff","showSwitchUser","showGuestSession",
            "iconShutDown","iconRestart","iconLock","iconSuspend","iconSleep",
            "iconHibernate","iconLogOff","iconSwitchUser","iconGuest",
            "backgroundColor","backgroundOpacity","showUptime",
            "useBackgroundImage","backgroundImage","backgroundImageSize",
            "noiseEnabled","noiseMode","noiseColor","noiseOpacity","noiseGrain",
            "buttonSize","buttonSpacing","buttonRoundness",
            "buttonBgColor","buttonBgOpacity","hoverBgColor","hoverBgOpacity",
            "hoverOutline","hoverOutlineColor","hoverOutlineWidth",
            "iconSize","twoColorIcons","iconColor","iconHoverColor",
            "labelUnder","labelColor","perIconColors",
            "colorShutDown","colorHoverShutDown","colorRestart","colorHoverRestart",
            "colorLock","colorHoverLock","colorSuspend","colorHoverSuspend",
            "colorSleep","colorHoverSleep","colorHibernate","colorHoverHibernate",
            "colorLogOff","colorHoverLogOff","colorSwitchUser","colorHoverSwitchUser",
            "colorGuest","colorHoverGuest","fadeIn","fadeDuration",
            "easing","bezierX1","bezierY1","bezierX2","bezierY2"
        ].forEach(k => b(k, null));
    }

    // ---------------- Overlay ----------------

    // Returns a Tweener transition: a built-in equation name for presets
    // (guaranteed to work), or our own cubic-bezier function for "custom".
    _easingTransition() {
        let e = this.easing || "ease-out";
        if (e === "custom") {
            let ez = cubicBezier(this.bezierX1, this.bezierY1, this.bezierX2, this.bezierY2);
            return function(t, b, c, d) {
                let p = d > 0 ? t / d : 1;
                if (p < 0) p = 0; else if (p > 1) p = 1;
                return b + c * ez(p);
            };
        }
        const names = {
            "ease":        "easeInOutCubic",
            "ease-in":     "easeInQuad",
            "ease-out":    "easeOutQuad",
            "ease-in-out": "easeInOutQuad",
            "linear":      "linear",
            "sine":        "easeInOutSine"
        };
        return names[e] || "easeOutQuad";
    }

    toggleOverlay() {
        if (this._overlay) this.closeOverlay();
        else this.openOverlay();
    }

    openOverlay() {
        let monitor = Main.layoutManager.primaryMonitor;

        this._overlay = new St.Widget({
            reactive: true,
            can_focus: true,
            width: monitor.width,
            height: monitor.height,
            x: monitor.x,
            y: monitor.y,
            layout_manager: new Clutter.BinLayout()
        });

        // Optional image background (bottom layer).
        let imgPath = resolvePath(this.backgroundImage);
        if (this.useBackgroundImage && imgPath && GLib.file_test(imgPath, GLib.FileTest.EXISTS)) {
            let imgActor = this._makeImageActor(imgPath, monitor.width, monitor.height);
            if (imgActor) this._overlay.add_child(imgActor);
        }

        // Flat translucent background / dim over the image.
        let tint = new St.Widget({ x_expand: true, y_expand: true });
        tint.set_style("background-color: " + toRgba(this.backgroundColor, this.backgroundOpacity) + ";");
        this._overlay.add_child(tint);

        // Optional grain/noise layer (above background, below buttons).
        if (this.noiseEnabled) {
            let noiseActor = this._makeNoiseActor(monitor.width, monitor.height);
            if (noiseActor) this._overlay.add_child(noiseActor);
        }

        // Count how many buttons will actually show, so we can clamp sizes to
        // fit the monitor width no matter the resolution.
        let visible = ACTIONS.filter(a =>
            this[a.show] &&
            !(a.needsSystemd && !has_systemd) &&
            !(a.needsLightdm && display_manager !== "lightdm")
        );
        let n = Math.max(1, visible.length);

        // Desired values from settings, then clamp to available width.
        let spacing = Math.max(0, this.buttonSpacing);
        let btnSize = Math.max(32, this.buttonSize);
        let iconSize = Math.max(12, this.iconSize);

        // Leave ~10% side margins; distribute the rest across buttons + gaps.
        let usable = monitor.width * 0.9;
        let maxBtn = Math.floor((usable - spacing * (n - 1)) / n);
        if (maxBtn < 32) maxBtn = 32;
        if (btnSize > maxBtn) {
            let scale = maxBtn / btnSize;
            btnSize = maxBtn;
            iconSize = Math.max(12, Math.round(iconSize * scale));
        }
        // Also cap button height to the monitor (with room for label/uptime).
        let maxBtnH = Math.floor(monitor.height * 0.6);
        if (btnSize > maxBtnH) {
            let scale = maxBtnH / btnSize;
            btnSize = maxBtnH;
            iconSize = Math.max(12, Math.round(iconSize * scale));
        }
        this._btnSize = btnSize;
        this._iconSize = iconSize;

        // Content: optional uptime label + centered row of buttons.
        // The gap between them is the box spacing (constant, independent of
        // button size), so it never changes when buttons grow/shrink.
        let content = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });
        content.set_style("spacing: 28px;");

        if (this.showUptime) {
            this._uptimeLabel = new St.Label({ style_class: "kappayashi-session-uptime" });
            this._uptimeLabel.set_style("color: " + (this.labelColor || "rgb(220,220,230)") + "; font-size: 14px;");
            this._updateUptime();
            content.add_actor(this._uptimeLabel);
            this._uptimeTimer = Mainloop.timeout_add_seconds(30, () => { this._updateUptime(); return true; });
        }

        let row = new St.BoxLayout({ vertical: false });
        row.set_style("spacing: " + Math.max(0, this.buttonSpacing) + "px;");

        for (let a of ACTIONS) {
            if (!this[a.show]) continue;
            if (a.needsSystemd && !has_systemd) continue;
            if (a.needsLightdm && display_manager !== "lightdm") continue;
            row.add_actor(this._makeButton(a));
        }
        content.add_actor(row);
        this._overlay.add_child(content);

        // Close on background click / Escape.
        this._overlay.connect("button-press-event", () => { this.closeOverlay(true); return true; });
        this._overlay.connect("key-press-event", (a, e) => {
            if (e.get_key_symbol() === Clutter.KEY_Escape) { this.closeOverlay(true); return true; }
            return false;
        });

        Main.uiGroup.add_child(this._overlay);
        this._modal = Main.pushModal(this._overlay);
        this._overlay.grab_key_focus();

        // Fade + subtle scale-in for a smoother appearance.
        if (this.fadeIn) {
            let t = Math.max(0, this.fadeDuration) / 1000;
            let ease = this._easingTransition();
            try {
                this._overlay.opacity = 0;
                Tweener.addTween(this._overlay, { opacity: 255, time: t, transition: ease });
                content.set_pivot_point(0.5, 0.5);
                content.scale_x = 0.90;
                content.scale_y = 0.90;
                Tweener.addTween(content, { scale_x: 1, scale_y: 1, time: t, transition: ease });
            } catch (e) {
                this._overlay.opacity = 255;
            }
        }
    }

    closeOverlay(animate) {
        if (this._uptimeTimer) { Mainloop.source_remove(this._uptimeTimer); this._uptimeTimer = 0; }
        if (!this._overlay) return;

        let ov = this._overlay;
        this._overlay = null;
        let finish = () => { try { Main.popModal(ov); } catch (e) {} ov.destroy(); };

        if (animate && this.fadeIn) {
            try {
                let t = Math.max(0, this.fadeDuration) / 1000;
                Tweener.addTween(ov, { opacity: 0, time: t, transition: this._easingTransition(), onComplete: finish });
            } catch (e) { finish(); }
        } else {
            finish();
        }
    }

    _makeButton(action) {
        let size = this._btnSize || Math.max(32, this.buttonSize);
        let radius = Math.round(size * Math.max(0, Math.min(100, this.buttonRoundness)) / 200);

        let custom = resolvePath(this[action.iconKey]);
        let iconPath = (custom && GLib.file_test(custom, GLib.FileTest.EXISTS))
            ? custom
            : button_path + action.id + "-symbolic.svg";

        let icon = new St.Icon({
            gicon: new Gio.FileIcon({ file: Gio.file_new_for_path(iconPath) }),
            icon_type: St.IconType.SYMBOLIC,
            icon_size: this._iconSize || Math.max(12, this.iconSize)
        });

        let iconColor, hoverIconColor;
        if (this.perIconColors) {
            iconColor = this[action.colorKey] || "rgb(255,255,255)";
            hoverIconColor = this.twoColorIcons ? (this[action.hoverKey] || iconColor) : iconColor;
        } else {
            iconColor = this.iconColor || "rgb(255,255,255)";
            hoverIconColor = this.twoColorIcons ? (this.iconHoverColor || iconColor) : iconColor;
        }
        icon.set_style("color: " + iconColor + ";");

        let btn = new St.Button({
            reactive: true,
            track_hover: true,
            can_focus: true,
            child: icon
        });

        const baseStyle = () =>
            "width: " + size + "px; height: " + size + "px;" +
            "border-radius: " + radius + "px;" +
            "background-color: " + toRgba(this.buttonBgColor, this.buttonBgOpacity) + ";" +
            "border: " + (this.hoverOutline ? this.hoverOutlineWidth : 0) + "px solid transparent;";

        const hoverStyle = () =>
            "width: " + size + "px; height: " + size + "px;" +
            "border-radius: " + radius + "px;" +
            "background-color: " + toRgba(this.hoverBgColor, this.hoverBgOpacity) + ";" +
            "border: " + (this.hoverOutline ? this.hoverOutlineWidth : 0) + "px solid " +
                (this.hoverOutline ? (this.hoverOutlineColor || "transparent") : "transparent") + ";";

        btn.set_style(baseStyle());

        btn.connect("enter-event", () => {
            btn.set_style(hoverStyle());
            icon.set_style("color: " + hoverIconColor + ";");
        });
        btn.connect("leave-event", () => {
            btn.set_style(baseStyle());
            icon.set_style("color: " + iconColor + ";");
        });
        btn.connect("clicked", () => {
            this.closeOverlay();
            Mainloop.timeout_add(120, () => {
                try { CommandDispatcher[action.id].call(CommandDispatcher); } catch (e) { global.logError(e); }
                return false;
            });
        });

        if (this.labelUnder) {
            let box = new St.BoxLayout({ vertical: true, x_align: Clutter.ActorAlign.CENTER });
            box.add_actor(btn);
            let lbl = new St.Label({ text: _(action.label), x_align: Clutter.ActorAlign.CENTER });
            lbl.set_style("color: " + (this.labelColor || "rgb(220,220,230)") + "; font-size: 12px; margin-top: 10px;");
            box.add_actor(lbl);
            return box;
        }
        return btn;
    }

    _makeImageActor(path, w, h) {
        try {
            let size = this.backgroundImageSize || "cover";
            let pb;
            if (size === "stretch") {
                pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, w, h, false);
            } else if (size === "fit") {
                pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, w, h, true);
            } else { // cover
                let info = GdkPixbuf.Pixbuf.get_file_info(path);
                let iw = info[1], ih = info[2];
                if (!iw || !ih) { iw = w; ih = h; }
                let imgA = iw / ih, scrA = w / h, tw, th;
                if (imgA > scrA) { th = h; tw = Math.round(h * imgA); }
                else { tw = w; th = Math.round(w / imgA); }
                pb = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, tw, th, false);
            }

            let image = new Clutter.Image();
            image.set_data(
                pb.get_pixels(),
                pb.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                pb.get_width(), pb.get_height(), pb.get_rowstride()
            );

            let actor = new Clutter.Actor({ width: w, height: h, x_expand: true, y_expand: true });
            actor.set_content(image);
            actor.set_clip_to_allocation(true);
            if (size === "fit") actor.set_content_gravity(Clutter.ContentGravity.RESIZE_ASPECT);
            else if (size === "stretch") actor.set_content_gravity(Clutter.ContentGravity.RESIZE_FILL);
            else actor.set_content_gravity(Clutter.ContentGravity.CENTER);
            return actor;
        } catch (e) {
            global.logError("[kappa.yashi Session] image bg failed: " + e);
            return null;
        }
    }

    _makeNoiseActor(w, h) {
        try {
            // Generate at capped resolution and stretch to fill the whole
            // screen (RESIZE_FILL) - reliable full coverage, unlike tiling.
            let genW = Math.min(w, 1920);
            let genH = Math.min(h, 1080);
            const grain = Math.max(1, Math.min(6, this.noiseGrain || 1));
            const mode = this.noiseMode || "normal";
            let bytes = new Uint8Array(genW * genH * 4);

            // Parse the grain colour once (used by "colored" mode).
            let cc = { r: 255, g: 255, b: 255 };
            let cm = ("" + (this.noiseColor || "")).match(/rgba?\(([^)]+)\)/i);
            if (cm) {
                let pp = cm[1].split(",").map(s => parseInt(s.trim(), 10));
                cc = { r: pp[0] || 0, g: pp[1] || 0, b: pp[2] || 0 };
            }

            const speck = () => {
                let r = Math.random();
                switch (mode) {
                    case "light":   return [255, 255, 255, Math.floor(r * 255)];
                    case "dark":    return [0, 0, 0, Math.floor(r * 255)];
                    case "overlay": { let c = r < 0.5 ? 0 : 255; return [c, c, c, Math.floor(Math.random() * 255)]; }
                    case "soft":    { let g = 110 + Math.floor(r * 40); return [g, g, g, Math.floor(Math.random() * 70)]; }
                    case "colored": return [cc.r, cc.g, cc.b, Math.floor(r * 255)];
                    case "rgb":     return [Math.floor(Math.random()*255), Math.floor(Math.random()*255), Math.floor(Math.random()*255), Math.floor(Math.random()*255)];
                    default:        { let g = Math.floor(r * 255); return [g, g, g, Math.floor(Math.random() * 255)]; }
                }
            };

            for (let y = 0; y < genH; y += grain) {
                for (let x = 0; x < genW; x += grain) {
                    let px = speck();
                    for (let by = 0; by < grain && y + by < genH; by++) {
                        let rowBase = (y + by) * genW;
                        for (let bx = 0; bx < grain && x + bx < genW; bx++) {
                            let i = (rowBase + (x + bx)) * 4;
                            bytes[i] = px[0]; bytes[i + 1] = px[1]; bytes[i + 2] = px[2]; bytes[i + 3] = px[3];
                        }
                    }
                }
            }

            let image = new Clutter.Image();
            image.set_data(bytes, Cogl.PixelFormat.RGBA_8888, genW, genH, genW * 4);

            let actor = new Clutter.Actor({ width: w, height: h, x_expand: true, y_expand: true });
            actor.set_content(image);
            actor.set_content_gravity(Clutter.ContentGravity.RESIZE_FILL);
            try { actor.set_content_scaling_filter(Clutter.ScalingFilter.NEAREST, Clutter.ScalingFilter.NEAREST); } catch (e) {}
            actor.set_opacity(Math.round(Math.max(0, Math.min(100, this.noiseOpacity)) / 100 * 255));
            return actor;
        } catch (e) {
            global.logError("[kappa.yashi Session] noise failed: " + e);
            return null;
        }
    }

    _updateUptime() {
        if (!this._uptimeLabel) return;
        let text = "";
        try {
            let [ok, contents] = GLib.file_get_contents("/proc/uptime");
            let secs = Math.floor(parseFloat(("" + contents).split(" ")[0]));
            let h = Math.floor(secs / 3600);
            let m = Math.floor((secs % 3600) / 60);
            text = _("System") + " | " + _("Uptime") + ": " + h + " " + _("hours") + ", " + m + " " + _("minutes");
        } catch (e) {}
        this._uptimeLabel.set_text(text);
    }

    setPanelIcon() {
        if ( this.panelIcon == "" ||
           ( GLib.path_is_absolute(this.panelIcon) && GLib.file_test(this.panelIcon, GLib.FileTest.EXISTS) ) ) {
            if ( this.panelIcon.search("-symbolic.svg") == -1 ) this.set_applet_icon_path(this.panelIcon);
            else this.set_applet_icon_symbolic_path(this.panelIcon);
        }
        else if ( Gtk.IconTheme.get_default().has_icon(this.panelIcon) ) {
            if ( this.panelIcon.search("-symbolic") != -1 ) this.set_applet_icon_symbolic_name(this.panelIcon);
            else this.set_applet_icon_name(this.panelIcon);
        }
        else this.set_applet_icon_symbolic_name("system-shutdown");
    }

    setPanelText() {
        if ( this.panelText ) this.set_applet_label(this.panelText);
        else this.set_applet_label("");
    }

    on_applet_removed_from_panel() {
        this.closeOverlay();
        if (this.settings) this.settings.finalize();
    }
}

function main(metadata, orientation, panel_height, instanceId) {
    return new MyApplet(metadata, orientation, panel_height, instanceId);
}
