import { describe, expect, test } from 'vitest'
import { isWslBashLauncher } from './hooks'

/**
 * Both WSL launchers sit ahead of Git's bash on a default Windows PATH. Picking
 * one turns every hook and verify command into a false "FAILED" verdict carrying
 * a Microsoft Store advert, which is exactly what the GUI smoke run caught.
 */
describe('bash lookup', () => {
  test('rejects both WSL launchers, whatever the casing', () => {
    expect(isWslBashLauncher('C:\\Windows\\System32\\bash.exe')).toBe(true)
    expect(isWslBashLauncher('C:\\Windows\\Sysnative\\bash.exe')).toBe(true)
    expect(isWslBashLauncher('C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe')).toBe(true)
    expect(isWslBashLauncher('c:\\windows\\system32\\BASH.EXE')).toBe(true)
  })

  test('accepts the Git for Windows shells', () => {
    expect(isWslBashLauncher('D:\\Program Files\\Git\\bin\\bash.exe')).toBe(false)
    expect(isWslBashLauncher('D:\\Program Files\\Git\\usr\\bin\\bash.exe')).toBe(false)
  })

  test('does not reject a real bash that merely lives under a similar name', () => {
    expect(isWslBashLauncher('C:\\tools\\WindowsApps-backup\\bash.exe')).toBe(false)
    expect(isWslBashLauncher('C:\\Windows\\System32\\wsl.exe')).toBe(false)
  })
})
