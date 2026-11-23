# Covoiturage local + horaires de transports

Un petit site citoyen pour un territoire mal desservi. Il regroupe :
- 🚗 **le covoiturage local** : trajets proposés et demandés, contact direct par appel, WhatsApp ou Telegram ;
- 🚆 **les prochains trains** des gares du coin, en direct (retards, suppressions, cars de remplacement) ;
- 🚌 **les prochains bus**, calculés depuis les horaires saisis (jours, périodes scolaires, jours fériés).

L'exemple livré est **Causse qui Roule**, dans le **Quercy Rouergue** (Tarn-et-Garonne, Tarn, Aveyron). Tout se modifie dans la page `/admin` : nom, villes, gares, horaires de bus, textes. Le site est donc réutilisable pour n'importe quel territoire.

Caractéristiques :
- **Aucune dépendance** : Node ≥ 22.13 suffit.
- **Aucun traqueur** : pas de cookie côté visiteurs, pas de ressource externe.
- **Numéros vérifiés** par Telegram.
- **Sauvegarde automatique** chaque jour.

---

## Installation (machine maison + tunnel Cloudflare)

Il faut Docker et un nom de domaine géré par Cloudflare (offre gratuite).

1. **Bot Telegram** : sur @BotFather, envoie `/newbot`, puis note le token et le nom du bot.
2. **Secrets** : `cp .env.example .env`, puis remplis `BOT_TOKEN`, `BOT_USERNAME`, `ADMIN_USER`, `ADMIN_PASSWORD` (10 caractères minimum) et `TUNNEL_TOKEN`. Laisse `TRUST_PROXY=cloudflare` (voir plus bas).
3. **Tunnel** : dans Cloudflare, va dans Networking → Tunnels → Create Tunnel. Copie le jeton (il commence par `eyJ`) dans `TUNNEL_TOKEN`. Ajoute ensuite la route : ton domaine → `http://app:3000`.
4. **Démarrage** : `docker compose up -d --build`.
5. **Configuration** : ouvre `https://ton-domaine/admin` et connecte-toi. Dans l'onglet **Site**, renseigne au minimum l'adresse du site et l'e-mail de contact.
6. **Admin Telegram** : envoie `/monid` au bot **en discussion privée** (le bot ignore les groupes), et colle le nombre obtenu dans Site → Administrateur·ices Telegram.

Au quotidien :
- mise à jour du code : `docker compose up -d --build` ;
- logs : `docker compose logs -f app` ;
- vérifier que le site répond, depuis la machine :
  `docker compose exec app node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>r.text()).then(console.log)"`.

Le site ne publie volontairement **aucun port** : il n'est joignable que par le tunnel, sur le réseau interne de Docker. C'est ce qui rend fiable l'IP des visiteurs transmise par Cloudflare.

### `TRUST_PROXY` : d'où vient l'IP des visiteurs

L'IP sert aux limites de requêtes (anti-abus, connexion admin) et aux statistiques anonymes. Les en-têtes ajoutés par un proxy sont falsifiables : le site ne les lit que si on le lui dit.

| Valeur | Quand l'utiliser |
|---|---|
| `cloudflare` | Cloudflare Tunnel (valeur par défaut avec `docker compose`) : lit `CF-Connecting-IP` |
| `1` | Caddy, Nginx… devant le site : lit la dernière IP de `X-Forwarded-For` |
| vide | site exposé directement, sans proxy : adresse de la connexion |

Si la valeur ne correspond pas à ton installation, tous les visiteurs risquent d'avoir la même IP, et donc de partager les mêmes limites.

Sans Docker : `npm run fonts` (une fois), puis `npm start`. Le fichier `.env` est lu automatiquement.

## Réutiliser pour un autre territoire

1. Fais un fork (ou « Use this template ») de ce dépôt et installe-le comme ci-dessus.
2. Dans `/admin`, règle :
   - **Site** : nom, sous-titre, description, thème et couleur, villes du formulaire, textes de la page « À propos », petite phrase sous le titre.
   - **Trains** : tes gares. Pour chacune, il faut l'URL de l'API, qui se termine par le code UIC de la gare (`…/Departures/0087xxxxxx`), le lien TER « prochains départs », et les **paniers** de destinations (« Vers Toulouse », « Vers Paris »…). L'onglet liste les destinations réellement vues pour t'aider à les ranger.
   - **Bus** : les arrêts du menu, le calendrier (périodes scolaires, vacances, été, jours fériés) et les cars, saisis à la main.
3. Remplace les images dans `public/` :
   - `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` : l'icône de l'appli ;
   - `og.png` : l'aperçu des liens partagés, en 1200×630.
4. Pour cloner une configuration d'un site à l'autre, utilise **Sauvegardes → Exporter / Importer la configuration**. Le fichier contient les réglages et les horaires de bus. Il ne contient ni les secrets, ni ce qui est propre à chaque installation : admins Telegram, adresse du site et e-mail de contact. À l'import, ces trois réglages sont conservés. Tout est vérifié avant d'être appliqué, donc un fichier invalide ne modifie rien.

