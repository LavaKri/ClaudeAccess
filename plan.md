> Internal working notes, kept in French, not intended as polished public
> documentation — see CLAUDE.md's Conventions section. Written while
> designing and building the app; kept for the "why" behind non-obvious
> decisions (protocol discoveries, things tried and abandoned) rather than
> as a how-to.

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
  - ~~un scénario `AskUserQuestion`~~ : abandonné, voir note ci-dessous (§4) — l'outil ne fait pas partie du protocole observable sur ce compte.
- Ces hypothèses seront confirmées/corrigées plus tard par une capture réelle ciblée (`--permission-mode manual` + `--input-format=stream-json`).
- Le serveur doit pouvoir invoquer indifféremment le vrai `claude` ou le mock (variable de config/env), pour basculer facilement pendant le développement.

## 2. Prototype minimal

- Formulaire → WebSocket → affichage progressif du texte (deltas), sans historique.
- Premier test JAWS ici : zone `aria-live="polite"`, pas de déplacement de focus intempestif pendant le streaming.
- Affichage minimal des `tool_use`/`tool_result` (au moins en texte brut), puisque le mock les inclut déjà.
- Bouton Annuler / tuer le process en cours, à côté du bouton d'envoi. Pendant que `claude` travaille : le champ prompt est en lecture seule, le bouton d'envoi est désactivé, et inversement seul le bouton Annuler est actif.
- Distinction prévue à l'origine pour l'étape suivante entre une **demande de permission** (question fermée : oui / non / oui-toujours…, champ prompt indisponible) et une hypothétique **`AskUserQuestion`** (question ouverte, champ prompt resté disponible en plus des suggestions) — devenue sans objet, voir §4 : `AskUserQuestion` a été abandonné, seule la demande de permission (fermée) reste implémentée.

## 3. Historique

- Historique en mémoire côté serveur (pas de persistance disque), effacé au redémarrage du serveur ou fermeture du navigateur.
- Bouton « Nouvelle session » (reset côté serveur + client).
- Gestion du titre de session (via `-n/--name` réel, ou stocké côté serveur pour le mock).

