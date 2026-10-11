const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const Applet = imports.ui.applet;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const PopupMenu = imports.ui.popupMenu;
const SignalManager = imports.misc.signalManager;
const Tooltips = imports.ui.tooltips;
const Settings = imports.ui.settings;
const ModalDialog = imports.ui.modalDialog;
const Pango = imports.gi.Pango;

const MIN_SWITCH_INTERVAL_MS = 220;


function removeWorkspaceAtIndex(index) {
    if (global.workspace_manager.n_workspaces <= 1 ||
        index >= global.workspace_manager.n_workspaces) {
        return;
    }

    const removeAction = () => {
        Main._removeWorkspace(global.workspace_manager.get_workspace_by_index(index));
    };

    if (!Main.hasDefaultWorkspaceName(index)) {
        let prompt = _("Are you sure you want to remove workspace \"%s\"?\n\n").format(
            Main.getWorkspaceName(index)
        );

        let confirm = new ModalDialog.ConfirmDialog(prompt, removeAction);
        confirm.open();
    }
    else {
        removeAction();
    }
}


class WorkspaceButton {
    constructor(index, applet) {
        this.index = index;
        this.applet = applet;
        this.workspace = global.workspace_manager.get_workspace_by_index(this.index);
        this.workspace_name = Main.getWorkspaceName(index);
        this.actor = null; // defined in subclass

        this.ws_signals = new SignalManager.SignalManager(null);

        this.ws_signals.connect(this.workspace, "window-added", this.update, this);
        this.ws_signals.connect(this.workspace, "window-removed", this.update, this);

        // Connect after Main or else we'll end up with stale names.
        this.ws_signals.connect_after(Main.wmSettings, "changed::workspace-names", this.updateName, this);
    }

    show() {
        this.actor.connect('button-release-event', Lang.bind(this, this.onClicked));
        // Tooltip is still important to show the full name if the button truncates it
        this._tooltip = new Tooltips.PanelItemTooltip(this, this.workspace_name, this.applet.orientation);
        if (this.index === global.workspace_manager.get_active_workspace_index()) {
            this.activate(true);
        }
    }

    updateName() {
        this.workspace_name = Main.getWorkspaceName(this.index);
        this._tooltip.set_text(this.workspace_name);
    }

    onClicked(actor, event) {
        if (event.get_button() == 1) {
            Main.wm.moveToWorkspace(this.workspace);
        } else if (event.get_button() == 2) {
            removeWorkspaceAtIndex(this.index);
        }
    }

    update() {
        // defined in subclass
    }

    activate(active) {
        // Defined in subclass
    }

    destroy() {
        this.ws_signals.disconnectAllSignals();
        this._tooltip.destroy();
        this.actor.destroy();
    }
}

class WorkspaceGraph extends WorkspaceButton {
    constructor(index, applet) {
        super(index, applet);

        this.scaleFactor = 0;

        this.actor = new St.Bin({ reactive: applet._draggable.inhibit,
                                     style_class: 'workspace',
                                     y_fill: true,
                                     important: true });

        this.graphArea = new St.DrawingArea({ style_class: 'windows', important: true });
        this.actor.add_actor(this.graphArea);
        this.panelApplet = applet;

        this.graphArea.set_size(1, 1);
        this.graphArea.connect('repaint', Lang.bind(this, this.onRepaint));
    }

    getSizeAdjustment (actor, vertical) {
        let themeNode = actor.get_theme_node()
        if (vertical) {
            return themeNode.get_horizontal_padding() +
                themeNode.get_border_width(St.Side.LEFT) +
                themeNode.get_border_width(St.Side.RIGHT);
        }
        else {
            return themeNode.get_vertical_padding() +
                themeNode.get_border_width(St.Side.TOP) +
                themeNode.get_border_width(St.Side.BOTTOM);
        }
    }

    setGraphSize () {
        this.workspace_size = this.workspace.get_work_area_all_monitors();

        let height, width;
        if (this.panelApplet.orientation == St.Side.LEFT ||
            this.panelApplet.orientation == St.Side.RIGHT) {

            width = this.panelApplet._panelHeight -
                this.getSizeAdjustment(this.panelApplet.actor, true) -
                this.getSizeAdjustment(this.actor, true);
            this.scaleFactor = this.workspace_size.width / width;
            height = Math.round(this.workspace_size.height / this.scaleFactor);
        }
        else {
            height = this.panelApplet._panelHeight -
                this.getSizeAdjustment(this.panelApplet.actor, false) -
                this.getSizeAdjustment(this.actor, false);
            this.scaleFactor = this.workspace_size.height / height;
            width = Math.round(this.workspace_size.width / this.scaleFactor);
        }

        this.graphArea.set_size(width, height);
    }

