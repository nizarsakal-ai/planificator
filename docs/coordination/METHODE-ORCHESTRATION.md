# Méthode d'orchestration — fiche courte

> Tirée d'une vidéo sur l'IA et l'entrepreneuriat, puis adaptée à Planificator.
> Une page, à relire avant de lancer un nouveau chantier.

## Le principe

L'IA fait l'exécution. Nizar garde quatre choses, sans exception :

| Nizar garde | Concrètement sur Planificator |
|---|---|
| **Les décisions** | Fusion sur `main`, activation des drapeaux en prod, choix de périmètre d'un LOT |
| **Les relations** | Clients pilotes, fournisseurs, partenaires : aucun message envoyé sans son accord |
| **La direction** | Ce qu'on construit ensuite et pourquoi (priorités du `PLAN.md`) |
| **La responsabilité** | Il valide ce qui part en production ; Claude vérifie et rend compte |

## La méthode en 3 temps

### 1. Découper
Partir d'un objectif encore flou et le couper en étapes livrables seules.
- Une étape = un LOT ou une PR, avec un résultat visible.
- Si une étape ne se décrit pas en une phrase, la recouper.
- Sur Planificator : spec → cadrage → plan d'implémentation → LOTs (ex. LOT-2A à 2E).

### 2. Confier
Donner chaque étape au bon outil, avec un brief clair.
- Recherche, lecture large → sous-agent.
- Code, migrations → session Claude dans son propre worktree.
- Une étape = un responsable ; deux sessions ne touchent jamais les mêmes fichiers.

### 3. Vérifier
Contrôler jusqu'à ce que ça colle à la réalité, pas seulement aux tests.
- Tests verts + build + vérification dans l'appli (navigateur, journaux Vercel).
- Mode « shadow » avant l'activation réelle (comme le Router du LOT-2).
- Rapport de clôture : ce qui marche, ce qui n'est pas vérifié, ce qui reste.

## Ce qui prend de la valeur

Quand l'exécution ne coûte presque plus rien, ce qui fait la différence :

1. **Direction** — savoir quoi construire.
2. **Distribution** — atteindre les clients (le LOT-3 acquisition va dans ce sens).
3. **Confiance** — fiabilité, données sûres, pas de surprise en prod.
4. **Positionnement** — pour qui Planificator est fait, et contre quoi.
5. **Goût** — une appli simple et agréable, en français, sans jargon.

## À prendre avec recul

- « Une équipe d'IA coûte moins qu'une journée de salarié » : vrai pour l'abonnement,
  faux si on oublie le temps de vérification et de correction.
- La courbe de valeur est une opinion, pas une mesure.

## Check-list avant un nouveau chantier

- [ ] L'objectif tient en une phrase.
- [ ] Il est découpé en étapes livrables seules.
- [ ] Chaque étape a un responsable (Claude, sous-agent, session) et un brief.
- [ ] On sait comment on vérifiera chaque étape (test, shadow, appli réelle).
- [ ] Les décisions réservées à Nizar sont identifiées (fusion, prod, messages externes).
