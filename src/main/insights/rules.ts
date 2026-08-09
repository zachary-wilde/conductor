import type { InsightDispatchSnapshot, InsightRule, InsightSnapshot } from './types'
import { MINUTE } from './types'

/**
 * The rule set.
 *
 * Every rule is a pure function of the snapshot. None of them infer intent from prose:
 * where the owner's original wording needed a semantic judgement ("the same fix", "an
 * architecture", "polishing"), the rule states the measurable fact instead and lets the
 * reader draw the conclusion. That is the difference between dry and untrue.
 */

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

const finished = (d: InsightDispatchSnapshot): boolean => d.status === 'completed'
const active = (d: InsightDispatchSnapshot): boolean => d.status === 'active' || d.status === 'starting'

function protectedHits(
  s: InsightSnapshot
): { dispatch: InsightDispatchSnapshot; file: string; guard: string }[] {
  return s.dispatches
    .flatMap((dispatch) =>
      dispatch.changedPaths.flatMap((raw) => {
        const file = norm(raw)
        const guard = dispatch.protectedPaths
          .map(norm)
          .find((p) => p.length > 0 && (file === p || file.startsWith(`${p}/`)))
        return guard ? [{ dispatch, file, guard }] : []
      })
    )
    .sort((a, b) => a.file.localeCompare(b.file))
}

/** Files touched by more than one still-running child. */
function overlaps(s: InsightSnapshot): { file: string; count: number }[] {
  const byFile = new Map<string, Set<string>>()
  for (const d of s.dispatches.filter(active)) {
    for (const raw of d.changedPaths) {
      const file = norm(raw)
      if (!byFile.has(file)) byFile.set(file, new Set())
      byFile.get(file)?.add(d.key)
    }
  }
  return [...byFile.entries()]
    .filter(([, owners]) => owners.size > 1)
    .map(([file, owners]) => ({ file, count: owners.size }))
    .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
}

const totalOut = (s: InsightSnapshot): number =>
  s.dispatches.reduce((n, d) => n + d.usage.outputTokens, 0)

const changedCount = (d: InsightDispatchSnapshot): number => d.changedPaths.length

