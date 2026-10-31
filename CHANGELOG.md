# Journal des versions

## 1.6.3

- **Un clip n'annonce plus une durée fausse.** Quand le PC était chargé, un clip de 30 secondes pouvait afficher 50 secondes, avec l'image ou le son décalés d'autant. Un fragment sans son portait un temps de zéro, pris à tort pour le début du clip.

## 1.6.2

- **Avertissement sur la capture compatible** : chez un utilisateur, elle ramène bien la souris dans Project Zomboid, mais l'image clignote fortement, dans le jeu comme dans le stream. Le réglage le dit maintenant clairement, et reste désactivé par défaut.

## 1.6.1

- **La souris ne disparaît plus dans certains jeux pendant un direct.** Nouveau réglage dans Paramètres, Diffusion : **Capture compatible avec les jeux**. La capture habituelle force Windows à dessiner le curseur en logiciel, et dans des jeux OpenGL ou Vulkan comme Project Zomboid, ce curseur ne s'affiche plus. Le mode compatible passe par la duplication du bureau, garde le vrai curseur et le pose lui-même sur l'image pour les spectateurs. Une fenêtre partagée montre alors aussi ce qui passe devant elle.

## 1.6.0

Ton téléphone, un vrai Stream Deck

- **Tourne ton téléphone** : 15 touches par page, en 5×3 à l'horizontale et 3×5 à la verticale. L'ordre ne change pas, seule la grille pivote.
- **Chaque touche montre l'état renvoyé par le PC** : elle s'allume quand c'est fait, tourne pendant qu'elle attend, et tremble si le PC ne répond pas. Le résultat arrive tout de suite, sans attendre la mise à jour suivante.
- **À ta façon** : déplace les touches, renomme-les, choisis leur couleur, ajoute des pages. Messages tout prêts, bandeaux, réactions, scènes, écrans d'attente, sons, Watch Party et mesures du direct.
- **Une table de mixage à curseurs verticaux**, qui agit pendant que le doigt glisse.
- **Arrêter le direct demande un appui long** : impossible de couper par accident.
- **L'écran reste allumé** tant que la régie est ouverte. Une bande affiche le dernier message du chat et qui arrive, et une demande de main fait vibrer le téléphone.
- **Lance le direct depuis le téléphone** sur la dernière source ou une scène. Désactivé par défaut : à autoriser dans Paramètres, Compte.

Lier son téléphone, sans se tromper

- **Tes salons arrivent sur le téléphone** dès la liaison, et te suivent ensuite sur tous tes appareils.
- **Un seul champ sur l'accueil** : il accepte le code d'un salon comme le code de liaison du PC. Le PC envoyait vers un menu qu'on ne trouvait que dans un salon.
- **Le PC confirme** que le téléphone est lié, et le QR code se ferme.
- **L'accueil d'un téléphone lié** montre ton nom, tes salons, et si ton PC est en ligne ou en direct.
- **Sur iPhone**, Safari et l'icône de l'écran d'accueil sont deux appareils séparés : le PC l'explique, et le code se saisit dans l'icône.

Panneau d'administration

