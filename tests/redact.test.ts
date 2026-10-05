import { expect, test } from 'claude-code/testing'

import { mask, promptForJev, shorten } from '../hooks/redact'

test('credentials, links, addresses and absolute paths never reach Jev', () => {
  const sent = promptForJev(
    'deploy with api_key=abc123def and token: "s3cret" using sk-abcdefghijklmnopqrstu and ghp_abcdefghijklmnopqrstuvwxyz12 ' +
      'see https://internal.example.com/x?y=1 and postgres://u:p@db:5432/app, mail bob@example.com, host 10.0.0.12:8080, ' +
      'file /Users/andrew/Dev/app/config.yml and ~/notes.md',
  )!
  for (const leak of ['abc123def', 's3cret', 'sk-abc', 'ghp_', 'internal.example.com', 'postgres://', 'bob@', '10.0.0.12', '/Users/andrew', '~/notes'])
    expect(sent).not.toContain(leak)
  expect(sent).toContain('api_key=<secret>')
  expect(sent).toContain('<url>')
  expect(sent).toContain('<email>')
  expect(sent).toContain('<ip>')
  expect(sent).toContain('<path>')
})

test('code and pastes become a note of their size; short names and relative paths stay', () => {
  const sent = promptForJev('fix `getUser` in app/Http/Kernel.php:\n```ts\nconst a = 1\nconst b = 2\n```\nthanks')!
  expect(sent).toContain('`getUser`')
  expect(sent).toContain('app/Http/Kernel.php')
  expect(sent).toContain('[code: 2 lines]')
  expect(sent).not.toContain('const a')
  expect(mask('<pasted_content id="7">lots of text</pasted_content id="7">').text).toBe('[pasted text: 12 chars]')
})

test('a long prompt keeps its opening and end; slash commands and empty prompts are not scored', () => {
  const long = 'a'.repeat(3000) + 'MIDDLE' + 'b'.repeat(1000)
  expect(shorten(long)).not.toContain('MIDDLE')
  expect(shorten(long)).toContain('[6 chars left out]')
  expect(promptForJev('/jeffort audit')).toBeUndefined()
  expect(promptForJev('   ')).toBeUndefined()
})