export const RULES: readonly InsightRule[] = [
  {
    id: 'scope.do-not-touch',
    category: 'scope',
    severity: 'critical',
    cooldownMs: 30 * MINUTE,
    predicate: (s) => protectedHits(s).length > 0,
    format: (s) => {
      const hits = protectedHits(s)
      const first = hits[0]
      const rest = hits.length > 1 ? ` and ${plural(hits.length - 1, 'other protected path')}` : ''
      return {
        message: `"${first.dispatch.briefTitle}" changed ${first.file}${rest}, despite its do-not-touch list.`,
        dedupeKey: hits.map((h) => `${h.dispatch.key}:${h.file}`).join('|')
      }
    }
  },

  {
    id: 'coordination.file-overlap',
    category: 'coordination',
    severity: 'warning',
    cooldownMs: 15 * MINUTE,
    predicate: (s) => overlaps(s).length > 0,
    format: (s) => {
      const worst = overlaps(s)[0]
      return {
        message: `${worst.count} agents are editing ${worst.file}. That might cause conflicts.`,
        dedupeKey: `overlap:${worst.file}:${worst.count}`
      }
    }
  },

  {
    id: 'progress.implementer-no-diff',
    category: 'progress',
    severity: 'warning',
    cooldownMs: 20 * MINUTE,
    predicate: (s) =>
      s.dispatches.some((d) => finished(d) && d.role === 'lead-engineer' && changedCount(d) === 0),
    format: (s) => {
      const d = s.dispatches.find(
        (x) => finished(x) && x.role === 'lead-engineer' && changedCount(x) === 0
      )
      return {
        message: `"${d?.briefTitle}" finished as lead engineer without changing a single file.`,
        dedupeKey: `nodiff:${d?.key}`
      }
    }
  },

  {
    id: 'scope.auditor-wrote-code',
    category: 'scope',
    severity: 'warning',
    cooldownMs: 30 * MINUTE,
    predicate: (s) => s.dispatches.some((d) => d.role === 'auditor' && changedCount(d) > 0),
    format: (s) => {
      const d = s.dispatches.find((x) => x.role === 'auditor' && changedCount(x) > 0)
      return {
        message: `The auditor "${d?.briefTitle}" changed ${plural(changedCount(d!), 'file')}. Auditors are meant to report, not edit.`,
        dedupeKey: `auditorwrote:${d?.key}:${changedCount(d!)}`
      }
    }
  },

  {
    id: 'verification.exit-ok-verify-failed',
    category: 'verification',
    severity: 'critical',
    cooldownMs: 10 * MINUTE,
    predicate: (s) => s.dispatches.some((d) => finished(d) && d.verification?.ok === false),
    format: (s) => {
      const d = s.dispatches.find((x) => finished(x) && x.verification?.ok === false)
      return {
        message: `"${d?.briefTitle}" reported success, but verification failed.`,
        dedupeKey: `verifyfail:${d?.key}`
      }
    }
  },

  {
    id: 'verification.none-configured',
    category: 'verification',
    severity: 'info',
    cooldownMs: 60 * MINUTE,
    predicate: (s) =>
      s.dispatches.some((d) => finished(d) && changedCount(d) > 0 && d.verification === null),
    format: (s) => {
      const d = s.dispatches.find(
        (x) => finished(x) && changedCount(x) > 0 && x.verification === null
      )
      return {
        message: `"${d?.briefTitle}" changed ${plural(changedCount(d!), 'file')} and nothing verified it.`,
        dedupeKey: `noverify:${d?.key}`
      }
    }
  },

  {
    id: 'verification.suspiciously-green',
    category: 'verification',
    severity: 'info',
    cooldownMs: 60 * MINUTE,
    predicate: (s) => {
      const done = s.dispatches.filter(finished)
      return done.length >= 3 && done.every((d) => d.verification?.ok === true)
    },
    format: (s) => ({
      message: `${plural(s.dispatches.filter(finished).length, 'child')} finished and every verification passed. Suspiciously green.`,
      dedupeKey: `allgreen:${s.dispatches.filter(finished).length}`
    })
  },

  {
    id: 'coordination.context-requests',
    category: 'coordination',
    severity: 'warning',
    cooldownMs: 20 * MINUTE,
    predicate: (s) => s.dispatches.some((d) => d.contextRequests >= 3),
    format: (s) => {
      const d = s.dispatches.find((x) => x.contextRequests >= 3)
      return {
        message: `"${d?.briefTitle}" has asked for more context ${d?.contextRequests} times. It was probably under-briefed.`,
        dedupeKey: `ctxreq:${d?.key}:${d?.contextRequests}`
      }
    }
  },

  {
    id: 'progress.brief-retried',
    category: 'progress',
    severity: 'warning',
    cooldownMs: 20 * MINUTE,
    predicate: (s) => s.dispatches.some((d) => d.attempt >= 3),
    format: (s) => {
      const d = s.dispatches.find((x) => x.attempt >= 3)
      return {
        message: `"${d?.briefTitle}" has been attempted ${d?.attempt} times.`,
        dedupeKey: `attempt:${d?.briefId}:${d?.attempt}`
      }
    }
  },

  {
    id: 'progress.repeated-failures',
    category: 'progress',
    severity: 'warning',
    cooldownMs: 20 * MINUTE,
    predicate: (s) =>
      s.dispatches.filter((d) => d.status === 'failed' || d.status === 'interrupted').length >= 2,
    format: (s) => {
      const n = s.dispatches.filter((d) => d.status === 'failed' || d.status === 'interrupted').length
      return {
        message: `${plural(n, 'child')} failed or were interrupted in this fleet.`,
        dedupeKey: `failures:${n}`
      }
    }
  },

  {
    id: 'cost.one-dispatch-dominates',
    category: 'cost',
    severity: 'info',
    cooldownMs: 30 * MINUTE,
    predicate: (s) => {
      const total = totalOut(s)
      return total > 0 && s.dispatches.some((d) => d.usage.outputTokens / total >= 0.7)
    },
    format: (s) => {
      const total = totalOut(s)
      const d = s.dispatches.find((x) => x.usage.outputTokens / total >= 0.7)
      const pct = Math.round(((d?.usage.outputTokens ?? 0) / total) * 100)
      return {
        message: `"${d?.briefTitle}" used ${pct}% of this fleet's output tokens on its own.`,
        dedupeKey: `dominant:${d?.key}:${pct}`
      }
    }
  },

  {
    id: 'cost.above-role-median',
    category: 'cost',
    severity: 'info',
    cooldownMs: 30 * MINUTE,
    predicate: (s) =>
      s.dispatches.some((d) => {
        const median = s.roleMedianOutputTokens[d.role]
        return finished(d) && median !== undefined && median > 0 && d.usage.outputTokens >= median * 2
      }),
    format: (s) => {
      const d = s.dispatches.find((x) => {
        const m = s.roleMedianOutputTokens[x.role]
        return finished(x) && m !== undefined && m > 0 && x.usage.outputTokens >= m * 2
      })
      const median = s.roleMedianOutputTokens[d!.role] ?? 1
      const ratio = (d!.usage.outputTokens / median).toFixed(1)
      return {
        message: `"${d?.briefTitle}" used ${ratio}× the median output of recent ${d?.role} dispatches.`,
        dedupeKey: `costmedian:${d?.key}:${ratio}`
      }
    }
  },

  {
    id: 'progress.long-run-no-commits',
    category: 'progress',
    severity: 'info',
    cooldownMs: 30 * MINUTE,
    predicate: (s) =>
      s.dispatches.some((d) => active(d) && s.now - d.startedAt >= 45 * MINUTE && d.commits === 0),
    format: (s) => {
      const d = s.dispatches.find(
        (x) => active(x) && s.now - x.startedAt >= 45 * MINUTE && x.commits === 0
      )
      const mins = Math.floor((s.now - (d?.startedAt ?? s.now)) / MINUTE)
      return {
        message: `"${d?.briefTitle}" has been running ${mins} minutes with nothing committed.`,
        dedupeKey: `nocommit:${d?.key}:${Math.floor(mins / 15)}`
      }
    }
  },

  {
    id: 'scope.small-ask-big-diff',
    category: 'scope',
    severity: 'warning',
    cooldownMs: 45 * MINUTE,
    predicate: (s) =>
      s.openingPromptWords > 0 &&
      s.openingPromptWords <= 25 &&
      s.dispatches.reduce((n, d) => n + changedCount(d), 0) >= 20,
    format: (s) => {
      const files = s.dispatches.reduce((n, d) => n + changedCount(d), 0)
      return {
        message: `You asked for something in ${plural(s.openingPromptWords, 'word')}. It changed ${plural(files, 'file')}.`,
        dedupeKey: `smallask:${s.openingPromptWords}:${files}`
      }
    }
  },

  {
    id: 'progress.one-child-did-everything',
    category: 'progress',
    severity: 'info',
    cooldownMs: 45 * MINUTE,
    predicate: (s) => {
      const done = s.dispatches.filter(finished)
      const total = done.reduce((n, d) => n + changedCount(d), 0)
      return done.length >= 2 && total > 0 && done.some((d) => changedCount(d) / total >= 0.8)
    },
    format: (s) => {
      const done = s.dispatches.filter(finished)
      const total = done.reduce((n, d) => n + changedCount(d), 0)
      const d = done.find((x) => changedCount(x) / total >= 0.8)
      const pct = Math.round((changedCount(d!) / total) * 100)
      return {
        message: `"${d?.briefTitle}" produced ${pct}% of this fleet's file changes. The others were mostly idle.`,
        dedupeKey: `onechild:${d?.key}:${pct}`
      }
    }
  }
]
