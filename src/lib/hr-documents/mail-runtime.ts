import { Resend } from "resend"
import { hrDb } from "./runtime"
import { PrismaHrRepository } from "./repository"
import { deliverNotice } from "./notification"
import type { Identity } from "./domain"
export function dispatchHrNotice(identity:Identity,documentId:string){
  return deliverNotice(new PrismaHrRepository(hrDb()),identity,documentId,{
    enabled:process.env.HR_DOCUMENT_MAIL_ENABLED==="true",appUrl:process.env.NEXTAUTH_URL??"",
    send:async({to,url,idempotencyKey})=>{
      const client=new Resend(process.env.RESEND_API_KEY)
      const result=await client.emails.send({from:"Planificator <noreply@galyaevents.fr>",to,
        subject:"Un document est disponible dans votre espace personnel",
        text:`Un document est disponible dans votre espace personnel Planificator. Connectez-vous pour le consulter : ${url}\nCe message ne contient aucune pièce jointe.`,
      },{idempotencyKey})
      if(result.error||!result.data?.id)throw new Error("MAIL_UNCONFIRMED")
    },
  })
}
