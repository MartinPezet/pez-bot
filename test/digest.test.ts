import { describe, expect, it } from 'vitest'
import { dayHeader, dayKey, Digest, DigestBatch, DigestSetupError, renderBatch } from '../src/digest/digest.js'
import { DryRunGitHub } from '../src/github/dryrun.js'
import { kv, openDb } from '../src/state/db.js'
import { FakeGitHub } from './fakes.js'

const TZ = 'Europe/London'
const mon = new Date('2026-10-05T08:30:00Z') // Mon 5 Oct, 09:30 BST

function setup(o: { autoCreate?: boolean; withThread?: boolean } = {}) {
  const gh = new FakeGitHub('acme/digest')
  if (o.withThread !== false) gh.discussion.threads.push({ id: 'D1', title: 'EarthScope' })
  const db = openDb(':memory:')
  const digest = new Digest({ gh, db, category: 'Daily Digest', title: 'EarthScope', autoCreate: o.autoCreate ?? false, tz: TZ })
  return { gh, db, digest }
}
const batch = (text: string, at = mon) => {
  const b = new DigestBatch()
  b.add('📝', text, 'https://github.com/acme/app/pull/1', at)
  return b
}

describe('digest rendering', () => {
  it('formats one line per event in local time, then sections', () => {
    const b = batch('Proposal opened for #12')
    b.add('🚧', 'Blocked #13', undefined, new Date('2026-10-05T09:05:00Z'))
    b.addSection('**Pipeline** ready 2')
    expect(renderBatch(b, TZ)).toBe(
      '- 09:30 📝 Proposal opened for #12 — https://github.com/acme/app/pull/1\n- 10:05 🚧 Blocked #13\n\n**Pipeline** ready 2',
    )
  })

  it('anchors the day in the configured time zone', () => {
    const lateUtc = new Date('2026-10-05T23:30:00Z') // already Tuesday in London
    expect(dayKey(lateUtc, TZ)).toBe('2026-10-06')
    expect(dayHeader(mon, TZ)).toBe('📅 Mon 5 Oct 2026')
  })
})

describe('digest posting', () => {
  it('posts nothing for an empty batch', async () => {
    const { gh, digest } = setup()
    expect(await digest.post(new DigestBatch(), mon)).toBe(false)
    expect(gh.writes).toEqual([])
  })

  it('opens the day with a dated top-level comment, then replies in that thread', async () => {
    const { gh, digest } = setup()
    await digest.post(batch('first'), mon)
    await digest.post(batch('second'), new Date('2026-10-05T12:00:00Z'))
    const [day, reply] = gh.discussion.comments
    expect(day?.body.startsWith('📅 Mon 5 Oct 2026\n\n- 09:30 📝 first')).toBe(true)
    expect(day?.replyTo).toBeUndefined()
    expect(reply?.replyTo).toBe(day?.id)
    expect(reply?.body).toContain('second')
  })

  it('starts a new thread the next day', async () => {
    const { gh, digest } = setup()
    await digest.post(batch('mon'), mon)
    await digest.post(batch('tue'), new Date('2026-10-06T08:00:00Z'))
    expect(gh.discussion.comments.map(c => c.replyTo)).toEqual([undefined, undefined])
    expect(gh.discussion.comments[1]?.body.startsWith('📅 Tue 6 Oct 2026')).toBe(true)
  })

  it('recovers when the cached day comment was deleted', async () => {
    const { gh, db, digest } = setup()
    await digest.post(batch('first'), mon)
    const dayId = kv.get(db, 'digest.day.2026-10-05')!
    gh.discussion.deleted.add(dayId)
    await digest.post(batch('second'), mon)
    const last = gh.discussion.comments.at(-1)
    expect(last?.replyTo).toBeUndefined()
    expect(last?.body.startsWith('📅 Mon 5 Oct 2026')).toBe(true)
    expect(kv.get(db, 'digest.day.2026-10-05')).toBe(last?.id)
  })

  it('recovers when the cached discussion itself was deleted and recreated', async () => {
    const { gh, digest } = setup()
    await digest.post(batch('first'), mon)
    gh.discussion.deleted.add('D1')
    gh.discussion.threads.push({ id: 'D2', title: 'EarthScope' })
    await digest.post(batch('second'), mon)
    expect(gh.discussion.comments.at(-1)?.discussionId).toBe('D2')
  })

  it('says exactly what to create when the discussion or category is missing', async () => {
    const noThread = setup({ withThread: false })
    await expect(noThread.digest.post(batch('x'), mon)).rejects.toThrow(/Create a discussion titled "EarthScope" in the "Daily Digest" category of acme\/digest/)
    const noCat = setup()
    noCat.gh.discussion.categories = []
    await expect(noCat.digest.post(batch('x'), mon)).rejects.toThrow(DigestSetupError)
    const off = setup()
    off.gh.discussion.enabled = false
    await expect(off.digest.post(batch('x'), mon)).rejects.toThrow(/not enabled/)
  })

  it('creates the discussion itself when DIGEST_AUTO_CREATE is on', async () => {
    const { gh, digest } = setup({ autoCreate: true, withThread: false })
    await digest.post(batch('x'), mon)
    expect(gh.writes[0]).toBe('create discussion EarthScope')
  })

  it('never caches placeholder ids in dry run', async () => {
    const { gh, db } = setup()
    const dry = new DryRunGitHub(gh)
    const digest = new Digest({ gh: dry, db, category: 'Daily Digest', title: 'EarthScope', autoCreate: false, tz: TZ })
    await digest.post(batch('x'), mon)
    expect(dry.intents.map(i => i.action)).toEqual(['add discussion comment'])
    expect(kv.get(db, 'digest.day.2026-10-05')).toBeUndefined()
    expect(gh.discussion.comments).toEqual([])
  })
})
