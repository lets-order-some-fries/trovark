import { describe, expect, it } from 'vitest'
import { grade } from '../src/scoring/score.js'

describe('grade bands (A>=85, B>=70, C>=55, D>=40, F<40; +/- at band edges)', () => {
  it.each([
    [100, 'A+'], [96, 'A+'], [95, 'A'], [90, 'A'], [89, 'A-'], [85, 'A-'],
    [84, 'B+'], [80, 'B+'], [79, 'B'], [75, 'B'], [74, 'B-'], [70, 'B-'],
    [69, 'C+'], [65, 'C+'], [64, 'C'], [60, 'C'], [59, 'C-'], [55, 'C-'],
    [54, 'D+'], [50, 'D+'], [49, 'D'], [45, 'D'], [44, 'D-'], [40, 'D-'],
    [39, 'F'], [0, 'F'],
  ])('grade(%i) === %s', (n, expected) => {
    expect(grade(n)).toBe(expected)
  })
})

import { gradeFloor } from '../src/scoring/score.js'

// The CLI's --fail-under thresholds come from here, derived from grade()
// itself rather than a second hand-typed table that can drift from it.
describe('gradeFloor: the lowest score grade() maps to a label', () => {
  it.each([
    ['A+', 96], ['A', 85], ['A-', 85],
    ['B+', 80], ['B', 70], ['B-', 70],
    ['C+', 65], ['C', 55], ['C-', 55],
    ['D+', 50], ['D', 40], ['D-', 40],
  ])('gradeFloor(%s) === %i', (label, floor) => {
    expect(gradeFloor(label)).toBe(floor)
  })
  it('every modified label is exact: grade(floor) is the label and grade(floor - 1) is not', () => {
    for (const letter of ['A', 'B', 'C', 'D']) {
      for (const mod of ['+', '-']) {
        const label = `${letter}${mod}`
        const floor = gradeFloor(label)!
        expect(grade(floor)).toBe(label)
        expect(grade(floor - 1)).not.toBe(label)
      }
    }
  })
  it('a bare letter is the whole band: the same floor as its minus', () => {
    for (const letter of ['A', 'B', 'C', 'D']) expect(gradeFloor(letter)).toBe(gradeFloor(`${letter}-`))
  })
  it('accepts lower case', () => {
    expect(gradeFloor('b+')).toBe(80)
  })
  it.each(['B*', 'B++', '+B', 'F', 'F+', 'E', '', 'AB', 'A+ '])('returns undefined for "%s"', (label) => {
    expect(gradeFloor(label)).toBeUndefined()
  })
})
