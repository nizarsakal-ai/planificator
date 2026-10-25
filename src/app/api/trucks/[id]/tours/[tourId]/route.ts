import { consumeVehicleTourImport } from "@/lib/vehicules/v3/integration-bridges"
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { handleTours } from "@/lib/vehicules/v3/tour-api";
export async function POST(request: Request, context: {
    params: Promise<{
        id: string;
        tourId: string;
    }>;
}) { const p = await context.params; return handleTours(request, p.id, p.tourId, { auth, db: prisma, consumeApprovedImport: consumeVehicleTourImport }); }
