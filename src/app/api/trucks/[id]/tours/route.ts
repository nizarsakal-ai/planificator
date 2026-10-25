import { consumeVehicleTourImport } from "@/lib/vehicules/v3/integration-bridges"
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { handleTours } from "@/lib/vehicules/v3/tour-api";
export async function GET(request: Request, context: {
    params: Promise<{
        id: string;
    }>;
}) { return handleTours(request, (await context.params).id, undefined, { auth, db: prisma, consumeApprovedImport: consumeVehicleTourImport }); }
export const POST = GET;
