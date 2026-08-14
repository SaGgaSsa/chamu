use ashpd::desktop::{
    remote_desktop::{
        DeviceType, KeyState, NotifyKeyboardKeycodeOptions, RemoteDesktop, SelectDevicesOptions,
    },
    Session,
};
use ashpd::enumflags2::BitFlags;

use crate::wayland_shortcut::registered_portal_connection;

const KEY_LEFTCTRL: i32 = 29;
const KEY_V: i32 = 47;

pub(crate) struct WaylandPasteSession {
    portal: RemoteDesktop,
    session: Session<RemoteDesktop>,
}

pub(crate) fn paste_key_sequence() -> [(i32, bool); 4] {
    [
        (KEY_LEFTCTRL, true),
        (KEY_V, true),
        (KEY_V, false),
        (KEY_LEFTCTRL, false),
    ]
}

impl WaylandPasteSession {
    pub(crate) async fn connect() -> Result<Self, String> {
        let connection = registered_portal_connection().await?;
        let portal = RemoteDesktop::with_connection(connection)
            .await
            .map_err(|error| format!("No se encontró el portal de escritorio remoto: {error}"))?;
        let session = portal
            .create_session(Default::default())
            .await
            .map_err(|error| format!("No se pudo crear la sesión de pegado Wayland: {error}"))?;
        portal
            .select_devices(
                &session,
                SelectDevicesOptions::default()
                    .set_devices(BitFlags::from_flag(DeviceType::Keyboard)),
            )
            .await
            .map_err(|error| format!("No se pudo solicitar el teclado Wayland: {error}"))?;
        let selected = portal
            .start(&session, None, Default::default())
            .await
            .map_err(|error| format!("No se pudo iniciar el permiso de pegado Wayland: {error}"))?
            .response()
            .map_err(|error| format!("El portal no autorizó el pegado Wayland: {error}"))?;
        if !selected.devices().contains(DeviceType::Keyboard) {
            return Err("El portal no autorizó el control de teclado para pegar".into());
        }
        Ok(Self { portal, session })
    }

    pub(crate) async fn paste(&self) -> Result<(), String> {
        for (keycode, pressed) in paste_key_sequence() {
            let state = if pressed { KeyState::Pressed } else { KeyState::Released };
            self.portal
                .notify_keyboard_keycode(
                    &self.session,
                    keycode,
                    state,
                    NotifyKeyboardKeycodeOptions::default(),
                )
                .await
                .map_err(|error| format!("No se pudo enviar Ctrl+V al portal Wayland: {error}"))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{paste_key_sequence, KEY_LEFTCTRL, KEY_V};

    #[test]
    fn paste_shortcut_releases_v_before_control() {
        assert_eq!(paste_key_sequence(), [
            (KEY_LEFTCTRL, true),
            (KEY_V, true),
            (KEY_V, false),
            (KEY_LEFTCTRL, false),
        ]);
    }
}
