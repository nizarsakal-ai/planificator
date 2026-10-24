import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { executeMileageCommand, readMileage } from "@/lib/vehicules/mileage-service"
import { ADMIN, COMPANY, LEADER, MileageMemoryDb, TRUCK } from "./mileage-test-db"
const key = "00000000-0000-4000-8000-000000000001"
function adminProfile(db: MileageMemoryDb) {
  db.state.employees.push({ id: "admin-profile", userId: "admin-a", companyId: COMPANY,
    role: "ADMIN", active: true, firstName: "Admin", lastName: "Member" })
}
const write = (db: MileageMemoryDb) => executeMileageCommand(TRUCK, "READING", { mileage: 10, expectedRevision: 0 }, key, db.deps())
describe("V2 authority follows multi-company memberships", () => {
  it("uses membership ADMIN role independently of primary login company and role", async () => {
    const db = new MileageMemoryDb()
    adminProfile(db)
    db.state.users[0].companyId = "company-b"
    db.state.users[0].role = "EMPLOYEE"
    assert.equal((await write(db)).status, 201)
  })
  it("uses membership TEAM_LEADER role independently of login role", async () => {
    const db = new MileageMemoryDb()
    db.state.users.find(user => user.id === "leader-a")!.role = "EMPLOYEE"
    db.state.users.find(user => user.id === "leader-a")!.companyId = "company-b"
    assert.equal((await readMileage(TRUCK, db.deps(LEADER))).truckId, TRUCK)
  })
  it("refuses inactive or demoted primary membership despite legacy ADMIN login", async () => {
    const db = new MileageMemoryDb()
    adminProfile(db)
    const member = db.state.employees.find(row => row.id === "admin-profile")!
    member.active = false
    await assert.rejects(write(db), /FORBIDDEN/)
    member.active = true; member.role = "EMPLOYEE"
    await assert.rejects(write(db), /FORBIDDEN/)
    assert.equal(db.state.entries.length, 0)
  })
  it("denies missing membership in a secondary company and disabled company", async () => {
    const db = new MileageMemoryDb()
    db.state.users[0].companyId = "company-b"
    await assert.rejects(write(db), /FORBIDDEN/)
    db.state.users[0].companyId = COMPANY
    db.state.companies[0].active = false
    await assert.rejects(write(db), /FORBIDDEN/)
  })
  it("retains legacy primary ADMIN and global Super Admin with explicit server scope", async () => {
    const db = new MileageMemoryDb()
    assert.equal((await write(db)).status, 201)
    const session = { user: { id: "super", role: "SUPER_ADMIN", companyId: COMPANY } }
    assert.equal((await readMileage(TRUCK, db.deps(session))).truckId, TRUCK)
    await assert.rejects(readMileage(TRUCK, db.deps({ user: { ...session.user, companyId: null } })), /NO_COMPANY/)
  })
})
