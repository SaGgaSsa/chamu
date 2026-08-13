import { copyFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopEntryFileName = 'com.chamu.desktop.desktop';

export async function installDesktopEntry({ sourcePath, applicationsDir }) {
  await mkdir(applicationsDir, { recursive: true });

  const target = join(applicationsDir, desktopEntryFileName);
  await copyFile(sourcePath, target);

  return target;
}

function applicationsDirFromEnvironment(environment = process.env) {
  const dataHome =
    environment.XDG_DATA_HOME ||
    join(environment.HOME || homedir(), '.local', 'share');

  return join(dataHome, 'applications');
}

async function main() {
  const sourcePath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'src-tauri',
    'resources',
    desktopEntryFileName,
  );

  const target = await installDesktopEntry({
    sourcePath,
    applicationsDir: applicationsDirFromEnvironment(),
  });

  console.log(`Installed ${target}`);
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && modulePath === resolve(process.argv[1])) {
  await main();
}
