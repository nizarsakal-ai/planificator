"use client"

import { useState, useRef } from "react"
import { Upload, Trash2, FileText, Image, FileImage, Loader2, Download } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { uploadDocument, deleteDocument } from "@/lib/actions/document.actions"

interface Document {
  id: string
  name: string
  url: string
  size: number | null
  mimeType: string | null
  type: "PLAN" | "PHOTO" | "DOCUMENT"
  uploadedAt: Date
}

interface DocumentsSectionProps {
  worksiteId: string
  documents: Document[]
}

function formatSize(bytes: number | null) {
  if (!bytes) return ""
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`
}

function isImage(mimeType: string | null) {
  return mimeType?.startsWith("image/") ?? false
}

// Toutes les URLs passent par notre API → URL signée Cloudinary
// ?dl=1 force le téléchargement (fl_attachment), sinon ouverture dans le navigateur
function viewUrl(mimeType: string | null, originalUrl: string, id: string) {
  if (mimeType?.startsWith("image/")) return originalUrl
  return `/api/documents/${id}`
}
function downloadUrl(id: string) {
  return `/api/documents/${id}?dl=1`
}

export function DocumentsSection({ worksiteId, documents }: DocumentsSectionProps) {
  const [activeTab, setActiveTab] = useState<"PHOTO" | "PLAN" | "DOCUMENT">("PHOTO")
  const [uploading, setUploading] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const filtered = documents.filter((d) => d.type === activeTab)

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setUploading(true)
    try {
      const formData = new FormData()
      formData.append("worksiteId", worksiteId)
      formData.append("type", activeTab)
      formData.append("file", file)

      const result = await uploadDocument(formData)

      if (result?.error) {
        toast.error(result.error)
      } else {
        toast.success("Fichier uploadé avec succès")
      }
    } catch (err) {
      toast.error("Erreur lors de l'upload")
      console.error(err)
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  const handleDelete = async (docId: string) => {
    if (!confirm("Supprimer ce fichier ?")) return
    setDeleting(docId)
    const result = await deleteDocument(docId, worksiteId)
    setDeleting(null)
    if (result?.error) toast.error(result.error)
    else toast.success("Fichier supprimé")
  }

  const tabs: { key: "PHOTO" | "PLAN" | "DOCUMENT"; label: string; accept: string }[] = [
    { key: "PHOTO", label: "Photos", accept: "image/*" },
    { key: "PLAN", label: "Plans", accept: "image/*,.pdf" },
    { key: "DOCUMENT", label: "Documents", accept: ".pdf,.doc,.docx,.xls,.xlsx" },
  ]

  const currentTab = tabs.find((t) => t.key === activeTab)!

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Médias & Documents
          </CardTitle>
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept={currentTab.accept}
              className="hidden"
              onChange={handleUpload}
            />
            <Button
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="bg-[#0f3460] hover:bg-[#0a2540] h-8 text-xs"
            >
              {uploading ? (
                <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Upload...</>
              ) : (
                <><Upload className="h-3 w-3 mr-1" /> Ajouter</>
              )}
            </Button>
          </div>
        </div>

        {/* Onglets */}
        <div className="flex gap-1 mt-2 border-b border-slate-100">
          {tabs.map((tab) => {
            const count = documents.filter((d) => d.type === tab.key).length
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
                  activeTab === tab.key
                    ? "border-[#0f3460] text-[#0f3460]"
                    : "border-transparent text-slate-500 hover:text-slate-700"
                }`}
              >
                {tab.label} {count > 0 && <span className="ml-1 text-slate-400">({count})</span>}
              </button>
            )
          })}
        </div>
      </CardHeader>

      <CardContent>
        {filtered.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center py-8 border-2 border-dashed border-slate-200 rounded-lg cursor-pointer hover:border-slate-300 transition-colors"
            onClick={() => fileInputRef.current?.click()}
          >
            {activeTab === "PHOTO" ? (
              <Image className="h-8 w-8 text-slate-300 mb-2" />
            ) : (
              <FileImage className="h-8 w-8 text-slate-300 mb-2" />
            )}
            <p className="text-sm text-slate-400">
              Aucun{activeTab === "PHOTO" ? "e photo" : activeTab === "PLAN" ? " plan" : " document"}
            </p>
            <p className="text-xs text-slate-300 mt-1">Cliquez pour ajouter</p>
          </div>
        ) : activeTab === "PHOTO" ? (
          /* Grille photos */
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {filtered.map((doc) => (
              <div key={doc.id} className="group relative aspect-square rounded-lg overflow-hidden bg-slate-100">
                {isImage(doc.mimeType) ? (
                  <img
                    src={doc.url}
                    alt={doc.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <FileText className="h-8 w-8 text-slate-400" />
                  </div>
                )}
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                  <a
                    href={viewUrl(doc.mimeType, doc.url, doc.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-white text-xs bg-white/20 px-2 py-1 rounded hover:bg-white/30"
                  >
                    Voir
                  </a>
                  <a
                    href={downloadUrl(doc.id)}
                    download
                    className="text-white text-xs bg-white/20 px-2 py-1 rounded hover:bg-white/30"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </a>
                  <button
                    onClick={() => handleDelete(doc.id)}
                    disabled={deleting === doc.id}
                    className="text-white"
                  >
                    {deleting === doc.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4 text-red-300 hover:text-red-200" />
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          /* Liste plans/documents */
          <div className="space-y-2">
            {filtered.map((doc) => (
              <div key={doc.id} className="flex items-center justify-between py-2 px-3 rounded-lg bg-slate-50 hover:bg-slate-100 transition-colors">
                <div className="flex items-center gap-3 min-w-0">
                  <FileText className="h-4 w-4 text-slate-400 shrink-0" />
                  <div className="min-w-0">
                    <a
                      href={viewUrl(doc.mimeType, doc.url, doc.id)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium text-[#0f3460] hover:underline truncate block"
                    >
                      {doc.name}
                    </a>
                    {doc.size && (
                      <p className="text-xs text-slate-400">{formatSize(doc.size)}</p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 ml-2 shrink-0">
                  <a
                    href={downloadUrl(doc.id)}
                    download
                    title="Télécharger"
                    className="text-slate-400 hover:text-[#0f3460] transition-colors"
                  >
                    <Download className="h-4 w-4" />
                  </a>
                  <button
                    onClick={() => handleDelete(doc.id)}
                    disabled={deleting === doc.id}
                    className="text-red-400 hover:text-red-600"
                  >
                    {deleting === doc.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