    scale (windows_rect, workspace_rect) {
        let scaled_rect = new Meta.Rectangle();
        scaled_rect.x = Math.round((windows_rect.x - workspace_rect.x) / this.scaleFactor);
        scaled_rect.y = Math.round((windows_rect.y - workspace_rect.y) / this.scaleFactor);
        scaled_rect.width = Math.round(windows_rect.width / this.scaleFactor);
        scaled_rect.height = Math.round(windows_rect.height / this.scaleFactor);
        return scaled_rect;
    }

    sortWindowsByUserTime (win1, win2) {
        let t1 = win1.get_user_time();
        let t2 = win2.get_user_time();
        return (t2 < t1) ? 1 : -1;
    }

    paintWindow(metaWindow, themeNode, cr) {
        let windowBackgroundColor;
        let windowBorderColor;

        let scaled_rect = this.scale(metaWindow.get_buffer_rect(), this.workspace_size);

        if (metaWindow.has_focus()) {
            windowBorderColor = themeNode.get_color('-active-window-border');
            windowBackgroundColor = themeNode.get_color('-active-window-background');
        } else {
            windowBorderColor = themeNode.get_color('-inactive-window-border');
            windowBackgroundColor = themeNode.get_color('-inactive-window-background');
        }

        Clutter.cairo_set_source_color(cr, windowBorderColor);
        cr.rectangle(scaled_rect.x, scaled_rect.y, scaled_rect.width, scaled_rect.height);
        cr.strokePreserve();

        Clutter.cairo_set_source_color(cr, windowBackgroundColor);
        cr.fill();
    }

    onRepaint(area) {
        // we need to set the size of the drawing area the first time, but we can't get
        // accurate measurements until everything is added to the stage
        if (this.scaleFactor === 0) this.setGraphSize();

        let graphThemeNode = this.graphArea.get_theme_node();
        let cr = area.get_context();
        cr.setLineWidth(1);

        // construct a list with all windows
        let windows = this.workspace.list_windows();
        windows = windows.filter( Main.isInteresting );
        windows = windows.filter(
            function(w) {
                return !w.is_skip_taskbar() && !w.minimized;
            });

        windows.sort(this.sortWindowsByUserTime);

        if (windows.length) {
            let focusWindow = null;

            for (let i = 0; i < windows.length; ++i) {
                let metaWindow = windows[i];

                if (metaWindow.has_focus()) {
                    focusWindow = metaWindow;
                    continue;
                }

                this.paintWindow(metaWindow, graphThemeNode, cr);
            }

            if (focusWindow) {
                this.paintWindow(focusWindow, graphThemeNode, cr);
            }
        }

        cr.$dispose();
    }

    update() {
        this.graphArea.queue_repaint();
    }

    activate(active) {
        if (active) {
            this.actor.add_style_pseudo_class('active');
            if (this.applet.use_accent_color)
                this.actor.set_style('border: 2px solid ' + this.applet.accent_color + ';');
        }
        else {
            this.actor.remove_style_pseudo_class('active');
            this.actor.set_style('');
        }
    }
}

// Class for displaying workspace NAMES as text (old SimpleButton)
class NameButton extends WorkspaceButton {
    constructor(index, applet) {
        super(index, applet);

        // CRITICAL CHANGE: Using St.Bin instead of St.Button to avoid theme conflicts
        this.actor = new St.Bin({ name: 'workspaceBin',
                                  style_class: 'workspace-name-button', // Unique class is still needed for our base styles
                                  reactive: applet._draggable.inhibit });

        if (applet.orientation == St.Side.TOP || applet.orientation == St.Side.BOTTOM) {
            this.actor.set_height(applet._panelHeight);
        } else {
            this.actor.set_width(applet._panelHeight);
            this.actor.add_style_class_name('vertical');
        }
        
        let label = new St.Label({ text: this.workspace_name });
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        this.actor.set_child(label);
        
        this.update();
    }

    updateName() {
        super.updateName(); 
        let label = this.actor.get_child();
        if (label && this.workspace_name) {
            label.set_text(this.workspace_name);
        }
    }

