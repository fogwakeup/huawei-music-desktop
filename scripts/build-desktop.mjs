// Explicit local builds only. No publishing and no fabricated maintainer/signing identity.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { build, Platform, Arch } from 'electron-builder';

const target = process.argv[2] ?? ({ win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform]);
const architecture = process.argv[3] ?? (target === 'mac' ? process.arch : 'x64');
const format = process.argv[4];
if (!['win', 'mac', 'linux'].includes(target) || !['x64', 'arm64'].includes(architecture) || format !== undefined) {
  throw new Error('Usage: npm run dist -- <win|linux|mac> <x64|arm64>');
}
const nativePlatform = { win: 'win32', mac: 'darwin', linux: 'linux' }[target];
// Windows installers are only produced on a real Windows host: the NSIS toolchain needs its own
// resource editor and we do not ship an unsigned single-file portable fallback any more.
if (process.platform !== nativePlatform) throw new Error(`Build ${target} on its native OS (${nativePlatform}).`);
if (target !== 'mac' && architecture !== 'x64') throw new Error('The first release only targets Windows/Linux x64.');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['run', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (result.status !== 0) process.exit(result.status ?? 1);
// Optional suffix lets a rebuild land in a fresh directory instead of forcing a delete of a
// previous output (useful when the workspace path contains non-ASCII characters).
const outputSuffix = process.env.DESKTOP_BUILD_OUTPUT_SUFFIX
  ? `-${process.env.DESKTOP_BUILD_OUTPUT_SUFFIX.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 24)}`
  : '';
const config = { directories: { output: `release/${target}-${architecture}${outputSuffix}` } };
// Optional local Electron distribution: skips the builder's redundant download, which is
// fragile behind proxies. The directory must contain electron.exe and a version file.
if (process.env.DESKTOP_ELECTRON_DIST) config.electronDist = resolve(process.env.DESKTOP_ELECTRON_DIST);
const names = target === 'win' ? ['nsis'] : target === 'mac' ? ['dmg'] : ['AppImage'];
if (target === 'win') {
  config.win = { signExecutable: false, forceCodeSigning: false, requestedExecutionLevel: 'asInvoker' };
}
if (target === 'linux') {
  const homepage = process.env.DESKTOP_BUILD_HOMEPAGE;
  const maintainer = process.env.DESKTOP_BUILD_MAINTAINER;
  if (homepage && maintainer) {
    if (!/^https:\/\//.test(homepage) || !/^[^<>]+ <[^<>@\s]+@[^<>@\s]+>$/.test(maintainer)) {
      throw new Error('Supply a real HTTPS DESKTOP_BUILD_HOMEPAGE and DESKTOP_BUILD_MAINTAINER="Name <email>".');
    }
    config.extraMetadata = { homepage };
    config.linux = { maintainer };
    names.push('deb');
  } else console.log('DEB not built: real homepage and maintainer identity are required; AppImage is still built.');
}
const platform = target === 'win' ? Platform.WINDOWS : target === 'mac' ? Platform.MAC : Platform.LINUX;
await build({ targets: platform.createTarget(names, architecture === 'arm64' ? Arch.arm64 : Arch.x64), config, publish: 'never' });
console.log(`${target}/${architecture} INTERNAL build complete. Signing, installation and account/media acceptance must be recorded separately.`);
