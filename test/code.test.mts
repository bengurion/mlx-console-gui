/**
 * Language detection for the snippets shown on the Clients page.
 *
 * The rendering is React and needs a DOM, but the choice of language is plain
 * logic and is where this can go wrong: a command line and a YAML document
 * both contain colons, so the order the tests run in decides the answer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectLanguage, tokenize } from '../webview/src/highlight.ts'

test('a JSON document is recognised by its opening brace', () => {
  assert.equal(detectLanguage('{\n  "provider": {}\n}'), 'json')
  assert.equal(detectLanguage('\n\n  [\n  {"a": 1}\n]'), 'json', 'leading blank lines are ignored')
})

test('a command is recognised before the looser YAML test', () => {
  // `curl http://127.0.0.1:8081/v1/...` contains a colon followed by a space
  // in no case, but `-H 'Content-Type: application/json'` does — which reads
  // as a YAML key unless commands are checked first.
  const curl = [
    'curl http://127.0.0.1:8081/v1/chat/completions \\',
    "  -H 'Content-Type: application/json' \\",
    "  -d '{}'",
  ].join('\n')
  assert.equal(detectLanguage(curl), 'shell')

  assert.equal(detectLanguage('sudo /usr/bin/powermetrics --samplers tasks'), 'shell')
  assert.equal(detectLanguage('mlx-console serve --port 8090'), 'shell')
})

test('a YAML document is recognised by its keys', () => {
  const yaml = ['models:', '  - name: MLX (local)', '    provider: openai'].join('\n')
  assert.equal(detectLanguage(yaml), 'yaml')
})

test('a comment-led YAML file is still YAML', () => {
  // The Continue snippet opens with two comment lines; the keys come later.
  const yaml = [
    '# Continue (marketplace: Continue.continue) — no Copilot seat needed.',
    '# Add to ~/.continue/config.yaml:',
    '',
    'models:',
    '  - name: MLX (local)',
  ].join('\n')
  assert.equal(detectLanguage(yaml), 'yaml')
})

test('prose falls back to shell rather than mis-colouring as YAML', () => {
  const prose = [
    'The first request loads the model — minutes for a large one — and most',
    'clients give up long before that.',
  ].join('\n')
  assert.equal(detectLanguage(prose), 'shell', 'no keys, so nothing gets highlighted as one')
})

// ---- tokenising ------------------------------------------------------------

test('a YAML key is coloured but a URL after it is not split at its colon', () => {
  const tokens = tokenize('    apiBase: http://127.0.0.1:8081/v1', 'yaml')
  const key = tokens.find((t) => t.kind === 'key')
  assert.equal(key?.text, 'apiBase')

  // The colons inside the URL must survive as plain text, not become keys.
  assert.equal(tokens.filter((t) => t.kind === 'key').length, 1)
  const rendered = tokens.map((t) => t.text).join('')
  assert.equal(rendered, '    apiBase: http://127.0.0.1:8081/v1', 'text is preserved exactly')
})

test('a comment takes the whole line, whatever is in it', () => {
  const tokens = tokenize('# Add to ~/.continue/config.yaml:', 'yaml')
  assert.deepEqual(
    tokens.map((t) => t.kind),
    ['comment'],
  )
})

test('JSON keys and string values are told apart', () => {
  const tokens = tokenize('    "baseURL": "http://127.0.0.1:8081/v1"', 'json')
  assert.equal(tokens.find((t) => t.kind === 'key')?.text, '"baseURL"')
  assert.equal(tokens.find((t) => t.kind === 'string')?.text, '"http://127.0.0.1:8081/v1"')
})

test('every line round-trips to exactly its input', () => {
  // Highlighting must never alter the text: it is copied into config files.
  const lines = [
    'curl http://127.0.0.1:8081/v1/chat/completions \\',
    "  -H 'Content-Type: application/json' \\",
    '    provider: openai',
    '        "toolCalling": true,',
    '',
    '   ',
  ]
  for (const line of lines) {
    for (const lang of ['json', 'yaml', 'shell'] as const) {
      assert.equal(tokenize(line, lang).map((t) => t.text).join(''), line, `${lang}: ${line}`)
    }
  }
})
