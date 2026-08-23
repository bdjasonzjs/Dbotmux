import {
  accessSync,
  chmodSync,
  constants,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { logger } from '../utils/logger.js';

const PUBLIC_DEFAULT_NO_PROXY = [
  'localhost',
  '127.0.0.1',
  '::1',
  '*.feishu.cn',
  '*.larksuite.com',
  'open.feishu.cn',
].join(',');

const PUBLIC_DEFAULT_EGRESS_ALLOW_HOSTS = [
  'feishu.cn',
  'larksuite.com',
  'open.feishu.cn',
].join(',');

const GUARDED_BINS = ['bash', 'sh', 'zsh', 'curl', 'wget', 'python', 'python3', 'node'] as const;

export function commandGuardDir(env: NodeJS.ProcessEnv = process.env): string {
  // A relative override is interpreted once, at the daemon boundary. Workers
  // and terminal backends run from session-specific cwd values, so carrying a
  // relative prefix into their PATH would make the guard point somewhere else
  // and silently fall through to the real command.
  return resolve(env.BOTMUX_COMMAND_GUARD_DIR?.trim() || join(homedir(), '.botmux', 'security-bin'));
}

export function commandGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BOTMUX_COMMAND_GUARD !== '0';
}

function configuredNoProxy(env: NodeJS.ProcessEnv): string {
  return env.BOTMUX_EGRESS_NO_PROXY?.trim()
    || env.NO_PROXY?.trim()
    || env.no_proxy?.trim()
    || PUBLIC_DEFAULT_NO_PROXY;
}

/**
 * Keep deployment-specific hostnames runtime-only. Existing installations
 * already carry their direct-connect inventory in NO_PROXY; deriving the guard
 * allowlist from that value preserves those routes without committing private
 * infrastructure names to the public tree. BOTMUX_EGRESS_ALLOW_HOSTS remains
 * the explicit override when the two inventories intentionally differ.
 */
function configuredEgressAllowHosts(env: NodeJS.ProcessEnv): string {
  const explicit = env.BOTMUX_EGRESS_ALLOW_HOSTS?.trim();
  if (explicit) return explicit;
  const derived = configuredNoProxy(env)
    .split(',')
    .map(value => value.trim().replace(/^\*?\./, ''))
    .filter(Boolean)
    .join(',');
  return derived || PUBLIC_DEFAULT_EGRESS_ALLOW_HOSTS;
}

export function resolveEgressProxyEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const proxy = env.BOTMUX_EGRESS_PROXY?.trim();
  const noProxy = configuredNoProxy(env);
  const allowHosts = configuredEgressAllowHosts(env);
  if (!proxy) {
    // 默认（未显式配置受限代理）：**保留 worker 继承的代理 env**（本机通常是 http://127.0.0.1:7890），
    // 不覆盖、不清空。硬约束：所有 bot（尤其 claude→Anthropic / codex→OpenAI）必须走该代理，否则本机
    // IP 不稳会被模型厂商封号；且 chatgpt.com 等只能经代理可达。出口管控应在**代理层白名单**做（放行
    // 内网+模型、拉黑攻击 IP），**绝不在此清代理**——清代理会断 bot 模型 + 招封号（曾致生产回归事故）。
    // 只有显式设置 BOTMUX_EGRESS_PROXY 指向受限代理时（下方分支）才改写 worker 的 proxy 路由。
    return {};
  }
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    FTP_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    all_proxy: proxy,
    ftp_proxy: proxy,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    BOTMUX_EGRESS_POLICY: env.BOTMUX_EGRESS_POLICY?.trim() || 'restricted-proxy',
    BOTMUX_EGRESS_ALLOW_HOSTS: allowHosts,
  };
}

export function resolveWorkerSecurityEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {
    ...resolveEgressProxyEnv(env),
  };
  if (commandGuardEnabled(env)) {
    // The command guard needs the same runtime-only deployment inventory even
    // when no restricted proxy is configured and inherited proxy vars are left
    // untouched by resolveEgressProxyEnv().
    out.BOTMUX_EGRESS_ALLOW_HOSTS = configuredEgressAllowHosts(env);
    out.BOTMUX_PATH_PREFIX = commandGuardDir(env);
    out.BOTMUX_COMMAND_GUARD = '1';
  }
  return out;
}

function findRealBinary(bin: string, guardDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const normalizedGuardDir = resolve(guardDir);
  for (const pathEntry of (env.PATH ?? '').split(delimiter)) {
    // POSIX treats an empty PATH component as the current directory. Resolve it
    // explicitly so a command reachable through `:/bin` cannot bypass the shim.
    // Resolve every PATH entry against the daemon lookup cwd before probing.
    // The absolute candidate is embedded into REAL_BIN, so changing to a
    // worker/session cwd cannot rebind it to another executable.
    const searchDir = resolve(pathEntry || process.cwd());
    if (searchDir === normalizedGuardDir) continue;
    const candidate = join(searchDir, bin);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Missing/non-executable candidates are not guard materialization failures:
      // there is no command at this PATH position for the shim to intercept.
    }
  }
  return null;
}

