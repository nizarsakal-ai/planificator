"use client"

import { useEffect, useState } from "react"
import { Download, X, Share } from "lucide-react"

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

export function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [showBanner, setShowBanner] = useState(false)
  const [isIOS, setIsIOS] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    // Vérifier si déjà installée ou déjà dismissed
    const isDismissed = localStorage.getItem("pwa-install-dismissed")
    if (isDismissed) return

    // Vérifier si déjà en mode standalone (déjà installée)
    if (window.matchMedia("(display-mode: standalone)").matches) return

    // iOS Safari detection
    const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as unknown as { MSStream?: unknown }).MSStream
    if (isIOSDevice) {
      setIsIOS(true)
      setShowBanner(true)
      return
    }

    // Android / Chrome — écouter l'événement beforeinstallprompt
    const handler = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
      setShowBanner(true)
    }

    window.addEventListener("beforeinstallprompt", handler)
    return () => window.removeEventListener("beforeinstallprompt", handler)
  }, [])

  function dismiss() {
    setShowBanner(false)
    setDismissed(true)
    localStorage.setItem("pwa-install-dismissed", "1")
  }

  async function install() {
    if (!deferredPrompt) return
    await deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    if (outcome === "accepted") {
      setShowBanner(false)
    }
    setDeferredPrompt(null)
  }

  if (!showBanner || dismissed) return null

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 p-4 md:hidden">
      <div className="bg-[#0f3460] text-white rounded-2xl shadow-2xl p-4 flex items-start gap-3">
        {/* Icône */}
        <div className="w-12 h-12 rounded-xl bg-white flex items-center justify-center shrink-0">
          <span className="text-[#0f3460] font-black text-xl">P</span>
        </div>

        {/* Texte */}
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm">Installer Planificator</p>
          {isIOS ? (
            <p className="text-xs text-white/70 mt-0.5">
              Appuyez sur <Share className="h-3 w-3 inline" /> puis &quot;Sur l&apos;écran d&apos;accueil&quot;
            </p>
          ) : (
            <p className="text-xs text-white/70 mt-0.5">
              Accédez rapidement depuis votre écran d&apos;accueil
            </p>
          )}

          {!isIOS && (
            <button
              onClick={install}
              className="mt-2 flex items-center gap-1.5 bg-white text-[#0f3460] text-xs font-semibold px-3 py-1.5 rounded-lg"
            >
              <Download className="h-3.5 w-3.5" />
              Installer
            </button>
          )}
        </div>

        {/* Fermer */}
        <button onClick={dismiss} className="text-white/60 hover:text-white p-1 shrink-0">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
