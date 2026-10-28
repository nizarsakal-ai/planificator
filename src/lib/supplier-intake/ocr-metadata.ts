/** Raw OCR text is not part of the validated browser-to-server metadata contract. */
export function supplierOcrMetadata(ocr: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!ocr) return null
  const { rawText: _rawText, ...metadata } = ocr
  return metadata
}
