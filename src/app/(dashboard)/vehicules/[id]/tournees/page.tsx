import { notFound } from "next/navigation";
import { TourPanel } from "@/components/vehicules/TourPanel";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireMileageSession } from "@/lib/vehicules/mileage-access";
import { authorizeVehicleLocked } from "@/lib/vehicules/vehicle-authority";
import { MileageDomainError } from "@/lib/vehicules/mileage-domain";
export default async function Page({ params, searchParams }: {
    params: Promise<{
        id: string;
    }>;
    searchParams: Promise<{
        importId?: string | string[];
        revision?: string | string[];
    }>;
}) {
    if (process.env.PLANIFICATOR_VEHICLES_V3_ENABLED !== "true")
        notFound();
    const { id } = await params;
    // Lecture V3 : administrateur de l'entreprise ou chef de l'équipe affectée, relu sous verrou partagé.
    try {
        const session = requireMileageSession(await auth());
        await prisma.$transaction(async tx => { await authorizeVehicleLocked(tx, id, session, "READ"); }, {maxWait:5000,timeout:15000});
    }
    catch (error) {
        if (error instanceof MileageDomainError && [401, 403, 404].includes(error.status))
            notFound();
        throw error;
    }
    const query = await searchParams;
    const importId = typeof query.importId === "string" ? query.importId : undefined;
    const revision = typeof query.revision === "string" && /^\d+$/.test(query.revision) ? Number(query.revision) : undefined;
    return <TourPanel truckId={id} importId={importId} importRevision={revision} importRequested={query.importId !== undefined || query.revision !== undefined}/>;
}
