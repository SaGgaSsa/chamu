# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the React and TypeScript renderer. Reusable UI lives in `src/components/`, Tauri bridge wrappers in `src/native/`, and domain state in `src/domain/`. `src-tauri/src/` contains the Rust application, audio capture, local transcription, persistence, and platform integration. Tauri capabilities and packaging configuration are in `src-tauri/capabilities/` and `src-tauri/tauri.conf.json`. Generated output lives in `dist/`, `src-tauri/target/`, and `src-tauri/gen/`; do not edit generated files.

## Build, Test, and Development Commands
Use `npm run dev` for the renderer and `npm run tauri -- dev` to launch the desktop application. Run `npm test`, `npm run typecheck`, and `npm run build` for frontend validation. Run `cargo test -q` from `src-tauri/` for Rust validation. Use `npm run tauri -- build --bundles deb` only when Linux packaging validation is needed. Build Windows installers in Windows CI.

## Coding Style & Naming Conventions
Use strict TypeScript, ES modules, 2-space indentation, single quotes, and the established React component structure. Use `PascalCase` for components and `camelCase` for functions, hooks, and state. In Rust, use `rustfmt` style and keep platform-specific behavior behind small, testable modules. Keep audio ephemeral: never persist audio input or transcripts outside the explicit SQLite text history.

## Testing Guidelines
Add frontend tests beside the feature as `*.test.ts` or `*.test.tsx`. Add Rust tests in the relevant module. Run the validation commands that cover the changed code before a commit, push, or release. Test native behavior manually when changing microphone capture, shortcuts, clipboard, paste behavior, model download, or tray behavior.

## Plan Implementation and Luna Delegation
When implementing a documented plan or a code change, delegate each independent, bounded implementation task through Codex native agent controls to a user-visible task configured with model `gpt-5.6-luna` and reasoning effort `max`. Create tasks with `spawn_agent`; monitor them with `list_agents` and `wait_agent`; and use `send_message` or `followup_task` for corrections. Do not use a custom-agent TOML/profile or a Superpowers native-subagent skill to route work to Luna.

Before creating a Luna task, confirm that the available native controls support creating, monitoring, receiving the handoff, and messaging tasks with the requested model and reasoning effort. Give each task a complete packet: objective and acceptance criteria, exact file ownership, affected interfaces, constraints, starting branch or worktree state, verification commands, and Git/PR boundaries. Do not delegate a partial prompt or assume the thread inherits this conversation.

Use separate isolated worktrees for Git-backed agent tasks. Tasks with non-overlapping file ownership may run concurrently; shared-file or dependent tasks must run serially after the prior result has been accepted. Monitor each task, read its handoff, and independently inspect its worktree, complete diff, changed-file scope, and verification output before accepting its changes. Keep corrections in the same task. Do not allow a delegated task to push, create, update, or merge a PR without explicit authorization after that review.

## Commit & Release Guidelines
Use concise Conventional Commit subjects such as `feat: add local model validation` or `fix: preserve clipboard fallback`. Release notes are generated from subjects between tags, so public changes should use clear `feat:`, `fix:`, `perf:`, or `refactor:` subjects. Keep private links, credentials, machine paths, and implementation-only details out of public commit subjects.

The release version must remain aligned in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`. Also inspect lockfiles, release workflows, and visible version text before a release.

## Security & Configuration Tips
Do not add credentials, signing keys, local models, audio, SQLite databases, or generated bundles to Git. Keep the Tauri capability allowlist minimal. The production path must not require transcription APIs, accounts, telemetry, or persistent audio.

Usa español técnico simplificado estilo ASD-STE100: instrucciones directas, frases cortas, una acción por frase, términos consistentes y lenguaje literal; evita ambigüedad, redundancia y variaciones innecesarias de vocabulario.
