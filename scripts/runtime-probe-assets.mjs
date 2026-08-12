import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

export const RUNTIME_PROBE_ARTIFACTS = Object.freeze({
  proot: Object.freeze({
    url: 'https://raw.githubusercontent.com/green-green-avk/build-proot-android/01f83b8841358450c78333d1b33ab30d4943bec4/packages/proot-android-aarch64.tar.gz',
    sha256: '9629eb30cdf86e95c6ba681f8ab89c6fdaa9eca093d5577163513c99af5ca281'
  }),
  debian: Object.freeze({
    repository: 'library/debian',
    manifestDigest: 'sha256:817e6cf99d6fc127ff4ffe8580049b60deba0adfbbb2bd65ddc3ef8fbb7aade0',
    layerDigest: 'sha256:0f5d7465a5bb9d419f60c93d126a161286c73a1ede4a8b2e46bd5e7ad5782cc7'
  }),
  omp: Object.freeze({
    version: '17.2.11',
    url: 'https://github.com/can1357/oh-my-pi/releases/download/v17.2.11/omp-linux-arm64',
    sha256: '3a5349bd6cfe8b1c5f428ea10afeef94730c7923a2e4ae4b963762bd94151b6e'
  })
})

export function verifySha256(bytes, expected, label) {
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) {
    throw new Error(`${label} SHA-256 mismatch: expected ${expected}, received ${actual}`)
  }
}

async function fileSha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function fetchBytes(url, headers = {}) {
  const response = await fetch(url, { headers, redirect: 'follow' })
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

async function downloadVerified(url, destination, expected, label, headers = {}) {
  if (existsSync(destination) && (await fileSha256(destination)) === expected) return

  await mkdir(dirname(destination), { recursive: true })
  const partial = `${destination}.partial`
  await rm(partial, { force: true })

  const response = await fetch(url, { headers, redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`${label} download failed (${response.status})`)
  }

  const hash = createHash('sha256')
  const hasher = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    }
  })
  await pipeline(Readable.fromWeb(response.body), hasher, createWriteStream(partial))
  const actual = hash.digest('hex')
  if (actual !== expected) {
    await rm(partial, { force: true })
    throw new Error(`${label} SHA-256 mismatch: expected ${expected}, received ${actual}`)
  }
  await rename(partial, destination)
}

function tarString(bytes, offset, length) {
  const end = bytes.indexOf(0, offset)
  return bytes.toString('utf8', offset, Math.min(end === -1 ? offset + length : end, offset + length))
}

function tarSize(bytes, offset) {
  const value = tarString(bytes, offset, 12).trim()
  return value ? Number.parseInt(value, 8) : 0
}

function extractTarFiles(gzipBytes, wanted) {
  const tar = gunzipSync(gzipBytes)
  const found = new Map()
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = tarString(tar, offset, 100)
    if (!name) break
    const size = tarSize(tar, offset + 124)
    const dataStart = offset + 512
    if (wanted.has(name)) found.set(name, tar.subarray(dataStart, dataStart + size))
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  for (const name of wanted) {
    if (!found.has(name)) throw new Error(`PRoot archive is missing ${name}`)
  }
  return found
}

async function dockerToken(repository) {
  const query = new URLSearchParams({
    service: 'registry.docker.io',
    scope: `repository:${repository}:pull`
  })
  const response = await fetch(`https://auth.docker.io/token?${query}`)
  if (!response.ok) throw new Error(`Docker token request failed (${response.status})`)
  const body = await response.json()
  if (typeof body.token !== 'string' || !body.token) throw new Error('Docker token response omitted token')
  return body.token
}

