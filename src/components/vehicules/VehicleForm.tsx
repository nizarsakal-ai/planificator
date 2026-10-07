"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  isVehicleFormSubmittable,
  type VehicleFormValues,
  EMPTY_VEHICLE_FORM,
} from "@/lib/vehicules/vehicules-view"

const INPUT =
  "w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"

interface VehicleFormProps {
  /** Valeurs initiales (modification) ; vides par défaut (création). */
  initialValues?: VehicleFormValues
  submitLabel: string
  submitting?: boolean
  onSubmit: (values: VehicleFormValues) => void | Promise<void>
  onCancel: () => void
  /** Préfixe d'id pour relier les labels (plusieurs formulaires sur une même page). */
  idPrefix?: string
}

/**
 * Formulaire véhicule partagé (Véhicules et Équipes) : Immatriculation, Marque, Modèle.
 * Marque et modèle sont deux champs distincts ; une ancienne marque « VW Crafter » reste telle quelle (jamais découpée).
 */
export function VehicleForm({
  initialValues = EMPTY_VEHICLE_FORM,
  submitLabel,
  submitting = false,
  onSubmit,
  onCancel,
  idPrefix = "vehicle",
}: VehicleFormProps) {
  const [values, setValues] = useState<VehicleFormValues>(initialValues)
  const set = (patch: Partial<VehicleFormValues>) => setValues((v) => ({ ...v, ...patch }))

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (isVehicleFormSubmittable(values) && !submitting) void onSubmit(values)
      }}
    >
      <div className="space-y-1">
        <label htmlFor={`${idPrefix}-matricule`} className="block text-xs font-medium text-slate-600">
          Immatriculation
        </label>
        <input
          id={`${idPrefix}-matricule`}
          type="text"
          placeholder="ex: AB-123-CD"
          value={values.matricule}
          onChange={(e) => set({ matricule: e.target.value.toUpperCase() })}
          className={INPUT}
          autoComplete="off"
          required
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor={`${idPrefix}-marque`} className="block text-xs font-medium text-slate-600">
            Marque
          </label>
          <input
            id={`${idPrefix}-marque`}
            type="text"
            placeholder="ex: Volkswagen"
            value={values.marque}
            onChange={(e) => set({ marque: e.target.value })}
            className={INPUT}
            autoComplete="off"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${idPrefix}-modele`} className="block text-xs font-medium text-slate-600">
            Modèle
          </label>
          <input
            id={`${idPrefix}-modele`}
            type="text"
            placeholder="ex: Crafter"
            value={values.modele}
            onChange={(e) => set({ modele: e.target.value })}
            maxLength={100}
            className={INPUT}
            autoComplete="off"
          />
        </div>
      </div>
      <div className="flex gap-2 pt-1">
        <Button
          type="submit"
          disabled={submitting || !isVehicleFormSubmittable(values)}
          className="bg-[#0f3460] hover:bg-[#0a2540]"
        >
          {submitLabel}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          Annuler
        </Button>
      </div>
    </form>
  )
}
