use std::process::Command;

pub(crate) fn ydotool_arguments() -> [&'static str; 5] {
    ["key", "29:1", "47:1", "47:0", "29:0"]
}

pub(crate) fn paste_with_ydotool() -> Result<(), String> {
    let output = Command::new("ydotool")
        .args(ydotool_arguments())
        .output()
        .map_err(|error| format!("No se pudo ejecutar ydotool: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err("El teclado virtual local no está disponible. Inicia ydotoold; el texto sigue en el portapapeles.".into())
}

#[cfg(test)]
mod tests {
    use super::ydotool_arguments;

    #[test]
    fn ydotool_command_presses_and_releases_control_v() {
        assert_eq!(ydotool_arguments(), [
            "key", "29:1", "47:1", "47:0", "29:0",
        ]);
    }
}
