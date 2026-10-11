const Applet = imports.ui.applet;
const GLib = imports.gi.GLib;
const Interfaces = imports.misc.interfaces;
const PopupMenu = imports.ui.popupMenu;
const St = imports.gi.St;
const Settings = imports.ui.settings;

const MEDIA_PLAYER_2_PATH = "/org/mpris/MediaPlayer2";
const MEDIA_PLAYER_2_NAME = "org.mpris.MediaPlayer2";
const MEDIA_PLAYER_2_PLAYER_NAME = "org.mpris.MediaPlayer2.Player";

class MediaPlayer {
    // ... (No changes to this class) ...
    constructor(name, updateCallback = () => { }) {
        this.name = name;

        this.mediaServer = null;
        this.mediaServerPlayer = null;
        this.prop = null;
        this.propChangeId = null;

        this.isPlaying = false;
        this.songArtist = "";
        this.songTitle = "";
        this.appIcon = "multimedia-audio-player-symbolic";

        this.menuItem = new PopupMenu.PopupMenuItem(this.name);

        this.updateCallback = updateCallback;

        this.initDBus();
    }

    initDBus() {
        Interfaces.getDBusProxyWithOwnerAsync(MEDIA_PLAYER_2_NAME, this.name, (proxy, error) => {
            if (error) {
                global.log(error);
            } else {
                this.mediaServer = proxy;

                if (this.mediaServer.DesktopEntry) {
                    this.appIcon = this.mediaServer.DesktopEntry;
                }

                this.menuItem.setLabel(this.mediaServer.Identity);

                this.updateCallback();
            }
        });

        Interfaces.getDBusProxyWithOwnerAsync(MEDIA_PLAYER_2_PLAYER_NAME, this.name, (proxy, error) => {
            if (error) {
                global.log(error);
            } else {
                this.mediaServerPlayer = proxy;
                this.setMetadata(this.mediaServerPlayer.Metadata);
                this.setStatus(this.mediaServerPlayer.PlaybackStatus);

                this.updateCallback();
            }
        });

        Interfaces.getDBusPropertiesAsync(this.name, MEDIA_PLAYER_2_PATH, (proxy, error) => {
            if (error) {
                global.log(error);
            } else {
                this.prop = proxy;

                this.propChangeId = this.prop.connectSignal('PropertiesChanged', (proxy, sender, [iface, props]) => {
                    if (props.PlaybackStatus) {
                        this.setStatus(props.PlaybackStatus.unpack());
                    }

                    if (props.Metadata) {
                        this.setMetadata(props.Metadata.deep_unpack());
                    }

                    this.updateCallback();
                });
            }
        });
    }

    setStatus(status) {
        if (!status) { return; }
        this.isPlaying = status == "Playing";
    }

    setMetadata(metadata) {
        if (!metadata) { return; }

        if (metadata['mpris:artUrl']) {
            // Capa do álbum
            let artUrl = metadata['mpris:artUrl'].unpack();
        }

        this.songArtist = "";
        if (metadata['xesam:artist']) {
            switch (metadata["xesam:artist"].get_type_string()) {
                case 's':
                    // smplayer sends a string
                    this.songArtist = metadata["xesam:artist"].unpack();
                    break;
                case 'as':
                    // others send an array of strings
                    this.songArtist = metadata["xesam:artist"].deep_unpack().join(", ");
                    break;
            }
        }

        this.songTitle = "";
        if (metadata["xesam:title"]) {
            this.songTitle = metadata["xesam:title"].unpack();
        }
    }

    destroy() {
        if (this.prop && this.propChangeId) {
            this.prop.disconnectSignal(this.propChangeId);
            this.propChangeId = null;
        }

        this.menuItem.destroy();
    }
}

class MediaControlsApplet extends Applet.TextIconApplet {
    constructor(orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.actor.set_track_hover(false);
        this._appletOrientation = orientation;
        this._appletPanelHeight = panel_height;
        this._appletInstanceId = instance_id;

        // MODIFICATION: (Req 1) Define the list of browsers to exclude
        // This checks the DBus service name (e.g., org.mpris.MediaPlayer2.firefox)
        this._browserBlacklist = [
            "firefox",
            "chromium",
            "chrome",
            "brave",
            "vivaldi",
            "opera"
        ];

        // Settings: expose a configurable hover color for the control buttons.
        this.settings = new Settings.AppletSettings(this, "musiccontrols@kappayashi", instance_id);
        this.settings.bind("hover-color", "hover_color");

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        this._players = {};
        this._activePlayer = null;
        this._ownerChangedId = null;

        // MODIFICATION: (Req 3) Add a main style class to the applet's root actor
        this.actor.add_style_class_name("mediacontrols-applet");

        this._buildUi();
        this._loadDBus();
    }

