// Git URL and credential helpers any code host can use.

/** Hostname of a git URL: "git@github.com:o/r.git" and "https://github.com/o/r" -> "github.com". */
export function gitHostname(url: string): string | undefined {
  const scp = url.match(/^[^@/:]+@([^:/]+):/);
  if (scp) return scp[1]!.toLowerCase();
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** Repo path of a git URL, without ".git": "git@gitlab.com:group/sub/repo.git" -> "group/sub/repo". */
export function gitPath(url: string): string {
  const scp = url.match(/^[^@/:]+@[^:/]+:(.+)$/);
  let path = scp ? scp[1]! : "";
  if (!scp) {
    try {
      path = new URL(url).pathname;
    } catch {
      throw new Error(`not a git URL: ${url}`);
    }
  }
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!path.includes("/")) throw new Error(`no owner/repo path in git URL: ${url}`);
  return path;
}

/**
 * Environment that makes the factory's own git commands reach `https://<hostname>/`
 * with HTTP Basic credentials, and rewrites `git@<hostname>:` SSH URLs to HTTPS so
 * the container needs no SSH keys. Uses GIT_CONFIG_COUNT (git >= 2.31), so nothing
 * is written to any git config file, and the agent user never sees it.
 */
export function basicAuthGitEnv(hostname: string, username: string, token: string): Record<string, string> {
  const base = `https://${hostname}/`;
  const pairs: [string, string][] = [
    [`url.${base}.insteadOf`, `git@${hostname}:`],
    [`http.${base}.extraHeader`, `Authorization: Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`],
  ];
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length), GIT_TERMINAL_PROMPT: "0" };
  pairs.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}