    activate(active) {
        // CRITICAL CHANGE: Use 'active' class instead of ':outlined' pseudo-class
        let label = this.actor.get_child();
        if (active) {
            this.actor.add_style_class_name('active');
            if (this.applet.use_accent_color && label) {
                // Inline style overrides the white .active color from the stylesheet.
                label.set_style('color: ' + this.applet.accent_color + ';');
            }
        }
        else {
            this.actor.remove_style_class_name('active');
            if (label) label.set_style('');
            this.update();
        }
    }

    shade(used) {
        if (!used) {
            this.actor.add_style_pseudo_class('shaded');
        }
        else {
            this.actor.remove_style_pseudo_class('shaded');
        }
    }
    
    update() {
        let windows = this.workspace.list_windows();
        let used = windows.some(Main.isInteresting);
        this.shade(used);
    }
}

// Class for displaying visual INDICATORS (Bullets/Pills)
class IndicatorButton extends WorkspaceButton {
    constructor(index, applet) {
        super(index, applet);
        
        this.active = false;
        this.used = true; // Assume used until update() runs
        this.hovered = false; // Track hover state manually

        // Main container
        this.actor = new St.Bin({ name: 'workspaceBin',
                                  style_class: 'workspace-indicator-button', 
                                  reactive: applet._draggable.inhibit });
                                  
        // Inner element for the visual indicator (bullet/pill) - NOW A DRAWING AREA
        this.indicatorArea = new St.DrawingArea({ style_class: 'workspace-indicator' });
        
        // Connect repaint signal
        this.indicatorArea.connect('repaint', Lang.bind(this, this._onRepaint));
        
        // Manual hover tracking for drawing logic
        this.actor.connect('enter-event', () => { this.hovered = true; this.update(); });
        this.actor.connect('leave-event', () => { this.hovered = false; this.update(); });


        if (applet.orientation == St.Side.TOP || applet.orientation == St.Side.BOTTOM) {
            this.actor.set_height(applet._panelHeight);
        } else {
            this.actor.set_width(applet._panelHeight);
            this.actor.add_style_class_name('vertical');
        }
        
        // Use the indicator as the only child
        this.actor.set_child(this.indicatorArea);
        
        this.update();
    }
    
    _onRepaint(area) {
        let cr = area.get_context();
        let [width, height] = area.get_size();
        let radius = 4; // Max radius for circle
        let pillRadius = 4; // Radius for pill ends

        // 1. Determine Color (White color base: 255, 255, 255)
        let color;
        if (this.active) {
            if (this.applet.use_accent_color) {
                // Active: custom accent color
                color = this.applet.getAccentClutterColor();
            } else {
                // Active: 100% White
                color = new Clutter.Color({ red: 255, green: 255, blue: 255, alpha: 255 });
            }
        } else if (this.hovered) {
            // Hover: ~70% White
            color = new Clutter.Color({ red: 255, green: 255, blue: 255, alpha: 178 });
        } else if (this.used) {
            // Inactive (Used): 50% White (User specified)
            color = new Clutter.Color({ red: 255, green: 255, blue: 255, alpha: 127 }); 
        } else {
            // Shaded (Empty): 20% White (User specified)
            color = new Clutter.Color({ red: 255, green: 255, blue: 255, alpha: 51 });
        }

        // 2. Set Draw Color
        Clutter.cairo_set_source_color(cr, color);

        // 3. Draw Shape
        // We use the CSS transition to make the 'width' of the St.DrawingArea change.
        if (width <= 8) {
            // Draw a perfect circle (bullet)
            cr.arc(width / 2, height / 2, radius, 0, 2 * Math.PI);
        } else {
            // Draw a pill shape (rounded rectangle)
            cr.moveTo(pillRadius, 0);
            cr.arc(width - pillRadius, height / 2, pillRadius, -Math.PI / 2, Math.PI / 2); // Right semi-circle
            cr.lineTo(pillRadius, height);
            cr.arc(pillRadius, height / 2, pillRadius, Math.PI / 2, 3 * Math.PI / 2); // Left semi-circle
            cr.closePath();
        }

        // 4. Fill Shape
        cr.fill();
        cr.$dispose();
    }

    // Since we are no longer showing text, this function only updates the tooltip
    updateName() {
        super.updateName();
    }

    activate(active) {
        this.active = active;
        if (active) {
            this.actor.add_style_class_name('active');
        }
        else {
            this.actor.remove_style_class_name('active');
        }
        this.update(); // Force repaint
    }

