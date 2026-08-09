import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename } from 'node:path'
import type {
  DeleteBranchResult,
  MergeBranchResult,
  MergeFailure,
  MergeLanded,
  MergeOptions,
  MergePreviewEntry,
  MergePreviewResult,
  WorktreeInfo
} from '@shared/types'

const execFileP = promisify(execFile)

/** Rejects with a friendly error if git isn't installed or path isn't a repo. */
async function git(repoPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP('git', ['-C', repoPath, ...args], {
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true
    })
    return stdout
  } catch (e) {
    const err = e as Error & { stderr?: string }
    throw new Error(err.stderr?.trim() || err.message)
  }
}

interface GitExit {
  code: number
  stdout: string
  stderr: string
}

/**
 * Same invocation as `git`, but a nonzero exit is data rather than a throw:
 * `merge` and `merge-tree` report conflicts through the exit code and print
 * the useful detail on stdout, which the throwing helper discards.
 */
async function gitExit(repoPath: string, args: string[]): Promise<GitExit> {
  try {
    const { stdout, stderr } = await execFileP('git', ['-C', repoPath, ...args], {
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true
    })
    return { code: 0, stdout, stderr }
  } catch (e) {
    const err = e as Error & { code?: unknown; stdout?: string; stderr?: string }
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message
    }
  }
}

export async function isRepo(dir: string): Promise<boolean> {
  try {
    const out = (await git(dir, ['rev-parse', '--is-inside-work-tree'])).trim()
    return out === 'true'
  } catch {
    return false
  }
}

