# Architecture de SpokaStream

Ce document garde les décisions, les mesures qui les ont motivées, et ce qui n'a pas marché. Mesures faites sur Windows 11, i7-11700K, RTX 5070, Electron 45 (Chromium 156).

## Les trois pièces

| Pièce | Rôle | Pourquoi |
| --- | --- | --- |
| **Application Electron** | Interface, capture de l'image, WebRTC | Chromium apporte WebRTC, les encodeurs matériels et tout le savoir accumulé sur la party |
| **SpokaAudio** (C#, 11 Mo) | Capture du son par processus, capture d'image, touches globales | Des API que le web n'expose pas. C#, parce qu'il n'y a pas de compilateur C++ dans la chaîne et que c'est la stack de SpokaSoundBoard |
| **Serveur de salons** (Node, un seul fichier) | Présente les participants, chat, état des salons | Ne voit jamais la vidéo : il tient sur le VPS sans rien lui coûter |

## Son

Le moteur envoie du flottant 32 bits, stéréo, 48 kHz, sur stdout. Le processus principal le relaie par un `MessagePort` directement au fil audio temps réel de la page : le son ne passe jamais par le fil de l'interface, une interface qui rame ne le coupe pas.

- **Application précise** : `INCLUDE_TARGET_PROCESS_TREE` sur la racine de l'application. Il faut remonter à la racine, un navigateur joue le son depuis un sous-processus.
- **Tout le PC** : `EXCLUDE_TARGET_PROCESS_TREE` sur SpokaStream. C'est ce qui supprime l'écho : le son qu'on reçoit n'est jamais renvoyé.
- **« Tout le PC » et une application s'excluent** : les garder ensemble doublerait le son de l'application.

`DriftBuffer` absorbe la dérive entre l'horloge de la carte son et celle du contexte audio, à ±0,5 %, inaudible. Testé sur 4 minutes simulées à ±0,2 % : aucune coupure, latence stable.

## Image

Toute la capture passe par une seule piste, et chaque spectateur a sa connexion.

### Capture native

Windows.Graphics.Capture impose par défaut un intervalle d'environ 16,7 ms entre deux images. Sur un écran 144 Hz, la première image après ce délai tombe à la 3e synchro : 20,8 ms, soit **48 i/s**. Chromium ne règle pas cette limite, d'où les ~47 i/s constants de la capture de bureau, quels que soient la taille de l'image, l'encodeur ou la cadence demandée.

`GraphicsCaptureSession.MinUpdateInterval` (Windows 11 24H2) la lève. SpokaAudio capture donc lui-même, convertit en NV12 sur la carte graphique (`ID3D11VideoProcessor`, redimensionnement compris), relit en mémoire et tient la cadence voulue. Une image coûte 0,8 ms.

Chemin des images : moteur → WebSocket local → worker → `VideoFrame` → `MediaStreamTrackGenerator`. Une mémoire partagée serait idéale, mais une page isolée ne peut pas en ouvrir sans module natif.

Mesuré sur une fenêtre 1886x993, AV1 matériel :

| Capture | Cadence encodée | Processeur (machine) |
| --- | --- | --- |
| Chromium, 60 demandés | 47,5 i/s | 5,2 % |
| Native, 60 demandés | 55-58 i/s (60 reçues par la page) | 8,5 % |
| Native, 120 demandés | ~103 i/s (118 reçues par la page) | 17 % |

Le transport plafonne à environ 340 Mo/s, dans le service réseau de Chromium : deux connexions parallèles n'y changent rien et mélangent les images. Le 1440p60 (332 Mo/s) tient donc environ 55 i/s, et le 4K60 tomberait à 27 i/s. **En dessous de 48 i/s possibles, le moteur refuse et la capture de Chromium prend le relais**, tout comme sur un Windows qui ne connaît pas `MinUpdateInterval` ou WGC. Le choix se fait tout seul et le diagnostic l'indique.

Détails qui comptent :

- WGC n'envoie rien tant que l'écran ne change pas. Le moteur répète la dernière image toutes les 200 ms : sinon un nouveau spectateur n'aurait pas d'image, et l'encodeur pas de quoi produire une image clé.
- La relecture attend la carte graphique (1 ms) : une file de relecture l'éviterait mais ajouterait deux images de latence.
- Ce sont des images de l'écran : le port local exige un jeton de 256 bits et refuse tout le reste immédiatement.
- Sur cette piste, Chromium cache le nom de l'encodeur tant qu'aucune de ses captures n'est ouverte : le Studio reprend celui de la mesure initiale.

Pour une capture Chromium, **ne jamais mettre `maxWidth` sur une fenêtre** : l'image est agrandie jusqu'à cette limite. Une fenêtre de 960 px partait en 8K et écrasait la machine.

### Liste des sources

`desktopCapturer` rend souvent une miniature vide, et jamais d'image pour un jeu OpenGL en plein écran exclusif. Une fenêtre sans miniature n'est donc pas une fenêtre à écarter : le moteur énumère lui-même les fenêtres visibles (`windows.list`), et `missingWindows` ajoute celles qui manquent, sans aperçu. Les identifiants de Chromium n'ont pas tous le même suffixe (`window:123:0`, `window:123:1`) : seul le numéro compte pour les comparer.

Quand la cadence tombe sans surcharge ni perte réseau, c'est que la source n'envoie plus d'images. `FrameServer` répète alors la dernière toutes les 200 ms : **5 i/s et 0 Mb/s** veulent dire que rien de neuf n'arrive, pas que la connexion lâche.

### La souris dans les jeux OpenGL

WGC force le curseur logiciel, dessiné par le compositeur. Dans un jeu OpenGL ou Vulkan qui présente sans passer par lui, plus personne ne le dessine : **la vraie souris disparaît de l'écran du joueur**, en direct seulement. C'est [connu de Microsoft](https://github.com/microsoft/Windows.UI.Composition-Win32-Samples/issues/128), toujours ouvert au 2026-10-31, et `IsCursorCaptureEnabled` n'y change rien. Les traces du pointeur de Windows font tomber les mêmes jeux dans le même piège, puisqu'elles forcent le même mode.

**Ne pas remettre la duplication du bureau.** La « capture compatible » (`DesktopDuplication.cs`, de la 1.6.1 à la 1.6.6) ramenait la souris, mais l'écran du joueur et le stream clignotaient fortement sur la machine même où elle devait aider, ce qui est un risque pour les personnes photosensibles. Le rapport Microsoft signale aussi qu'elle marche mal avec l'OpenGL en plein écran depuis 24H2. La capture de jeu répond au même besoin sans ce défaut, testée sur le vrai Project Zomboid le 2026-11-01. Un jeu Vulkan touché par le bug n'a pas de réponse dans l'application : il lui reste une vraie fenêtre, ou le réglage NVIDIA « Préférer superposé sur une chaîne d'échange DXGI ».

### Capture de jeu

C'est ce que font Discord et OBS sur ces jeux : ne pas demander l'image à Windows, la prendre dans le jeu. `GameCapture.cs` injecte `SpokaHook.dll` (`CreateRemoteThread` + `LoadLibraryW`), uniquement si `gameCapture` est coché, uniquement sur une fenêtre choisie, et uniquement si le processus a chargé `opengl32.dll`. Windows ne voit aucune capture : le curseur reste matériel, donc visible du joueur, et `CursorPainter` le pose sur l'image des spectateurs.

La DLL remplace `SwapBuffers` et `wglSwapBuffers` dans les tables d'imports de tous les modules, sans réécrire de code, et recommence toutes les 2 s puisque Java charge sa fenêtre tard. Chaque image passe par un anneau de 3 PBO : `glReadPixels` ne bloque pas le jeu, au prix de deux images de retard. Elle arrive dans une mémoire partagée `Local\SpokaGameFrames-<pid>` à deux emplacements, avec un évènement pour réveiller le lecteur. Un fil à part fait cette copie, comme dans OBS : le jeu ne fait que l'ouvrir et la refermer, car OpenGL n'accepte ces appels que depuis son propre fil. La cadence garde une marge d'un quart d'intervalle : sans elle, un jeu à 60 i/s capturé à 60 i/s perd une image sur deux.

La DLL reste dans le jeu jusqu'à sa fermeture : la décharger pendant qu'il tourne serait le vrai danger. Windows retire le nom de la mémoire dès que le lecteur la ferme, même si la DLL garde sa vue : elle vérifie donc chaque seconde que le nom existe, lâche l'ancienne, et rouvre la suivante. Sans ça, une capture relancée n'aurait plus jamais d'image. Ça couvre aussi un moteur planté.

Si rien n'arrive en 2,5 s, on revient à la capture habituelle et l'interface le dit. Le moteur rend à l'interface `gameCapture` : `active`, `failed`, `protected` ou `unsupported`, ce dernier en silence, puisque la capture normale est alors la bonne.

**Discord et OBS entrent dans les jeux avec une DLL signée, que les éditeurs d'anti-triche connaissent. La nôtre n'est pas signée.** Une DLL n'hérite pas de la confiance d'une autre : les responsables d'OBS renvoient chacun à sa propre signature et à une demande auprès des éditeurs. Même une DLL signée peut être coupée : en juillet 2026, Vanguard a bloqué le Game Capture d'OBS sur LoL et Valorant jusqu'à une mise à jour. On n'entre donc que là où c'est indispensable. Le bug de souris vise les jeux OpenGL et Vulkan, pas Direct3D : LoL n'a aucune raison de recevoir la DLL, et WGC ne le touche pas. L'option reste à cocher, mais la décision revient au moteur, dans cet ordre : fenêtre de navigateur (Chromium et Firefox chargent OpenGL sans être des jeux), `AntiCheat.Protects`, 32 bits (`LoadLibraryW` 64 bits y ferait planter le jeu), `opengl32.dll` chargée. Les trois premiers contrôles n'ouvrent pas le jeu en lecture : un jeu protégé n'est jamais lu.

`AntiCheat.cs` cherche les jeux Riot, les services d'anti-triche en marche et leurs traces **dans le dossier du jeu seulement**, jamais dans les dossiers partagés de Windows : sur ce PC, un vieux `AppData\Local\BattlEye` bloquait tout. Cette liste ne connaît pas tous les anti-triches, et VAC ne laisse aucune trace locale. Project Zomboid n'annonce pas d'anti-triche sur sa page Steam, même si ses serveurs gardent un réglage `SteamVAC`.

**Signer ne réglerait rien d'un coup** (point du 2026-11-01). Pour un anti-triche, il faudrait encore se faire accepter par chaque éditeur. Pour Windows, un fichier signé reste signalé tant que son éditeur n'a pas de réputation : Microsoft parle de plusieurs semaines et de centaines d'installations. Azure Artifact Signing est fermé aux particuliers hors États-Unis et Canada, et SignPath Foundation demande une réputation vérifiable et s'affiche comme éditeur à notre place. Seul le Microsoft Store retire l'alerte tout de suite, gratuitement pour un particulier, et seulement en MSIX : sa voie `.exe` exige une signature payante (règle 10.2.9). `docs/STORE.md` est le guide complet, avec la fiche et les notes de certification.

`npm run dist:store` construit le paquet avec `electron-builder.store.yml` et `build/store-manifest.xml`, un modèle à part parce qu'electron-builder ne connaît pas les capacités `uap11`. Sans `graphicsCaptureWithoutBorder` et `RequestAccessAsync`, **Windows encadre de jaune ce qui est capté dans une application empaquetée**, même avec `IsBorderRequired` à faux : `video.borderless` le demande avant la première capture. `process.windowsStore` coupe `electron-updater`, l'identifiant, le lien par le registre et le lancement avec Windows, qui n'existe pas sous cette forme.

Essayé le 2026-11-02 avec le mode développeur et `Add-AppxPackage -Register` : application et moteur sous l'identité du paquet, son d'une application (process loopback), micro accordé, capture normale à 58 i/s sans cadre, DLL dans un jeu OpenGL d'essai à 59 i/s. Cette méthode laisse les fichiers hors de `WindowsApps` : là, on a seulement vérifié que des processus ordinaires lisent et projettent les DLL de 4 paquets installés. **Lancer un essai du paquet avec un profil vide** : une application empaquetée peut lire le vrai `AppData`, donc les identifiants de la personne, et elle n'hérite pas des variables d'environnement de l'appelant. Passer par un `.cmd` lancé avec `Invoke-CommandInDesktopPackage`. Les règles n'interdisent pas l'injection en toutes lettres, mais la règle générale de sécurité (10.2) laisse Microsoft juge.

La DLL se compile avec MSVC dans `build-native.ps1`, et `SPOKA_WINSDK` désigne une copie dépliée du SDK Windows sur un PC qui n'a pas de kit installé.

### Coût pour le jeu

Mesuré en 1080p60 sur une RTX 5070, avec un jeu OpenGL sans limite d'images qui occupe toute la carte, en plein écran sur le second écran. Le moteur seul enlève environ 5 % d'images au jeu, la capture de jeu 15 à 20 % quand la carte est saturée mais 6 à 8 % quand c'est le processeur qui limite, et l'application entière 15 à 20 % avant la correction ci-dessous.

Le gros du surcoût d'Electron n'est pas l'encodage : c'est la fenêtre redessinée à 60 i/s. Deux choses ne tournent que pendant un direct : le point « en direct » qui pulse et les vumètres. Chacune force un dessin complet, et le retour, la plus grande surface de la fenêtre, suit. Sans le focus, `followFocus` pose `is-blurred` sur la page (plus de pulsation), les vumètres passent à 10 mises à jour par seconde, et le retour à 15 i/s, sur une copie de la piste ralentie par `applyConstraints` : la piste envoyée et les clips gardent toute leur cadence. Temps de carte de l'application : 5,6 % contre 6,5 à 8 %.

Essayé sans effet mesurable : couper l'overlay, couper les clips (l'encodeur NVENC est un moteur à part), remettre l'occultation native de Chromium (`backgroundThrottling: false` dessine quand même, et il protège les minuteries) et relever `MinUpdateInterval` à la cadence voulue. **Pour mesurer, ne pas se fier aux seuls FPS** : sur un PC utilisé par ailleurs, ils varient de 30 % d'un essai à l'autre. Le temps de carte de l'arbre de processus (`GPU Engine`) est bien plus stable. Windows refuse aussi de donner le premier plan à une fenêtre de test : il faut simuler la perte de focus dans la page.

### Choix du codec

Mesure réelle à la première diffusion, 2 s par codec :

| Codec | Encodeur | 1080p60 |
| --- | --- | --- |
| AV1 | NVIDIA AV1 (matériel) | ~6 ms par image |
| H265 | NVIDIA HEVC (matériel) | ~5 ms |
| H264 | NVIDIA H.264 (matériel) | ~5 ms |
| VP9 | libvpx (processeur) | ~11 ms |

**AV1 n'est plus choisi en automatique.** Sur la RTX 5070 de développement (pilote 610.88), des parcours e2e en AV1 matériel ont provoqué un évènement `nvlddmkm 153`, réinitialisation du pilote, environ 100 s après le départ, autour des étapes qui changent la taille d'affichage. L'application se bloque alors en attendant un autre processus (`AppHangXProcB1`) et le processus GPU ne redémarre pas seul. Sur 12 parcours en AV1 arrivés à cette étape les 1er et 2 novembre : 5 resets, dont 3 sur 3 pour les derniers, plus un 6e le 31 octobre. En H264 et H265, aucun sur les parcours suivants. Le déclencheur exact n'est pas prouvé, et ce pilote avait déjà eu 2 resets en juin, avant SpokaStream. **Regarder `nvlddmkm` dans le journal Système avant de classer un test bloqué en aléa.**

Sans le drapeau `WebRtcAV1HWEncode`, AV1 tourne sur le processeur (`libaom`), pendant le jeu de la personne. Les noms de drapeaux viennent d'une recherche dans le binaire d'Electron : plusieurs noms connus sur internet n'existent plus.

Le classement met d'abord ce qui tient la cadence, puis le matériel, puis l'efficacité. **On juge le coût par image, pas la cadence atteinte** : les encodeurs NVIDIA avaient été recalés à 50 i/s alors que c'était la scène de test qui plafonnait. Pour la même raison, le choix n'est plus « le plus rapide » comme dans la party : à débit égal, AV1 et H265 donnent une bien meilleure image que H264.

Un spectateur qui ne décode pas le codec préféré n'est pas bloqué : le SDP retombe sur le suivant.

### Débit

Chrome plafonne l'encodeur d'après le SDP distant. On négocie donc 300 Mb/s une fois pour toutes dans la réponse du spectateur, puis `setParameters` pilote le débit réel : il change à chaud, sans renégocier ni couper, contrairement à la party.

### Clips

MediaRecorder coupe un fragment à chaque image clé. Sur un PC chargé, un fragment peut ne contenir aucun échantillon d'une piste, qui porte alors un temps de zéro. Une piste à plus de 2 secondes de l'autre ne compte donc pas pour trouver le début d'un fragment (`fragmentStart`) : la prendre laissait tout le clip décalé de son temps d'enregistrement.

Une seule mémoire tourne à la fois : son propre stream, sinon celui qu'on regarde en grand. MediaRecorder y écrit un MP4 fragmenté avec une image clé par seconde, et `mp4.ts` ne garde que l'en-tête et les derniers fragments. Couper ne réencode rien : il suffit de remettre le temps à zéro dans chaque fragment, avec le même décalage en secondes pour l'image et le son, sinon ils se décalent.

- **`avc3`, pas `avc1`** : avec `avc1`, la définition n'est écrite qu'une fois dans l'en-tête, et Chromium se plaint dès qu'une fenêtre change de taille.
- **MP4 plutôt que MKV** : H.264 et AAC, le seul mélange que Discord et tous les lecteurs acceptent.
- **Coût mesuré** à 946x532 : +1 point de processeur chez le diffuseur, +4 chez le spectateur, qui doit réencoder ce qu'il reçoit. Sans encodeur matériel H.264, les clips restent coupés.

### Bulle caméra

La caméra est un second flux vidéo dans la connexion de chaque spectateur, réservé dès l'ouverture : l'allumer ne renégocie rien et ne touche pas à l'image principale. Elle reste chez le spectateur : ni dans les clips ni dans les enregistrements. Les mesures ne regardent que `mid` 0, sinon elles suivraient la caméra.

**Ne pas appeler `setParameters` sur un flux réservé sans piste** : mesuré, la page du diffuseur se fige plusieurs secondes de plus à chaque redimensionnement.

Sa place voyage avec le stream (`cameraLayout`), en fractions de l'image : chaque spectateur dessine la bulle lui-même. Rien n'est incrusté, donc rien n'est réencodé, et un téléphone la place aussi bien qu'un PC. Le prix : elle n'est pas dans les clips ni les enregistrements.

### Régie

La barre de direct reste visible partout. Le Studio et la vue Régie affichent les mêmes panneaux, définis une seule fois dans `RegiePanels.tsx` : l'un dans une colonne, l'autre sur trois zones. La disposition vit dans les réglages. Les modèles sont connus : le Stream Manager de Twitch pour les panneaux déplaçables et les actions rapides, le Live Control Room de YouTube pour la santé qui dit quoi faire, OBS pour les réglages par source et les raccourcis de scène.

La fenêtre détachée n'est pas une seconde application : c'est la même arborescence React rendue dans une autre fenêtre par un portail, donc rien à synchroniser. Conséquences : les styles sont recopiés dans son document, et tout ce qui mesure ou écoute doit passer par `ownerDocument`, sinon les menus s'ouvrent dans la fenêtre principale. `setContentProtection` la retire des captures.

Le décalage et la baisse automatique sont deux nœuds de plus par source dans le mixeur. Le décalage ne fait que retarder : on ne peut pas avancer un son. La voix mesurée pour la baisse automatique est celle du vocal et des entrées du mixeur.

### Scènes

Une scène retient la source, les sons de la table, la caméra, sa place et le bandeau, dans les réglages du diffuseur. Les passages utilisent `switchSource`, qui remplace la piste sans renégocier. Une fenêtre change d'identifiant et une application de numéro de processus quand le jeu redémarre : la scène les retrouve alors par leur nom. Les volumes ne sont pas retenus, et un fichier non plus, car une page ne peut pas rouvrir un fichier seule.

### OBS

OBS 30 sait pousser sa sortie en WHIP. L'application écoute donc sur `127.0.0.1:8189` (ou le port suivant libre), avec une clé propre à ce PC. Le processus principal ne fait que passer l'offre à la page : c'est elle qui reçoit l'image et le son, et ils deviennent une source comme une autre. Chaque spectateur a donc un réencodage de plus, ce qui justifie un débit généreux dans OBS.

Trois détails, mesurés sur OBS 31 :

- **OBS doit ouvrir le chiffrement** (`a=setup:passive` dans la réponse). Si c'est Chromium, OBS passe à `Failed` 2 ms après la connexion réseau, sans message. Cause probable, non prouvée : un premier message trop gros, découpé, qu'OBS ne recolle pas.
- **L'offre d'OBS ne contient aucune adresse** : tout repose sur celles de la réponse, qui doit donc les porter toutes. `revealCandidates` remplace les noms en `.local` si Chromium en met.
- **Une piste distante n'entre dans Web Audio que si un élément la lit aussi** : même détour que pour les spectateurs.

`tests/e2e/obs.ts` lance le vrai OBS dans une copie portable. **Ne pas écrire `global.ini` à la main** : cette copie bloque alors avant même d'ouvrir son journal. On la laisse créer sa configuration, puis on ne change que `service.json` et les sources audio du PC.

### Page web

La source navigateur s'appuie sur `setDisplayMediaRequestHandler` : `getDisplayMedia` rend l'image et le son d'une seule `WebFrameMain`, celle de la fenêtre ouverte par `WebSource`. Cette fenêtre a sa propre session persistante et aucune passerelle vers l'application.

### Overlay

**Ne jamais redimensionner la fenêtre de l'overlay.** Elle couvre un écran entier et c'est son contenu qui se place sur la fenêtre capturée. La version qui suivait la fenêtre par `setBounds` figeait la page principale du diffuseur, avec le fil bloqué hors de JavaScript. Le mécanisme exact dans Chromium n'est pas élucidé, mais la bissection est nette : overlay coupé, plus de gel. Le parcours de bout en bout garde ce cas.

Quand une fenêtre capturée change de taille, l'encodeur se réinitialise en 0,6 s, hors du fil de l'interface, et rien ne se fige. On a longtemps cru le contraire, jusqu'à documenter un arrêt de la page depuis la 1.0.1 : c'était l'outil de test. Playwright reçoit par DevTools chaque trame WebSocket de la capture native, ce canal sature, et une page parfaitement fluide semble muette pendant 30 s, avec des gigaoctets en attente dans le processus principal si le test cesse de lire. Une trace Perfetto du même moment montre 143 i/s et jamais plus de 31 ms entre deux images, pendant que Playwright annonce 15 s. **Toute mesure de fluidité se fait dans la page, jamais à travers DevTools.** Les mises en garde sur `setParameters` et le redimensionnement de l'overlay viennent de cette ancienne méthode : elles restent appliquées, mais n'ont pas été revérifiées.

## La scène

Toutes les dispositions passent par une seule fonction pure, `layoutWall` (`ui/wall.ts`), qui rend un rectangle par image. Chaque tuile reste au même endroit du DOM, en position absolue : changer de disposition ne remonte aucun composant, donc aucun lecteur ni le cadre de la Watch Party ne redémarre. Une disposition libre est gardée en parts de la scène, par personne et non par stream, parce qu'un stream change d'identifiant à chaque direct. Elle démarre de ce qui est à l'écran. Les petites images passent toujours devant les grandes, sinon une disposition venue de l'incrustation en cacherait une.

Le son solo passe par `soloOf` dans le store, pour qu'un seul endroit décide de ce qu'on entend. La qualité suit la taille de la tuile : `fitSub` attend 1,5 s que la tuile se pose avant de renégocier, et ne plafonne jamais un stream seul à l'écran.

## Watch Party

Le serveur sert `/player`, une page minuscule que l'application et le site affichent en cadre et pilotent par `postMessage`. YouTube refuse une page sans origine web, et l'application est chargée depuis un fichier. Un fichier ou un flux HLS passe par la même page, dans un simple `<video>` : les états rendus sont ceux de YouTube, donc le reste du code ne voit aucune différence. `hls.js` n'est chargé qu'à la demande. Le titre et la vérification d'un lien se font dans le processus principal de l'application (`webSource.ts`), jamais sur le serveur : lui faire ouvrir une adresse donnée par un client permettrait de lui faire joindre n'importe quoi. Un `<video>` caché essaie ensuite vraiment le lien, seul moyen de savoir si le format passe.

Une page https refuse une vidéo http, et un cadre `file:` ne change rien à ça : ces liens basculent vers « Diffuser cette page ».

Un flux `captureStream()` meurt avec la fin du média. Le fichier diffusé tourne donc toujours en boucle, et `followFile` met en pause au retour au début quand personne n'a demandé la répétition.

Le cadre ne reçoit aucun clic : toutes les commandes sont les nôtres, et un geste passe toujours par le serveur avant de s'appliquer, chez celui qui l'a fait comme chez les autres. Aucune boucle possible, parce que l'état du lecteur n'est jamais renvoyé au salon.

Le serveur garde une position et l'instant où elle était vraie, et calcule la position réelle à chaque envoi : un arrivant reprend au bon endroit. Chaque client compare sa position toutes les 500 ms et ne se recale qu'au-delà de 1,5 s d'écart, sans jamais insister plus d'une fois toutes les 3 s : une publicité YouTube ne déclenche pas de rafale.

Le lecteur est une page tierce : le gestionnaire de permissions lui refuse le micro, la caméra et l'écran.

## Revoir et partager

Le clip reste découpé en fragments tant qu'il est ouvert : couper revient à choisir des fragments, à la seconde près, sans réencoder. Partager n'envoie au salon qu'une vignette. Le fichier reste chez son auteur et part de PC à PC quand quelqu'un l'ouvre, sur une connexion qui ne vit que le temps de l'envoi. Les 6 derniers clips restent disponibles tant que leur auteur est là. Le texte du message n'est lu que par les versions qui ne savent pas afficher un clip.

## Lecteur web

Une application servie par le serveur (`/` et `/w/CODE`), construite par `scripts/build-viewer.mjs` et embarquée dans `server/viewer.gen.ts` : il n'y a toujours qu'un fichier à déployer. Elle réutilise `Signal`, `Subscription`, `Voice`, `ClipShare` et `StrokeCanvas`, avec Preact plutôt que React : un téléphone sur son forfait ne doit pas télécharger 190 ko de bibliothèque. Tout tient en 90 ko, 30 ko compressés. L'invitation `/j/CODE` y mène directement sur un téléphone.

- **Le plein écran porte sur toute la page, jamais sur la vidéo.** Le lecteur natif d'un téléphone met la vidéo en pause en sortant, et le chat ne pourrait pas rester à portée. Un iPhone n'a que ce lecteur natif : la page y occupe tout ce qu'elle peut, et l'ajout à l'écran d'accueil retire les barres de Safari.
- **Un seul élément vidéo pour toute la séance**, créé hors de l'arbre de composants : le geste qui autorise le son reste valable quand l'écran se reconstruit.
- **La qualité automatique descend vite et remonte lentement** : mieux vaut 480p fluide que 1080p figé. Elle part de 720p sur un écran tactile, et reste basse si le navigateur signale une connexion lente ou l'économie de données.
- **Preact 11 n'ajoute plus `px` aux nombres dans les styles** : une largeur numérique est ignorée sans erreur. Les calques posés sur l'image ont perdu leur taille comme ça.
- **Installable** : un manifeste et un service worker sans cache. Un salon n'a de sens que connecté, rien n'est gardé hors ligne.
- **Le titre d'une vidéo YouTube** passe par `/oembed` : YouTube ne le donne pas à une page web.

La politique de sécurité n'autorise que ce serveur. Le chat y est écrit en `textContent`, jamais en HTML. Un téléphone demande 720p par défaut, avec un encodage dédié chez le diffuseur comme tout spectateur.

Un bannissement repose sur le jeton de l'appareil : depuis un navigateur, une nouvelle identité se crée en vidant ses données. Pour un salon qui doit rester fermé, c'est le verrou qui protège.

### Notifications

`server/push.ts` applique Web Push sans dépendance : aes128gcm (RFC 8291) pour le contenu, VAPID (RFC 8292) pour l'identité. Les clés et les abonnements vivent dans `push.json`, à côté de `rooms.json`. L'adresse d'envoi vient du client : le serveur n'accepte que celles des services de push des navigateurs. Un même événement ne repart pas avant 10 minutes, et rien ne part dans la minute qui suit un démarrage, où les streams en cours s'annoncent à nouveau. L'envoi réel vers un téléphone n'est pas couvert par les tests : seuls le chiffrement et les règles d'envoi le sont.

## Prendre la main

Les gestes passent par un canal de données dans la connexion du spectateur : le serveur n'en voit rien, et ce canal existe dès l'ouverture sans rien coûter tant que personne ne s'en sert. Ils traversent la page du diffuseur, le processus principal, puis `RemoteInput` dans SpokaAudio.

**Les garde-fous sont dans le moteur natif**, pas dans l'interface : armement sur une seule cible, premier plan vérifié à chaque lot, table de touches fermée, signe de vie toutes les secondes. Les touches partent en code de position : c'est ce que lisent les jeux, et chacun garde sa disposition de clavier.

- Ctrl+Alt+lettre est bloqué parce que c'est la forme des raccourcis globaux : un ami ne doit pas pouvoir couper le stream ni accepter à la place du diffuseur. E reste permis pour écrire € avec Alt Gr.
- `SetForegroundWindow` n'est accordé qu'à qui vient de recevoir une entrée : le moteur presse Alt le temps de l'appel.
- Le moteur se déclare sensible à l'échelle de l'écran, sinon Windows lui donne des positions fausses dès 125 %.
- Un moteur relancé repart désarmé.

## Comptes et appareils

Il n'y a toujours ni mot de passe ni e-mail. Le jeton d'un appareil donne son identifiant, et ce qui a changé, c'est qu'un appareil peut maintenant se rattacher à un compte (`server/accounts.ts`). Le PC de départ est le compte : son identifiant ne change pas, donc les salons existants lui appartiennent toujours.

`userId` reste l'**appareil** : c'est lui qui est membre d'un salon et que WebRTC adresse. `accountId` est la **personne** : propriété des salons, bannissements et profil se décident là. Donner le même `userId` au téléphone aurait été plus simple, et il aurait éjecté le PC du salon à chaque connexion.

La régie à distance passe par le serveur, sans WebRTC : le PC pousse `remote.state` quand quelque chose change, le téléphone envoie `remote.cmd`, et le serveur ne relaie qu'entre appareils du même compte. Ce que le téléphone affiche vient toujours du PC, jamais d'une supposition locale. Le PC n'exécute que la liste fermée de `onRemoteCommand`, et il renvoie son état juste après chaque commande : une touche qui s'allume une seconde plus tard donne envie d'appuyer deux fois.

Les salons appartiennent à la personne : `account.rooms` les envoie à chaque connexion et à chaque liaison. Avant, la liste du téléphone ne venait que de sa mémoire locale, et un téléphone lié arrivait sur un accueil vide. Sur l'accueil, un seul champ tente d'abord une liaison, puis un salon : deux champs auraient rejoué l'erreur de mettre le code au mauvais endroit. Le code de liaison peut aussi se saisir à la main, parce que sur iPhone l'icône de l'écran d'accueil et Safari ne partagent pas leur stockage, donc pas leur identité : le QR code ne lie que Safari.

Un PC allumé envoie aussi `remote.state` avec `idle` quand il ne diffuse pas : c'est ce qui dit au téléphone que le PC est là. Il n'y met de quoi lancer un direct que si `allowRemoteStart` est activé, désactivé par défaut puisque cela partage l'écran sans personne devant.

La régie du téléphone (`web/deck.ts`, `web/Deck.tsx`) tient en quinze touches par page, comme un Stream Deck : 5×3 en paysage et 3×5 en portrait, donc tourner le téléphone ne change ni l'ordre ni le nombre de touches. `keyView` calcule ce que montre une touche à partir de l'état du PC, sans rien afficher : c'est ce qui se teste. Une touche qui attend le PC compare son apparence avant et après : si rien ne change dans les délais, elle le signale. La disposition reste sur le téléphone. La régie couvre le salon sans le démonter, pour que la vidéo et le vocal continuent dessous.

## Panneau d'administration

`server/admin.ts`, `server/adminAuth.ts` et `admin/` : une page servie par le serveur, sous `/admin`. On y entre avec un identifiant et un mot de passe, indépendants de tout compte d'appareil : le panneau doit rester accessible sans l'application, c'est même là qu'il sert le plus. Le mot de passe est gardé en empreinte scrypt dans `admin-auth.json`, le code à 6 chiffres suit la RFC 6238, et un code déjà utilisé ne ressert pas. Après 5 échecs, une adresse est bloquée 15 minutes.

Chaque accès a son rôle : propriétaire, administrateur, modérateur. Le rang de chaque action est dans `ACTION_RANK`, côté serveur : l'interface ne fait que masquer ce qui serait refusé. Le rôle se relit à chaque requête, donc retirer un droit agit tout de suite. Il reste toujours un propriétaire actif, sinon plus personne ne pourrait gérer les accès.

Un accès se crée avec un lien à usage unique valable 24 h. Le premier, et la porte de secours en cas d'oubli, vient de `sudo bash deploy/admin-setup.sh` sur le VPS : ce lien vise l'accès du propriétaire et retire son code à 6 chiffres, puisque c'est ce qu'on a pu perdre. Les comptes de `ADMIN_ACCOUNTS`, et ceux rattachés à un accès, gardent un raccourci depuis l'application : un billet valable 60 s. Un téléphone lié n'a aucun passe-droit : un téléphone volé ne doit pas ouvrir le panneau.

La session est un cookie `HttpOnly`, `SameSite=Strict`, de 12 h, et toute écriture vérifie aussi son origine.

Derrière nginx, l'adresse du client est le **dernier** maillon de `X-Forwarded-For` : le début de la liste est écrit par le client, et s'y fier rendrait tout blocage inutile.

Le panneau montre le chat d'un salon, parce qu'on ne modère pas ce qu'on ne peut pas lire, et chaque ouverture est notée au journal. L'image, elle, ne passe jamais par le serveur. La fiche d'un compte garde ses dernières adresses IP : c'est ce qui permet de voir qu'un banni revient sous un autre compte.

Le journal (`journal.jsonl`) et les retours (`reports.json`) sont écrits sur le disque : c'est après un incident qu'on veut les relire. Les sessions du panneau et les blocages de connexion restent en mémoire : un redémarrage les efface.

Sur un téléphone, le panneau s'installe à part du site (`/admin/manifest.webmanifest`, portée `/admin`) : le service worker ne met rien en cache, parce qu'un panneau qui afficherait des chiffres anciens serait pire qu'un panneau vide. Sa mise en page se vérifie page par page sur quatre tailles d'écran avec `npm run test:admin-phone`. Le cookie de session reste à 12 h : une application installée redemande donc le mot de passe aussi souvent qu'un navigateur.

### Mesures

`server/metrics.ts` lit `/proc` et les cgroups toutes les 10 secondes : aucun agent à installer, et rien ne change côté coturn ni nginx, qui appartiennent aussi à PinoyBot. Les cgroups donnent le processeur et la mémoire de chaque service, conteneurs compris, ainsi que les limites posées par systemd et le temps passé bridé. Hors de Linux, une mesure absente reste `null` : le panneau dit « pas de mesure » plutôt que zéro. Les points sont gardés 1 h à 10 s, 24 h à la minute et 30 jours au quart d'heure ; en résumant une tranche, une moyenne ferait disparaître les pics de connexions, donc ces mesures gardent le maximum.

Le serveur ne voit passer aucune vidéo. Pour savoir comment va un direct, les appareils envoient `telemetry` toutes les 10 secondes : c'est **déclaré**, pas mesuré par le serveur. Le débit affiché sur le relais vient de là : coturn n'expose rien sans toucher à sa configuration. Une sonde HTTPS passe par l'adresse publique, comme un visiteur, et une requête STUN prouve que le relais répond, pas seulement que son service tourne.

Les alertes (`server/alerts.ts`) ne se déclenchent qu'après avoir tenu le temps prévu. `server/usage.ts` garde 90 jours d'usage et le résumé des 300 dernières diffusions.

### Bande passante par compte

`server/bandwidth.ts` garde un point toutes les 5 minutes pendant 48 h et un total par jour pendant 90 jours, en mémoire puis dans `bandwidth.json`. Ces durées sont dans la politique de confidentialité : `prune` les fait tenir pour tous les comptes, et un compte supprimé part avec son historique. Le fichier n'est pas sauvegardé : perdre ces chiffres ne coûte rien.

Tout vient des relevés `telemetry`, déclarés par les applications. On multiplie par le temps écoulé depuis le relevé précédent, borné à 30 s : répéter ses relevés ne gonfle rien, et aucune nouvelle version d'application n'est nécessaire. Un flux relayé est vu par ses deux bouts. Sur un compte il compte pour les deux, parce que l'un ou l'autre peut en être la cause. Dans les totaux, seul le côté du diffuseur compte.

La page Bande passante met le relais déclaré à côté de `netTx`, la sortie mesurée par `metrics.ts`, qui comprend aussi PinoyBot : un écart durable dit que les chiffres déclarés ne suffisent plus. Les règles `relay` et `relayAccount` s'appuient sur le déclaré, `network` sur la mesure. Les seuils de départ (100, 50 et 300 Mb/s pendant 5 minutes) sont une estimation : le VPS n'expose pas la vitesse de sa ligne. Ils se changent dans la page Alertes.

### Limites de compte

La vidéo va de PC à PC : le serveur ne peut pas brider un flux qu'il ne voit pas. `AccountLimits` se tient donc à trois endroits. La fiche d'un compte ou les réglages du serveur (`defaultLimits`) les fixent, celles du compte passent devant, et un administrateur n'en a aucune.

- **Le serveur refuse** : lancer un direct, créer un salon, lancer une Watch Party, dépasser le nombre de spectateurs. Sans le relais, il ne donne plus d'identifiants TURN. Ces refus valent contre n'importe quel client.
- **L'application applique** : `account.limits` arrive en direct, `limited()` borne définition et cadence, et le débit total se partage entre les spectateurs dans `effectiveKbps`. Ce que la personne a demandé reste dans `wantedTarget` : quand une limite se lève, le stream y revient.
- **Le serveur surveille** : si le total déclaré dans `telemetry` dépasse la limite de 25 % sur 3 relevés de suite, soit 30 s, il coupe le stream. Il rattrape ainsi les anciennes versions, qui ignorent `account.limits`. Une limite expirée se lève au relevé suivant.

Ce que ça ne couvre pas : un client modifié peut sous-déclarer son débit, un identifiant TURN déjà donné reste valable jusqu'à 12 h, une connexion déjà relayée continue, et une nouvelle limite de spectateurs ne renvoie pas ceux déjà là. Rien n'empêche non plus de recréer un compte : c'est le rôle du blocage d'adresse.

**L'arrêt d'un stream par le serveur arrive au diffuseur par `stream.remove`.** Il doit l'y arrêter lui aussi (`stopLive`), sinon il garde sa capture et le relance en se reconnectant.

### Sauvegardes

`server/backups.ts` copie les fichiers de données dans `data/backups/`. Restaurer ne touche à rien pendant que le serveur tourne : un repère est posé, le serveur s'arrête, et le démarrage suivant remet les fichiers avant que quoi que ce soit ne les lise. Sinon, l'écriture finale de l'arrêt écraserait ce qu'on vient de restaurer. `admin-auth.json` n'en fait pas partie : restaurer une ancienne version ne doit pas ramener un ancien mot de passe. Ces copies sont sur le même disque que l'original : elles protègent d'une erreur, pas de la perte du serveur.

## SpokaSoundBoard

Il joue sur plusieurs sorties en même temps, câble du jeu, câble de Discord et casque. Une capture par application les additionne toutes, d'où un son doublé. Son vrai point de sortie est l'entrée `CABLE Output`, qui passe par `addDevice` sans aucun traitement. Sur le vocal, `isVirtualInput` coupe la réduction du bruit, l'annulation d'écho et le réglage automatique, comme le README de SpokaSoundBoard le demande pour Discord.

## Réseau

**Maillage plutôt que serveur vidéo.** Le stream va directement de PC à PC : latence minimale (1 ms en local), aucun coût serveur, aucune limite imposée par le VPS. La contrepartie est un encodage par spectateur, donc un envoi multiplié par leur nombre. C'est le bon choix pour des groupes d'amis, avec des connexions fibre. Au-delà de 6 à 8 spectateurs, il faudrait un SFU : `Publisher` et `Subscription` sont les seuls endroits à changer.

Ce qui limite le coût du maillage :

- **Une connexion n'existe que pendant qu'on regarde.** Les autres voient une vignette, envoyée par le serveur toutes les 6 s.
- **Son seul** : `replaceTrack(null)`, le diffuseur cesse d'encoder pour cette personne.
- **Qualité par spectateur** : c'est le côté positif du maillage. Chacun reçoit ce que sa connexion supporte, sans dégrader les autres.

Chaque spectateur a sa propre connexion, et le vocal a les siennes : un spectateur qui arrive ne perturbe ni les autres ni la voix.

### Coupures

Le serveur n'est pas sur le chemin de la vidéo. S'il tombe, les streams continuent : le test d'intégration l'arrête en plein direct et compte les images reçues pendant la coupure. Au retour :

- le diffuseur se présente de nouveau avec le même identifiant de stream ;
- le spectateur se présente avec `resume`, et le diffuseur ne recrée pas une connexion qui marche ;
- un membre déconnecté garde sa place 20 s.

Si une connexion vidéo tombe vraiment, le spectateur en redemande une après 6 s d'instabilité. En relais TCP, le débit est limité à 4 Mb/s : au-delà, les retransmissions font saccader.

## Sécurité

- **Pas de compte** : un jeton aléatoire de 256 bits, créé sur le PC, est l'identité. Le serveur n'en garde que l'empreinte.
- **Electron verrouillé** : `contextIsolation`, `sandbox`, CSP, navigation bloquée, liens externes en `http(s)` seulement.
- **Serveur méfiant** : tout est revalidé, images comprises (`data:image/...` strict), débits limités par connexion, tailles bornées, tentatives de code freinées par adresse.
- **Plafonds par adresse** (`server/guard.ts`) : le Store ouvre le serveur à des inconnus. 32 connexions par adresse, parce qu'une adresse peut cacher un foyer ou un réseau mobile entier, 1000 pour le serveur, moins d'un compte toutes les 3 minutes et un salon par minute en régime établi, 3000 salons au total, et 2 Mo/s par connexion. Une connexion muette tombe après 20 s. Mesuré : 1000 connexions présentées pèsent 73 Mo, pour un service bridé à 256 Mo. Au-delà de la limite, un nouveau venu reste invité : aucun compte écrit, pas de salon, et pas de relais. Tout se réinitialise au redémarrage. La boucle locale passe, ce qui suppose `TRUST_PROXY=1` derrière nginx : sans lui, tout le monde aurait l'adresse de nginx et plus rien ne serait limité.
- **Le relais reste la vraie exposition** : coturn est partagé avec PinoyBot et n'a aucune limite (`max-bps=0`, `total-quota=0`). Un compte reçoit des identifiants valables 12 h, qu'on ne peut pas raccourcir sans couper les longs directs, et rien côté SpokaStream ne peut brider un flux qui passe par coturn. Seule sa configuration le peut.
- **Suppression de compte** : `account.delete` efface le compte, ses appareils, ses salons et ses messages dans les autres salons. L'appli change alors de jeton : avec l'ancien, elle recréerait le même compte. Un autre appareil de la personne repart sur un compte vierge. Un compte administrateur est refusé. Les sauvegardes s'en vident sous 7 jours.
- **Overlay** : `setContentProtection` l'exclut de la capture, `setIgnoreMouseEvents` et `focusable: false` le rendent incapable de voler un clic.
- **Touches** : la lecture par `GetAsyncKeyState` ne voit que les touches demandées. Un hook clavier les verrait toutes.

## Qualité

| Commande | Ce qu'elle prouve |
| --- | --- |
| `npm test` | 54 tests : serveur, SDP, choix du codec, tampon audio, découpe MP4 |
| `npm run test:remote` | Liaison du téléphone, régie à distance, panneau admin de bout en bout |
| `npm run test:party` | Deux diffuseurs, dispositions, Watch Party d'une URL, page web diffusée, film du PC, paramètres, gestes du téléphone |
| `CHROMIUM_CAPTURE=1 npm run test:e2e` | Le même parcours sans capture native. À préférer sur un PC chargé : chaque trame native passe par DevTools, et ce canal sature même sur la 1.3.0, alors que la page reste à 144 i/s. Une étape s'arrête seule au bout de 4 minutes |
| `npm run test:e2e` | 42 étapes avec deux instances et un téléphone émulé : WebRTC, son, YouTube, gestes reçus par une vraie fenêtre, sortie WHIP de ffmpeg, formats de 320 à 1280 px, fenêtre de régie détachée |
| `npm run test:obs` | Le vrai OBS, dans une copie isolée, jusqu'à l'image reçue par un spectateur |
| `npm run test:capture-game` | La DLL dans une vraie fenêtre OpenGL : images à l'endroit, 60 i/s, arrêt et reprise sans redémarrer le jeu, et aucune DLL dans un jeu avec un anti-triche à côté de lui |
| `node --experimental-strip-types tests/e2e/run.ts --packaged` | La même chose sur l'application empaquetée |
| `npm run test:production` | Le vrai serveur, avec la vidéo forcée par le relais TURN : PC → VPS → PC |

Mesuré par le relais sur le vrai serveur : 58 i/s, aller-retour 50 ms, aucune perte, aucun gel.

Une erreur de rendu React vide toute la page et ne laisse que le fond de l'application. `CrashGuard` entoure donc l'interface : il remonte le rendu jusqu'à trois fois, sans toucher au moteur, donc le direct continue, puis propose un bouton. Chaque erreur part dans les rapports du panneau admin. Si le processus de rendu meurt, `render-process-gone` recharge la page.

## Déploiement

Sur une machine avec Node.js 22 :

```bash
npm run server:build                        # sur le poste de développement
scp server/dist/spokastream-server.mjs vps:spokastream/
scp -r deploy vps:spokastream/
sudo bash spokastream/deploy/install.sh     # sur le VPS
```

Le service écoute sur `127.0.0.1:8787`, derrière `deploy/nginx-stream.conf` et son certificat. En production : `https://stream.chretieno.fr`, sur le VPS de PinoyBot.

Le relais est le coturn de PinoyBot : `TURN_HOST` et `TURN_SECRET` dans `/opt/spokastream/.env`, le format d'identifiants est le même.

Santé : `GET /health`. Invitation : `/j/CODE` ouvre l'application, parce que Discord ne rend pas `spokastream://` cliquable.

## Pour la suite

- **Relais vidéo (SFU)** optionnel pour les grands groupes.
- **Manette** dans la prise en main : il faudrait un pilote de manette virtuelle.
- **Signature du code**, pour retirer l'avertissement de Windows.
