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
 * header cannot be used to index the columns — two headings each span two
 * numeric fields — so rows are read by shape: name, pid, then numbers, GPU
 * last.
 */

export interface ProcessGpuSample {
  name: string
  pid: number
  /** GPU milliseconds consumed per wall-clock second. */
  gpuMsPerS: number
}

/** Header cell that marks the per-process GPU column. */
const GPU_HEADER = /GPU\s*ms\/s/i

export function parseProcessGpu(output: string): ProcessGpuSample[] {
  let inTable = false
  const out: ProcessGpuSample[] = []

  for (const line of output.split(/\r?\n/)) {
    if (GPU_HEADER.test(line)) {
      inTable = true
      continue
    }
    if (!inTable || !line.trim()) continue

    const cells = line.trim().split(/\s+/)
    if (cells.length < 3) continue

    // The pid is the first whole number; everything before it is the name.
    const pidIdx = cells.findIndex((c, i) => i > 0 && /^-?\d+$/.test(c))
    if (pidIdx < 1) continue

    const rest = cells.slice(pidIdx + 1)
    // Every remaining field is numeric in a real row; anything else is a
    // footer or a section break, not data.
    if (!rest.length || !rest.every((c) => /^-?\d+(\.\d+)?$/.test(c))) continue

    const gpu = Number(rest[rest.length - 1])
    const pid = Number(cells[pidIdx])
    if (!Number.isFinite(gpu) || !Number.isFinite(pid)) continue

    out.push({ name: cells.slice(0, pidIdx).join(' '), pid, gpuMsPerS: gpu })
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
