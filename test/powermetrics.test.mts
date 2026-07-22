import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseProcessGpu,
  findProcessGpu,
  powermetricsArgs,
} from '../src/services/powermetrics.ts'

// Representative `powermetrics --samplers tasks --show-process-gpu` table.
// NOTE: synthesised, not captured — running powermetrics requires root, so the
// exact column layout on this OS version is unverified.
const OUTPUT = `
*** Sampled system activity ***

**** Running Tasks ****

Name                          ID       CPU ms/s     GPU ms/s
mlx_lm.server                 15469    920.11       812.40
WindowServer                  412      31.02        44.10
Code Helper (Renderer)        3311     12.50        0.00
kernel_task                   0        4.01        0.00
`

test('parseProcessGpu finds the GPU column by header, not offset', () => {
  const rows = parseProcessGpu(OUTPUT)
  const server = findProcessGpu(rows, 15469)!
  assert.equal(server.name, 'mlx_lm.server')
  assert.equal(server.gpuMsPerS, 812.4)

  const ws = findProcessGpu(rows, 412)!
  assert.equal(ws.gpuMsPerS, 44.1)
})

test('parseProcessGpu ignores preamble lines before the header', () => {
  const rows = parseProcessGpu(OUTPUT)
  // Only the four task rows, none of the "*** Sampled ***" banner lines.
  assert.equal(rows.length, 4)
})

test('parseProcessGpu returns nothing when the GPU column is absent', () => {
  const noGpu = `Name        ID     CPU ms/s
mlx_lm.server  15469  920.11
`
  assert.deepEqual(parseProcessGpu(noGpu), [], 'no GPU header means no data, not zeros')
})

test('parseProcessGpu skips rows with a non-numeric GPU cell', () => {
  const messy = `Name     ID    GPU ms/s
good     10    5.5
bad      11    n/a
`
  const rows = parseProcessGpu(messy)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].pid, 10)
})

test('parseProcessGpu handles empty input', () => {
  assert.deepEqual(parseProcessGpu(''), [])
})

test('powermetricsArgs takes exactly one sample into the given file', () => {
  const args = powermetricsArgs('/tmp/out.txt')
  assert.deepEqual(args, [
    'powermetrics',
    '--samplers',
    'tasks',
    '--show-process-gpu',
    '-n',
    '1',
    '-i',
    '1000',
    '-o',
    '/tmp/out.txt',
  ])
  // -n 1 matters: without it powermetrics streams forever and never returns.
  assert.equal(args[args.indexOf('-n') + 1], '1')
})

test('process names containing spaces do not shift the columns', () => {
  const rows = parseProcessGpu(OUTPUT)
  const helper = rows.find((r) => r.pid === 3311)!
  assert.equal(helper.name, 'Code Helper (Renderer)')
  assert.equal(helper.gpuMsPerS, 0)
})
