// Shared by the pure-logic/Ink-rendering test scripts (not a test itself — CI's
// workflow lists files explicitly, so this is never picked up and run on its own).
let failed = false;

export function check(label: string, cond: boolean) {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) failed = true;
}

/** Call once at the end of a test script — sets a failing exit code if any check()
 * failed. Without this, a script that only console.logs ❌ still exits 0, and CI (or
 * any automated runner) would never actually notice the regression. */
export function finish() {
  process.exitCode = failed ? 1 : 0;
}
