"use client"

import { useEffect, useId, useRef, useSyncExternalStore } from "react"
import { cn } from "@/lib/utils"
import type { LoginField } from "@/components/auth/LoginForm"

/**
 * Illustration DÉCORATIVE de la connexion (aria-hidden) : trois personnages Planificator (repère, agenda, casque) dont
 * les yeux suivent la souris et se ferment pendant la saisie du mot de passe. Elle ne reçoit que le champ qui a le focus
 * et l'état « mot de passe affiché » : jamais la valeur des champs, rien n'est stocké ni envoyé.
 * `prefers-reduced-motion` : ni flottement ni suivi du pointeur (regard fixe vers le formulaire).
 */

type Eye = { cx: number; cy: number; r: number; ink: string }
// Coordonnées dans la scène SVG (520 × 280) : repère, agenda, casque.
const EYES: readonly Eye[] = [
  { cx: 101, cy: 92, r: 8.5, ink: "#e6eeff" }, { cx: 129, cy: 92, r: 8.5, ink: "#e6eeff" },
  { cx: 239, cy: 158, r: 10, ink: "#0b1b36" }, { cx: 281, cy: 158, r: 10, ink: "#0b1b36" },
  { cx: 395, cy: 204, r: 8, ink: "#0b1b36" }, { cx: 425, cy: 204, r: 8, ink: "#0b1b36" },
]
// Bouche : centre et couleur du trait (claire sur le repère bleu nuit).
const MOUTHS = [[115, 113, "#e6eeff"], [260, 184, "#0b1b36"], [410, 216, "#0b1b36"]] as const
const MAX_OFFSET = 3.6

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)"
const subscribeReduced = (onChange: () => void) => {
  const media = window.matchMedia(REDUCED_QUERY)
  media.addEventListener("change", onChange)
  return () => media.removeEventListener("change", onChange)
}

