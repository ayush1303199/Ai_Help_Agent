export function projectRootsMatch(left: string, right: string): boolean {
  const normalize = (root: string) => root.trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLocaleLowerCase();
  return normalize(left) === normalize(right);
}

export function hasProjectContextMismatch(
  activeProjectRoot: string | null,
  reportedProjectRoot: string | null,
  reportedProjectAttached: boolean,
): boolean {
  if (!activeProjectRoot) return false;
  return !reportedProjectAttached
    || !reportedProjectRoot
    || !projectRootsMatch(activeProjectRoot, reportedProjectRoot);
}
