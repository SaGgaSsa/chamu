// @vitest-environment node

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile } from 'vite';

const test = process.env.VITEST
  ? (await import('vitest')).test
  : (await import('node:test')).test;

const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
const worktreesPattern = '**/.worktrees/**';

test('excludes worktree copies from Vite watching and Vitest discovery', async () => {
  const loaded = await loadConfigFromFile(
    { command: 'serve', mode: 'test' },
    configFile,
  );

  assert.ok(loaded, 'Vite configuration should load');
  assert.ok(
    loaded.config.server?.watch?.ignored?.includes(worktreesPattern),
    'Vite watcher should ignore worktree copies',
  );
  assert.ok(
    loaded.config.test?.exclude?.includes(worktreesPattern),
    'Vitest should exclude worktree copies',
  );
});
