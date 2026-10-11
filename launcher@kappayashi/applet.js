const Applet = imports.ui.applet;
const St = imports.gi.St;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Settings = imports.ui.settings;
const Util = imports.misc.util;

class KappaYashiLauncher extends Applet.Applet {
    constructor(orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.settings = new Settings.AppletSettings(this, "launcher@kappayashi", instance_id);
        this.settings.bind("icon-source", "icon_source", () => this._rebuildIcon());
        this.settings.bind("icon-file", "icon_file", () => this._rebuildIcon());
        this.settings.bind("icon-name", "icon_name_setting", () => this._rebuildIcon());
        this.settings.bind("symbolic-icon", "symbolic_icon", () => this._rebuildIcon());
        this.settings.bind("icon-color", "icon_color", () => this._applyBaseIcon());
        this.settings.bind("icon-size", "icon_size", () => this._rebuildIcon());
        this.settings.bind("hover-color", "hover_color", () => {});
        this.settings.bind("hover-bg-color", "hover_bg_color", () => {});
        this.settings.bind("hover-target", "hover_target", () => {});
        this.settings.bind("background-radius", "background_radius", () => {});
        this.settings.bind("command-source", "command_source", () => {});
        this.settings.bind("command-file", "command_file", () => {});
        this.settings.bind("command", "command", () => {});

        // Kill the default applet-box hover highlight; we colour on hover ourselves.
        this.actor.add_style_class_name("kappayashi-launcher-box");
        this.actor.set_track_hover(false);

        this._icon = new St.Icon({ style_class: "applet-icon", icon_name: "application-x-executable-symbolic" });

        this._button = new St.Bin({
            style_class: "kappayashi-launcher-button",
            reactive: true,
            track_hover: false,
            can_focus: true,
            child: this._icon
        });
        this.actor.add_child(this._button);

        this._button.connect("enter-event", () => this._onEnter());
        this._button.connect("leave-event", () => this._onLeave());
        // Consume presses; act on release so a right-click context menu opens
        // cleanly (opening it on press would let the release close it again).
        this._button.connect("button-press-event", (a, e) => {
            if (this._editMode)
                return false;
            return (e.get_button() === 1 || e.get_button() === 3);
        });
        this._button.connect("button-release-event", (a, e) => this._onRelease(e));

        // In panel edit mode the child must not swallow clicks, otherwise the
        // applet can't be selected and dragged. Track the mode and toggle the
        // button's reactivity accordingly.
        this._editMode = false;
        this._editSignalId = 0;
        try {
            this._editSignalId = global.settings.connect(
                "changed::panel-edit-mode", () => this._updateEditMode());
        } catch (e) {}
        this._updateEditMode();

        this._rebuildIcon();
    }

    _updateEditMode() {
        let edit = false;
        try { edit = global.settings.get_boolean("panel-edit-mode"); } catch (e) {}
        this._editMode = edit;
        if (this._button)
            this._button.set_reactive(!edit);
    }

    _resolvePath(s) {
        s = ("" + (s || "")).trim();
        if (!s)
            return "";
        if (s.indexOf("file://") === 0) {
            try {
                return GLib.filename_from_uri(s)[0];
            } catch (e) {
                s = s.replace(/^file:\/\//, "");
                try { s = decodeURIComponent(s); } catch (e2) {}
            }
        }
        return s;
    }

    _rebuildIcon() {
        if (!this._icon)
            return;

        let size = Math.max(4, this.icon_size || 22);
        this._icon.set_icon_size(size);
        this._icon.set_icon_type(this.symbolic_icon ? St.IconType.SYMBOLIC : St.IconType.FULLCOLOR);

        let path = "";
        let name = "";
        if (this.icon_source === "name") {
            let raw = ("" + (this.icon_name_setting || "")).trim();
            if (raw.indexOf("/") >= 0 || raw.indexOf("file://") === 0)
                path = this._resolvePath(raw);
            else
                name = raw;
        } else {
            path = this._resolvePath(this.icon_file);
        }

        if (path) {
            this._icon.set_gicon(Gio.FileIcon.new(Gio.File.new_for_path(path)));
        } else if (name) {
            this._icon.set_gicon(null);
            this._icon.set_icon_name(name);
        } else {
            // Visible placeholder until the user picks an icon.
            this._icon.set_gicon(null);
            this._icon.set_icon_name("application-x-executable-symbolic");
        }

        this._applyBaseIcon();
    }

    _applyBaseIcon() {
        if (!this._icon)
            return;
        if (this.symbolic_icon && this.icon_color)
            this._icon.set_style("color: " + this.icon_color + ";");
        else
            this._icon.set_style("");
    }

    _onEnter() {
        if (this._editMode)
            return;
        let target = this.hover_target || "icon";

        if ((target === "icon" || target === "both") && this.symbolic_icon)
            this._icon.set_style("color: " + this.hover_color + ";");

        if (target === "background" || target === "both")
            this._button.set_style("background-color: " + this.hover_bg_color + "; border-radius: " + (this.background_radius || 0) + "px;");
    }

    _onLeave() {
        this._applyBaseIcon();
        this._button.set_style("");
    }

    _onRelease(event) {
        if (this._editMode)
            return false;   // let the panel handle selection / dragging

        let button = event.get_button();
        if (button === 3) {
            if (this._applet_context_menu)
                this._applet_context_menu.toggle();
            return true;
        }
        if (button === 1) {
            this._launch();
            return true;
        }
        return false;
    }

    _launch() {
        if (this.command_source === "browse") {
            let f = this._resolvePath(this.command_file);
            if (!f)
                return;
            if (f.slice(-8) === ".desktop") {
                try {
                    let info = Gio.DesktopAppInfo.new_from_filename(f);
                    if (info) {
                        info.launch([], null);
                        return;
                    }
                } catch (e) {}
            }
            Util.spawnCommandLine("\"" + f + "\"");
            return;
        }

        let cmd = ("" + (this.command || "")).trim();
        if (cmd.length > 0)
            Util.spawnCommandLine(cmd);
    }

    on_applet_removed_from_panel() {
        if (this._editSignalId) {
            try { global.settings.disconnect(this._editSignalId); } catch (e) {}
            this._editSignalId = 0;
        }
        if (this.settings)
            this.settings.finalize();
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new KappaYashiLauncher(orientation, panel_height, instance_id);
}