    shade(used) {
        this.used = used;
        if (!used) {
            this.actor.add_style_pseudo_class('shaded');
        }
        else {
            this.actor.remove_style_pseudo_class('shaded');
        }
    }
    
    update() {
        let windows = this.workspace.list_windows();
        let used = windows.some(Main.isInteresting);
        this.shade(used);
        
        // We need to queue a repaint whenever state changes (active, hover, or shading)
        this.indicatorArea.queue_repaint();
    }
}

class CinnamonWorkspaceSwitcher extends Applet.Applet {
    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);

        this.orientation = orientation;
        this.signals = new SignalManager.SignalManager(null);
        this.buttons = [];
        this._last_switch = 0;
        this._last_switch_direction = 0;
        this.createButtonsQueued = false;

        this._focusWindow = null;
        if (global.display.focus_window)
            this._focusWindow = global.display.focus_window;

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instance_id);
        this.settings.bind("display-type", "display_type", this.queueCreateButtons);
        this.settings.bind("scroll-behavior", "scroll_behavior");
        this.settings.bind("use-accent-color", "use_accent_color", this.queueCreateButtons);
        this.settings.bind("accent-color", "accent_color", this.queueCreateButtons);

        this.actor.connect('scroll-event', this.hook.bind(this));

        this.signals.connect(Main.layoutManager, 'monitors-changed', this.onWorkspacesUpdated, this);

        this.queueCreateButtons();
        global.workspace_manager.connect('notify::n-workspaces', () => { this.onWorkspacesUpdated() });
        global.workspace_manager.connect('workspaces-reordered', () => { this.onWorkspacesUpdated() });
        // NOTE: We change the signal handler to _onWorkspaceChangedManual to handle active class
        global.window_manager.connect('switch-workspace', this._onWorkspaceChangedManual.bind(this));
        global.settings.connect('changed::panel-edit-mode', Lang.bind(this, this.on_panel_edit_mode_changed));

        let expoMenuItem = new PopupMenu.PopupIconMenuItem(_("Manage workspaces (Expo)"), "view-grid-symbolic", St.IconType.SYMBOLIC);
        expoMenuItem.connect('activate', Lang.bind(this, function() {
            if (!Main.expo.animationInProgress)
                Main.expo.toggle();
        }));
        this._applet_context_menu.addMenuItem(expoMenuItem);

        let addWorkspaceMenuItem = new PopupMenu.PopupIconMenuItem (_("Add a new workspace"), "list-add", St.IconType.SYMBOLIC);
        addWorkspaceMenuItem.connect('activate', Lang.bind(this, function() {
            Main._addWorkspace();
        }));
        this._applet_context_menu.addMenuItem(addWorkspaceMenuItem);

        this.removeWorkspaceMenuItem = new PopupMenu.PopupIconMenuItem (_("Remove the current workspace"), "list-remove", St.IconType.SYMBOLIC);
        this.removeWorkspaceMenuItem.connect('activate', this.removeCurrentWorkspace.bind(this));
        this._applet_context_menu.addMenuItem(this.removeWorkspaceMenuItem);
        this.removeWorkspaceMenuItem.setSensitive(global.workspace_manager.n_workspaces > 1);
    }
    
    // Parse an "rgb(...)", "rgba(...)" or "#hex" string into {r,g,b,a} (0-255).
    // Done manually so it is independent of the GJS/Clutter.Color.from_string API version.
    _parseColorString(str) {
        let r = 255, g = 255, b = 255, a = 255;
        if (!str) return { r, g, b, a };
        str = ("" + str).trim();

        let m = str.match(/rgba?\(([^)]+)\)/i);
        if (m) {
            let parts = m[1].split(',').map(s => s.trim());
            r = parseInt(parts[0], 10);
            g = parseInt(parts[1], 10);
            b = parseInt(parts[2], 10);
            if (parts.length === 4) a = Math.round(parseFloat(parts[3]) * 255);
        } else if (str[0] === '#') {
            let hex = str.slice(1);
            if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
            r = parseInt(hex.substr(0, 2), 16);
            g = parseInt(hex.substr(2, 2), 16);
            b = parseInt(hex.substr(4, 2), 16);
            if (hex.length === 8) a = parseInt(hex.substr(6, 2), 16);
        }

        if (isNaN(r)) r = 255;
        if (isNaN(g)) g = 255;
        if (isNaN(b)) b = 255;
        if (isNaN(a)) a = 255;
        return { r, g, b, a };
    }

    // Returns a Clutter.Color for the accent (used by the JS-drawn indicators).
    getAccentClutterColor() {
        let c = this._parseColorString(this.accent_color);
        return new Clutter.Color({ red: c.r, green: c.g, blue: c.b, alpha: c.a });
    }

    // Manual activation handler since we are no longer using St.Button's default functionality
    _onWorkspaceChangedManual(wm, from, to) {
        if (this.buttons[from]) this.buttons[from].activate(false);
        if (this.buttons[to]) this.buttons[to].activate(true);
    }

    onWorkspacesUpdated() {
        this.removeWorkspaceMenuItem.setSensitive(global.workspace_manager.n_workspaces > 1);
        this._createButtons();
    }

    removeCurrentWorkspace() {
        if (global.workspace_manager.n_workspaces <= 1) {
            return;
        }
        this.workspace_index = global.workspace_manager.get_active_workspace_index();
        removeWorkspaceAtIndex(this.workspace_index);
    }

    on_panel_edit_mode_changed() {
        let reactive = !global.settings.get_boolean('panel-edit-mode');
        for (let i = 0; i < this.buttons.length; ++i) {
            this.buttons[i].actor.reactive = reactive;
        }
    }

    on_orientation_changed(neworientation) {
        this.orientation = neworientation;

        if (this.orientation == St.Side.TOP || this.orientation == St.Side.BOTTOM)
            this.actor.set_vertical(false);
        else
            this.actor.set_vertical(true);

        this.queueCreateButtons();
    }

    on_panel_height_changed() {
        this.queueCreateButtons();
    }

    hook(actor, event) {
        if (this.scroll_behavior == "disabled")
            return;

        let now = (new Date()).getTime();
        let direction = event.get_scroll_direction();

        // Avoid fast scroll directions
        if(direction != 0 && direction != 1) return;

        // Do the switch only after a elapsed time to avoid fast
        // consecutive switches on sensible hardware, like touchpads
        if ((now - this._last_switch) > MIN_SWITCH_INTERVAL_MS ||
            direction !== this._last_switch_direction) {

            // XOR used to determine the effective direction
            if ((direction == 0) == (this.scroll_behavior == "normal"))
                Main.wm.actionMoveWorkspaceLeft();
            else
                Main.wm.actionMoveWorkspaceRight();

            this._last_switch = now;
            this._last_switch_direction = direction;
        }
    }

    queueCreateButtons() {
        if (!this.createButtonsQueued) {
            Mainloop.idle_add(Lang.bind(this, this._createButtons));
            this.createButtonsQueued = true;
        }
    }

    _createButtons() {
        this.createButtonsQueued = false;
        for (let i = 0; i < this.buttons.length; ++i) {
            this.buttons[i].destroy();
        }

        if (this.display_type == "visual")
            this.actor.set_style_class_name('workspace-graph');
        else
            this.actor.set_style_class_name('workspace-switcher');

        this.actor.set_important(true);

        this.buttons = [];
        for (let i = 0; i < global.workspace_manager.n_workspaces; ++i) {
            if (this.display_type == "visual")
                this.buttons[i] = new WorkspaceGraph(i, this);
            else if (this.display_type == "indicators")
                this.buttons[i] = new IndicatorButton(i, this);
            else // Default to name buttons
                this.buttons[i] = new NameButton(i, this);

            this.actor.add_actor(this.buttons[i].actor);
            this.buttons[i].show();
        }

        this.signals.disconnect("notify::focus-window");
        if (this.display_type == "visual") {
            // In visual mode, keep track of window events to represent them
            this.signals.connect(global.display, "notify::focus-window", this._onFocusChanged, this);
            this._onFocusChanged();
        }
    }

    _onFocusChanged() {
        if (global.display.focus_window &&
            this._focusWindow == global.display.focus_window)
            return;

        this.signals.disconnect("position-changed");
        this.signals.disconnect("size-changed");

        if (!global.display.focus_window)
            return;

        this._focusWindow = global.display.focus_window;
        this.signals.connect(this._focusWindow, "position-changed", Lang.bind(this, this._onPositionChanged), this);
        this.signals.connect(this._focusWindow, "size-changed", Lang.bind(this, this._onPositionChanged), this);
        this._onPositionChanged();
    }

    _onPositionChanged() {
        let button = this.buttons[global.workspace_manager.get_active_workspace_index()];
        button.update();
    }

    on_applet_removed_from_panel() {
        this.signals.disconnectAllSignals();
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new CinnamonWorkspaceSwitcher(metadata, orientation, panel_height, instance_id);
}
