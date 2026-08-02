import { prisma } from "@/lib/prisma"
import {
  handleBookingAgentPost,
  type BookingAgentDb,
} from "@/lib/booking/booking-agent.handler"

/**
 * POST /api/booking/agent — wrapper fin ; métier dans booking-agent.handler.
 */
export async function POST(req: Request) {
  return handleBookingAgentPost(req, {
    db: prisma as unknown as BookingAgentDb,
  })
}

/** Réexport pour tests qui invoquent le handler réel. */
export { handleBookingAgentPost }
export type { BookingAgentDb }
