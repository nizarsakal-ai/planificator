"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Camera, Loader2 } from "lucide-react"
import { updateEmployeAvatar } from "@/lib/actions/employe.actions"
import Image from "next/image"

interface Props {
  employeeId: string
  avatarUrl:  string | null
  initials:   string
}

export function AvatarUpload({ employeeId, avatarUrl, initials }: Props) {
  const router      = useRouter()
  const inputRef    = useRef<HTMLInputElement>(null)
  const [loading,   setLoading]   = useState(false)
  const [preview,   setPreview]   = useState<string | null>(avatarUrl)

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    // Preview local immédiat
    const reader = new FileReader()
    reader.onload = (ev) => setPreview(ev.target?.result as string)
    reader.readAsDataURL(file)

    setLoading(true)
    const fd = new FormData()
    fd.append("file", file)
    const result = await updateEmployeAvatar(employeeId, fd)
    setLoading(false)

    if (result.error) {
      toast.error(result.error)
      setPreview(avatarUrl)
    } else {
      toast.success("Photo mise à jour.")
      router.refresh()
    }
    // Reset input
    e.target.value = ""
  }

  return (
    <div className="relative shrink-0 group">
      {/* Avatar */}
      <div className="w-20 h-20 rounded-full overflow-hidden bg-[#0f3460] flex items-center justify-center text-white text-xl font-bold shadow-md">
        {preview ? (
          <Image
            src={preview}
            alt="Avatar"
            width={80}
            height={80}
            className="w-full h-full object-cover"
            unoptimized
          />
        ) : (
          <span>{initials}</span>
        )}
      </div>

      {/* Overlay upload */}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={loading}
        className="absolute inset-0 rounded-full bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
        title="Changer la photo"
      >
        {loading
          ? <Loader2 className="h-5 w-5 text-white animate-spin" />
          : <Camera className="h-5 w-5 text-white" />
        }
      </button>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
      />
    </div>
  )
}
