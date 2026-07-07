import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { logger } from '../utils/logger.js';

const DEFAULT_NO_PROXY = [
  'localhost',
  '127.0.0.1',
  '::1',
  '*.feishu.cn',
  '*.larksuite.com',
  'open.feishu.cn',
  'code.byted.org',
  'bits.bytedance.net',
  'luban-source',
  '*.byted.org',
  '*.bytedance.net',
].join(',');

const DEFAULT_EGRESS_ALLOW_HOSTS = [
  'feishu.cn',
  'larksuite.com',
  'open.feishu.cn',
  'code.byted.org',
  'bits.bytedance.net',
  'luban-source',
  'byted.org',
  'bytedance.net',
].join(',');

const GUARDED_BINS = ['bash', 'sh', 'zsh', 'curl', 'wget', 'python', 'python3', 'node'] as const;

export function commandGuardDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.BOTMUX_COMMAND_GUARD_DIR?.trim() || join(homedir(), '.botmux', 'security-bin');
}

export function commandGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BOTMUX_COMMAND_GUARD !== '0';
}

export function resolveEgressProxyEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const proxy = env.BOTMUX_EGRESS_PROXY?.trim();
  const noProxy = env.BOTMUX_EGRESS_NO_PROXY?.trim() || DEFAULT_NO_PROXY;
  const allowHosts = env.BOTMUX_EGRESS_ALLOW_HOSTS?.trim() || DEFAULT_EGRESS_ALLOW_HOSTS;
  if (!proxy) {
    return {
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      FTP_PROXY: '',
      http_proxy: '',
      https_proxy: '',
      all_proxy: '',
      ftp_proxy: '',
      NO_PROXY: noProxy,
      no_proxy: noProxy,
      BOTMUX_EGRESS_POLICY: 'direct-no-inherited-proxy',
      BOTMUX_EGRESS_ALLOW_HOSTS: allowHosts,
    };
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
    out.BOTMUX_PATH_PREFIX = commandGuardDir(env);
    out.BOTMUX_COMMAND_GUARD = '1';
  }
  return out;
}

function findRealBinary(bin: string, guardDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const path = (env.PATH ?? '').split(delimiter).filter(p => p && p !== guardDir).join(delimiter);
  try {
    const out = execFileSync('bash', ['-lc', `command -v ${bin}`], {
      encoding: 'utf-8',
      env: { ...env, PATH: path },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    return out && out !== join(guardDir, bin) ? out : null;
  } catch {
    return null;
  }
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
  allow_hosts="\${BOTMUX_EGRESS_ALLOW_HOSTS:-${DEFAULT_EGRESS_ALLOW_HOSTS}}"
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

export function ensureCommandGuardShims(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!commandGuardEnabled(env)) return null;
  const dir = commandGuardDir(env);
  try {
    mkdirSync(dir, { recursive: true });
    for (const bin of GUARDED_BINS) {
      const real = findRealBinary(bin, dir, env);
      if (!real) continue;
      const fp = join(dir, bin);
      const content = shimContent(bin, real);
      if (!existsSync(fp)) {
        writeFileSync(fp, content, { mode: 0o755 });
      } else {
        writeFileSync(fp, content, 'utf-8');
        chmodSync(fp, 0o755);
      }
    }
    return dir;
  } catch (err) {
    logger.warn(`[worker-security] failed to prepare command guard shims: ${err}`);
    return null;
  }
}
