import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Extension as GnomeExtension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BUS_NAME = 'app.chamu.Input';
const OBJECT_PATH = '/app/chamu/Input';
const INTERFACE_NAME = 'app.chamu.Input';
const DBUS_INTERFACE = `
<node>
  <interface name="${INTERFACE_NAME}">
    <method name="Paste"/>
  </interface>
</node>`;

class InputService {
  Paste() {
    const virtualKeyboard = Clutter.get_default_backend()
      .get_default_seat()
      .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

    // Ctrl+V
    virtualKeyboard.notify_keyval(
      GLib.get_monotonic_time(),
      Clutter.KEY_Control_L,
      Clutter.KeyState.PRESSED,
    );
    virtualKeyboard.notify_keyval(
      GLib.get_monotonic_time(),
      Clutter.KEY_v,
      Clutter.KeyState.PRESSED,
    );
    virtualKeyboard.notify_keyval(
      GLib.get_monotonic_time(),
      Clutter.KEY_v,
      Clutter.KeyState.RELEASED,
    );
    virtualKeyboard.notify_keyval(
      GLib.get_monotonic_time(),
      Clutter.KEY_Control_L,
      Clutter.KeyState.RELEASED,
    );
  }
}

export default class Extension extends GnomeExtension {
  enable() {
    this._service = new InputService();
    this._dbusObject = Gio.DBusExportedObject.wrapJSObject(
      DBUS_INTERFACE,
      this._service,
    );
    this._dbusObject.export(Gio.DBus.session, OBJECT_PATH);
    this._nameOwnerId = Gio.DBus.session.own_name(
      BUS_NAME,
      Gio.BusNameOwnerFlags.NONE,
      null,
      null,
    );
  }

  disable() {
    if (this._nameOwnerId) {
      Gio.DBus.session.unown_name(this._nameOwnerId);
      this._nameOwnerId = 0;
    }

    if (this._dbusObject) {
      this._dbusObject.unexport();
      this._dbusObject.run_dispose();
      this._dbusObject = null;
    }

    this._service = null;
  }
}
