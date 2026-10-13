/**
 * Pure scrollback math. `viewEnd` is either `null` (auto-follow the latest content) or
 * an ABSOLUTE index into the blocks array marking where the view is frozen — deliberately
 * not "N blocks back from the end", which would silently drift forward as new blocks
 * keep getting appended while the user is reading scrollback.
 */
export function scrollUp(viewEnd: number | null, blocksLength: number, by: number): number {
  return Math.max(0, (viewEnd ?? blocksLength) - by);
}

/** Returns null (snap back to auto-follow) once scrolling down reaches the live tail. */
export function scrollDown(viewEnd: number | null, blocksLength: number, by: number): number | null {
  if (viewEnd == null) return null;
  const next = viewEnd + by;
  return next >= blocksLength ? null : next;
}
