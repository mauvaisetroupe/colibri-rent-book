# 20. Authentification par passkey, dans l'application

- Statut : Accepté
- Date : 2026-10-18

## Contexte

Jusqu'ici, l'API n'avait aucune authentification : elle n'écoutait que sur le réseau local (ADR 0011), et toute
personne qui l'atteignait pouvait tout lire et tout modifier. Pour l'ouvrir depuis l'extérieur (un tunnel Cloudflare,
puis un VPS), il faut une authentification, et le propriétaire ne veut pas qu'elle dépende d'un service tiers :
Cloudflare ne sert qu'au transport, l'application doit se protéger seule, chez elle comme chez un hébergeur.

Deux ou trois personnes s'en servent (le propriétaire, les associés), toutes avec les mêmes droits.

## Décision

- **Connexion par passkey (WebAuthn) seulement**, sans mot de passe : rien à retenir ni à se faire voler, une passkey
  ne marche que sur le vrai domaine (insensible à l'hameçonnage), et l'appareil vérifie la personne (empreinte, visage,
  code) : deux facteurs d'un coup, pas de TOTP. La vérification des réponses WebAuthn (CBOR, signatures) est celle de
  `@simplewebauthn/server` et `@simplewebauthn/browser` (MIT), pas du code maison.
- **Liée à l'adresse de l'application** (`COLIBRI_ORIGIN`, ex. `https://colibri.example.org`) : le nom d'hôte est
  l'identifiant des passkeys. L'accès par une adresse IP ne permet pas de se connecter (WebAuthn la refuse) ; en
  développement, `http://localhost:5173` est accepté. En production, l'API **refuse de démarrer** sans
  `COLIBRI_ORIGIN` : elle ne peut pas tourner ouverte par oubli.
- **Session** : un cookie aléatoire `HttpOnly`, `SameSite=Strict`, `Secure` en https, gardé en base (révocable),
  valable 30 jours après la dernière utilisation. Une modification envoyée avec le cookie doit venir de l'origine de
  l'application.
- **Toute l'API est fermée** sans session ni jeton, sauf `/api/health` et ce que demande la connexion ; les fichiers du
  frontend restent servis (la page de connexion en fait partie), sans aucune donnée.
- **Pas d'inscription** : un compte et sa première passkey viennent d'un **lien à usage unique** (15 minutes) fait sur
  le serveur (`cli/lien.js <email> [nom]`). Le même lien sert à la récupération si tous les appareils sont perdus.
  Une fois connecté, « Mon compte » ajoute une passkey sur l'appareil, ou sur **un autre appareil** par un lien affiché
  en **QR code** (un téléphone le scanne et crée sa propre passkey) ; la dernière passkey d'un compte ne se supprime
  pas.
- **Jetons d'API** pour les scripts (`Authorization: Bearer`), créés dans « Mon compte » ou sur le serveur
  (`cli/jeton.js`), révocables, affichés une seule fois.
- Seules les **empreintes** (SHA-256) des cookies, des liens et des jetons sont en base : une copie de la base ne donne
  aucun accès. Pas de rôles : tous les comptes ont les mêmes droits.

## Conséquences

- L'application peut être exposée (tunnel, VPS) sans protection en amont ; Cloudflare Access ou un autre proxy restent
  possibles, jamais nécessaires.
- Changer de domaine oblige à réenregistrer les passkeys (un lien par compte) ; passer chez un hébergeur avec le même
  domaine ne change rien.
- Les tests et le développement sans `COLIBRI_ORIGIN` tournent sans authentification ; les scripts de l'exploitation
  envoient un jeton (`COLIBRI_JETON`).
- Migration 017 : `utilisateur`, `passkey`, `session`, `lien_enregistrement`, `jeton_api`.
