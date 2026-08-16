use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

pub(crate) const EXTENSION_UUID: &str = "chamu@chamu.app";
pub(crate) const DBUS_NAME: &str = "app.chamu.Input";
pub(crate) const DBUS_PATH: &str = "/app/chamu/Input";
pub(crate) const DBUS_INTERFACE: &str = "app.chamu.Input";
pub(crate) const DBUS_METHOD: &str = "Paste";

const EXTENSION_SOURCE_ENV: &str = "CHAMU_GNOME_EXTENSION_SOURCE";
const EXTENSION_RESOURCE_DIR_ENV: &str = "CHAMU_GNOME_RESOURCE_DIR";

static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Provide the resource directory resolved by Tauri for the running bundle.
///
/// The public installation interface intentionally has no application handle. Tauri calls
/// this once during setup so the same interface works for development and packaged builds.
pub(crate) fn configure_resource_dir(path: PathBuf) {
    let _ = RESOURCE_DIR.set(path);
}

/// Install the bundled GNOME Shell extension in the user's extension directory.
///
/// The copy is staged in a sibling temporary directory and switched into place only after all
/// files were copied. A failed copy therefore leaves a previous installation usable.
pub fn install_extension() -> Result<(), String> {
    let source = extension_source_dir()?;
    let extensions_dir = user_extensions_dir()?;
    fs::create_dir_all(&extensions_dir)
        .map_err(|error| io_error("crear el directorio de extensiones", &extensions_dir, error))?;

    let destination = extensions_dir.join(EXTENSION_UUID);
    let temporary = extensions_dir.join(format!(
        ".{EXTENSION_UUID}.install-{}",
        std::process::id()
    ));
    let backup = extensions_dir.join(format!(
        ".{EXTENSION_UUID}.previous-{}",
        std::process::id()
    ));

    remove_path_if_present(&temporary)?;
    remove_path_if_present(&backup)?;
    copy_directory(&source, &temporary)?;

    if destination.exists() {
        fs::rename(&destination, &backup).map_err(|error| {
            io_error(
                "preparar la actualización de la extensión",
                &destination,
                error,
            )
        })?;
    }

    if let Err(error) = fs::rename(&temporary, &destination) {
        if backup.exists() {
            let _ = fs::rename(&backup, &destination);
        }
        let _ = remove_path_if_present(&temporary);
        return Err(io_error(
            "activar los archivos de la extensión",
            &destination,
            error,
        ));
    }

    remove_path_if_present(&backup)?;
    Ok(())
}

/// Enable the installed extension through GNOME Shell's supported command-line interface.
pub fn enable_extension() -> Result<(), String> {
    let output = Command::new("gnome-extensions")
        .args(["enable", EXTENSION_UUID])
        .output()
        .map_err(|error| format!("No se pudo ejecutar gnome-extensions: {error}"))?;
    if output.status.success() {
        return Ok(());
    }

    let details = command_output_details(&output.stderr, &output.stdout);
    if details.is_empty() {
        Err(format!(
            "No se pudo habilitar la extensión GNOME {EXTENSION_UUID} (código {})",
            output
                .status
                .code()
                .map_or_else(|| "desconocido".into(), |code| code.to_string())
        ))
    } else {
        Err(format!(
            "No se pudo habilitar la extensión GNOME {EXTENSION_UUID}: {details}"
        ))
    }
}

/// Ask the GNOME Shell extension to synthesize Ctrl+V in the focused application.
pub async fn paste() -> Result<(), String> {
    let connection = ashpd::zbus::Connection::session()
        .await
        .map_err(|error| format!("No se pudo conectar al bus D-Bus de sesión: {error}"))?;
    connection
        .call_method(
            Some(DBUS_NAME),
            DBUS_PATH,
            Some(DBUS_INTERFACE),
            DBUS_METHOD,
            &(),
        )
        .await
        .map_err(|error| format!("No se pudo invocar la extensión GNOME: {error}"))?;
    Ok(())
}

