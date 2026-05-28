import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard"

export default async function OnboardingPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")
  if (!["ADMIN"].includes(session.user.role)) redirect("/dashboard")

  const company = await prisma.company.findUnique({
    where: { id: session.user.companyId! },
    select: { name: true },
  })

  return <OnboardingWizard companyName={company?.name ?? ""} />
}
