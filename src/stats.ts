import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SessionMeta } from "./types";

const pexec = promisify(execFile);

export interface ResourceStats {
  cpuPercent?: number;
  memUsedMB?: number;
  memLimitMB?: number;
  gpuUtilPercent?: number;
  gpuMemUsedMB?: number;
  gpuMemTotalMB?: number;
}

const UNIT_MB: Record<string, number> = { B: 1 / 1e6, KiB: 1 / 1024, MiB: 1, GiB: 1024, TiB: 1024 * 1024 };

function parseMemPart(s: string): number | undefined {
  const m = s.trim().match(/^([\d.]+)\s*([A-Za-z]+)$/);
  if (!m) return undefined;
  const unit = UNIT_MB[m[2]];
  return unit != null ? parseFloat(m[1]) * unit : undefined;
}

/**
 * CPU/RAM via `docker stats` — works for any container on any machine, no hardware
 * assumptions. GPU via `nvidia-smi` scoped to the session's OWN assigned device
 * (meta.gpu, e.g. "1") — not an attempt at per-container GPU isolation (there's no
 * simple portable way to attribute GPU usage to one container's cgroup; this reports
 * "how busy is the device this session owns", which is what you actually want to know).
 * Fully optional and silently omitted (not an error) when:
 *   - nvidia-smi isn't installed (no NVIDIA GPU on this machine) — the whole point of
 *     keeping this gracefully degrading is running Scuttle on hardware other than this rig.
 *   - the session's gpu is "none" or "all" (no single device to scope to).
 */
export async function getContainerStats(meta: SessionMeta): Promise<ResourceStats> {
  const stats: ResourceStats = {};

  try {
    const { stdout } = await pexec("docker", ["stats", meta.container, "--no-stream", "--format", "{{.CPUPerc}}\t{{.MemUsage}}"]);
    const [cpuRaw, memRaw] = stdout.trim().split("\t");
    const cpu = parseFloat((cpuRaw || "").replace("%", ""));
    if (!Number.isNaN(cpu)) stats.cpuPercent = cpu;
    const [usedRaw, limitRaw] = (memRaw || "").split(" / ");
    if (usedRaw) stats.memUsedMB = parseMemPart(usedRaw);
    if (limitRaw) stats.memLimitMB = parseMemPart(limitRaw);
  } catch {
    /* container not running right now — leave cpu/mem undefined */
  }

  const gpu = meta.gpu;
  if (gpu && gpu !== "none" && gpu !== "all") {
    try {
      const { stdout } = await pexec("nvidia-smi", [
        "--query-gpu=utilization.gpu,memory.used,memory.total",
        `--id=${gpu}`,
        "--format=csv,noheader,nounits",
      ]);
      const [util, used, total] = stdout.trim().split(",").map((s) => parseFloat(s.trim()));
      if (!Number.isNaN(util)) stats.gpuUtilPercent = util;
      if (!Number.isNaN(used)) stats.gpuMemUsedMB = used;
      if (!Number.isNaN(total)) stats.gpuMemTotalMB = total;
    } catch {
      /* no nvidia-smi on this machine, or that device id doesn't exist — fine, omit GPU stats */
    }
  }

  return stats;
}
