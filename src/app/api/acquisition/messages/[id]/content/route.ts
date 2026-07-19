import {
  handleFetchMessageContent,
  handleGetMessageContent,
} from "@/lib/acquisition/content/message-content.handler"

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  return handleGetMessageContent(req, id)
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  return handleFetchMessageContent(req, id)
}