export function LoginCrew({ focusedField, passwordVisible, layout = "side", className }: {
  focusedField: LoginField | null
  passwordVisible: boolean
  /** Position du formulaire : à droite (bureau) ou en dessous (mobile) ; oriente le regard au repos. */
  layout?: "side" | "stacked"
  className?: string
}) {
  const reducedMotion = useSyncExternalStore(subscribeReduced, () => window.matchMedia(REDUCED_QUERY).matches, () => true)
  const ids = useId().replace(/:/g, "")
  const pupils = useRef<Array<SVGCircleElement | null>>([])
  const closed = focusedField === "password" && !passwordVisible
  const lookingAway = focusedField === "password" && passwordVisible
  // Suivi du pointeur seulement au repos ; un champ actif impose le regard (vers le formulaire, ou ailleurs).
  const follow = !reducedMotion && focusedField === null

  const toward = layout === "side" ? { x: MAX_OFFSET, y: 0.8 } : { x: 0.6, y: MAX_OFFSET }
  const rest = lookingAway ? { x: -MAX_OFFSET * 0.8, y: -MAX_OFFSET * 0.8 } : toward

  useEffect(() => {
    if (!follow) return
    let frame = 0
    let pointer: { x: number; y: number } | null = null
    const update = () => {
      frame = 0
      if (!pointer) return
      pupils.current.forEach((pupil, index) => {
        const socket = pupil?.previousElementSibling
        if (!pupil || !socket) return
        const box = socket.getBoundingClientRect()
        const vx = pointer!.x - (box.left + box.width / 2)
        const vy = pointer!.y - (box.top + box.height / 2)
        const distance = Math.hypot(vx, vy) || 1
        const reach = Math.min(MAX_OFFSET, distance / 40) * (EYES[index].r / 9)
        pupil.style.transform = `translate(${((vx / distance) * reach).toFixed(2)}px, ${((vy / distance) * reach).toFixed(2)}px)`
      })
    }
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return
      pointer = { x: event.clientX, y: event.clientY }
      if (!frame) frame = requestAnimationFrame(update)
    }
    window.addEventListener("pointermove", onMove, { passive: true })
    return () => { window.removeEventListener("pointermove", onMove); cancelAnimationFrame(frame) }
  }, [follow])

  // Hors suivi (champ actif, mouvement réduit) : le regard imposé remplace la dernière position du pointeur.
  useEffect(() => {
    if (follow) return
    pupils.current.forEach((pupil, index) => {
      if (pupil) pupil.style.transform = `translate(${(rest.x * EYES[index].r / 9).toFixed(2)}px, ${(rest.y * EYES[index].r / 9).toFixed(2)}px)`
    })
  }, [follow, rest.x, rest.y])

  const bob = (delay: string) => cn("motion-safe:animate-[login-crew-bob_4.2s_ease-in-out_infinite]", delay)

  return (
    <svg viewBox="0 0 520 280" className={cn("h-auto w-full select-none", className)} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${ids}-pin`} x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0" stopColor="#2a5aa6" />
          <stop offset="1" stopColor="#0f3460" />
        </linearGradient>
        <linearGradient id={`${ids}-cal`} x1="0" y1="0" x2="0.8" y2="1">
          <stop offset="0" stopColor="#4f7df8" />
          <stop offset="1" stopColor="#1d4ed8" />
        </linearGradient>
        <linearGradient id={`${ids}-cal-top`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1e40af" />
          <stop offset="1" stopColor="#1d4ed8" />
        </linearGradient>
        <radialGradient id={`${ids}-hat`} cx="0.35" cy="0.3" r="0.9">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.7" stopColor="#eef2f8" />
          <stop offset="1" stopColor="#d5deeb" />
        </radialGradient>
        <radialGradient id={`${ids}-shine`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Décor discret */}
      <circle cx="196" cy="44" r="9" fill="none" stroke="#7cc4ec" strokeWidth="4" opacity="0.8" />
      <path d="M470 98h16M478 90v16" stroke="#93b4f8" strokeWidth="3.5" strokeLinecap="round" />
      <circle cx="40" cy="214" r="5" fill="#bfd3fb" />

      {/* Ombres au sol */}
      <ellipse cx="115" cy="258" rx="40" ry="7" className="fill-slate-900/10" />
      <ellipse cx="260" cy="258" rx="74" ry="8" className="fill-slate-900/10" />
      <ellipse cx="410" cy="258" rx="66" ry="7" className="fill-slate-900/10" />

      {/* Repère (pointage) */}
      <g className={bob("[animation-delay:0s]")}>
        <path d="M115 30C150 30 172 56 172 89C172 134 115 196 115 196S58 134 58 89C58 56 80 30 115 30Z" fill={`url(#${ids}-pin)`} stroke="#ffffff" strokeOpacity="0.14" strokeWidth="2" />
        <ellipse cx="94" cy="60" rx="20" ry="13" fill={`url(#${ids}-shine)`} />
      </g>

      {/* Agenda (planning) */}
      <g className={bob("[animation-delay:-1.4s]")}>
        <rect x="186" y="78" width="148" height="164" rx="28" fill={`url(#${ids}-cal)`} />
        <path d="M186 106a28 28 0 0 1 28-28h92a28 28 0 0 1 28 28v18H186Z" fill={`url(#${ids}-cal-top)`} />
        <rect x="222" y="62" width="13" height="32" rx="6.5" fill="#dbe7ff" />
        <rect x="285" y="62" width="13" height="32" rx="6.5" fill="#dbe7ff" />
        <ellipse cx="216" cy="140" rx="18" ry="11" fill={`url(#${ids}-shine)`} />
        <circle cx="214" cy="182" r="8" fill="#f9a8d4" fillOpacity="0.4" />
        <circle cx="306" cy="182" r="8" fill="#f9a8d4" fillOpacity="0.4" />
      </g>

      {/* Casque (chantier) */}
      <g className={bob("[animation-delay:-2.6s]")}>
        <path d="M352 236A58 58 0 0 1 468 236Z" fill={`url(#${ids}-hat)`} />
        <path d="M398 180.2a58 58 0 0 1 24 0l-2 9a46 46 0 0 0-20 0Z" fill="#c9d6ea" />
        <path d="M354.6 222h110.8a58 58 0 0 1 1.9 8H352.7a58 58 0 0 1 1.9-8Z" fill="#3b6cf6" />
        <ellipse cx="386" cy="196" rx="14" ry="8" fill={`url(#${ids}-shine)`} />
        <rect x="340" y="232" width="140" height="14" rx="7" fill="#c9d6ea" />
      </g>

      {/* Yeux : orbite, pupille (déplacée), paupière fermée */}
      {EYES.map((eye, index) => (
        <g key={index}>
          <circle cx={eye.cx} cy={eye.cy} r={eye.r} fill="#ffffff" opacity={closed ? 0 : 1} />
          <circle
            ref={(element) => { pupils.current[index] = element }}
            cx={eye.cx}
            cy={eye.cy}
            r={eye.r * 0.48}
            fill="#0b1b36"
            opacity={closed ? 0 : 1}
            style={{ transform: `translate(${(rest.x * eye.r / 9).toFixed(2)}px, ${(rest.y * eye.r / 9).toFixed(2)}px)` }}
            className="transition-transform duration-150 ease-out motion-reduce:transition-none"
          />
          {closed && (
            <path d={`M${eye.cx - eye.r * 0.85} ${eye.cy}q${eye.r * 0.85} ${eye.r * 0.9} ${eye.r * 1.7} 0`} fill="none" stroke={eye.ink} strokeWidth="3" strokeLinecap="round" />
          )}
        </g>
      ))}
      {MOUTHS.map(([x, y, ink], index) => (
        closed
          ? <path key={index} d={`M${x - 6} ${y}h12`} stroke={ink} strokeWidth="3" strokeLinecap="round" />
          : <path key={index} d={`M${x - 7} ${y - 2}q7 7 14 0`} fill="none" stroke={ink} strokeWidth="3" strokeLinecap="round" />
      ))}
    </svg>
  )
}