function shimContent(bin: string, realBin: string): string {
return `#!/bin/sh
REAL_BIN='${realBin.replace(/'/g, `'\\''`)}'
BIN_NAME='${bin}'
if [ "\${BOTMUX_COMMAND_GUARD:-1}" = "0" ]; then
  exec "$REAL_BIN" "$@"
fi
if [ "$BIN_NAME" = "curl" ] || [ "$BIN_NAME" = "wget" ]; then
  url=''
  skip_next=0
  for arg in "$@"; do
    if [ "$skip_next" = "1" ]; then
      skip_next=0
      continue
    fi
    case "$arg" in
      --help|--version|-h|-V) exec "$REAL_BIN" "$@" ;;
      -O)
        if [ "$BIN_NAME" = "wget" ]; then skip_next=1; fi
        continue
        ;;
      -o|--output|--output-document|--header|-H|--user-agent|-A|--referer|-e|--data|--data-*|--request|-X|--max-time|-m|-T|--timeout|-t|--tries)
        skip_next=1
        continue
        ;;
      --*=*) continue ;;
      -*) continue ;;
      *) url="$arg"; break ;;
    esac
  done
  if [ -z "$url" ]; then
    echo "botmux command guard: blocked network fetch without a parseable target host" >&2
    exit 126
  fi
  host="$url"
  case "$host" in
    *://*) host="\${host#*://}" ;;
  esac
  host="\${host%%/*}"
  host="\${host%%\\?*}"
  host="\${host%%#*}"
  host="\${host##*@}"
  case "$host" in
    \\[*\\]*) host="\${host#\\[}"; host="\${host%\\]*}" ;;
    *:*) host="\${host%%:*}" ;;
  esac
  if [ -z "$host" ] || [ "$host" = "$url" ] && [ "$host" = "-" ]; then
    echo "botmux command guard: blocked network fetch without a parseable target host" >&2
    exit 126
  fi
  allowed=0
  allow_hosts="\${BOTMUX_EGRESS_ALLOW_HOSTS:-${PUBLIC_DEFAULT_EGRESS_ALLOW_HOSTS}}"
  old_ifs="$IFS"
  IFS=,
  for suffix in $allow_hosts; do
    suffix="$(printf '%s' "$suffix" | sed 's/^ *//;s/ *$//;s/^\\.//')"
    [ -z "$suffix" ] && continue
    if [ "$host" = "$suffix" ]; then allowed=1; break; fi
    case "$host" in *."$suffix") allowed=1; break ;; esac
  done
  IFS="$old_ifs"
  if [ "$allowed" != "1" ]; then
    echo "botmux command guard: blocked network fetch to non-allowlisted host: $host" >&2
    exit 126
  fi
fi
case "$1" in
  -c)
    shift
    code="$1"
    case "$code" in
      *urllib.request*urlopen*exec*|*exec*urllib.request*urlopen*|*requests.get*exec*|*exec*requests.get*|*fetch\\(*eval*|*eval*fetch\\(*|*http://*exec*|*https://*exec*|*exec*http://*|*exec*https://*|*base64*decode*exec*|*exec*base64*decode*|*base64*-d*sh*|*base64*-d*bash*)
        echo "botmux command guard: blocked inline remote execution pattern" >&2
        exit 126
        ;;
    esac
    exec "$REAL_BIN" -c "$@"
    ;;
esac
case " $* " in
  *"45.32.11.7"*|*"exec("*"urlopen("*|*"eval("*"http://"*|*"eval("*"https://"*)
    echo "botmux command guard: blocked suspicious network execution pattern" >&2
    exit 126
    ;;
esac
exec "$REAL_BIN" "$@"
`;
}

function unavailableShimContent(bin: string): string {
  return `#!/bin/sh
echo "botmux command guard: ${bin} is unavailable in the daemon worker PATH" >&2
exit 127
`;
}

export function ensureCommandGuardShims(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!commandGuardEnabled(env)) return null;
  const dir = commandGuardDir(env);
  try {
    // The generated shims are POSIX /bin/sh programs. Native Windows must never
    // silently advertise BOTMUX_COMMAND_GUARD=1 while executing past them.
    if (process.platform === 'win32') {
      throw new Error('native Windows command-guard shims are not supported');
    }
    mkdirSync(dir, { recursive: true });
    const stagingDir = mkdtempSync(join(dir, '.staging-'));
    try {
      // Stage every declared interception target first. A command that is not
      // currently reachable still gets an explicit blocking shim, so a later
      // interactive-shell PATH expansion cannot bypass the launch-time guard.
      for (const bin of GUARDED_BINS) {
        const real = findRealBinary(bin, dir, env);
        const staged = join(stagingDir, bin);
        writeFileSync(staged, real ? shimContent(bin, real) : unavailableShimContent(bin), {
          mode: 0o755,
        });
        chmodSync(staged, 0o755);
        accessSync(staged, constants.X_OK);
      }

      // rename(2) prevents an interrupted write from truncating an existing
      // live shim. If any publication fails, the caller throws and no worker is
      // forked; files already published in this loop are individually complete.
      for (const bin of GUARDED_BINS) {
        renameSync(join(stagingDir, bin), join(dir, bin));
      }
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
    for (const bin of GUARDED_BINS) {
      const shim = join(dir, bin);
      if (!statSync(shim).isFile()) {
        throw new Error(`guard target is not a file after materialization: ${bin}`);
      }
      accessSync(shim, constants.X_OK);
    }
    return dir;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const failure = new Error(
      `command guard is enabled but its shims could not be fully materialized; refusing worker start: ${reason}`,
      { cause: err },
    );
    logger.error(`[worker-security] ${failure.message}`);
    throw failure;
  }
}
