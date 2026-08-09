import { describe, expect, test } from 'vitest'
import { SessionOutput } from './output-meter'

/** One frame of a typical agent CLI spinner: clear, colour, text, redraw. */
function spinnerFrame(seconds: number): string {
  return (
    `\u001b[2J\u001b[H\u001b[?25l\u001b[38;5;208m\u001b[1m thinking\u001b[0m ` +
    `\u001b[38;5;240m(${seconds}s · esc to interrupt)\u001b[0m\u001b[?25h\r`
  )
}

describe('SessionOutput counting', () => {
  test('counts plain text and its line breaks', () => {
    const output = new SessionOutput()
    output.push('hello\n')
    expect(output.chars).toBe(6)
  })

  test('counts an unterminated line while it is still being written', () => {
    const output = new SessionOutput()
    output.push('par')
    expect(output.chars).toBe(3)
    output.push('tial')
    expect(output.chars).toBe(7)
  })

  /**
   * ConPTY terminates lines with CRLF. Treating that CR as an overwrite made
   * every Windows console line count as one character, which silently zeroed
   * child metering on the only platform this app ships on.
   */
  test('counts a CRLF line the same as an LF line', () => {
    const lf = new SessionOutput()
    lf.push('hello\n')
    const crlf = new SessionOutput()
    crlf.push('hello\r\n')
    expect(crlf.chars).toBe(lf.chars)
    expect(crlf.chars).toBe(6)
  })

  test('still collapses a real CR overwrite inside a CRLF-terminated line', () => {
    const output = new SessionOutput()
    output.push('scratch\rfinal\r\n')
    expect(output.chars).toBe(6)
  })

  test('accumulates CRLF output at full volume, not one char per line', () => {
    const output = new SessionOutput()
    for (let i = 0; i < 10; i += 1) output.push(`working: step ${i}\r\n`)
    expect(output.chars).toBeGreaterThan(100)
  })

  test('drops escape sequences rather than billing them as output', () => {
    const bare = new SessionOutput()
    bare.push('done\n')
    const dressed = new SessionOutput()
    dressed.push('\u001b[38;5;208m\u001b[1mdone\u001b[0m\n')
    expect(dressed.chars).toBe(bare.chars)
  })

  /**
   * The defect this class exists for: a spinner is terminal traffic, not model
   * output. Billing raw bytes charged ~2,600 tokens for two idle minutes.
   */
  test('collapses a carriage-return redraw to the surviving line', () => {
    const output = new SessionOutput()
    let raw = ''
    for (let i = 0; i < 120; i += 1) {
      raw += spinnerFrame(i)
      output.push(spinnerFrame(i))
    }
    expect(raw.length).toBeGreaterThan(10_000)
    // Only the final frame's visible text survives, and nothing is committed
    // because no newline was ever written.
    expect(output.chars).toBeLessThan(60)
    expect(output.chars).toBeLessThan(raw.length / 100)
  })

  test('survives a redraw split across chunk boundaries', () => {
    const whole = new SessionOutput()
    whole.push('aaaa\rbbbb\n')
    const split = new SessionOutput()
    split.push('aaaa\rbb')
    split.push('bb\n')
    expect(split.chars).toBe(whole.chars)
    expect(whole.chars).toBe(5)
  })

  test('keeps a pending line bounded when no newline ever arrives', () => {
    const output = new SessionOutput()
    for (let i = 0; i < 50; i += 1) output.push('x'.repeat(1_000))
    expect(output.chars).toBeLessThanOrEqual(4_096)
  })
})

describe('SessionOutput tail', () => {
  test('returns the trailing screen text, cleaned', () => {
    const output = new SessionOutput()
    output.push('\u001b[32mstep one\u001b[0m\nstep two\n')
    output.push('all done')
    expect(output.tail).toBe('step one\nstep two\nall done')
  })

  test('is empty when the session said nothing printable', () => {
    const output = new SessionOutput()
    output.push('\u001b[?25l\u001b[2J\u001b[H')
    expect(output.tail).toBe('')
  })

  test('is clipped so a long session cannot retain unbounded text', () => {
    const output = new SessionOutput()
    for (let i = 0; i < 2_000; i += 1) output.push(`line ${i} of chatter\n`)
    expect(output.tail.length).toBeLessThanOrEqual(4_000)
    expect(output.tail.endsWith('line 1999 of chatter')).toBe(true)
  })
})
