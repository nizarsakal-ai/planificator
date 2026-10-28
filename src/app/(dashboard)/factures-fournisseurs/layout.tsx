import { requireIntakePage } from "@/lib/supplier-intake/pages"
export default async function SupplierIntakeLayout({ children }: { children: React.ReactNode }) {
  await requireIntakePage()
  return <section className="space-y-4"><h1 className="text-2xl font-bold">Factures fournisseurs &amp; OCR</h1><p className="text-sm text-slate-600">Importez vos justificatifs, vérifiez les données puis soumettez-les à validation. La validation comptable reste réservée aux personnes habilitées.</p>{children}</section>
}
