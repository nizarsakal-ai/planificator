"use client"
// Lot D : champ de signature manuscrite pour le procès-verbal. Le tracé est converti en image PNG (URL de données)
// dans un champ caché « signature » du formulaire ; le serveur revérifie le format et la taille. Même tracé que la
// signature existante des feuilles de présence (SignaturePad), sans envoi à un service tiers.
// Revue D : le champ caché n'est renseigné qu'après le tracé d'au moins un SEGMENT RÉEL de longueur non nulle (un simple
// clic n'est pas une signature) ; « Effacer » le vide. Tracé manuscrit conservé, pas une signature électronique qualifiée.
// Extension PV (retour d'état) : `resetSignal` facultatif ; chaque CHANGEMENT de sa valeur (après le montage) vide le tracé
// comme « Effacer ». Le parent ne l'incrémente qu'après un PV signé avec succès. Sans `resetSignal`, comportement inchangé.
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"

export function SignatureField({ name = "signature", label, resetSignal }: { name?: string; label: string; resetSignal?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)
  const drawn = useRef(false)
  const [value, setValue] = useState("")
  const lastSignal = useRef(resetSignal)

  useEffect(() => {
    const c = canvasRef.current
    const ctx = c?.getContext("2d")
    if (!c || !ctx) return
    c.width = c.offsetWidth
    c.height = c.offsetHeight
    ctx.strokeStyle = "#0f3460"
    ctx.lineWidth = 2.5
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
  }, [])

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drawing.current = true
    last.current = pos(e)
  }
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = e.currentTarget.getContext("2d")
    if (!drawing.current || !ctx || !last.current) return
    const p = pos(e)
    if (Math.hypot(p.x - last.current.x, p.y - last.current.y) < 1) return
    ctx.beginPath()
    ctx.moveTo(last.current.x, last.current.y)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    last.current = p
    drawn.current = true
  }
  const up = () => {
    if (!drawing.current) return
    drawing.current = false
    last.current = null
    if (drawn.current) setValue(canvasRef.current?.toDataURL("image/png") ?? "")
  }
  const clear = () => {
    const c = canvasRef.current
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height)
    drawn.current = false
    setValue("")
  }
  useEffect(() => {
    if (resetSignal === lastSignal.current) return   // montage, ou signal inchangé : rien
    lastSignal.current = resetSignal
    clear()
  }, [resetSignal])   // eslint-disable-line react-hooks/exhaustive-deps -- clear() ne lit que des refs et un setState stable

  return (
    <div className="grid gap-1">
      <span className="text-xs uppercase text-slate-500">{label}</span>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`${label} : zone de tracé`}
        className="h-32 w-full touch-none rounded-md border border-input bg-white"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={up}
      />
      <input type="hidden" name={name} value={value} />
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={clear}>Effacer</Button>
        <span className="text-xs text-slate-500" aria-live="polite">{value ? "Signature saisie." : "Signez dans le cadre ci-dessus."}</span>
      </div>
    </div>
  )
}
