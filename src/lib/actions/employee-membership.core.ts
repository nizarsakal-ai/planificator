import type { Prisma } from "@prisma/client"

type Input = { companyId: string; email: string; firstName: string; lastName: string; password: string; jobTitle?: string; phone?: string }
/** Reuses login credentials; only the company employee record can be created/reactivated. */
export async function attachEmployee(tx: Prisma.TransactionClient, input: Input, hashPassword: (password: string) => Promise<string>) {
  const { email, firstName, lastName, password, jobTitle, phone } = input
  const existing = await tx.user.findFirst({ where: { email: { equals: email.trim(), mode: "insensitive" } } })
  if (existing && (!existing.active || existing.role === "CLIENT" || existing.role === "SUPER_ADMIN")) {
    throw new Error("Ce compte doit être vérifié par le Super Admin avant rattachement.")
  }
  const account = existing ?? await tx.user.create({ data: {
    email: email.trim().toLowerCase(), password: await hashPassword(password),
    role: "EMPLOYEE", companyId: input.companyId,
  } })
  const profile = await tx.employee.findFirst({ where: { userId: account.id, companyId: input.companyId } })
  if (profile?.active) throw new Error("Cet employé appartient déjà à cette entreprise.")
  if (profile) {
    await tx.employee.update({ where: { id: profile.id }, data: { active: true } })
  } else {
    await tx.employee.create({ data: {
      userId: account.id, companyId: input.companyId, role: account.companyId === input.companyId ? account.role : "EMPLOYEE",
      firstName, lastName, jobTitle: jobTitle || null, phone: phone || null,
    } })
  }
}
