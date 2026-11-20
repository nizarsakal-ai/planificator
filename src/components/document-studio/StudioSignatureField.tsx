"use client"
// Lot G Planificator V2 (portage sur ef36578f) : champ de signature manuscrite du valideur d'un document généré.
// Composant LOCAL au lot G : le pavé V1 (components/planning/SignaturePad) est couplé à l'émargement des affectations et
// le champ du lot D (components/reserves) est absent de cette base ; aucun des deux n'est modifié. Le tracé est converti en
// image PNG (URL de données) dans un champ caché du formulaire, envoyé seulement avec la validation ; le serveur revérifie
// le format, la taille et calcule l'empreinte (lib/document-studio/signature.ts). Aucun service tiers.
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"

// Espace PDF (lot 2) : `onChange` facultatif (tracé courant ou chaîne vide après effacement) ; usage existant inchangé.
export function StudioSignatureField({ name = "signature", label, onChange }: { name?: string; label: string; onChange?: (dataUrl: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)
  const [value, setValue] = useState("")

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
    ctx.beginPath()
    ctx.moveTo(last.current.x, last.current.y)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    last.current = p
  }
  const up = () => {
    if (!drawing.current) return
    drawing.current = false
    last.current = null
    const v = canvasRef.current?.toDataURL("image/png") ?? ""
    setValue(v)
    onChange?.(v)
  }
  const clear = () => {
    const c = canvasRef.current
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height)
    setValue("")
    onChange?.("")
  }

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
