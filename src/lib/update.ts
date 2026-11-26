const LATEST = 'https://api.github.com/repos/Gingerbreadfork/bedsheet/releases/latest';
const TIMEOUT_MS = 15_000;

export interface Release {
  version: string;
  /** The git tag, which names the release's page. */
  tag: string;
}

function parts(version: string): number[] {
  return version
    .replace(/^v/, '')
    .split(/[-+]/)[0]
    .split('.')
    .map((n) => Number(n) || 0);
}

/** Compares versions number by number. A pre-release counts as the version it leads up to. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/** True for a release as this module stores it. */
export function isRelease(value: unknown): value is Release {
  const r = value as Release | null;
  return typeof r?.version === 'string' && typeof r.tag === 'string';
}

/** Asks GitHub for the newest release. The request says nothing about the user or their files. */
export async function latestRelease(): Promise<Release> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(LATEST, { headers: { Accept: 'application/vnd.github+json' }, signal: abort.signal });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const body = (await res.json()) as { tag_name?: unknown };
    if (typeof body.tag_name !== 'string' || !body.tag_name) throw new Error('GitHub listed no release');
    return { version: body.tag_name.replace(/^v/, ''), tag: body.tag_name };
  } catch (e) {
    if (abort.signal.aborted) throw new Error('GitHub took too long to answer');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
