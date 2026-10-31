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

### Choix du codec

Mesure réelle à la première diffusion, 2 s par codec :

| Codec | Encodeur | 1080p60 |
| --- | --- | --- |
| AV1 | NVIDIA AV1 (matériel) | ~6 ms par image |
| H265 | NVIDIA HEVC (matériel) | ~5 ms |
| H264 | NVIDIA H.264 (matériel) | ~5 ms |
| VP9 | libvpx (processeur) | ~11 ms |

Sans le drapeau `WebRtcAV1HWEncode`, AV1 tourne sur le processeur (`libaom`), pendant le jeu de la personne. Les noms de drapeaux viennent d'une recherche dans le binaire d'Electron : plusieurs noms connus sur internet n'existent plus.

Le classement met d'abord ce qui tient la cadence, puis le matériel, puis l'efficacité. **On juge le coût par image, pas la cadence atteinte** : les encodeurs NVIDIA avaient été recalés à 50 i/s alors que c'était la scène de test qui plafonnait. Pour la même raison, le choix n'est plus « le plus rapide » comme dans la party : à débit égal, AV1 et H265 donnent une bien meilleure image que H264.

Un spectateur qui ne décode pas le codec préféré n'est pas bloqué : le SDP retombe sur le suivant.

### Débit

Chrome plafonne l'encodeur d'après le SDP distant. On négocie donc 300 Mb/s une fois pour toutes dans la réponse du spectateur, puis `setParameters` pilote le débit réel : il change à chaud, sans renégocier ni couper, contrairement à la party.

### Overlay

**Ne jamais redimensionner la fenêtre de l'overlay.** Elle couvre un écran entier et c'est son contenu qui se place sur la fenêtre capturée. La version qui suivait la fenêtre par `setBounds` figeait la page principale du diffuseur, avec le fil bloqué hors de JavaScript. Le mécanisme exact dans Chromium n'est pas élucidé, mais la bissection est nette : overlay coupé, plus de gel. Le parcours de bout en bout garde ce cas.

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
- **Overlay** : `setContentProtection` l'exclut de la capture, `setIgnoreMouseEvents` et `focusable: false` le rendent incapable de voler un clic.
- **Touches** : la lecture par `GetAsyncKeyState` ne voit que les touches demandées. Un hook clavier les verrait toutes.

## Qualité

| Commande | Ce qu'elle prouve |
| --- | --- |
| `npm test` | 33 tests : serveur, SDP, choix du codec, tampon audio |
| `npm run test:e2e` | 26 étapes avec deux instances, WebRTC réel, son réel |
| `node --experimental-strip-types tests/e2e/run.ts --packaged` | La même chose sur l'application empaquetée |
| `npm run test:production` | Le vrai serveur, avec la vidéo forcée par le relais TURN : PC → VPS → PC |

Mesuré par le relais sur le vrai serveur : 58 i/s, aller-retour 50 ms, aucune perte, aucun gel.

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
- **Vidéo synchronisée** YouTube, déjà écrite dans la party.
- **Contrôle à distance** avec accord du diffuseur : `SendInput` dans SpokaAudio.
- **Clips** des 30 dernières secondes.
- **Signature du code**, pour retirer l'avertissement de Windows.
