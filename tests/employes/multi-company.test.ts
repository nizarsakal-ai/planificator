import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Prisma } from '@prisma/client'
import { resolveCompanyAccess } from '../../src/lib/company-access'
import { attachEmployee } from '../../src/lib/actions/employee-membership.core'

const profile = (companyId: string, role = 'EMPLOYEE', active = true) => ({ companyId, role, active, company: { active: true } })
const account = () => ({ role: 'ADMIN', companyId: 'noiza', company: { active: true }, employeeProfiles: [profile('noiza', 'ADMIN'), profile('galya')] })

test('same login has ADMIN rights in Noiza and EMPLOYEE rights in Galya', () => {
  assert.deepEqual(resolveCompanyAccess(account(), 'noiza'), { companyId: 'noiza', role: 'ADMIN' })
  assert.deepEqual(resolveCompanyAccess(account(), 'galya'), { companyId: 'galya', role: 'EMPLOYEE' })
})
test('forged company does not grant membership', () => {
  assert.deepEqual(resolveCompanyAccess(account(), 'foreign'), { companyId: 'noiza', role: 'ADMIN' })
})
test('archiving Noiza preserves Galya access without primary-company fallback', () => {
  const a = account(); a.employeeProfiles[0].active = false
  assert.deepEqual(resolveCompanyAccess(a, 'noiza'), { companyId: 'galya', role: 'EMPLOYEE' })
})
test('inactive company is inaccessible and no memberships means no session', () => {
  const a = account(); a.employeeProfiles.forEach(p => p.company.active = false)
  assert.equal(resolveCompanyAccess(a, 'noiza'), null)
})
test('legacy admin without employee profile keeps primary company access', () => {
  assert.deepEqual(resolveCompanyAccess({ ...account(), employeeProfiles: [] }), { companyId: 'noiza', role: 'ADMIN' })
})
test('Super Admin retains global role', () => {
  assert.deepEqual(resolveCompanyAccess({ ...account(), role: 'SUPER_ADMIN' }, 'galya'), { companyId: 'noiza', role: 'SUPER_ADMIN' })
})

function fake(existing: object | null, member: object | null = null) {
  const calls: { operation: string; args: any }[] = []
  const tx = {
    user: {
      findFirst: async (args: unknown) => { calls.push({ operation: 'lookup', args }); return existing },
      create: async (args: any) => { calls.push({ operation: 'createUser', args }); return { id: 'new', ...args.data } },
    },
    employee: {
      findFirst: async (args: unknown) => { calls.push({ operation: 'profile', args }); return member },
      create: async (args: unknown) => { calls.push({ operation: 'createEmployee', args }) },
      update: async (args: unknown) => { calls.push({ operation: 'reactivate', args }) },
    },
  } as unknown as Prisma.TransactionClient
  return { tx, calls }
}
const input = { companyId: 'galya', email: ' Person@example.com ', firstName: 'Test', lastName: 'Person', password: 'Temporary123' }
const existing = { id: 'original', email: 'person@example.com', password: 'unchanged', companyId: 'noiza', role: 'ADMIN', active: true }

test('existing email adds company-local employee without creating user or hashing password', async () => {
  const { tx, calls } = fake(existing)
  await attachEmployee(tx, input, async () => { throw Error('must not hash') })
  assert.deepEqual(calls.find(c => c.operation === 'profile')?.args.where, { userId: 'original', companyId: 'galya' })
  assert.equal(calls.find(c => c.operation === 'createEmployee')?.args.data.role, 'EMPLOYEE')
  assert.equal(calls.some(c => c.operation === 'createUser'), false)
  assert.equal(existing.password, 'unchanged')
})
test('new email creates one login and one membership with normalized email', async () => {
  const { tx, calls } = fake(null)
  await attachEmployee(tx, input, async () => 'hash')
  assert.equal(calls.find(c => c.operation === 'createUser')?.args.data.email, 'person@example.com')
  assert.equal(calls.find(c => c.operation === 'createUser')?.args.data.password, 'hash')
  assert.equal(calls.find(c => c.operation === 'createEmployee')?.args.data.userId, 'new')
})
test('duplicate within company remains rejected', async () => {
  const { tx, calls } = fake(existing, { id: 'employee', active: true })
  await assert.rejects(attachEmployee(tx, input, async () => ''), /déjà/)
  assert.equal(calls.some(c => c.operation === 'createEmployee'), false)
})
test('reactivation preserves employee id and historical records', async () => {
  const { tx, calls } = fake(existing, { id: 'old-profile', active: false })
  await attachEmployee(tx, input, async () => '')
  assert.deepEqual(calls.find(c => c.operation === 'reactivate')?.args, { where: { id: 'old-profile' }, data: { active: true } })
})
test('disabled login cannot be reactivated by another company', async () => {
  const { tx } = fake({ ...existing, active: false })
  await assert.rejects(attachEmployee(tx, input, async () => ''), /Super Admin/)
})
