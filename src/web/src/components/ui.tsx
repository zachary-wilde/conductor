// Small, dependency-light UI primitives shared across the web views. Styled
// with the theme tokens so they repaint with `:root`; no CSS files of their own.

import { forwardRef } from 'react'
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes
} from 'react'

type Variant = 'primary' | 'ghost' | 'danger' | 'success'

const VARIANT_CLASS: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-accent/90',
  ghost: 'bg-bg-2 text-text-mid hover:bg-bg-3 hover:text-text-hi border border-edge',
  danger:
    'bg-[rgb(var(--danger))]/10 text-[rgb(var(--danger))] hover:bg-[rgb(var(--danger))]/20 border border-[rgb(var(--danger))]/30',
  success:
    'bg-accent-green/10 text-accent-green hover:bg-accent-green/20 border border-accent-green/30'
}

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }
>(function Button({ variant = 'ghost', className = '', children, ...rest }, ref) {
  return (
    <button
      ref={ref}
      {...rest}
      className={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${VARIANT_CLASS[variant]} ${className}`}
    >
      {children}
    </button>
  )
})

export function Spinner({ className = '' }: { className?: string }): JSX.Element {
  return (
    <span
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-edge-active border-t-accent ${className}`}
      aria-hidden
    />
  )
}

export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-text-low">
        {label}
      </span>
      {children}
      {hint ? <span className="text-[11px] text-text-hint">{hint}</span> : null}
    </label>
  )
}

export function TextInput({
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return (
    <input
      {...rest}
      className={`rounded-md border border-edge bg-bg-1 px-3 py-2 text-sm text-text-hi placeholder:text-text-hint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40 ${className}`}
    />
  )
}

export function TextArea({
  className = '',
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  return (
    <textarea
      {...rest}
      className={`rounded-md border border-edge bg-bg-1 px-3 py-2 text-sm text-text-hi placeholder:text-text-hint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40 ${className}`}
    />
  )
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label?: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 ${
        checked ? 'bg-accent' : 'bg-bg-3'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

export type BadgeTone =
  | 'neutral'
  | 'accent'
  | 'blue'
  | 'cyan'
  | 'green'
  | 'amber'
  | 'red'
  | 'purple'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'

export function Badge({
  tone,
  children,
  className = ''
}: {
  children: ReactNode
  className?: string
  tone?: BadgeTone
}): JSX.Element {
  return (
    <span
      data-tone={tone}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide ${className}`}
    >
      {children}
    </span>
  )
}

export function EmptyState({
  title,
  body
}: {
  title: string
  body?: string
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-edge px-6 py-12 text-center">
      <p className="text-sm font-medium text-text-mid">{title}</p>
      {body ? <p className="max-w-sm text-xs text-text-hint">{body}</p> : null}
    </div>
  )
}

export function Notice({
  tone,
  children
}: {
  tone: 'info' | 'warn' | 'error'
  children: ReactNode
}): JSX.Element {
  const cls =
    tone === 'error'
      ? 'border-[rgb(var(--danger))]/30 bg-[rgb(var(--danger))]/10 text-[rgb(var(--danger))]'
      : tone === 'warn'
        ? 'border-[rgb(var(--warn))]/30 bg-[rgb(var(--warn))]/10 text-[rgb(var(--warn))]'
        : 'border-accent/30 bg-accent/10 text-accent'
  return (
    <div className={`rounded-md border px-3 py-2 text-xs ${cls}`}>{children}</div>
  )
}
