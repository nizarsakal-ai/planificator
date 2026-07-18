import type {
  AttachmentAccessAuditEntry,
  ConsultableAttachmentRecord,
  CreateSignedUrlInput,
  FetchSignedResourceInput,
  FetchSignedResourceResult,
  FindConsultableAttachmentInput,
  SignedUrlResult,
} from "@/lib/acquisition/access/attachment-access.types"

export interface AttachmentAccessRepositoryPort {
  findConsultableAttachment(
    input: FindConsultableAttachmentInput
  ): Promise<ConsultableAttachmentRecord | null>
}

export interface AttachmentUrlSignerPort {
  createSignedUrl(input: CreateSignedUrlInput): Promise<SignedUrlResult>
}

export interface AttachmentAccessFetcherPort {
  fetchSignedResource(input: FetchSignedResourceInput): Promise<FetchSignedResourceResult>
}

export interface AttachmentAccessAuditRepositoryPort {
  record(entry: AttachmentAccessAuditEntry): Promise<void>
}

export interface AttachmentAccessServiceDeps {
  repository?: AttachmentAccessRepositoryPort
  signer?: AttachmentUrlSignerPort
  fetcher?: AttachmentAccessFetcherPort
  auditRepository?: AttachmentAccessAuditRepositoryPort
  clock?: () => Date
  log?: (event: string, payload?: Record<string, unknown>) => void
}