    _buildUi() {
        // MODIFICATION: (Req 2 & 3) Create a container for controls
        // This lets us hide/show all controls at once (Req 2)
        // and gives it a CSS class for styling (Req 3)
        this.controlsContainer = new St.BoxLayout({ style_class: "mediacontrols-controls-container" });
        this.actor.add_child(this.controlsContainer);

        // MODIFICATION: (Req 3) Use specific style classes for each element
        // Instead of "mediacontrols_rbfraphael-element", we now have unique classes.

        // Menu Icon
        this.playerIcon = new St.Icon({
            icon_name: "multimedia-audio-player-symbolic",
            icon_type: St.IconType.SYMBOLIC,
            style_class: "mediacontrols-player-icon"
        });
        // MODIFICATION: (Req 2) Add to the new container
        this.controlsContainer.add_child(this.playerIcon);

        // Previous Button
        this.previousButton = new St.Button({ style_class: "mediacontrols-button mediacontrols-previous-button" });
        this.previousButton.child = new St.Icon({ icon_name: "media-skip-backward-symbolic", icon_size: 14, icon_type: St.IconType.SYMBOLIC })
        this.previousButton.connect("clicked", () => this._buttonAction("previous"));
        this._makeHoverable(this.previousButton);
        // MODIFICATION: (Req 2) Add to the new container
        this.controlsContainer.add_child(this.previousButton);

        // Play/Pause Button
        this.playPauseButton = new St.Button({ style_class: "mediacontrols-button mediacontrols-playpause-button" });
        this.playPauseButton.child = new St.Icon({ icon_name: "media-playback-pause-symbolic", icon_size: 14, icon_type: St.IconType.SYMBOLIC })
        this.playPauseButton.connect("clicked", () => this._buttonAction("playPause"));
        this._makeHoverable(this.playPauseButton);
        // MODIFICATION: (Req 2) Add to the new container
        this.controlsContainer.add_child(this.playPauseButton);

        // Next Button
        this.nextButton = new St.Button({ style_class: "mediacontrols-button mediacontrols-next-button" });
        this.nextButton.child = new St.Icon({ icon_name: "media-skip-forward-symbolic", icon_size: 14, icon_type: St.IconType.SYMBOLIC })
        this.nextButton.connect("clicked", () => this._buttonAction("next"));
        this._makeHoverable(this.nextButton);
        // MODIFICATION: (Req 2) Add to the new container
        this.controlsContainer.add_child(this.nextButton);

        // Media Info
        this.mediaInfo = new St.Bin({
        x_align: St.Align.START,
        y_align: St.Align.MIDDLE,
        style_class: "mediacontrols-media-info"
});

        // Create the label as a separate variable
        let mediaLabel = new St.Label({ text: "No player selected" });

        // MODIFICATION: Apply the inline style directly to the label object
        // This forces the font size, overriding the theme/OS settings
        mediaLabel.set_style("font-size: pt;"); // <-- Change 9pt to your desired size

        // Now set the styled label as the child of the container
        this.mediaInfo.child = mediaLabel;

        // MODIFICATION: (Req 2) Add to the new container
        this.controlsContainer.add_child(this.mediaInfo);
        
        // Menu Icon (Dropdown)
        let menuIconName = ["pan-down-symbolic", "pan-left-symbolic", "pan-up-symbolic", "pan-right-symbolic"][this._appletOrientation];
        this.menuIcon = new St.Icon({
            icon_name: menuIconName,
            icon_size: 12,
            icon_type: St.IconType.SYMBOLIC,
            // MODIFICATION: (Req 3) Add a style class
            style_class: "mediacontrols-menu-icon"
        })
        // MODIFICATION: (Req 2) Add this *after* the container, as a sibling
        this.actor.add_child(this.menuIcon);

        this._updateUi();
    }

    // Applies the user-selected hover color to a button's icon on mouse-over,
    // and clears it on mouse-out (falling back to the stylesheet's default white).
    // Done in JS because a static stylesheet can't read the color setting.
    _makeHoverable(button) {
        button.connect("enter-event", () => {
            if (button.child && this.hover_color) {
                button.child.set_style("color: " + this.hover_color + ";");
            }
        });
        button.connect("leave-event", () => {
            if (button.child) {
                button.child.set_style("");
            }
        });
    }

