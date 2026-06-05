"use client"

import { useRef, useState, useEffect, useTransition } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { PenLine, Loader2, CheckCircle2, RotateCcw } from "lucide-react"
import { saveSignature } from "@/lib/actions/signature.actions"

interface SignaturePadProps {
  assignmentId: string
  worksiteName: string
  date: string // YYYY-MM-DD
  isSigned: boolean
  existingSignatureUrl?: string | null
}

export function SignaturePad({ assignmentId, worksiteName, date, isSigned, existingSignatureUrl }: SignaturePadProps) {
  const [open, setOpen] = useState(false)
  const [isEmpty, setIsEmpty] = useState(true)
  const [isPending, startTransition] = useTransition()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const isDrawing = useRef(false)
  const lastPos = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (!open) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    // Set canvas size
    canvas.width = canvas.offsetWidth * window.devicePixelRatio
    canvas.height = canvas.offsetHeight * window.devicePixelRatio
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio)
    ctx.strokeStyle = "#0f3460"
    ctx.lineWidth = 2.5
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
  }, [open])

  function getPos(e: React.MouseEvent | React.TouchEvent, canvas: HTMLCanvasElement) {
    const rect = canvas.getBoundingClientRect()
    if ("touches" in e) {
      const touch = e.touches[0]
      return { x: touch.clientX - rect.left, y: touch.clientY - rect.top }
    }
    return { x: (e as React.MouseEvent).clientX - rect.left, y: (e as React.MouseEvent).clientY - rect.top }
  }

  function startDraw(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault()
    const canvas = canvasRef.current
    if (!canvas) return
    isDrawing.current = true
    lastPos.current = getPos(e, canvas)
    setIsEmpty(false)
  }

  function draw(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault()
    if (!isDrawing.current || !canvasRef.current) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const pos = getPos(e, canvas)
    ctx.beginPath()
    ctx.moveTo(lastPos.current!.x, lastPos.current!.y)
    ctx.lineTo(pos.x, pos.y)
    ctx.stroke()
    lastPos.current = pos
  }

  function stopDraw() {
    isDrawing.current = false
    lastPos.current = null
  }

  function clearCanvas() {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.offsetWidth, canvas.offsetHeight)
    setIsEmpty(true)
  }

  function handleSave() {
    const canvas = canvasRef.current
    if (!canvas || isEmpty) return
    const dataUrl = canvas.toDataURL("image/png")
    startTransition(async () => {
      const result = await saveSignature(assignmentId, dataUrl)
      if (result?.error) {
        toast.error(result.error)
      } else {
        toast.success("Signature enregistrée")
        setOpen(false)
      }
    })
  }

  const formatDate = (d: string) =>
    new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "2-digit", month: "long" }).format(new Date(d))

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className={`mt-2 w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
          isSigned
            ? "border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"
            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
        }`}
      >
        {isSigned ? (
          <><CheckCircle2 className="h-3.5 w-3.5" /> Feuille signée — voir / modifier</>
        ) : (
          <><PenLine className="h-3.5 w-3.5" /> Signer la feuille de présence</>
        )}
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="px-5 pt-5 pb-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-900 text-sm">Signature électronique</h2>
          <p className="text-xs text-slate-500 mt-0.5">{worksiteName} · <span className="capitalize">{formatDate(date)}</span></p>
        </div>

        <div className="p-5 space-y-4">
          {/* Signature existante */}
          {isSigned && existingSignatureUrl && (
            <div className="border border-blue-100 bg-blue-50 rounded-lg p-3">
              <p className="text-xs text-blue-600 font-medium mb-2">Signature actuelle</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={existingSignatureUrl} alt="Signature" className="h-16 object-contain" />
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-slate-700">Tracez votre signature</label>
              <button
                type="button"
                onClick={clearCanvas}
                className="text-xs text-slate-400 hover:text-slate-600 flex items-center gap-1"
              >
                <RotateCcw className="h-3 w-3" /> Effacer
              </button>
            </div>
            <canvas
              ref={canvasRef}
              className="w-full h-36 border-2 border-dashed border-slate-200 rounded-lg bg-slate-50 touch-none cursor-crosshair"
              style={{ touchAction: "none" }}
              onMouseDown={startDraw}
              onMouseMove={draw}
              onMouseUp={stopDraw}
              onMouseLeave={stopDraw}
              onTouchStart={startDraw}
              onTouchMove={draw}
              onTouchEnd={stopDraw}
            />
            <p className="text-[10px] text-slate-400 mt-1 text-center">Signez dans le cadre ci-dessus</p>
          </div>

          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={() => setOpen(false)}
              disabled={isPending}
            >
              Annuler
            </Button>
            <Button
              type="button"
              className="flex-1 bg-[#0f3460] hover:bg-[#0a2540]"
              onClick={handleSave}
              disabled={isPending || isEmpty}
            >
              {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Valider la signature"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
