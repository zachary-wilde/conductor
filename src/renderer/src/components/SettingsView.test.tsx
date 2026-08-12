// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { installApi, resetStore } from '../lib/testStubs'
import { useStore } from '../store/useStore'
import { SettingsView } from './SettingsView'

Object.assign(globalThis, { React })

beforeEach(() => {
  installApi()
  resetStore()
})

afterEach(cleanup)

const fallbackToggle = (): HTMLElement => screen.getByTestId('harness-fallback-toggle')

describe('Settings harness fallback toggle', () => {
  test('is unchecked when harnessFallback is empty', () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, harnessFallback: [] } })
    render(<SettingsView />)

    expect(fallbackToggle()).not.toBeChecked()
  })

  test('is checked when harnessFallback is populated', () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS } })
    render(<SettingsView />)

    expect(fallbackToggle()).toBeChecked()
  })

  test('enabling it persists the full ordered fallback list', async () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, harnessFallback: [] } })
    const user = userEvent.setup()
    render(<SettingsView />)

    await user.click(fallbackToggle())
    await user.click(screen.getByTestId('settings-save'))

    expect(window.api.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ harnessFallback: ['claude', 'codex', 'zai'] })
    )
  })

  test('disabling it persists an empty fallback list', async () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS } })
    const user = userEvent.setup()
    render(<SettingsView />)

    await user.click(fallbackToggle())
    await user.click(screen.getByTestId('settings-save'))

    expect(window.api.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ harnessFallback: [] })
    )
  })
})

const consentToggle = (): HTMLElement => screen.getByTestId('shell-consent-toggle')

describe('Settings shell-execution consent toggle', () => {
  test('is unchecked by default (unconsented)', () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, shellHooksConsented: false } })
    render(<SettingsView />)

    expect(consentToggle()).not.toBeChecked()
  })

  test('reflects a granted consent', () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, shellHooksConsented: true } })
    render(<SettingsView />)

    expect(consentToggle()).toBeChecked()
  })

  test('granting consent persists shellHooksConsented true', async () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, shellHooksConsented: false } })
    const user = userEvent.setup()
    render(<SettingsView />)

    await user.click(consentToggle())
    await user.click(screen.getByTestId('settings-save'))

    expect(window.api.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ shellHooksConsented: true })
    )
  })
})
const autostartToggle = (): HTMLElement => screen.getByTestId('autostart-toggle')

describe('Settings sign-in autostart toggle', () => {
  test('is off by default and reflects an enabled setting', () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, autostart: false } })
    render(<SettingsView />)
    expect(autostartToggle()).not.toBeChecked()

    cleanup()
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, autostart: true } })
    render(<SettingsView />)
    expect(autostartToggle()).toBeChecked()
  })

  test('enabling it persists autostart true', async () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, autostart: false } })
    const user = userEvent.setup()
    render(<SettingsView />)

    await user.click(autostartToggle())
    await user.click(screen.getByTestId('settings-save'))

    expect(window.api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ autostart: true }))
  })
})
describe('Settings updater controls', () => {
  test('checks for updates from the release section', async () => {
    const user = userEvent.setup()
    render(<SettingsView />)

    await user.click(screen.getByTestId('check-for-updates'))

    expect(window.api.checkForUpdates).toHaveBeenCalledOnce()
  })
  test('passes explicit confirmation before installing a downloaded update', async () => {
    const installUpdate = vi.fn().mockResolvedValue({ state: 'downloaded', version: '0.2.0' })
    installApi({
      updaterStatus: vi.fn().mockResolvedValue({ state: 'downloaded', version: '0.2.0' }),
      installUpdate
    })
    vi.stubGlobal('confirm', vi.fn(() => true))
    const user = userEvent.setup()
    render(<SettingsView />)

    await user.click(await screen.findByTestId('install-update'))

    expect(installUpdate).toHaveBeenCalledWith(true)
  })
})
