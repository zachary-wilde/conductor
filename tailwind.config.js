/**
 * Colors resolve to CSS variables so a theme can repaint the whole app by
 * swapping `data-theme` on the root element. Values are space-separated RGB
 * channels so Tailwind's `/opacity` modifiers keep working.
 */
const themed = (name) => `rgb(var(${name}) / <alpha-value>)`

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}', './src/web/index.html', './src/web/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          0: themed('--bg-0'),
          1: themed('--bg-1'),
          2: themed('--bg-2'),
          3: themed('--bg-3')
        },
        edge: {
          DEFAULT: themed('--edge'),
          mid: themed('--edge-mid'),
          active: themed('--edge-active')
        },
        accent: {
          DEFAULT: themed('--accent'),
          blue: themed('--accent-blue'),
          green: themed('--accent-green'),
          cyan: themed('--accent-cyan'),
          purple: themed('--accent-purple')
        },
        /**
         * Semantic, not decorative. Green means "this worked": a running child, an
         * approved plan, an added diff line, a harness that was found. Those must NOT
         * follow the interaction accent when it changes.
         */
        success: themed('--success'),
        text: {
          hi: themed('--text-hi'),
          mid: themed('--text-mid'),
          low: themed('--text-low'),
          hint: themed('--text-hint')
        }
      },
      fontFamily: {
        sans: ['IBM Plex Sans', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['Hack Nerd Font Propo', 'Hack Nerd Font', 'IBM Plex Mono', 'ui-monospace', 'monospace']
      },
      boxShadow: {
        glow: '0 0 0 1px rgb(var(--accent) / 0.25), 0 8px 30px -8px rgb(var(--accent) / 0.15)'
      }
    }
  },
  plugins: []
}