**Titre de session et suggestions de prompt (confirmés réels, plus des hypothèses) :**
- `--prompt-suggestions=true` déclenche bien un événement `{"type":"prompt_suggestion","suggestion":"...","session_id":"..."}` en fin de flux, après `result` — confirmé sur un vrai `claude -p` avec un prompt « actionnable » (un prompt trivial ne suffit pas à le déclencher). Champ : `suggestion` (pas `prompt`). Pas d'`id`/réponse attendue, fire-and-forget.
- Un titre de session est bien généré automatiquement pour toute session, y compris un simple `-p` (confirmé en inspectant directement `~/.claude/projects/<cwd-encodé>/<sessionId>.jsonl`, où apparaît une ligne `{"type":"ai-title","aiTitle":"...","sessionId":"..."}`). Il existe aussi `custom-title` (renommage manuel) et `last-prompt`. **Mais ça ne transite jamais par le flux `stdout`** — écrit de façon asynchrone dans le fichier de session sur disque. Le mock n'émule donc plus de faux événement de titre dans le flux ; le vrai titre sera géré à l'étape 3 (lecture du même fichier de session, comme le fait `claude-code-webui`).
- Encodage du chemin de projet vers le nom de dossier dans `~/.claude/projects/` (confirmé via le code de `claude-code-webui`) : `/`, `\`, `:`, `.`, `_` → `-`.

## 4. Gestion des flux de travail

- ~~Changement de répertoire de travail, mémorisation des derniers répertoires utilisés, liste des sessions récentes, reprise de session, récupération du titre réel~~ — fait (voir ci-dessous).
- Choix du modèle (`--model`), de l'effort (`--effort`), du mode de permission (`--permission-mode`).
- Renommage de session (`custom-title`) — reporté à plus tard.
- Gestion propre des erreurs process (crash, exit non nul, `claude` introuvable) via une zone `aria-live` d'erreurs dédiée.
- **Bonus (optionnel)** : section statistiques affichant l'utilisation du contexte, du forfait et la date de reset.

**Historique, sessions et répertoire de travail (fait) :** confirmé qu'aucun stockage propre n'est nécessaire — `claude` persiste déjà tout dans `~/.claude/projects/<cwd-encodé>/<sessionId>.jsonl`, et `~/.claude.json` liste déjà les répertoires de travail connus (`projects`). Le serveur (`server/history.js`) ne fait que lire ces fichiers, exposés via trois routes REST (`GET /api/projects`, `GET /api/sessions?cwd=`, `GET /api/sessions/:sessionId?cwd=`) — pas de WebSocket pour ces données statiques. Dédoublonnage des sessions continuées/forkées par sous-ensemble d'ID de messages (même algorithme que `claude-code-webui`). Le titre réel (`ai-title`/`custom-title`) est récupéré avec un délai après la fin d'un tour (écriture asynchrone sur disque, non confirmée dans quel délai précisément), et immédiatement en cas de reprise d'une session existante. Changer de répertoire de travail réinitialise la conversation (nouvelle session, `allowedTools` vidé) et recharge la liste des sessions de ce répertoire.

**Protocole de permissions (confirmé par lecture de `claude-code-webui`, cloné en local) :** pas de pause/reprise en direct dans un même run. Un outil non autorisé revient simplement comme un `tool_result` avec `is_error: true` (forme confirmée par capture réelle) ; le client détecte ça, coupe la requête en cours (`abort`), affiche le choix fermé (autoriser une fois / toujours / refuser), et en cas d'autorisation, envoie une **nouvelle** requête `--resume <sessionId>` avec l'outil ajouté à `--allowed-tools`. « Autoriser une fois » n'ajoute l'outil que pour cette reprise ; « toujours autoriser » le persiste pour le reste de la session. Implique un suivi minimal de `session_id` côté front, indépendant de la gestion de session complète prévue à l'étape 3. **Non revérifié sous Auto Mode** (voir note `AskUserQuestion` ci-dessous) — à revalider quand `claude -p` sera vraiment branché en remplacement du mock.

**`AskUserQuestion` : abandonné (2026-08-20).** Testé directement en lançant un vrai `claude -p` (prompt demandant explicitement d'appeler cet outil, dans un répertoire scratch, sans risque pour le dépôt) avec `--output-format stream-json --verbose`, en nettoyant les variables d'environnement `CLAUDE_*` héritées pour simuler un lancement à froid. Résultat, reproduit avec deux binaires distincts (celui bundlé avec Claude Desktop *et* `@anthropic-ai/claude-code` installé via npm) : le compte utilisé sur cette machine a **Auto Mode** actif par défaut (`claude auto-mode config`), ce qui remplace tout le jeu d'outils standard par un jeu orienté agent autonome/arrière-plan (`Task*`, `Cron*`, `DesignSync`, `PushNotification`, `RemoteTrigger`, `ScheduleWakeup`, `SendMessage`, `Monitor`, `ToolSearch`...). `AskUserQuestion` (comme `TodoWrite`/`ExitPlanMode`) est absent de ce jeu d'outils, y compris des outils différés (confirmé par énumération complète via `ToolSearch`) — il ne peut donc structurellement pas être invoqué en l'état. Tentative de désactiver Auto Mode pour le test via `--settings` : bloquée par le classificateur Auto Mode lui-même (« Auto-Mode Bypass ») — pas de contournement cherché plus loin. Désactiver Auto Mode se ferait via `/auto-mode-setup` ou `~/.claude/settings.json`, mais c'est un réglage par compte/machine (pas par projet) : décision prise de ne pas y toucher, par simplicité. Conséquence : le protocole `AskUserQuestion` (`user_question`/`user_question_response`) a été retiré du mock, du serveur et du front — plus aucune trace dans le code, seule cette note en garde l'historique. Le protocole de permissions ci-dessus reste, lui, en place (implémenté indépendamment).

**Processus vivant via stdin `stream-json` : protocole confirmé (2026-10-22, claude 2.1.268, haiku).** Rend caducs les deux paragraphes précédents dès que le serveur sera migré. Invocation testée : `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio --replay-user-messages` (`--permission-prompt-tool` n'apparaît pas dans `--help` mais est accepté), variables `CLAUDE_*` nettoyées. Le mock (`mock/cli-mock.js`) reproduit tout ce qui suit.
- Entrée : une ligne JSON par message, `{"type":"user","message":{"role":"user","content":[...]}}` (le `content` accepte des blocs, donc pièces jointes possibles). Le processus reste vivant entre les tours tant que stdin est ouvert. Fermer stdin au repos → sortie immédiate (code 0). Fermer en plein tour → tour abandonné sans `result`, sortie en ~6 s, sous-processus nettoyés.
- `system`/`init` réémis **à chaque tour**. Fin de tour = `result` (porte `result_index`, `queued_turn_count` — ce dernier **non fiable** : valait 0 alors qu'un second message attendait ; compter soi-même via les accusés `isReplay`, qui sont émis à la consommation de chaque message). `usage` est propre au tour, mais `total_cost_usd`/`modelUsage` sont **cumulés sur la vie du processus**.
- Message envoyé pendant que Claude travaille : mis en file puis **injecté dans le tour en cours** à la prochaine frontière de résultat d'outil (un seul `result` à la fin, Claude tient compte du message). Avec `--replay-user-messages`, chaque message est renvoyé avec `isReplay: true` **au moment où il est réellement consommé** — utilisable comme accusé de réception. Pendant une demande de permission en attente, le message attend la réponse puis est injecté.
- `control_request` (stdin → CLI, réponse `control_response` avec le même `request_id`) : `initialize` (renvoie commandes, modèles, `current_permission_mode`, `pid`…), `interrupt` (arrête le tour sans tuer le processus : `tool_result` de rejet, `[Request interrupted by user for tool use]`, `result` `error_during_execution`/`aborted_tools`, le processus reste utilisable), `set_model` et `set_permission_mode` (effet immédiat, pas de redémarrage), `apply_flag_settings` (`{settings:{effortLevel}}` change l'effort à chaud — vérifié en relisant via `get_settings`) et `set_max_thinking_tokens`. `set_effort` n'existe pas. Sous-type inconnu → `subtype: "error"`.
- Permissions : avec `--permission-prompt-tool stdio`, le CLI envoie `control_request` `can_use_tool` (`tool_name`, `input`, `description`, `tool_use_id`, `permission_suggestions`) et **attend indéfiniment** la réponse. Réponse `{behavior:"allow", updatedInput, updatedPermissions?}` ou `{behavior:"deny", message}` — le message de refus est transmis tel quel à Claude, qui continue son tour. `interrupt` pendant une demande en attente → le CLI émet `control_cancel_request` pour cette demande. Les commandes jugées inoffensives par le CLI (`echo`, `sleep`) ne déclenchent aucune demande.
- **Piège `permission_suggestions`** : elles mélangent des destinations. `addRules` vers `localSettings` **écrit dans `<cwd>/.claude/settings.local.json`** du projet (constaté) ; `setMode: acceptEdits` vers `session` bascule tout le processus en acceptEdits (constaté : la demande suivante pour `Write` a sauté). Ne jamais renvoyer les suggestions telles quelles.
- **`AskUserQuestion` revient** : avec `--permission-prompt-tool stdio`, `AskUserQuestion`, `EnterPlanMode` et `ExitPlanMode` réapparaissent dans les outils malgré l'Auto Mode. Passe par `can_use_tool` (`requires_user_interaction: true`) ; on répond `allow` avec `updatedInput = {...input, answers: {"<question>": "<label choisi>"}}`.
- Sessions : persistées sur disque comme avant (`~/.claude/projects/...`). `--resume <id>` fonctionne dans ce mode, même `session_id` conservé. `/clear` envoyé comme message utilisateur → `conversation_reset` + nouveau `session_id` + `result` vide, **sans redémarrer le processus**. Attention : le `new_conversation_id` de `conversation_reset` n'est **pas** l'id de la nouvelle session (aucun fichier ne porte ce nom) ; le vrai id arrive dans l'`init` qui suit. `--session-id <uuid>` est accepté pour imposer l'id d'une nouvelle session dès le lancement. Le `cwd`, lui, impose un redémarrage.
- **À trancher plus tard (2026-10-22) — « toujours autoriser »** : rien n'est filtré pour l'instant, le serveur transmet tel quel ce que le front répond. Options discutées : limiter les autorisations à la session (réécrire `destination: localSettings` → `session`, ignorer les `setMode`), ou proposer un choix séparé « autoriser pour ce projet » qui écrirait volontairement dans `.claude/settings.local.json`.
- **Windows : `child.kill()` laisse des orphelins** (le `bash` lancé par un outil survit, constaté). `taskkill /PID <pid> /T /F` nettoie tout l'arbre (constaté).

## Points de vigilance

- **Risque `--bare`** : la doc officielle indique que `--bare` (qui n'accepte que `ANTHROPIC_API_KEY`, pas l'abonnement Pro/Max OAuth) deviendra le comportement par défaut de `-p` dans une future version. Plusieurs issues GitHub confirment que ce n'est aujourd'hui pas résolu pour les utilisateurs OAuth. On reste volontairement sur l'invocation directe de `claude -p` (sans `--bare`) tant que ce n'est pas le défaut ; à surveiller au fil des mises à jour de `claude`.
- **SDK vs CLI direct** : décision de rester sur l'invocation directe du binaire `claude` plutôt que le SDK `@anthropic-ai/claude-code`. Le SDK ne fait que spawn le même binaire (vu dans le code de `claude-code-webui`) : ça ne réduit pas le risque `--bare` ci-dessus. Vérifié aussi que l'usage personnel auto-hébergé (comme ce projet) reste dans le cadre toléré par la politique d'utilisation d'Anthropic (clarification de février 2026 sur l'OAuth des abonnements dans des outils tiers) : la restriction vise les services multi-tenant, pas un outil personnel utilisant son propre abonnement.

## 5. Nettoyage et publication

- Mise en conformité avec les conventions usuelles, design minimaliste avec un peu de CSS.
- Éventuelle publication sur GitHub, voire en package npm.
