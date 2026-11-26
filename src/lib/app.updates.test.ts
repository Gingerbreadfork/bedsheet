// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { app } from './app.svelte';
import { fetchUpdate, inFlatpak, openProjectPage, otherWindows, recovery } from './platform';
import { latestRelease } from './update';

/** Which build the app takes itself for. Tests switch it before starting a window. */
const host = vi.hoisted(() => ({ desktop: false, windows: false }));

vi.mock('./platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./platform')>();
  return {
    ...actual,
    get isTauri() {
      return host.desktop;
    },
    get canSelfUpdate() {
      return host.windows;
    },
    inFlatpak: vi.fn(async () => false),
    openProjectPage: vi.fn(async () => {}),
    otherWindows: vi.fn(async () => 0),
    fetchUpdate: vi.fn(),
  };
});

vi.mock('./update', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./update')>()),
  latestRelease: vi.fn(),
}));

const HOUR = 60 * 60 * 1000;
const NEWER = { version: '99.0.0', tag: 'v99.0.0' };
const CURRENT = { version: __APP_VERSION__, tag: `v${__APP_VERSION__}` };

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const texts = (): string[] => app.toasts.map((t) => t.text);
const checks = (): number => vi.mocked(latestRelease).mock.calls.length;

let clock = Date.parse('2026-01-01T00:00:00Z');

function later(ms: number): void {
  clock += ms;
  vi.setSystemTime(clock);
}

