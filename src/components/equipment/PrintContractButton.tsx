"use client"
import { Printer } from "lucide-react"
import { Button } from "@/components/ui/button"

/** Ouvre l'impression du navigateur (impression papier ou « Enregistrer au format PDF »). */
export function PrintContractButton() {
  return <Button type="button" onClick={() => window.print()}><Printer className="h-4 w-4" /> Imprimer / PDF</Button>
}
