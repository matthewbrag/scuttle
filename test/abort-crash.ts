import { streamSession } from "../src/tui/api";

// Reproduces the exact crash: abort a stream connection before it ever opens (e.g. a
// fast /new right after launch). Before the fix, the initial fetch() sat outside
// streamSession's try/catch, so this rejected uncaught and crashed the whole process.
process.on("unhandledRejection", (err) => {
  console.log("❌ UNHANDLED REJECTION (this is the crash) —", err);
  process.exit(1);
});

async function main() {
  const ac = new AbortController();
  const p = streamSession("s_does_not_exist", ac.signal, () => {}, () => {});
  ac.abort(); // abort immediately — before the connection has any chance to open
  await p;
  console.log("✅ no crash: aborted-before-open was caught gracefully");

  // Also: abort AFTER a connection attempt is clearly underway (still likely pre-open
  // against a real server, since this is a loopback call with no server listening here).
  const ac2 = new AbortController();
  const p2 = streamSession("s_also_missing", ac2.signal, () => {}, () => {});
  setTimeout(() => ac2.abort(), 5);
  await p2;
  console.log("✅ no crash: abort shortly after start was caught gracefully");
}

main()
  .then(() => {
    console.log("\nall good — exiting cleanly");
    process.exit(0);
  })
  .catch((e) => {
    console.log("❌ main() itself threw —", e.message);
    process.exit(1);
  });
