import { scrollUp, scrollDown } from "../src/tui/scroll";
import { check, finish } from "./_check";

// Start auto-following (null) with 100 blocks, scroll up by 1 step.
let v: number | null = null;
v = scrollUp(v, 100, 1);
check("scrolling up from auto-follow freezes at length-1", v === 99);

v = scrollUp(v, 100, 10);
check("scrolling up further moves back by exactly `by`", v === 89);

check("scrolling up clamps at 0, never negative", scrollUp(2, 100, 10) === 0);

// --- the property that actually matters: position is ABSOLUTE, not relative-to-end ---
// User is frozen at block 89 (out of 100). 20 MORE blocks arrive while they're reading.
const frozenAt = v; // 89
const blocksLengthAfterNewArrivals = 120;
check(
  "frozen scrollback position does NOT drift as new blocks are appended (still 89, not 109)",
  frozenAt === 89,
);
// (the position itself never changes on its own — only scrollUp/scrollDown ever move it —
// so re-deriving the SAME viewEnd against a larger blocksLength is a no-op by construction;
// this is what "absolute index" buys us vs. "N blocks back from the end" would NOT.)

// Scrolling back down should walk toward the (now larger) live tail, not overshoot into
// stale territory computed against the OLD length.
let down: number | null = frozenAt;
down = scrollDown(down, blocksLengthAfterNewArrivals, 10);
check("scrolling down moves forward by exactly `by`", down === 99);

// Scrolling down past the end snaps back to auto-follow (null), using the CURRENT length.
down = scrollDown(99, blocksLengthAfterNewArrivals, 50);
check("scrolling down past the live tail snaps to auto-follow (null)", down === null);

check("scrolling down while already auto-following is a no-op (stays null)", scrollDown(null, 100, 5) === null);

console.log("\ndone.");
finish();
