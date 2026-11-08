import { describe, expect, it } from 'vitest'
import { failureKeys, newFailures } from '../src/jobs/baseline.js'

const base = `$ npm run typecheck
app/a.vue(519,12): error TS2322: Type 'x' is not assignable to type 'y'.
app/b.vue(554,3): error TS2345: Argument is not assignable.`

describe('newFailures', () => {
  it('ignores errors the default branch already has, even when line numbers move', () => {
    const head = base.replace('(519,12)', '(530,12)')
    expect(newFailures(head, base)).toEqual([])
  })

  it('reports an error the branch adds', () => {
    const head = `${base}\napp/c.vue(10,1): error TS2304: Cannot find name 'z'.`
    expect(newFailures(head, base)).toEqual(["app/c.vue: error TS2304: Cannot find name 'z'."])
  })

  it('treats output with no recognisable errors as new, so it is never waved through', () => {
    expect(newFailures('Segmentation fault', base)).toHaveLength(1)
  })

  it('strips colour codes before comparing', () => {
    expect([...failureKeys('\u001b[31merror\u001b[0m in a.ts:3:4')]).toEqual(['error in a.ts'])
  })
})
