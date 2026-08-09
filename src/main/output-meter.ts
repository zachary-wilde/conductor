/**
 * Tracks what a terminal session actually *said*, not how many bytes it wrote.
 *
 * An interactive coding agent repaints its screen continuously. Two minutes of
 * an idle spinner is ~10,000 pty bytes — escape sequences and redraws of a
 * single line — representing nothing the model produced. Billing raw bytes
 * inflates a child's usage by an order of magnitude and makes a token ceiling
 * meaningless, so this drops escape sequences and keeps only the text that
 * survived on a line after any carriage-return overwrite.
 *
 * Known residual: a full-screen TUI that repaints with newlines rather than
 * carriage returns is still counted per repaint. That biases the estimate
 * high, which for a spend ceiling is the safe direction — a false stop is
 * recoverable, an unbounded run is not.
 *
 * The retained tail exists so a child that ignored the report-file instruction
 * can still hand something truthful to a dependent brief.
 */

/** CSI, OSC, and two-byte escapes. Mirrors manager-turn's stripper. */
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g

/** A single line cannot grow without bound between newlines. */
const MAX_PENDING_LINE = 4_096

/** Enough to carry a closing summary; small enough to hold for hours. */
const TAIL_CHARS = 4_000

/** Text after the last carriage return is what the user is left looking at. */
function afterLastReturn(line: string): string {
  const marker = line.lastIndexOf('\r')
  return marker === -1 ? line : line.slice(marker + 1)
}

export class SessionOutput {
  /** Committed characters: completed lines, post-overwrite. */
  private committed = 0
  /** The line still being written, already collapsed and stripped. */
  private pending = ''
  /** Trailing cleaned text, clipped to TAIL_CHARS. */
  private trailing = ''

  /**
   * One pass serves both the count and the tail: the expensive part is the
   * escape strip, and this runs on every pty chunk.
   */
  push(chunk: string): void {
    const parts = (this.pending + chunk.replace(ANSI_RE, '')).split('\n')
    this.pending = parts.pop() ?? ''
    for (const part of parts) {
      // The CR of a CRLF terminator is part of the line ending, not an
      // overwrite. Conflating the two makes every Windows console line count
      // as a single character.
      const line = afterLastReturn(part.endsWith('\r') ? part.slice(0, -1) : part)
      // +1 for the newline itself: a line break is real output.
      this.committed += line.length + 1
      this.trailing += `${line}\n`
    }
    this.pending = afterLastReturn(this.pending)
    if (this.pending.length > MAX_PENDING_LINE) this.pending = this.pending.slice(-MAX_PENDING_LINE)
    if (this.trailing.length > TAIL_CHARS) this.trailing = this.trailing.slice(-TAIL_CHARS)
  }

  /** Committed text plus whatever is on the unterminated final line. */
  get chars(): number {
    return this.committed + this.pending.length
  }

  /** Trailing screen text, trimmed. Empty when the session said nothing. */
  get tail(): string {
    return `${this.trailing}${this.pending}`.trim()
  }
}
