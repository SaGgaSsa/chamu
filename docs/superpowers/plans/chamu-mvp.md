# Chamu MVP implementation plan

## Constraints

- Tauri 2 desktop application using React/TypeScript and Rust.
- Spanish-first UI, local-only operation, no accounts, telemetry, or transcription APIs.
- Windows x64 and Linux x86_64 are the initial targets; Wayland support is diagnosable and assisted.
- Audio is never persisted. History retains only text and timestamp in SQLite.

## Task 1: Project foundation

Create the buildable Tauri 2 workspace, application configuration, core domain types, Spanish shell UI, tray state model, and tests for recording state/config behavior.

## Task 2: Native privacy core

Implement Rust commands/services for persisted settings and SQLite text history, local model discovery/checksum validation, safe in-memory recording lifecycle abstraction, platform/dependency diagnosis, and local diagnostic records that exclude audio and dictated text. Add focused Rust tests.

## Task 3: Onboarding and desktop flow

Implement the Spanish onboarding wizard and main screen: privacy explanation, language and model selection/download cancellation UI, microphone/shortcut/clipboard-paste checks, hold/toggle mode selection, status bubble, and persistent history copy/delete interactions through the native command bridge. Add frontend tests.

## Task 4: Packaging and release assets

Add MIT license, privacy-oriented README, release/update configuration, GitHub Actions for Windows NSIS and Linux AppImage/.deb artifacts, and a manual platform release test matrix. Ensure workflow builds do not add network transcription services.

## Task 5: Verification and integration hardening

Run the relevant frontend and Rust checks, inspect all public entry points for local-only guarantees, and correct integration issues. Document test limitations that require physical microphone/compositor access.