    _buttonAction(action) {
        if (this._activePlayer) {
            let timeout = false;
            switch (action) {
                case "playPause":
                    this._activePlayer.mediaServerPlayer.PlayPauseRemote();
                    timeout = true;
                    break;
                case "next":
                    this._activePlayer.mediaServerPlayer.NextRemote();
                    timeout = true;
                    break;
                case "previous":
                    this._activePlayer.mediaServerPlayer.PreviousRemote();
                    timeout = true;
                    break;
                default:
                    break;
            }

            if (timeout) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                    this._updateUi();
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
    }

_updateUi() {
        try {
            if (this._activePlayer) {
                // We have an active player, show the controls AND the menu icon
                this.controlsContainer.show();
                this.menuIcon.show(); // <-- MODIFICATION: Show the arrow

                this.playerIcon.icon_name = this._activePlayer.appIcon;

                if (this._activePlayer.isPlaying) {
                    this.playPauseButton.child.icon_name = "media-playback-pause-symbolic";
                } else {
                    this.playPauseButton.child.icon_name = "media-playback-start-symbolic";
                }

                let songDescription = this._activePlayer.songTitle;
                if (this._activePlayer.songArtist.length > 0) {
                    songDescription += songDescription.length > 0 ? " - " : "";
                    songDescription += this._activePlayer.songArtist;
                }

                // Set text, or a placeholder if no info
                this.mediaInfo.child.text = songDescription.length > 0 ? songDescription : "..."

            } else {
                // No active player, hide the controls AND the menu icon
                this.controlsContainer.hide();
                this.menuIcon.hide(); // <-- MODIFICATION: Hide the arrow
            }
        } catch (e) {
            global.logError(e);
            throw e;
        }
    }

    _loadDBus() {
        Interfaces.getDBusAsync((proxy, error) => {
            if (error) {
                global.log(error);
                throw error;
            }

            this._dbus = proxy;

            let nameRegex = /^org\.mpris\.MediaPlayer2\./;

            this._dbus.ListNamesRemote((names) => {
                for (let n in names[0]) {
                    let name = names[0][n];
                    if (nameRegex.test(name)) {
                        this._dbus.GetNameOwnerRemote(name, (owner) => {
                            this._addPlayer(name, owner[0], true);
                        });
                    }
                }
            });

            this._ownerChangedId = this._dbus.connectSignal('NameOwnerChanged',
                (proxy, sender, [name, oldOwner, newOwner]) => {
                    if (nameRegex.test(name)) {
                        if (newOwner && !oldOwner) {
                            this._addPlayer(name, newOwner, true);
                        } else if (oldOwner && !newOwner) {
                            this._removePlayer(name);
                        } else {
                            this._updatePlayerOwner(name, newOwner);
                        }
                    }
                }
            );
        });
    }

_addPlayer(name, ownerId, switchTo = false) {
        // MODIFICATION: (Req 1) Corrected browser check
        // 'name' is like "org.mpris.MediaPlayer2.firefox" or "org.mpris.MediaPlayer2.chromium.instance345"
        // We get the player-specific part: "firefox" or "chromium.instance345"
        let playerName = name.replace("org.mpris.MediaPlayer2.", "");

        // Now we check if this player name *starts with* any entry in our blacklist
        let isBrowser = this._browserBlacklist.some(browser => playerName.startsWith(browser));
        
        if (isBrowser) {
            global.log("MediaControlsApplet: Ignoring blacklisted player: " + name);
            return; // Stop processing this player
        }

        // --- Rest of the function is unchanged ---
        try {
            let player = new MediaPlayer(name, () => { this._updateUi() });
            let menuItem = player.menuItem;

            menuItem.activate = () => {
                this._switchPlayer(player);
                this.menu.toggle();
            };

            this._players[name] = { player, ownerId }
            this.menu.addMenuItem(menuItem);

            if (switchTo || !this._activePlayer) {
                this._switchPlayer(player);
            }
        } catch (e) {
            global.logError(e);
            throw e;
        }
    }

    _removePlayer(name) {
        try {
            if (!this._players[name]) {
                return;
            }

            let player = this._players[name].player;

            if (this._activePlayer == player) {
                let allPlayers = Object.keys(this._players).filter(p => p !== name); // Filter out the one we are removing
                if (allPlayers.length > 0) {
                    // Switch to the "last" player in the remaining list
                    let newPlayerName = allPlayers[allPlayers.length - 1];
                    this._switchPlayer(this._players[newPlayerName].player);
                } else {
                    // This was the last player
                    this._switchPlayer(null);
                }
            }
            
            player.destroy();
            delete this._players[name];

            // MODIFICATION: (Req 2) We must call _updateUi() here in case
            // the removed player was NOT the active one, but its removal
            // results in an empty list (which _switchPlayer wouldn't catch).
            // ... Actually, _switchPlayer(null) handles the visual update.
            // And if the removed player wasn't active, we don't need to do anything.
            // The original logic is fine.

        } catch (e) {
            global.logError(e);
            throw e;
        }
    }

    _updatePlayerOwner(name, ownerId) {
        if (this._players[name]) {
            this._players[name].ownerId = ownerId;
        }
    }

    _switchPlayer(player) {
        try {
            Object.keys(this._players).forEach(key => {
                this._players[key].player.menuItem.setShowDot(false);
            });

            this._activePlayer = player;

            if (this._activePlayer !== null) {
                this._activePlayer.menuItem.setShowDot(true);
            }

            this._updateUi();
        } catch (e) {
            global.logError(e);
            throw e;
        }
    }

    on_applet_clicked(event) {
        this.menu.toggle();
    }

    on_applet_removed_from_panel() {
        Object.values(this._players).forEach((p) => {
            p.player.destroy();
        });

        if (this._dbus && this._ownerChangedId) {
            this._dbus.disconnectSignal(this._ownerChangedId);
        }
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new MediaControlsApplet(orientation, panel_height, instance_id);
}
