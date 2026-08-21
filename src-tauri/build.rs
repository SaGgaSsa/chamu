fn main() {
    tauri_build::build();
    #[cfg(target_os = "linux")]
    {
        println!("cargo:rerun-if-changed=src/silence_alsa.c");
        cc::Build::new()
            .file("src/silence_alsa.c")
            .compile("chamu_alsa_silence");
    }
}