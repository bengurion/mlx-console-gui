/**
 * Parser for `powermetrics --show-process-gpu` output.
 *
 * This is the only macOS source of *per-process* GPU attribution, and it needs
 * root. Note what it does and does not provide:
 *
 *  - provides: per-process GPU **time** (ms/s), i.e. utilization attribution
 *  - does NOT provide: per-process GPU **memory**
 *
 * There is no per-process GPU memory accounting on macOS at any privilege
 * level, so the memory figures in the metrics panel stay device-wide even with
 * root. Only the utilization row gains attribution.
 *
 * The tasks sampler prints a header row followed by one row per process. The
 * exact column set varies with the flags and OS version, so the parser locates
 * the GPU column by header text rather than by a fixed offset.
 */

export interface ProcessGpuSample {
  name: string
  pid: number
  /** GPU milliseconds consumed per wall-clock second. */
  gpuMsPerS: number
}

/** Header cell that marks the per-process GPU column. */
const GPU_HEADER = /GPU\s*ms\/s/i

/**
 * Header cells, with `<X> ms/s` collapsed so a unit's space does not split it
 * into two columns (`CPU ms/s` and `GPU ms/s` both contain one).
 */
function headerCells(line: string): string[] {
  return line
    .replace(/(\w+)\s*ms\/s/gi, '$1MS')
    .trim()
    .split(/\s+/)
}

/**
 * Column layout expressed as offsets from the END of the row.
 *
 * Indexing from the left is wrong: a process name may contain spaces
 * ("Code Helper (Renderer)") and would consume extra cells, shifting every
 * column after it. The numeric columns are always the last N, so counting
 * back from the right is stable regardless of the name.
 */
interface Layout {
  gpuFromEnd: number
  pidFromEnd: number
}

function layoutOf(line: string): Layout | undefined {
  if (!GPU_HEADER.test(line)) return undefined
  const cells = headerCells(line)
  const gpuIdx = cells.findIndex((c) => /^GPUMS$/i.test(c))
  if (gpuIdx < 0) return undefined
  const pidIdx = cells.findIndex((c) => /^(id|pid)$/i.test(c))
  return {
    gpuFromEnd: cells.length - gpuIdx,
    pidFromEnd: cells.length - (pidIdx >= 0 ? pidIdx : 1),
  }
}

/**
 * Parse the per-process GPU table.
 *
 * Rows whose GPU cell is not numeric are skipped rather than treated as zero,
 * so a layout change degrades to "no data" instead of silently reporting 0.
 */
export function parseProcessGpu(output: string): ProcessGpuSample[] {
  let layout: Layout | undefined
  const out: ProcessGpuSample[] = []

  for (const line of output.split(/\r?\n/)) {
    const found = layoutOf(line)
    if (found) {
      layout = found
      continue
    }
    if (!layout || !line.trim()) continue

    const cells = line.trim().split(/\s+/)
    if (cells.length < layout.pidFromEnd) continue

    const pid = Number(cells[cells.length - layout.pidFromEnd])
    const gpu = Number(cells[cells.length - layout.gpuFromEnd])
    if (!Number.isFinite(pid) || !Number.isFinite(gpu)) continue

    // Everything before the pid is the name, spaces included.
    const name = cells.slice(0, cells.length - layout.pidFromEnd).join(' ')
    out.push({ name, pid, gpuMsPerS: gpu })
  }
  return out
}

/** The sample for one pid, if present. */
export function findProcessGpu(
  samples: ProcessGpuSample[],
  pid: number,
): ProcessGpuSample | undefined {
  return samples.find((s) => s.pid === pid)
}

/**
 * Command used to take a single sample into `outFile`.
 *
 * Kept as data (not an interpolated shell string) so the exact privileged
 * command is visible, testable, and cannot be altered by user input beyond the
 * output path.
 */
export function powermetricsArgs(outFile: string, intervalMs = 1000): string[] {
  return [
    'powermetrics',
    '--samplers',
    'tasks',
    '--show-process-gpu',
    '-n',
    '1',
    '-i',
    String(intervalMs),
    '-o',
    outFile,
  ]
}