Les valeurs par défaut (l'exemple du Quercy Rouergue) sont dans `lib/config.js` et dans le dossier `defaults/`. Au premier démarrage, elles sont copiées dans `data/config.json` et `data/bus.json`, qui sont ensuite modifiés par la page admin.

## La page `/admin`

| Onglet | Contenu |
|---|---|
| Tableau de bord | annonces en ligne, état du bot et des gares, fréquentation (24 h, 7 j, 30 j, total) |
| Annonces | recherche (prénom, ville, n°, téléphone, @pseudo), consultation, modification, retrait et remise en ligne, effacement définitif, export CSV ; **création d'une annonce pour une personne sans Telegram** (le code secret s'affiche à l'écran) |
| Site | identité, admins Telegram, durées de conservation, petite phrase, villes, textes « À propos » |
| Trains | gares, URL de l'API, paniers de destinations, destinations vues à classer |
| Bus | arrêts, « Bientôt ? », fiches horaires, calendrier, cars (ajouter, dupliquer, modifier, supprimer), import et export de `bus.json` |
| Sauvegardes | téléchargement de la base, export et import de la configuration (sans admins, adresse ni e-mail) |

Sécurité de la page :
- **Secrets hors de la page** : le mot de passe et les tokens restent dans le `.env` et ne sont jamais modifiables ni affichés depuis le web.
- **Sessions** : elles durent 12 h, avec un cookie `HttpOnly` / `SameSite=Strict` / `Secure` en HTTPS.
- **Essais limités** : 5 tentatives par minute, et blocage d'une heure après 10 échecs.
- **Alerte** : chaque connexion envoie un message Telegram aux admins.

Saisie d'un car dans l'onglet Bus, une ligne par arrêt :

```
07:05 Caylus · Centre
07:20 Caussade · Bd Edouard Herriot [Lu]          ← desservi le lundi seulement
07:45 Montauban · Gare routière [scolaire]        ← en période scolaire seulement
```

Tu peux aussi préparer un fichier `bus.json` ailleurs (même format que `defaults/bus.json`) et l'importer dans l'onglet Bus.

## Publication d'une annonce

1. La personne remplit le formulaire, sans numéro à taper.
2. Elle ouvre le lien Telegram et partage son numéro. Seuls les mobiles français (06/07) sont acceptés.
3. L'annonce est publiée, et le bot lui envoie un code secret pour la modifier ou la supprimer.

Deux garde-fous :
- **5 annonces en ligne maximum** par compte Telegram.
- **Une annonce « Telegram seul » demande un @pseudo**. Sans pseudo, la seule façon de joindre la personne serait d'afficher son numéro, qu'elle n'a pas choisi de montrer. Le bot lui propose de créer un pseudo dans Telegram puis de renvoyer son numéro (la demande reste valable 2 h), ou d'ajouter l'appel ou WhatsApp sur le site.

Code perdu : la personne envoie `/mesannonces` au bot, qui donne un nouveau code ou permet de supprimer l'annonce.

Sans Telegram, deux options pour l'admin : créer l'annonce depuis `/admin` → Annonces → Nouvelle annonce, ou utiliser la commande `/ajouter` du bot.

## Commandes admin du bot

Ces commandes ne répondent qu'aux identifiants listés dans `/admin`, et seulement en discussion privée avec le bot (les groupes sont ignorés, et les identifiants de groupe, négatifs, sont refusés).

- `/admin` ou `/stats` : statistiques. `/admin 48h` ou `/admin 14j` ajoute une période.
- `/annonces` : annonces en ligne.
- `/a12` : détail de l'annonce n°12, avec un bouton pour la retirer.
- `/cherche texte` : recherche, archives comprises.
- `/ajouter` : publier pour quelqu'un sans Telegram.
- `/monid` : ton identifiant Telegram (en discussion privée).

## Cycle de vie des annonces

Une annonce passe par quatre statuts :
- `online` : en ligne ;
- `expired` : la date est passée, ou l'annonce hebdomadaire n'a pas été mise à jour depuis N jours ;
- `deleted` : supprimée par son auteur·ice ;
- `removed` : retirée par l'admin.

Une annonce `expired` ou `removed` peut être remise en ligne (par l'admin ; par son auteur·ice seulement si elle a expiré). Une annonce supprimée par son auteur·ice, ou déjà anonymisée, ne revient jamais en ligne.

Les archives sont anonymisées au bout de N jours, réglable dans `/admin`. Les vérifications Telegram non terminées sont effacées après 2 h. Une sauvegarde est faite chaque jour dans `data/backups/` (les 7 dernières sont gardées).

## Vie privée

- **Aucune ressource externe** n'est chargée par le navigateur, ce que la politique de sécurité (CSP) impose.
- **Polices** : elles sont téléchargées une fois, à la construction de l'image Docker, dans `public/fonts/`.
- **Statistiques** : elles n'utilisent pas de cookie. L'identifiant de visiteur est un hash de l'IP et du navigateur, avec un sel qui change chaque jour, et l'IP n'est jamais stockée.
- **Sauvegardes** : une copie de la base est faite chaque jour et gardée 7 jours. Une annonce effacée (ou anonymisée) peut donc rester jusqu'à 7 jours dans ces copies, qui ne sont pas publiques.
- **Export CSV** : les cellules qui commencent par `=`, `+`, `-` ou `@` sont précédées d'une apostrophe, pour qu'un tableur ne les exécute pas comme des formules.
- **Cloudflare Web Analytics** : si Cloudflare propose d'injecter son script, il sera bloqué. Désactive-le dans Cloudflare (Analytics → Web Analytics).

## Organisation des fichiers

```
server.js            serveur HTTP et routes
lib/config.js        configuration (valeurs par défaut, vérification, migration)
lib/auth.js          connexion à /admin
lib/bot.js           bot Telegram
lib/trains.js        API SNCF
lib/db.js            base SQLite, statistiques, entretien
admin/index.html     page d'administration
public/              site public (index.html, styles, thèmes, icônes)
defaults/            données d'exemple (villes, phrases, horaires de bus)
scripts/             téléchargement des polices (à la construction de l'image Docker)
data/                base, configuration, sauvegardes (jamais dans Git)
```