fn extension_source_dir() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();

    if let Some(path) = env::var_os(EXTENSION_SOURCE_ENV).filter(|value| !value.is_empty()) {
        candidates.push(PathBuf::from(path));
    }
    if let Some(path) = RESOURCE_DIR.get() {
        candidates.push(path.join(EXTENSION_UUID));
    }
    if let Some(path) = env::var_os(EXTENSION_RESOURCE_DIR_ENV).filter(|value| !value.is_empty()) {
        candidates.push(PathBuf::from(path).join(EXTENSION_UUID));
    }

    if let Ok(executable) = env::current_exe() {
        for ancestor in executable.ancestors().take(6) {
            candidates.push(ancestor.join("resources").join(EXTENSION_UUID));
            candidates.push(ancestor.join(EXTENSION_UUID));
        }
    }

    if let Ok(current_dir) = env::current_dir() {
        candidates.push(current_dir.join("resources").join(EXTENSION_UUID));
        candidates.push(current_dir.join("src-tauri/resources").join(EXTENSION_UUID));
    }

    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(EXTENSION_UUID),
    );

    candidates
        .into_iter()
        .find(|candidate| candidate.is_dir())
        .ok_or_else(|| {
            format!(
                "No se encontró el recurso de la extensión GNOME {EXTENSION_UUID}"
            )
        })
}

fn user_extensions_dir() -> Result<PathBuf, String> {
    let data_home = env::var_os("XDG_DATA_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("HOME")
                .filter(|value| !value.is_empty())
                .map(|home| PathBuf::from(home).join(".local/share"))
        })
        .ok_or_else(|| {
            "No se pudo determinar el directorio de datos del usuario para GNOME".to_string()
        })?;
    if !data_home.is_absolute() {
        return Err(format!(
            "El directorio de datos XDG no es absoluto: {}",
            data_home.display()
        ));
    }
    Ok(data_home.join("gnome-shell/extensions"))
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| io_error("leer el recurso de la extensión GNOME", source, error))?;
    if !metadata.is_dir() {
        return Err(format!(
            "El recurso de la extensión GNOME no es un directorio: {}",
            source.display()
        ));
    }
    fs::create_dir_all(destination)
        .map_err(|error| io_error("crear el directorio temporal de la extensión", destination, error))?;

    let entries = fs::read_dir(source)
        .map_err(|error| io_error("leer el recurso de la extensión GNOME", source, error))?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            io_error("leer una entrada del recurso de la extensión GNOME", source, error)
        })?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry.file_type().map_err(|error| {
            io_error(
                "inspeccionar una entrada del recurso de la extensión GNOME",
                &source_path,
                error,
            )
        })?;
        if file_type.is_dir() {
            copy_directory(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &destination_path).map_err(|error| {
                io_error(
                    "copiar un archivo de la extensión GNOME",
                    &source_path,
                    error,
                )
            })?;
        } else {
            return Err(format!(
                "El recurso de la extensión GNOME contiene una entrada no compatible: {}",
                source_path.display()
            ));
        }
    }
    Ok(())
}

fn remove_path_if_present(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_error("inspeccionar una ruta de la extensión", path, error)),
    };
    let result = if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    result.map_err(|error| io_error("limpiar una ruta de la extensión", path, error))
}

fn io_error(action: &str, path: &Path, error: io::Error) -> String {
    format!("No se pudo {action} {}: {error}", path.display())
}

fn command_output_details(stderr: &[u8], stdout: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }
    String::from_utf8_lossy(stdout).trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::{copy_directory, DBUS_METHOD, DBUS_NAME, DBUS_PATH};
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn gnome_extension_contract_uses_only_paste() {
        assert_eq!(DBUS_NAME, "app.chamu.Input");
        assert_eq!(DBUS_PATH, "/app/chamu/Input");
        assert_eq!(DBUS_METHOD, "Paste");
    }

    #[test]
    fn extension_copy_preserves_nested_resource_files() {
        let root = test_root("copy");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::create_dir_all(source.join("nested")).expect("create source");
        fs::write(source.join("metadata.json"), b"metadata").expect("write metadata");
        fs::write(source.join("nested/extension.js"), b"extension").expect("write extension");

        copy_directory(&source, &destination).expect("copy extension");

        assert_eq!(
            fs::read(destination.join("metadata.json")).expect("read metadata"),
            b"metadata"
        );
        assert_eq!(
            fs::read(destination.join("nested/extension.js")).expect("read extension"),
            b"extension"
        );
        remove_test_root(&root);
    }

    fn test_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "chamu-gnome-paste-{name}-{}",
            std::process::id()
        ))
    }

    fn remove_test_root(root: &PathBuf) {
        let _ = fs::remove_dir_all(root);
    }
}
