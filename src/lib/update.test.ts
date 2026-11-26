import { describe, it, expect, afterEach, vi } from 'vitest';
import { isNewer, isRelease, latestRelease } from './update';

afterEach(() => {
  vi.unstubAllGlobals();
});

function answer(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

describe('isNewer', () => {
  it('compares versions by number, not as text', () => {
    expect(isNewer('0.2.0', '0.1.3')).toBe(true);
    expect(isNewer('v0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('0.1.3', '0.1.3')).toBe(false);
    expect(isNewer('0.1.2', '0.1.3')).toBe(false);
    expect(isNewer('1.0', '0.9.9')).toBe(true);
  });

  it('ignores pre-release and build labels', () => {
    expect(isNewer('0.2.0-beta.1', '0.2.0')).toBe(false);
    expect(isNewer('0.2.1+build.7', '0.2.0')).toBe(true);
  });
});

describe('isRelease', () => {
  it('accepts only a version with its tag', () => {
    expect(isRelease({ version: '0.5.0', tag: 'v0.5.0' })).toBe(true);
    expect(isRelease({ version: '0.5.0' })).toBe(false);
    expect(isRelease(null)).toBe(false);
    expect(isRelease('0.5.0')).toBe(false);
  });
});

describe('latestRelease', () => {
  it('reads the version from the tag', async () => {
    answer(200, { tag_name: 'v0.5.0', html_url: 'https://example.com/elsewhere' });
    expect(await latestRelease()).toEqual({ version: '0.5.0', tag: 'v0.5.0' });
  });

  it('fails when GitHub refuses or lists nothing', async () => {
    answer(403, { message: 'rate limited' });
    await expect(latestRelease()).rejects.toThrow('GitHub answered 403');
    answer(200, {});
    await expect(latestRelease()).rejects.toThrow('no release');
  });
});
