"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { VehicleMileagePanel } from "./VehicleMileagePanel"
import { VehicleMaintenancePanel, type MaintenanceSummary } from "./VehicleMaintenancePanel"

/** Les journaux restent chargés à la demande, l'échéance du parc vient du serveur. */
export function VehicleV2Panels({ truckId, matricule, active, canManage, currentMileage, maintenanceSummary }: {
  truckId: string
  matricule: string
  active: boolean
  canManage: boolean
  currentMileage?: number | null
  maintenanceSummary?: MaintenanceSummary
}) {
  const router = useRouter()
  const [refreshToken, setRefreshToken] = useState(0)
  return (
    <div className="mt-4 space-y-3 border-t border-slate-100 pt-3">
      <VehicleMileagePanel truckId={truckId} matricule={matricule} active={active} canManage={canManage}
        initialMileage={currentMileage} onMileageChanged={() => {
          setRefreshToken(value => value + 1)
          router.refresh()
        }} />
      <VehicleMaintenancePanel truckId={truckId} matricule={matricule} active={active} canManage={canManage}
        initialMileage={currentMileage} initialSummary={maintenanceSummary} refreshToken={refreshToken} />
    </div>
  )
}
