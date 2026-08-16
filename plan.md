# Plan — Interface web accessible JAWS pour `claude -p`

## Décisions d'architecture

- Projet Node.js avec `package.json`, Express (fichiers statiques + routes REST annexes) et le module `ws` pour le canal WebSocket (pas besoin de `socket.io` : pas de fallback polling ni de rooms nécessaires).
- Transport serveur ↔ navigateur : **WebSocket** (obligatoire dès qu'on veut le protocole de permissions interactif).
- Protocole de permissions : **interactif** dès la V1 (négociation en direct via le flux `stream-json`), plutôt qu'un simple `bypassPermissions`.
- Changement de répertoire de travail : via l'option `cwd` de `child_process.spawn`, pas de flag CLI dédié.
- Découpage : `server/` héberge toute la logique Node (spawn, WebSocket, sessions) ; `front/` est servi tel quel en statique par Express, sans build step ni bundler.
- `CLAUDE.md` et la documentation future : en anglais, pour permettre une éventuelle publication.

## 0. Initialisation

- `CLAUDE.md` en anglais (contexte projet, contraintes d'accessibilité JAWS, décisions d'architecture ci-dessus).
- Ossature `package.json` (Express, `ws`, `nodemon` en dev), `npm run start` / `npm run dev`, `git init` + `.gitignore`.

## 1. Mock du CLI

- Écrire le mock **en se basant sur la documentation** (`claude --help`) et sur les exemples déjà capturés (types `system`, `stream_event`, `assistant`, `user`/`tool_result`, `result`), sans bloquer sur une capture exhaustive du protocole de permissions.
- Le mock doit couvrir au minimum :
  - un scénario texte simple avec deltas progressifs et délai variable ;
  - un scénario avec appel d'outil (`tool_use` / `tool_result`) ;
  - un scénario de demande d'autorisation (permission interactive) mettant le flux en pause jusqu'à réponse ;
  - un scénario `AskUserQuestion` : comme les autres outils, ça transite par `tool_use`/`tool_result`, mais la réponse doit venir de l'utilisateur via l'interface plutôt que d'être auto-résolue — le serveur doit donc savoir mettre le flux en pause et attendre une réponse du navigateur, comme pour les permissions.
- Ces hypothèses seront confirmées/corrigées plus tard par une capture réelle ciblée (`--permission-mode manual` + `--input-format=stream-json`).
- Le serveur doit pouvoir invoquer indifféremment le vrai `claude` ou le mock (variable de config/env), pour basculer facilement pendant le développement.

## 2. Prototype minimal

- Formulaire → WebSocket → affichage progressif du texte (deltas), sans historique.
- Premier test JAWS ici : zone `aria-live="polite"`, pas de déplacement de focus intempestif pendant le streaming.
- Affichage minimal des `tool_use`/`tool_result` (au moins en texte brut), puisque le mock les inclut déjà.
- Bouton Annuler / tuer le process en cours.

## 3. Historique

- Historique en mémoire côté serveur (pas de persistance disque), effacé au redémarrage du serveur ou fermeture du navigateur.
- Bouton « Nouvelle session » (reset côté serveur + client).
- Gestion du titre de session (via `-n/--name` réel, ou stocké côté serveur pour le mock).

## 4. Gestion des flux de travail

- Choix du modèle (`--model`), de l'effort (`--effort`), du mode de permission (`--permission-mode`).
- Changement de répertoire de travail (cwd du `spawn`), mémorisation des derniers répertoires utilisés.
- Liste des sessions récentes du répertoire courant, reprise de session (`--resume` / `-c` / `--fork-session`).
- Gestion propre des erreurs process (crash, exit non nul, `claude` introuvable) via une zone `aria-live` d'erreurs dédiée.
- **Bonus (optionnel)** : section statistiques affichant l'utilisation du contexte, du forfait et la date de reset.

## 5. Nettoyage et publication

- Mise en conformité avec les conventions usuelles, design minimaliste avec un peu de CSS.
- Éventuelle publication sur GitHub, voire en package npm.
