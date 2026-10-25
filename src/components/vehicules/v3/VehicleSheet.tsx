"use client"

import Link from "next/link"
import { ArrowLeft, Truck } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { vehicleIdentityLabel } from "@/lib/vehicules/vehicules-view"
import { VehicleDocumentsTab } from "./VehicleDocumentsTab"
import { VehicleWorkspaceNav } from "./VehicleWorkspaceNav"

export type VehicleSheetTab = "documents"
export const VEHICLE_SHEET_TABS: { id: VehicleSheetTab; label: string }[] = [{ id: "documents", label: "Documents" }]

export function resolveSheetTab(value: string | null | undefined): VehicleSheetTab {
  return VEHICLE_SHEET_TABS.some((tab) => tab.id === value) ? (value as VehicleSheetTab) : "documents"
}

export interface VehicleSheetProps {
  truck: { id: string; matricule: string; marque: string | null; modele: string | null; active: boolean; archivedAt: string | null; teamName: string | null; chauffeurName: string | null }
  canManage: boolean
  initialTab?: string | null
}

/** Fiche camion : identité et onglets. Le lot Documents est le premier onglet ; les suivants arrivent par lots. */
export function VehicleSheet({ truck, canManage, initialTab }: VehicleSheetProps) {
  const tab = resolveSheetTab(initialTab)
  return <div className="space-y-5">
    <Link href="/vehicules" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"><ArrowLeft className="h-4 w-4" aria-hidden="true" />Retour aux véhicules</Link>
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100"><Truck className="h-6 w-6 text-slate-500" aria-hidden="true" /></div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">{truck.matricule}</h1>
            <p className="text-sm text-slate-500">{vehicleIdentityLabel(truck.marque, truck.modele)}{truck.teamName ? ` · ${truck.teamName}` : ""}{truck.chauffeurName ? ` · ${truck.chauffeurName}` : ""}</p>
          </div>
        </div>
        <Badge variant={truck.active ? "default" : "secondary"}>{truck.active ? "Actif" : "Archivé"}</Badge>
      </CardContent>
    </Card>
    <VehicleWorkspaceNav truckId={truck.id} active="documents" canManage={canManage} />
    {tab === "documents" && <VehicleDocumentsTab truckId={truck.id} canManage={canManage} />}
  </div>
}