export async function currentBranch(repoPath: string): Promise<string> {
  const out = (await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  return out === 'HEAD' ? '(detached)' : out
}

/**
 * The SHA a revision points at right now.
 *
 * A dispatch records this before its worktree is created and branches from the SHA
 * rather than from `HEAD`, so a commit landing on the base between measurement and
 * creation cannot make the child's later diff look like work it never did.
 */
export async function resolveCommit(repoPath: string, revision = 'HEAD'): Promise<string> {
  return (await git(repoPath, ['rev-parse', revision])).trim()
}

/**
 * What the repository looks like right now, in the plainest terms: the branch,
 * what changed recently, and what is uncommitted.
 *
 * Read-only and best-effort — a snapshot that cannot be taken is a shorter
 * snapshot, never a failure. It exists so a deliberation argues about the
 * project as it actually is instead of what someone remembers.
 */
export async function repoSnapshot(repoPath: string, commitLimit = 10): Promise<string> {
  const branch = await gitExit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const log = await gitExit(repoPath, ['log', `-${commitLimit}`, '--pretty=%h %s'])
  const status = await gitExit(repoPath, ['status', '--porcelain'])
  const sections = [`branch: ${branch.stdout.trim() || '(unknown)'}`]
  const commits = lines(log.stdout)
  sections.push(commits.length > 0 ? `recent commits:\n${commits.join('\n')}` : 'recent commits: (none)')
  const dirty = lines(status.stdout)
  sections.push(
    dirty.length > 0 ? `uncommitted changes:\n${dirty.join('\n')}` : 'uncommitted changes: (working tree clean)'
  )
  return sections.join('\n\n')
}

export interface BranchInfo {
  name: string
  current: boolean
}

export async function listBranches(repoPath: string): Promise<BranchInfo[]> {
  const out = await git(repoPath, ['branch', '--list', '--format=%(HEAD)%(refname:short)'])
  return out
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .map((l) => {
      const current = l.startsWith('*')
      return { name: current ? l.slice(1).trim() : l.trim(), current }
    })
}

export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  const out = await git(repoPath, ['worktree', 'list', '--porcelain'])
  const blocks = out.split('\n\n').map((b) => b.trim()).filter(Boolean)
  return blocks.map((block) => {
    const fields: Record<string, string> = {}
    for (const line of block.split('\n')) {
      const sp = line.indexOf(' ')
      if (sp > 0) fields[line.slice(0, sp)] = line.slice(sp + 1)
      else fields[line] = ''
    }
    const branch = fields['branch'] ? fields['branch'].replace(/^refs\/heads\//, '') : null
    return {
      path: fields['worktree'] ?? '',
      head: fields['HEAD'] ?? null,
      branch,
      bare: fields['bare'] === 'true',
      detached: 'detached' in fields
    }
  })
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'branch'
}

export function worktreePathFor(repoPath: string, branch: string, root: string): string {
  const repoSlug = slug(basename(repoPath))
  const branchSlug = slug(branch)
  return `${root}/${repoSlug}/${branchSlug}`.replace(/\\/g, '/')
}

/**
 * Create a worktree. If `newBranch` is set or the branch doesn't exist, a new
 * branch is created from `baseBranch` (or HEAD). Returns the new worktree path.
 */
export async function createWorktree(
  repoPath: string,
  branch: string,
  opts: { baseBranch?: string; newBranch?: boolean; targetPath: string }
): Promise<string> {
  const { targetPath, baseBranch, newBranch } = opts
  const exists = await branchExists(repoPath, branch)
  const makeNew = newBranch || !exists
  const args = ['worktree', 'add']
  if (makeNew) {
    args.push('-b', branch, targetPath, baseBranch ?? 'HEAD')
  } else {
    args.push(targetPath, branch)
  }
  await git(repoPath, args)
  return targetPath
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await git(repoPath, ['rev-parse', '--verify', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

export async function removeWorktree(
  repoPath: string,
  targetPath: string,
  opts: { force?: boolean; deleteBranch?: string } = {}
): Promise<void> {
  await git(repoPath, [
    'worktree',
    'remove',
    targetPath,
    ...(opts.force ? ['--force'] : [])
  ])
  if (opts.deleteBranch) {
    try {
      await git(repoPath, ['branch', '-D', opts.deleteBranch])
    } catch {
      /* branch may be checked out elsewhere or already gone */
    }
  }
}

export async function repoName(repoPath: string): Promise<string> {
  try {
    const out = (await git(repoPath, ['rev-parse', '--show-toplevel'])).trim()
    return basename(out)
  } catch {
    return basename(repoPath)
  }
}

/**
 * Paths `branch` changes relative to where it left `baseBranch`. The three-dot
 * range diffs against the merge base, so commits landed on the base after the
 * branch was cut are not misreported as the branch's own work.
 */
export async function changedFiles(repoPath: string, branch: string, baseBranch: string): Promise<string[]> {
  return lines(await git(repoPath, ['diff', '--name-only', `${baseBranch}...${branch}`]))
}

/** One changed file's metadata for a branch review. */
export interface ReviewFileMeta {
  path: string
  /** Rename/copy source path; null unless `status === 'renamed'`. */
  oldPath: string | null
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  /** Lines added / removed; null when the file is binary. */
  additions: number | null
  deletions: number | null
  binary: boolean
}

/**
 * Per-file change metadata for `branch` against its merge base with `baseBranch`
 * (three-dot, matching {@link changedFiles}). Rename/copy detection is on (`-M`),
 * so a moved file reports its `oldPath` once instead of as a delete + add pair.
 * Two `-z` passes are merged by destination path: `--name-status` is the
 * authoritative status + rename source, `--numstat` supplies the line counts.
 */
export async function reviewFileList(
  repoPath: string,
  branch: string,
  baseBranch: string
): Promise<ReviewFileMeta[]> {
  const range = `${baseBranch}...${branch}`
  const status = parseNameStatusZ(await git(repoPath, ['diff', '-M', '--name-status', '-z', range]))
  const counts = parseNumstatZ(await git(repoPath, ['diff', '-M', '--numstat', '-z', range]))
  return status.map((s) => {
    const c = counts.get(s.path)
    const binary = c?.binary ?? false
    return {
      ...s,
      additions: binary ? null : c?.additions ?? 0,
      deletions: binary ? null : c?.deletions ?? 0,
      binary
    }
  })
}

/**
 * The unified diff text for one file in the merge-base range. A rename passes
 * both paths so the move shows as one patch rather than an add + delete. The
 * caller bounds the size; this returns git's full output for the path(s).
 */
export async function fileUnifiedDiff(
  repoPath: string,
  branch: string,
  baseBranch: string,
  path: string,
  oldPath: string | null
): Promise<string> {
  const range = `${baseBranch}...${branch}`
  const paths = oldPath ? [oldPath, path] : [path]
  return git(repoPath, ['diff', '-M', range, '--', ...paths])
}

/** Split a NUL-terminated git `-z` stream into tokens, dropping the trailing empty. */
function splitZ(out: string): string[] {
  const parts = out.split('\0')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts
}

/** Parse `diff -M --name-status -z`: `STATUS\0path\0`, or `Rxxx\0old\0new\0` for a rename/copy. */
function parseNameStatusZ(out: string): Omit<ReviewFileMeta, 'additions' | 'deletions' | 'binary'>[] {
  const toks = splitZ(out)
  const result: Omit<ReviewFileMeta, 'additions' | 'deletions' | 'binary'>[] = []
  for (let i = 0; i < toks.length; ) {
    const code = toks[i++]
    if (!code) continue
    const kind = code[0]
    if (kind === 'R' || kind === 'C') {
      const oldPath = toks[i++] ?? ''
      const newPath = toks[i++] ?? ''
      result.push({ path: newPath, oldPath, status: 'renamed' })
    } else {
      const path = toks[i++] ?? ''
      result.push({ path, oldPath: null, status: kind === 'A' ? 'added' : kind === 'D' ? 'deleted' : 'modified' })
    }
  }
  return result
}

/** Parse `diff -M --numstat -z`: `add\tdel\tpath\0`, or `add\tdel\t\0old\0new\0` for a rename. */
function parseNumstatZ(out: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const toks = splitZ(out)
  const map = new Map<string, { additions: number; deletions: number; binary: boolean }>()
  for (let i = 0; i < toks.length; ) {
    const record = toks[i++]
    if (!record) continue
    const [add, del, inlinePath] = record.split('\t')
    const binary = add === '-' || del === '-'
    const meta = { additions: binary ? 0 : Number(add), deletions: binary ? 0 : Number(del), binary }
    if (inlinePath) {
      map.set(inlinePath, meta)
    } else {
      // Rename: the destination path is the second of the two trailing tokens.
      i++
      const newPath = toks[i++] ?? ''
      map.set(newPath, meta)
    }
  }
  return map
}

/**
 * Report what landing each branch would do, without touching the index, the
 * working tree or any ref.
 */
export async function mergePreview(
  repoPath: string,
  branches: readonly string[],
  baseBranch: string
): Promise<MergePreviewResult> {
  if (!(await branchExists(repoPath, baseBranch))) {
    return { ok: false, error: `base branch '${baseBranch}' does not exist` }
  }
  const entries: MergePreviewEntry[] = []
  for (const branch of branches) entries.push(await previewBranch(repoPath, branch, baseBranch))
  // Cross-branch overlap is a shared-file comparison, not a trial merge: two
  // branches editing the same file usually collide, and N^2 real merges to be
  // certain would cost far more than the warning is worth. Overlap therefore
  // means "inspect these", not "these definitely conflict".
  for (const entry of entries) {
    const own = new Set(entry.files)
    for (const other of entries) {
      if (other === entry) continue
      const shared = other.files.filter((file) => own.has(file))
      if (shared.length > 0) entry.overlaps.push({ branch: other.branch, files: shared })
    }
  }
  return { ok: true, baseBranch, entries }
}

/**
 * Merge `branch` into `baseBranch` in the repo's main working tree. Refuses to
 * start unless the tree is clean, and any failure — conflict included — leaves
 * the repo exactly as it was found, on the branch it was found on.
 */
export async function mergeBranch(
  repoPath: string,
  branch: string,
  baseBranch: string,
  options: MergeOptions = {}
): Promise<MergeBranchResult> {
  if (!(await branchExists(repoPath, branch))) {
    // Nothing ran, so nothing needed restoring.
    return { ok: false, error: `branch '${branch}' does not exist`, restored: true }
  }
  if (!(await branchExists(repoPath, baseBranch))) {
    return { ok: false, error: `base branch '${baseBranch}' does not exist`, restored: true }
  }

  // Untracked files are ignored: git refuses the merge itself if one would be
  // overwritten, and that refusal is already non-destructive.
  const dirty = lines(await git(repoPath, ['status', '--porcelain', '--untracked-files=no'])).map(statusPath)
  if (dirty.length > 0) {
    return { ok: false, error: 'working tree has uncommitted changes; commit or stash them first', paths: dirty, restored: true }
  }

  let files: string[]
  try {
    files = await changedFiles(repoPath, branch, baseBranch)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), restored: true }
  }

  const originalRef = await symbolicHead(repoPath)
  const originalHead = (await git(repoPath, ['rev-parse', 'HEAD'])).trim()
  const needsCheckout = originalRef !== baseBranch
  if (needsCheckout) {
    const checkout = await gitExit(repoPath, ['checkout', baseBranch])
    if (checkout.code !== 0) {
      return { ok: false, error: `cannot check out '${baseBranch}': ${firstLine(checkout.stderr, checkout.stdout)}`, restored: true }
    }
  }

  const baseHead = (await git(repoPath, ['rev-parse', 'HEAD'])).trim()
  const result = await attemptMerge(repoPath, branch, baseBranch, options, baseHead, files)
  const restoreFailure = needsCheckout ? await restoreHead(repoPath, originalRef, originalHead) : null
  if (result.ok) return { ...result, warning: restoreFailure }
  return restoreFailure === null ? result : { ...result, error: `${result.error}; ${restoreFailure}`, restored: false }
}

/**
 * Delete a branch that has already landed. Uses `-d`, never `-D`, so git itself
 * refuses when the branch is not an ancestor of HEAD — a squash-merged branch is
 * refused too, because its commits genuinely do not exist on the base.
 */
export async function deleteMergedBranch(repoPath: string, branch: string): Promise<DeleteBranchResult> {
  if (!(await branchExists(repoPath, branch))) return { ok: false, error: `branch '${branch}' does not exist` }
  const deleted = await gitExit(repoPath, ['branch', '-d', branch])
  if (deleted.code !== 0) {
    return { ok: false, error: firstLine(deleted.stderr, deleted.stdout) || `could not delete '${branch}'` }
  }
  return { ok: true, branch }
}

async function previewBranch(repoPath: string, branch: string, baseBranch: string): Promise<MergePreviewEntry> {
  const entry: MergePreviewEntry = {
    branch,
    files: [],
    conflictsWithBase: null,
    conflictPaths: [],
    overlaps: [],
    error: null
  }
  if (!(await branchExists(repoPath, branch))) {
    entry.error = `branch '${branch}' does not exist`
    return entry
  }
  try {
    entry.files = await changedFiles(repoPath, branch, baseBranch)
  } catch (e) {
    entry.error = e instanceof Error ? e.message : String(e)
    return entry
  }
  // `merge-tree --write-tree` merges in memory: it writes objects to the object
  // database but never moves a ref, the index or a file on disk.
  const trial = await gitExit(repoPath, ['merge-tree', '--write-tree', '--name-only', baseBranch, branch])
  if (trial.code === 0) {
    entry.conflictsWithBase = false
    return entry
  }
  // Exit 1 is a conflicted merge: line one is the resulting tree, then the
  // conflicted paths, then a blank line and git's messages.
  if (trial.code === 1 && trial.stdout.trim().length > 0) {
    entry.conflictsWithBase = true
    for (const line of trial.stdout.split('\n').slice(1)) {
      const path = line.trim()
      if (path.length === 0) break
      entry.conflictPaths.push(path)
    }
    return entry
  }
  entry.error = firstLine(trial.stderr, trial.stdout) || `git merge-tree exited with code ${trial.code}`
  return entry
}

async function attemptMerge(
  repoPath: string,
  branch: string,
  baseBranch: string,
  options: MergeOptions,
  baseHead: string,
  files: string[]
): Promise<Omit<MergeLanded, 'warning'> | MergeFailure> {
  const text =
    options.message ??
    (options.squash ? `Squash merge ${branch} into ${baseBranch}` : `Merge ${branch} into ${baseBranch}`)
  const merged = await gitExit(
    repoPath,
    options.squash ? ['merge', '--squash', branch] : ['merge', '--no-ff', '--no-edit', '-m', text, branch]
  )
  if (merged.code !== 0) {
    const paths = lines((await gitExit(repoPath, ['diff', '--name-only', '--diff-filter=U'])).stdout)
    const restored = await abortMerge(repoPath, baseHead)
    const detail = paths.length > 0 ? `merge conflict in ${paths.join(', ')}` : firstLine(merged.stderr, merged.stdout)
    return { ok: false, error: detail || `git merge exited with code ${merged.code}`, paths, restored }
  }

  // A squash stages the result without committing; nothing staged means the
  // base already contained every change.
  if (options.squash && lines((await gitExit(repoPath, ['diff', '--cached', '--name-only'])).stdout).length > 0) {
    const committed = await gitExit(repoPath, ['commit', '-m', text])
    if (committed.code !== 0) {
      const restored = await abortMerge(repoPath, baseHead)
      return { ok: false, error: firstLine(committed.stderr, committed.stdout) || 'squash commit failed', restored }
    }
  }

  const head = (await git(repoPath, ['rev-parse', 'HEAD'])).trim()
  const alreadyMerged = head === baseHead
  return { ok: true, branch, commit: alreadyMerged ? null : head, alreadyMerged, files: alreadyMerged ? [] : files }
}

/**
 * Put the base back exactly as it was found, and say whether that worked.
 * `merge --abort` covers a real merge; a squash never sets MERGE_HEAD so it
 * needs `reset --merge`; the hard reset to the recorded tip is the last resort
 * for a merge that failed before git recorded any state.
 *
 * The return value is evidence, not optimism: the recovery command's exit code
 * is not enough, so the repository is re-read and compared with the tip it
 * started from. Anything the operator is told about restoration comes from
 * here.
 */
async function abortMerge(repoPath: string, baseHead: string): Promise<boolean> {
  const recovered =
    (await gitExit(repoPath, ['merge', '--abort'])).code === 0 ||
    (await gitExit(repoPath, ['reset', '--merge'])).code === 0 ||
    (await gitExit(repoPath, ['reset', '--hard', baseHead])).code === 0
  if (!recovered) return false
  const head = (await gitExit(repoPath, ['rev-parse', 'HEAD'])).stdout.trim()
  if (head !== baseHead) return false
  // Untracked files are none of this function's business; a dirty tracked tree
  // or a merge still in progress is.
  const dirty = lines((await gitExit(repoPath, ['status', '--porcelain', '--untracked-files=no'])).stdout)
  const merging = (await gitExit(repoPath, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'])).code === 0
  return dirty.length === 0 && !merging
}

/** Branch name at HEAD, or null when HEAD is detached. */
async function symbolicHead(repoPath: string): Promise<string | null> {
  const head = await gitExit(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const name = head.stdout.trim()
  return head.code === 0 && name.length > 0 ? name : null
}

/** Returns the failure text when the original checkout could not be restored. */
async function restoreHead(repoPath: string, ref: string | null, head: string): Promise<string | null> {
  const back = await gitExit(repoPath, ['checkout', ref ?? head])
  return back.code === 0 ? null : `could not return to '${ref ?? head}': ${firstLine(back.stderr, back.stdout)}`
}

function lines(out: string): string[] {
  return out
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
}

/** `XY path` from `status --porcelain`; a rename reports its destination. */
function statusPath(line: string): string {
  const path = line.slice(3).trim()
  const arrow = path.lastIndexOf(' -> ')
  return arrow === -1 ? path : path.slice(arrow + 4)
}

function firstLine(...candidates: string[]): string {
  for (const candidate of candidates) {
    const [first] = lines(candidate)
    if (first) return first
  }
  return ''
}
