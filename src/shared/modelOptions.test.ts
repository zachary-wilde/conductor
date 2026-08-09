import { describe, expect, test } from 'vitest'
import { HARNESS_MODEL_OPTIONS, STATIC_MODEL_CATALOGUES, modelOptionsFor } from './types'

const live = { models: ['gpt-5.6-sol', 'gpt-5.5'], discovered: true }

describe('model dropdown options', () => {
  test('offers the catalogue as-is when the selection is listed', () => {
    expect(modelOptionsFor(live, 'gpt-5.5')).toEqual({ values: live.models, unlisted: null })
  })

  test('offers the catalogue as-is when nothing is selected', () => {
    expect(modelOptionsFor(live, '')).toEqual({ values: live.models, unlisted: null })
  })

  // A select whose value matches no option renders as its first entry, so a
  // dropped model would show — and then save — a model the user never chose.
  test('keeps a stored model the catalogue does not offer, first and flagged', () => {
    expect(modelOptionsFor(live, 'gpt-5.1-codex')).toEqual({
      values: ['gpt-5.1-codex', 'gpt-5.6-sol', 'gpt-5.5'],
      unlisted: 'gpt-5.1-codex'
    })
  })

  test('survives a harness with no catalogue at all', () => {
    expect(modelOptionsFor(undefined, 'opus')).toEqual({ values: ['opus'], unlisted: 'opus' })
    expect(modelOptionsFor(undefined, '')).toEqual({ values: [], unlisted: null })
  })
})

describe('static catalogues', () => {
  test('mirror the fallback lists and admit they are not discovered', () => {
    for (const [id, catalogue] of Object.entries(STATIC_MODEL_CATALOGUES)) {
      expect(catalogue.discovered).toBe(false)
      expect(catalogue.models).toBe(HARNESS_MODEL_OPTIONS[id as keyof typeof HARNESS_MODEL_OPTIONS])
    }
  })
})
