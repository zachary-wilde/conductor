import { describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import {
  createRuntimeManifest,
  RUNTIME_PROBE_ARTIFACTS,
  verifySha256
} from '../../scripts/runtime-probe-assets.mjs'

describe('runtime probe build artifacts', () => {
  test('pins immutable ARM64 PRoot, Debian, and OMP payloads', () => {
    expect(RUNTIME_PROBE_ARTIFACTS).toEqual({
      proot: {
        url: 'https://raw.githubusercontent.com/green-green-avk/build-proot-android/01f83b8841358450c78333d1b33ab30d4943bec4/packages/proot-android-aarch64.tar.gz',
        sha256: '9629eb30cdf86e95c6ba681f8ab89c6fdaa9eca093d5577163513c99af5ca281'
      },
      debian: {
        repository: 'library/debian',
        manifestDigest: 'sha256:817e6cf99d6fc127ff4ffe8580049b60deba0adfbbb2bd65ddc3ef8fbb7aade0',
        layerDigest: 'sha256:0f5d7465a5bb9d419f60c93d126a161286c73a1ede4a8b2e46bd5e7ad5782cc7'
      },
      omp: {
        version: '17.2.11',
        url: 'https://github.com/can1357/oh-my-pi/releases/download/v17.2.11/omp-linux-arm64',
        sha256: '3a5349bd6cfe8b1c5f428ea10afeef94730c7923a2e4ae4b963762bd94151b6e'
      }
    })
  })

  test('rejects payload bytes that do not match the pinned digest', () => {
    expect(() => verifySha256(Buffer.from('tampered'), '0'.repeat(64), 'OMP')).toThrow(
      'OMP SHA-256 mismatch'
    )
  })

  test('accepts payload bytes with the pinned digest', () => {
    expect(
      verifySha256(
        Buffer.from('abc'),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        'fixture'
      )
    ).toBeUndefined()
  })

  test('generates the manifest consumed by the Android installer', () => {
    const files = {
      'root/bin/proot': Buffer.from('proot'),
      'root/libexec/proot/loader': Buffer.from('loader'),
      'root/libexec/proot/loader32': Buffer.from('loader32')
    }

    const manifest = createRuntimeManifest(files)

    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.rootfs).toEqual({
      asset: 'debian-rootfs.tgz',
      sha256: RUNTIME_PROBE_ARTIFACTS.debian.layerDigest.replace('sha256:', '')
    })
    expect(manifest.proot.sha256).toBe(createHash('sha256').update('proot').digest('hex'))
    expect(manifest.proot.loaderSha256).toBe(createHash('sha256').update('loader').digest('hex'))
    expect(manifest.proot.loader32Sha256).toBe(createHash('sha256').update('loader32').digest('hex'))
    expect(manifest.omp).toEqual({
      asset: 'omp-linux-arm64',
      sha256: RUNTIME_PROBE_ARTIFACTS.omp.sha256
    })
  })
})