- **Système** : processeur (occupé, attente du disque, repris par l'hébergeur), mémoire et échange, tâches en attente, réseau, disque (débit, temps de réponse), réactivité du serveur, messages, requêtes, sondes depuis l'extérieur, de 1 heure à 30 jours. Les courbes survivent aux redémarrages.
- **Ce qui consomme** : processeur et mémoire de chaque service de la machine, coturn, nginx, conteneurs et voisins compris, et les limites de SpokaStream avec le temps où il est bridé.
- **Diffusions** : pour chaque direct, ce qu'envoie le diffuseur et ce que reçoit chaque spectateur (route directe ou relais, pertes, aller-retour, gels), puis l'historique des diffusions. Il faut une application 1.6 pour avoir les chiffres du diffuseur.
- **Statistiques** : comptes actifs, temps de diffusion et regardé, pics, heures de pointe, part du relais, classements, jusqu'à 90 jours.
- **Alertes** : 14 règles réglables, déclenchées seulement si le problème dure, avec historique et envoi sur Discord.
- **Modération** : mots filtrés, délai entre les messages, adresses bloquées, sanctions en cours, connexions en direct avec leur adresse.
- **Comptes** : fiche complète avec statistiques, adresses vues, autres comptes sur la même adresse, avertissements, silence ou bannissement à durée limitée, historique des sanctions, notes privées.
- **Salons** : recherche, lecture du chat, suppression d'un message, message au salon, débit maximum, qui peut diffuser, arrêt de la Watch Party ou d'un sondage. Le chat étant maintenant lisible, chaque ouverture est notée au journal.
- **Réglages** : serveur fermé aux inconnus, création de salons réservée, Watch Party, limites, message d'accueil, version minimale de l'application, maintenance prévue avec préavis, redémarrage dès que plus personne ne diffuse.
- **Sauvegardes** : une par jour toute seule, à la demande, téléchargement et restauration en un clic. Les accès au panneau n'en font pas partie.
- **Sécurité** : toutes les sessions ouvertes, fermer l'une d'elles, voir et lever un blocage de connexion.
- **Journal et retours gardés** après un redémarrage, avec recherche et export pour Excel.
- **Une vraie application sur téléphone** : il s'installe à part du site, avec son icône, et n'affiche plus de barre de navigateur. Barre du bas pour l'essentiel, tout le reste derrière « Plus », tableaux transformés en fiches, zones tactiles de 44 px, bouton retour qui revient à la page d'avant, et le téléphone couché est pris en charge. Le panneau ne garde rien sur l'appareil et dit quand il n'a plus de réseau.

## 1.5.0

Ton compte sur tous tes appareils

- **Lie ton téléphone à ton PC** avec un QR code, dans Paramètres, Compte : même profil, mêmes salons, mêmes droits. Pas de mot de passe : le code ne sert qu'une fois et vit 5 minutes.
- **Plusieurs appareils en même temps** : ton téléphone n'éjecte plus ton PC d'un salon.
- **Mes appareils** : qui est lié, qui est en ligne, et détacher un appareil en un geste.

Le téléphone, ta régie

- **Pendant que ton PC diffuse**, ton téléphone le pilote : pause, écrans d'attente, scènes, table de mixage, micro, caméra, enregistrement, clip, marqueur, titre, bandeau, spectateurs, film du PC, demandes de main, arrêt.
- **Dès l'accueil**, une carte te dit que ton PC est en direct.
- **Ton propre stream ne s'ouvre pas tout seul** sur le téléphone, pour éviter l'écho. Il reste disponible dans En direct.

Panneau d'administration

- **Une adresse, /admin**, depuis n'importe quel navigateur, avec un identifiant et un mot de passe. L'application n'est pas nécessaire : elle ajoute seulement un raccourci.
- **Code à 6 chiffres** en option, avec une application d'authentification, et 8 codes de secours.
- **Après 5 échecs**, une adresse est bloquée 15 minutes. Mot de passe perdu : un lien à usage unique se crée depuis le serveur.
- **Vue d'ensemble** : qui est en ligne, streams, spectateurs, courbes sur 24 heures, services, processeur, mémoire, disque, certificat HTTPS, dernière version et téléchargements, versions connectées, alertes.
- **Salons** : voir qui est où, arrêter un stream, retirer quelqu'un, verrouiller, renommer, donner le salon à quelqu'un, lever les bannissements, supprimer.
- **Comptes** : tous les comptes et leurs appareils, recherche et filtres. Renommer, retirer une photo, écrire à quelqu'un, le déconnecter, détacher un appareil, bannir avec un motif, supprimer le compte et ses salons.
- **Administrateurs** : plusieurs accès, avec trois rôles (propriétaire, administrateur, modérateur), des invitations par lien, un nouveau mot de passe en un clic, désactiver ou supprimer. Un droit retiré agit à la seconde.
- **Journal** et **Retours** : les erreurs des applications remontent toutes seules, et chacun peut signaler un problème depuis À propos, diagnostic joint.
- **Serveur** : annonce à tout le monde, mode maintenance, sauvegarde, redémarrage.
- Le contenu du chat et des streams ne s'affiche pas dans le panneau.

SpokaSoundBoard

- **Son micro virtuel est reconnu** : la réduction du bruit, l'écho et le niveau automatique se coupent dessus. Ils prenaient la musique pour du bruit.
- **Un bouton Utiliser** dans Son et voix règle le vocal d'un coup.
- **Dans le son du stream**, SpokaSoundBoard apparaît en tête : sa musique, ses sons et ta voix transformée, déjà mixés. Le capter comme application l'aurait doublé, parce qu'il joue sur plusieurs sorties à la fois.

## 1.4.0

Plusieurs streams à la fois

- **Cinq dispositions**, pour les spectateurs comme pour les diffuseurs : un grand avec un bandeau, un grand avec une colonne, grille, incrustation, et **libre**, où chaque image se glisse et se redimensionne, aimantée aux bords. Passer de l'une à l'autre ne coupe aucun lecteur.
- **Glisser une image sur une autre** échange leurs places. Chacun garde son arrangement, sans rien changer chez les autres.
- **Regarder les autres en diffusant** : quand un ami se lance aussi, une notification propose de l'ouvrir, et « Tout regarder » ouvre tout d'un coup.
- **N'écouter qu'un stream**, ou faire suivre le son à l'image en grand.
- **Qualité adaptée à la taille** : une petite image reçoit une petite définition. Le diffuseur et ta connexion respirent.
- **Ton propre retour** peut se masquer, se mettre en grand et passer en plein écran.
- **Plusieurs fenêtres flottantes** à la fois.

Watch Party

- **Regarder YouTube ensemble devient la Watch Party** : YouTube, ou l'adresse de n'importe quelle vidéo (.mp4, .webm, flux .m3u8). Chacun la lit chez lui, en pleine qualité.
- **Une page qui contient une vidéo** : SpokaStream la trouve et récupère son titre.
- **Un site qui garde sa vidéo pour lui** : ouvre la page dans SpokaStream et diffuse-la, image et son.
- **Sous-titres** : un lien pour tout le salon, ou ton fichier .srt ou .vtt pour toi seul.
- **File d'attente modifiable**, boutons et touches pour reculer ou avancer de 10 secondes, réactions sur la vidéo.
- **Un film du PC** se pilote enfin : pause, position, répétition. Il ne repart plus en boucle tout seul à la fin.

Nouvelle source

- **Page web** : SpokaStream ouvre une page et diffuse son image et son son, et rien d'autre du PC. Comme une source navigateur d'OBS. Les vidéos protégées (Netflix, Disney+…) restent noires.

Téléphone

- **Le mode dessin se quitte** : un bandeau reste affiché avec un bouton Terminer.
- **Glisser sur l'image** passe au stream voisin.
- **Mini-vue** : un second stream en petit par-dessus le premier, à échanger d'un toucher.
- **Double appui sur un bord** pour sauter de 10 secondes dans une Watch Party.
- **Notifications** quand un ami passe en direct ou lance une Watch Party. Sur iPhone, il faut d'abord ajouter le site à l'écran d'accueil.
- **Le volume** agit maintenant sur la Watch Party, ce qu'il ne faisait pas.
- **Réactions** pendant une Watch Party.

Paramètres

- **Apparence** : thèmes Bleu nuit et Noir pur, couleur d'accent libre, taille du texte du chat, chat compact, moins d'animations.
- **Son** : volume général des streams et des voix, test de la sortie.
- **Diffusion** : codec, priorité et qualité du son par défaut, enregistrement automatique, régie à l'ouverture.
- **Regarder** : qualité à l'ouverture et tous les réglages du multi-stream.
- **Overlay** : taille, opacité et bouton pour l'essayer sans diffuser.
- **Raccourcis** : un conflit est signalé, et on peut tout rétablir.
- **Notifications** : mentions à part, silence pendant qu'on diffuse, test, volume des petits sons.
- **Serveur** : l'adresse du site se colle telle quelle, retour au serveur SpokaStream en un clic.
- **À propos** : à quoi sert le moteur audio, dossier des données, rétablir les réglages sans perdre son profil.
- **Profil** : aperçu et couleur libre.

Le reste

- **SpokaAudio n'apparaît plus dans la liste des sons** : ce moteur interne s'y glissait pendant une capture, sans aucun son à offrir.
- **QR code d'invitation** à côté du code du salon : un téléphone scanne et il est dans le salon.
- **L'accueil** montre les Watch Party en cours.

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
