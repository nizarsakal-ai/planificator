"use client"

import { useId } from "react"
import { cn } from "@/lib/utils"

/**
 * Marque Planificator — « P » géométrique sur tuile dégradé bleu → cyan.
 * SVG inline, sans asset distant ; lisible de 16 px (favicon) à 64 px.
 */
export function PlanificatorMark({ className, title }: { className?: string; title?: string }) {
  const gradientId = useId()
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn("h-8 w-8 shrink-0", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <defs>
        <linearGradient id={gradientId} x1="4" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3b6cf6" />
          <stop offset="0.55" stopColor="#2563eb" />
          <stop offset="1" stopColor="#22b8e6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${gradientId})`} />
      {/* Fût + panse du P, traits arrondis */}
      <path
        d="M12 24V9h5.5a5 5 0 0 1 0 10H12"
        fill="none"
        stroke="#fff"
        strokeWidth="3.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Point de planification */}
      <circle cx="21.75" cy="23.75" r="1.9" fill="#fff" fillOpacity="0.75" />
    </svg>
  )
}

/** Logo complet (marque + nom) pour fonds sombres (sidebar). */
export function PlanificatorLogo({ subtitle }: { subtitle?: string }) {
  return (
    <div className="flex items-center gap-3">
      <PlanificatorMark />
      <div className="min-w-0">
        <p className="text-white font-bold text-sm leading-tight tracking-tight">Planificator</p>
        {subtitle && <p className="text-slate-400 text-[11px] truncate">{subtitle}</p>}
      </div>
    </div>
  )
}
