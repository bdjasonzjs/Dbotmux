/**
 * Ensure tmux is installed before the daemon starts. Strategy (first one
 * that fits wins):
 *
 *   1. Already installed → done.
 *   2. brew available → `brew install tmux` (no sudo)
 *   3. conda/mamba available → `conda install -y -c conda-forge tmux` (no sudo)
 *   4. Linux + system pkg manager:
 *        a. NOPASSWD sudo or running as root → run non-interactively
 *        b. Has TTY → run interactively (sudo will prompt for password)
 *        c. No TTY (autostart / pm2 fork) → skip and throw with manual command
 *   5. Otherwise → throw with manual command.
 *
 * The caller (cli.ts) treats a thrown error as fatal: tmux is non-negotiable
 * for the /adopt + multi-pane Web terminal experience, and the user explicitly
 * opted into hard-fail-on-missing.
 */
import { execSync, spawnSync } from 'node:child_process';
import { detectPlatform, type PackageManager, type PlatformInfo } from './detect-platform.js';

export interface TmuxResult {
  installed: boolean;
  version?: string;
  /** True iff we ran an installer (vs. tmux was already present). */
  freshInstall: boolean;
  /** Which strategy actually ran the install. */
  strategy?: PackageManager;
}

function probeTmuxVersion(): string | undefined {
  try {
    const out = execSync('tmux -V', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
    return out.trim();
  } catch {
    return undefined;
  }
}

/** Wrap a system command with the appropriate sudo prefix for the current
 *  platform context, or return undefined if we cannot escalate (no
 *  passwordless sudo and no TTY to prompt on). */
function sudoPrefix(cmd: string[], info: PlatformInfo): string[] | undefined {
  if (info.isRoot) return cmd;
  if (info.passwordlessSudo) return ['sudo', '-n', ...cmd];
  if (info.hasTty) return ['sudo', ...cmd];
  return undefined;
}

/** Build the install argv for a given package manager. Pure: returns argv[]
 *  ready for spawnSync, no side effects. Returns undefined if escalation
 *  isn't possible. */
function buildInstallArgv(pm: PackageManager, pkg: string, info: PlatformInfo): string[] | undefined {
  switch (pm) {
    case 'brew':    return ['brew', 'install', pkg];
    case 'conda':   return ['conda', 'install', '-y', '-c', 'conda-forge', pkg];
    case 'apt':     return sudoPrefix(['apt-get', 'install', '-y', pkg], info);
    case 'dnf':     return sudoPrefix(['dnf', 'install', '-y', pkg], info);
    case 'yum':     return sudoPrefix(['yum', 'install', '-y', pkg], info);
    case 'pacman':  return sudoPrefix(['pacman', '-S', '--noconfirm', pkg], info);
    case 'apk':     return sudoPrefix(['apk', 'add', pkg], info);
    case 'zypper':  return sudoPrefix(['zypper', 'install', '-y', pkg], info);
    case 'unknown': return undefined;
  }
}

/** apt-get specifically needs an updated package list on minimal images
 *  before the install will find tmux. This is NOT part of buildInstallArgv
 *  (which is pure) — it runs once just before the apt install attempt.
 *  Failure here is non-fatal; the actual install will fail loudly if it
 *  can't find the package. */
function aptUpdateBeforeInstall(info: PlatformInfo): void {
  const argv = sudoPrefix(['apt-get', 'update'], info);
  if (!argv) return;
  try {
    spawnSync(argv[0]!, argv.slice(1), { stdio: 'inherit', timeout: 120_000 });
  } catch { /* best-effort */ }
}

/** Suggest the manual command we'd have run, for the failure message. */
function suggestManualCommand(pm: PackageManager, pkg: string): string {
  switch (pm) {
    case 'brew': return `brew install ${pkg}`;
    case 'conda': return `conda install -y -c conda-forge ${pkg}`;
    case 'apt': return `sudo apt-get update && sudo apt-get install -y ${pkg}`;
    case 'dnf': return `sudo dnf install -y ${pkg}`;
    case 'yum': return `sudo yum install -y ${pkg}`;
    case 'pacman': return `sudo pacman -S --noconfirm ${pkg}`;
    case 'apk': return `sudo apk add ${pkg}`;
    case 'zypper': return `sudo zypper install -y ${pkg}`;
    default: return `(请手动安装 ${pkg})`;
  }
}

function runInstall(argv: string[]): boolean {
  const result = spawnSync(argv[0]!, argv.slice(1), {
    stdio: 'inherit',
    timeout: 10 * 60_000, // 10 min — apt-get on slow networks
  });
  return result.status === 0;
}

export async function ensureTmux(info?: PlatformInfo): Promise<TmuxResult> {
  const platform = info ?? detectPlatform();

  // Step 1: already installed?
  const existing = probeTmuxVersion();
  if (existing) {
    return { installed: true, version: existing, freshInstall: false };
  }

  console.log('⚠️  tmux 未检测到，正在安装...');

  // Step 2..4: walk the package-manager preference list.
  const tried: string[] = [];
  for (const pm of platform.packageManagers) {
    if (pm === 'unknown') continue;
    const argv = buildInstallArgv(pm, 'tmux', platform);
    if (!argv) {
      tried.push(`${pm}（跳过：当前用户无 sudo 且无 TTY）`);
      continue;
    }
    if (pm === 'apt') aptUpdateBeforeInstall(platform);
    console.log(`   尝试 ${pm}: ${argv.join(' ')}`);
    if (runInstall(argv)) {
      const v = probeTmuxVersion();
      if (v) {
        console.log(`✅ tmux ${v} 安装完成 (via ${pm})`);
        return { installed: true, version: v, freshInstall: true, strategy: pm };
      }
      tried.push(`${pm}（命令成功但 tmux -V 仍失败）`);
    } else {
      tried.push(`${pm}（命令返回非零）`);
    }
  }

  // Build a useful failure message with the most relevant manual command.
  const preferred = platform.packageManagers.find(p => p !== 'unknown') ?? 'unknown';
  const manual = suggestManualCommand(preferred, 'tmux');
  const lines = [
    '❌ 自动安装 tmux 失败',
    '',
    '已尝试：',
    ...tried.map(t => `  - ${t}`),
    '',
    '请手动安装后重试：',
    `  ${manual}`,
  ];
  // macOS without Homebrew → guide the user to install brew first.
  if (platform.os === 'darwin' && !platform.packageManagers.includes('brew')) {
    lines.push('');
    lines.push('macOS 推荐先安装 Homebrew：');
    lines.push('  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"');
    lines.push('安装完成后重试 `botmux start`，会走 brew 自动装 tmux。');
  }
  if (!platform.hasTty && !platform.isRoot && !platform.passwordlessSudo && platform.os === 'linux') {
    lines.push('');
    lines.push('提示：当前不是交互式 TTY 且 sudo 需要密码，systemd/pm2 自启场景下无法弹密码。');
    lines.push('请在 shell 中手动跑一次 `botmux start`，或配置 NOPASSWD sudoers 后再启用 autostart。');
  }
  throw new Error(lines.join('\n'));
}