export function createRuntimeManifest(prootFiles) {
  const file = (name) => prootFiles instanceof Map ? prootFiles.get(name) : prootFiles[name]
  const proot = file('root/bin/proot')
  const loader = file('root/libexec/proot/loader')
  const loader32 = file('root/libexec/proot/loader32')
  if (!proot || !loader || !loader32) throw new Error('Runtime manifest requires every PRoot executable')
  const layerSha256 = RUNTIME_PROBE_ARTIFACTS.debian.layerDigest.replace(/^sha256:/, '')
  return {
    schemaVersion: 1,
    version: `debian-${layerSha256.slice(0, 12)}-omp-${RUNTIME_PROBE_ARTIFACTS.omp.version}`,
    rootfs: {
      asset: 'debian-rootfs.tgz',
      sha256: layerSha256
    },
    proot: {
      sha256: createHash('sha256').update(proot).digest('hex'),
      loaderSha256: createHash('sha256').update(loader).digest('hex'),
      loader32Sha256: createHash('sha256').update(loader32).digest('hex')
    },
    omp: {
      asset: 'omp-linux-arm64',
      sha256: RUNTIME_PROBE_ARTIFACTS.omp.sha256
    },
    sources: RUNTIME_PROBE_ARTIFACTS
  }
}

export async function prepareRuntimeProbeAssets(outputRoot) {
  const output = resolve(outputRoot)
  const cache = join(dirname(output), 'runtimeProbeDownloads')
  const assets = join(output, 'assets', 'runtime')
  const jni = join(output, 'jniLibs', 'arm64-v8a')
  await rm(output, { recursive: true, force: true })
  await Promise.all([
    mkdir(assets, { recursive: true }),
    mkdir(jni, { recursive: true }),
    mkdir(cache, { recursive: true })
  ])

  const prootArchive = await fetchBytes(RUNTIME_PROBE_ARTIFACTS.proot.url)
  verifySha256(prootArchive, RUNTIME_PROBE_ARTIFACTS.proot.sha256, 'PRoot')
  const prootFiles = extractTarFiles(prootArchive, new Set([
    'root/bin/proot',
    'root/libexec/proot/loader',
    'root/libexec/proot/loader32'
  ]))
  await Promise.all([
    writeFile(join(jni, 'libproot.so'), prootFiles.get('root/bin/proot')),
    writeFile(join(jni, 'libproot-loader.so'), prootFiles.get('root/libexec/proot/loader')),
    writeFile(join(jni, 'libproot-loader32.so'), prootFiles.get('root/libexec/proot/loader32'))
  ])

  const token = await dockerToken(RUNTIME_PROBE_ARTIFACTS.debian.repository)
  const layerHex = RUNTIME_PROBE_ARTIFACTS.debian.layerDigest.replace(/^sha256:/, '')
  const cachedRootfs = join(cache, `${layerHex}.tar.gz`)
  const cachedOmp = join(cache, `omp-${RUNTIME_PROBE_ARTIFACTS.omp.version}-linux-arm64`)
  await downloadVerified(
    `https://registry-1.docker.io/v2/${RUNTIME_PROBE_ARTIFACTS.debian.repository}/blobs/${RUNTIME_PROBE_ARTIFACTS.debian.layerDigest}`,
    cachedRootfs,
    layerHex,
    'Debian ARM64 rootfs',
    { Authorization: `Bearer ${token}` }
  )
  await downloadVerified(
    RUNTIME_PROBE_ARTIFACTS.omp.url,
    cachedOmp,
    RUNTIME_PROBE_ARTIFACTS.omp.sha256,
    'OMP Linux ARM64'
  )
  await Promise.all([
    copyFile(cachedRootfs, join(assets, 'debian-rootfs.tgz')),
    copyFile(cachedOmp, join(assets, 'omp-linux-arm64'))
  ])

  const runtimeManifest = createRuntimeManifest(prootFiles)
  await writeFile(join(assets, 'manifest.json'), `${JSON.stringify(runtimeManifest, null, 2)}\n`)
  return output
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const output = process.argv[2] ?? join(repoRoot, 'android', 'runtime-probe', 'build', 'generated', 'runtimeProbePayload')
  prepareRuntimeProbeAssets(output)
    .then((path) => console.log(`Runtime probe assets ready: ${path}`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    })
}
