import { describe, it, expect } from 'vitest';
import { baseName, shortDir } from './paths';

describe('baseName', () => {
  it('takes the last segment of a Unix path', () => {
    expect(baseName('/home/me/data/export.csv')).toBe('export.csv');
    expect(baseName('/export.csv')).toBe('export.csv');
  });

  it('takes the last segment of a Windows path', () => {
    expect(baseName('C:\\Users\\me\\Documents\\export.csv')).toBe('export.csv');
    expect(baseName('\\\\server\\share\\export.csv')).toBe('export.csv');
  });

  it('returns a bare name unchanged', () => {
    expect(baseName('export.csv')).toBe('export.csv');
  });
});

describe('shortDir', () => {
  it('shortens the home directory on Linux', () => {
    expect(shortDir('/home/me/data/export.csv')).toBe('~/data');
    expect(shortDir('/home/me/export.csv')).toBe('~');
    expect(shortDir('/srv/export.csv')).toBe('/srv');
    expect(shortDir('/export.csv')).toBe('/');
  });

  it('shortens the home directory on Windows', () => {
    expect(shortDir('C:\\Users\\me\\Documents\\export.csv')).toBe('~\\Documents');
    expect(shortDir('C:\\Users\\me\\export.csv')).toBe('~');
    expect(shortDir('D:\\data\\export.csv')).toBe('D:\\data');
    expect(shortDir('C:\\export.csv')).toBe('C:\\');
    expect(shortDir('\\\\server\\share\\export.csv')).toBe('\\\\server\\share');
  });
});
