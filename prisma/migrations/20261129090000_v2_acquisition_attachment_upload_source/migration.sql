CREATE TABLE "acquisition_attachment_upload_sources" (
    "companyId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "acquisition_attachment_upload_sources_pkey" PRIMARY KEY ("attachmentId", "companyId"),
    CONSTRAINT "acquisition_attachment_upload_sources_attachmentId_companyId_fkey"
        FOREIGN KEY ("attachmentId", "companyId") REFERENCES "acquisition_attachments"("id", "companyId")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "acquisition_attachment_upload_sources_bytes_bound"
        CHECK (octet_length("bytes") <= 10485760)
);
