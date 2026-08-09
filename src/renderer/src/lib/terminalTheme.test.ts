// @vitest-environment jsdom
import { expect, test, vi } from 'vitest'

vi.mock('@xterm/xterm', () => ({ Terminal: class {} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
import { terminalTheme } from '../components/Terminal'

test('terminal themes use a transparent canvas and app palette tokens', () => {
  const root = document.documentElement
  const previousStyle = root.getAttribute('style')
  root.style.setProperty('--bg-0', '10 11 12')
  root.style.setProperty('--bg-1', '20 21 22')
  root.style.setProperty('--text-hi', '230 231 232')
  root.style.setProperty('--text-mid', '160 161 162')
  root.style.setProperty('--text-low', '100 101 102')
  root.style.setProperty('--accent', '240 140 40')
  root.style.setProperty('--success', '40 200 100')

  try {
    expect(terminalTheme(true)).toMatchObject({
      background: 'transparent',
      foreground: '#28c864',
      cursor: '#f08c28',
      cursorAccent: '#141516',
      black: '#0a0b0c',
      selectionBackground: '#f08c2852'
    })
    expect(terminalTheme(false)).toMatchObject({
      background: 'transparent',
      foreground: '#e6e7e8'
    })
  } finally {
    if (previousStyle === null) root.removeAttribute('style')
    else root.setAttribute('style', previousStyle)
  }
})
