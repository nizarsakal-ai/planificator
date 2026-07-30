export interface PendingAccommodationListItem {
  id: string
  propertyName: string | null
  address: string | null
  city: string | null
  zipCode: string | null
  startDate: Date | null
  endDate: Date | null
  doorCode: string | null
  contactName: string | null
  contactPhone: string | null
  notes: string | null
  createdAt: Date
  emailPreview: string | null
  gmailMessageId: string
}