/** Starts the app the way a newly opened window does. */
async function openWindow(): Promise<void> {
  app.toasts.length = 0;
  app.newRelease = null;
  app.updatable = false;
  await app.init();
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  later(30 * 24 * HOUR);
  vi.spyOn(globalThis, 'setInterval').mockReturnValue(0 as unknown as ReturnType<typeof setInterval>);
  localStorage.clear();
  host.desktop = true;
  host.windows = false;
  app.doc.close();
  app.toasts.length = 0;
  app.newRelease = null;
  app.autoUpdates = true;
  app.updatable = true;
  vi.mocked(latestRelease).mockResolvedValue(NEWER);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('checking for updates on its own', () => {
  it('announces a newer release once, and goes on offering it in later windows', async () => {
    await openWindow();
    expect(texts()).toEqual(['Bedsheet 99.0.0 is out']);
    expect(app.toasts[0].action?.label).toBe('See it');
    expect(app.newRelease).toEqual(NEWER);

    await openWindow();
    expect(checks()).toBe(1);
    expect(texts()).toEqual([]);
    expect(app.newRelease).toEqual(NEWER);
  });

  it('asks again after twelve hours, and not before', async () => {
    await openWindow();
    later(11 * HOUR);
    await openWindow();
    expect(checks()).toBe(1);
    later(2 * HOUR);
    await openWindow();
    expect(checks()).toBe(2);
  });

  it('stops offering a release once this build has caught up with it', async () => {
    await openWindow();
    vi.mocked(latestRelease).mockResolvedValue(CURRENT);
    later(13 * HOUR);
    await openWindow();
    expect(app.newRelease).toBeNull();
    expect(texts()).toEqual([]);
  });

  it('says nothing when a check fails, and waits before trying again', async () => {
    vi.mocked(latestRelease).mockRejectedValue(new Error('offline'));
    await openWindow();
    expect(texts()).toEqual([]);
    later(10 * 60 * 1000);
    await openWindow();
    expect(checks()).toBe(1);
    later(30 * 60 * 1000);
    await openWindow();
    expect(checks()).toBe(2);
  });

  it('stays quiet when turned off', async () => {
    app.toggleAutoUpdates();
    expect(app.autoUpdates).toBe(false);
    await openWindow();
    expect(checks()).toBe(0);
    expect(app.updatable).toBe(true);

    app.toggleAutoUpdates();
    await settle();
    expect(checks()).toBe(1);
    expect(texts()).toContain('Bedsheet 99.0.0 is out');
  });

  it('leaves updates to Flatpak inside one, and to nobody in a browser', async () => {
    vi.mocked(inFlatpak).mockResolvedValueOnce(true);
    await openWindow();
    expect(app.updatable).toBe(false);
    host.desktop = false;
    await openWindow();
    expect(app.updatable).toBe(false);
    expect(checks()).toBe(0);
  });
});

describe('checking for updates by hand', () => {
  it('says so when this build is the newest', async () => {
    vi.mocked(latestRelease).mockResolvedValue(CURRENT);
    await app.checkForUpdates();
    expect(texts()).toEqual(['Bedsheet is up to date']);
    expect(app.newRelease).toBeNull();
  });

  it('announces a release again that was announced before', async () => {
    await openWindow();
    app.toasts.length = 0;
    await app.checkForUpdates();
    expect(texts()).toEqual(['Bedsheet 99.0.0 is out']);
  });

  it('reports a check that failed', async () => {
    vi.mocked(latestRelease).mockRejectedValue(new Error('GitHub answered 403'));
    await app.checkForUpdates();
    expect(texts()).toEqual(['Couldn’t check for updates: GitHub answered 403']);
    expect(app.toasts[0].kind).toBe('error');
  });
});

describe('opening a page of the project', () => {
  it('says so when the browser cannot be opened', async () => {
    await app.openPage('issues');
    expect(openProjectPage).toHaveBeenCalledWith('issues');
    expect(texts()).toEqual([]);
    vi.mocked(openProjectPage).mockRejectedValueOnce('no browser found');
    await app.openPage();
    expect(texts()).toEqual(['Couldn’t open the page in your browser: no browser found']);
  });
});

describe('getting an update', () => {
  beforeEach(() => {
    app.newRelease = NEWER;
    vi.spyOn(recovery, 'clear').mockResolvedValue();
  });

  it('opens the release page where the app cannot install it', async () => {
    expect(app.updateLabel).toBe('Get Bedsheet 99.0.0');
    await app.getUpdate();
    expect(openProjectPage).toHaveBeenCalledWith('releases/tag/v99.0.0');
    expect(fetchUpdate).not.toHaveBeenCalled();
  });

  it('installs it on Windows, reporting the download as it goes', async () => {
    host.windows = true;
    const install = vi.fn(async () => {});
    let seen: number | null = null;
    vi.mocked(fetchUpdate).mockImplementationOnce(async (onProgress) => {
      onProgress(0.4);
      seen = app.updateProgress;
      return install;
    });
    expect(app.updateLabel).toBe('Install Bedsheet 99.0.0');
    await app.getUpdate();
    expect(seen).toBe(0.4);
    expect(install).toHaveBeenCalledOnce();
    expect(app.updateProgress).toBeNull();
    expect(openProjectPage).not.toHaveBeenCalled();
  });

  it('will not install while other windows are open', async () => {
    host.windows = true;
    vi.mocked(otherWindows).mockResolvedValueOnce(2);
    await app.getUpdate();
    expect(fetchUpdate).not.toHaveBeenCalled();
    expect(texts()).toEqual(['Close your other Bedsheet windows first. Installing an update closes them all.']);
  });

  it('asks about unsaved work before handing over to the installer', async () => {
    host.windows = true;
    const install = vi.fn(async () => {});
    vi.mocked(fetchUpdate).mockResolvedValue(install);
    app.doc.loadText('h\na\n', { name: 't.csv', path: '/tmp/t.csv', encoding: 'UTF-8' });
    app.doc.setCell(0, 0, 'b');

    let installing = app.getUpdate();
    await settle();
    expect(app.dialog?.title).toBe('Save changes to t.csv?');
    app.dialog!.actions.find((a) => a.label === 'Cancel')!.run();
    await installing;
    expect(install).not.toHaveBeenCalled();
    expect(app.updateProgress).toBeNull();

    installing = app.getUpdate();
    await settle();
    app.dialog!.actions.find((a) => a.label === 'Don’t save')!.run();
    await installing;
    expect(install).toHaveBeenCalledOnce();
    expect(recovery.clear).toHaveBeenCalled();
  });

  it('points at the release page when the installer is not ready or fails', async () => {
    host.windows = true;
    vi.mocked(fetchUpdate).mockResolvedValueOnce(null);
    await app.getUpdate();
    expect(texts()).toEqual(['The update isn’t ready to install yet. Try again later, or get it from the release page.']);
    app.toasts[0].action!.run();
    expect(openProjectPage).toHaveBeenCalledWith('releases/tag/v99.0.0');

    app.toasts.length = 0;
    vi.mocked(fetchUpdate).mockRejectedValueOnce('signature did not match');
    await app.getUpdate();
    expect(texts()).toEqual(['Couldn’t install the update: signature did not match']);
    expect(app.toasts[0].action?.label).toBe('See it');
    expect(app.updateProgress).toBeNull();
  });
});
