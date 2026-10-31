# Journal des versions

## 1.3.0

La régie

- **Barre de direct** : l'état, le temps, les spectateurs, la santé, la scène en cours et les gestes essentiels restent visibles, quel que soit l'onglet ouvert.
- **Vue Régie** (G) : l'image au centre, le chat et tous les contrôles autour, en même temps. Les panneaux se déplacent, se replient et se masquent, et la disposition est gardée.
- **Fenêtre détachée** pour un second écran, invisible dans les captures, avec l'option de rester au-dessus du jeu.
- **Actions rapides** au choix : pause, enregistrer, clip, revoir, marqueur, caméra, micro, sondage, inviter…
- **Santé du stream** : la cause, le conseil et la correction en un clic, avec deux minutes de cadence et de débit en graphique.
- **Écrans d'attente** personnalisables avec compte à rebours, en gardant le son si tu veux.
- **Table de mixage** : micro dans le stream en un clic, décalage du son par source, baisse automatique du son quand tu parles, niveau total.
- **Raccourci par scène**, même en plein jeu, et mise à jour d'une scène depuis l'état du direct.
- **Fil d'activité** et **marqueurs** horodatés, à copier après le direct.
- **Profils de qualité** applicables en direct, enregistrement automatique au lancement, bloc-notes.

Le site, sur téléphone et partout

- **Entièrement refait** pour s'adapter à tous les écrans : petit téléphone, grand téléphone, paysage, tablette, ordinateur.
- **S'installe sur l'écran d'accueil** et s'ouvre alors comme une application.
- **Mes salons** : l'accueil retient tes salons et montre qui est en direct.
- **Plein écran** de toute la page : le chat vient en volet par-dessus l'image, et la lecture ne s'interrompt plus.
- **Gestes** : pincer pour zoomer, double tap, pointeur laser au doigt.
- **Qualité automatique** selon le réseau, data consommée, son seul, petite fenêtre.
- **Chat complet** : réponses, réactions sur les messages, mentions, images, capture du stream, sondages à créer.
- **Vocal** : qui parle, sourdine, mode talkie.
- **YouTube ensemble** pilotable depuis le téléphone, et l'écran reste allumé pendant qu'on regarde.
- **Profil** : nom, couleur et photo.

Corrections

- Reprise du lecteur web quand le serveur redémarre.

## 1.2.0

Regarder et jouer ensemble

- **Lecteur web** : le lien d'invitation s'ouvre dans un navigateur, téléphone compris, sans rien installer. Image, son, chat, réactions, sondages, clips, YouTube ensemble et vocal. Diffuser reste réservé à l'application.
- **Prendre la main** : un ami demande, tu acceptes, et il joue à ta place avec son clavier et sa souris, directement dans ta fenêtre. Mode souris de jeu pour les jeux à la première personne.
- **Revoir** (R) : les dernières secondes rejouées tout de suite, coupées à la seconde près, sans réencoder.
- **Clips dans le chat** : envoyés au salon de PC à PC, ils s'ouvrent d'un clic chez les autres et se gardent en fichier.

Gérer son stream

- **Diffuser depuis OBS** : choisis le service WHIP dans OBS, colle l'adresse et la clé. Tes scènes, filtres et ton mix arrivent tels quels, et le stream reprend tout seul si OBS redémarre.
- **Caméra libre** : glisse-la sur l'aperçu, redimensionne-la, choisis sa forme et l'effet miroir. Elle apparaît au même endroit chez tout le monde.
- **Scènes** : une scène retient la source, la caméra et le bandeau, et un clic passe de l'une à l'autre sans couper.
- **Bandeau** : un texte posé sur l'image.

Corrections

- Les boutons de l'écran vide d'un salon sont alignés.
- Positions justes sur un écran mis à l'échelle : le moteur natif tient compte de l'échelle de Windows.

Le protocole ne change pas : une application 1.1 continue de fonctionner dans un salon 1.2.

## 1.1.0

Les menus ne sont plus coupés : celui des sons, dans la fenêtre de lancement, était illisible.

Regarder

- **Regarder YouTube ensemble** : colle un lien, chacun lit la vidéo chez lui en pleine qualité, et tout le salon reste au même endroit. Pause, position et file d'attente sont partagées.
- **Mode cinéma** (T) : l'image prend toute la fenêtre. Le chat passe sur l'image, en mode cinéma comme en plein écran, et Entrée permet d'y répondre.
- **Zoom** dans l'image, à la molette avec Ctrl : pratique pour lire du code ou un petit texte.
- **Ambiance** : les bandes autour de l'image prennent ses couleurs.
- **Raccourcis du lecteur** : M, F, T, C, I, flèches. Appuie sur ? pour tous les voir.

Interagir

- **Sondages** en direct, visibles au-dessus du chat et sur l'écran du diffuseur.
- **Chat enrichi** : réactions sur les messages, mentions avec suggestions et @tous, « écrit… », message épinglé.
- **Images dans le chat** : coller, glisser ou choisir un fichier. Une capture du stream s'envoie au chat d'un clic.

Diffuser

- **Clips** : une touche garde les dernières secondes dans un MP4 prêt à partager, chez le diffuseur comme chez le spectateur.
- **Bulle caméra** : ta caméra par-dessus le stream, que chaque spectateur peut masquer.
- **Titre modifiable en direct**, durée du direct et état de santé du stream dans le Studio.

Partout

- **Recherche Ctrl+K** : salons, streams, actions et réglages au clavier.
- **Accueil en direct** : vignettes de ce qui se passe et qui est là, salon par salon.
- **Apparence** : couleur d'accent et taille de l'interface.

Le serveur passe au protocole 2 : les applications 1.0 doivent se mettre à jour pour rejoindre un salon.

## 1.0.1

- Correction : un minuteur de vignette restait actif après chaque fin de stream.

## 1.0.0

Première version.

- Salons avec code et lien d'invitation, chat, réactions, pointeur laser et dessin sur le stream.
- Stream d'écran, de fenêtre, de caméra ou de fichier vidéo, plusieurs diffuseurs à la fois.
- Capture native à 60 i/s et plus, avec retour automatique à la capture de Chromium si elle convient mieux.
- Son d'une application précise, de plusieurs, ou de tout le PC sauf SpokaStream, avec table de mixage.
- Choix automatique du meilleur encodeur par mesure réelle : AV1, H265, H264.
- Qualité, son seul et latence réglables par chaque spectateur.
- Vocal intégré, appuyer pour parler compris.
- Overlay en jeu, fenêtre flottante, enregistrement, capture d'écran.
- Zone de notification, lancement avec Windows, raccourcis globaux, notifications, mises à jour automatiques.
- Hébergement sur le PC pour un réseau local.
