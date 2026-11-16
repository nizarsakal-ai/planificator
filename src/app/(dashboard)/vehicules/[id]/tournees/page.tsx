import { notFound } from "next/navigation";
import { isVehiclesV3Enabled } from "@/lib/vehicules/v3/v3-feature-flag"
import { TourPanel } from "@/components/vehicules/TourPanel";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireMileageSession } from "@/lib/vehicules/mileage-access";
import { authorizeVehicleLocked } from "@/lib/vehicules/vehicle-authority";
import { MileageDomainError } from "@/lib/vehicules/mileage-domain";
import { parseTourPrefill } from "@/lib/chantiers/worksite-vehicles";
export default async function Page({ params, searchParams }: {
    params: Promise<{
        id: string;
    }>;
    searchParams: Promise<{
        importId?: string | string[];
        revision?: string | string[];
        worksiteId?: string | string[];
        start?: string | string[];
        end?: string | string[];
    }>;
}) {
    if (!isVehiclesV3Enabled())
        notFound();
    const { id } = await params;
    // Lecture V3 : administrateur de l'entreprise ou chef de l'équipe affectée, relu sous verrou partagé.
    let companyId: string;
    try {
        const session = requireMileageSession(await auth());
        companyId = session.companyId;
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
    const importRequested = query.importId !== undefined || query.revision !== undefined;
    // Pré-remplissage depuis la fiche chantier (jamais combiné à un import approuvé).
    const parsed = importRequested ? null : parseTourPrefill(query);
    // Chantier relu côté serveur, scopé à l'entreprise (indépendant de la liste des 200 premiers chantiers).
    // La création de la tournée revalide de toute façon le chantier côté service.
    const site = parsed ? await prisma.worksite.findFirst({
        where: { id: parsed.worksiteId, companyId, archivedAt: null, address: { not: null } },
        select: { id: true, name: true, address: true, clientId: true, latitude: true, longitude: true },
    }) : null;
    const prefill = parsed ? { ...parsed, site: site && site.address ? { ...site, address: site.address } : null } : null;
    return <TourPanel truckId={id} importId={importId} importRevision={revision} importRequested={importRequested} {...(prefill ? { prefill } : {})}/>;
}
