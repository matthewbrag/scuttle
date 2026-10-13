import { readMeta } from "../src/store";
import { startBackground, checkBackground, killBackground, listTasks } from "../src/background";

const sid = process.argv[2];
if (!sid) throw new Error("usage: tsx test/background-probe.ts <session-id>");

const check = (label: string, cond: boolean) => console.log(`${cond ? "✅" : "❌"} ${label}`);

async function main() {
  const meta = readMeta(sid);
  if (!meta) throw new Error("no such session");

  console.log("--- 1. start a background task (sleep 5 then write a marker) ---");
  const t0 = Date.now();
  const task = await startBackground(meta, "sleep 5; echo done-sleeping-5s; echo marker-line-2");
  const startElapsed = Date.now() - t0;
  console.log("task:", task, "\nstart() returned in", startElapsed, "ms");
  check("start() returns almost immediately (does NOT block for the 5s sleep)", startElapsed < 2000);

  console.log("\n--- 2. check immediately — should still be RUNNING with no output yet ---");
  const early = await checkBackground(meta, task.id);
  console.log(early);
  check("reports running while the sleep is still in progress", early?.running === true);

  console.log("\n--- 3. list_background shows it ---");
  const list = listTasks(sid);
  check("listTasks includes this task", list.some((t) => t.id === task.id));

  console.log("\n--- 4. wait past the sleep, check again — should show real output + finished ---");
  await new Promise((r) => setTimeout(r, 6000));
  const late = await checkBackground(meta, task.id);
  console.log(late);
  check("finished after the sleep completes", late?.running === false);
  check("output contains both echoed lines", !!late?.output.includes("done-sleeping-5s") && !!late?.output.includes("marker-line-2"));

  console.log("\n--- 5. kill_background on a genuinely long-running task ---");
  const task2 = await startBackground(meta, "sleep 30; echo SHOULD_NOT_APPEAR");
  await new Promise((r) => setTimeout(r, 500));
  const killed = await killBackground(meta, task2.id);
  check("kill reports success", killed === true);
  await new Promise((r) => setTimeout(r, 1000));
  const afterKill = await checkBackground(meta, task2.id);
  console.log(afterKill);
  check("process is confirmed not running after kill", afterKill?.running === false);
  check("killed task's output does NOT contain the post-sleep marker (genuinely stopped, not just outlived)", !afterKill?.output.includes("SHOULD_NOT_APPEAR"));
}
main().then(() => console.log("\ndone.")).catch((e) => { console.error("FATAL", e); process.exit(1); });
