const SEPARATOR = /[\\/]/;

/** The last segment of a path, with either kind of separator. */
export function baseName(path: string): string {
  return path.split(SEPARATOR).pop() || path;
}

/** The directory of a path for display, with the home directory shortened to ~. */
export function shortDir(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dir = path.slice(0, Math.max(cut, 0));
  if (/^[A-Za-z]:$/.test(dir)) return `${dir}\\`;
  return dir.replace(/^\/home\/[^/]+/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~') || '/';
}
