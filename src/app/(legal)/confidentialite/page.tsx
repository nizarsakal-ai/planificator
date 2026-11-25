import type { Metadata } from "next"
import { LegalPage } from "@/components/legal/LegalPage"
import { legalDocument } from "@/lib/legal/legal-documents"

export const dynamic = "force-static"
export const metadata: Metadata = { title: legalDocument("confidentialite").title }

export default function Page() {
  return <LegalPage documentKey="confidentialite" />
}
