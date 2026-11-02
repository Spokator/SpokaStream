# Publier SpokaStream sur le Microsoft Store

SpokaStream est [en ligne sur le Store](https://apps.microsoft.com/detail/9PKH6GKMMQDN) depuis le 2 novembre 2026, avec la capture de jeu acceptée telle quelle. Pour publier une version, va directement à [Pour une nouvelle version](#pour-une-nouvelle-version). La suite garde les étapes de la première publication.

Le Store garde la version GitHub telle quelle : les deux peuvent exister côte à côte.

## Ce que tu dois faire

### 1. Créer le compte

Va sur <https://storedeveloper.microsoft.com> avec un compte Microsoft personnel, et choisis **Individual**. C'est gratuit, sans carte bancaire. Microsoft demande une pièce d'identité et un selfie.

Regarde bien le nom d'éditeur que tu choisis : c'est lui qui sera public sur la fiche. Vérifie à ce moment-là si ton vrai nom apparaît quelque part.

### 2. Réserver le nom

Dans [Partner Center](https://partner.microsoft.com/dashboard) : **Applications et jeux**, **Nouveau produit**, **Application MSIX ou PWA**, puis réserve **SpokaStream**.

### 3. M'envoyer trois valeurs

Dans **Gestion des produits**, **Identité du produit**, copie ces trois lignes et envoie-les-moi. Elles ne sont pas secrètes :

- `Package/Identity/Name`
- `Package/Identity/Publisher` (commence par `CN=`)
- `Package/Properties/PublisherDisplayName`

Je construis alors le vrai paquet `SpokaStream-x.y.z.appx`.

### 4. Remplir la soumission

| Section | Quoi mettre |
| --- | --- |
| Tarification et disponibilité | Gratuit |
| Propriétés | Catégorie **Photo et vidéo**. Politique de confidentialité : `https://stream.chretieno.fr/confidentialite` |
| Classifications par âge | Réponds au questionnaire : l'application permet le chat, la voix et la vidéo entre personnes, et le partage de contenu créé par les gens |
| Packages | Dépose le fichier `.appx` |
| Listes du Store | Copie la fiche ci-dessous, et ajoute les images de `docs/store` |
| Options de soumission | Copie les notes de certification ci-dessous |

Une vraie capture d'un de tes jeux vaudrait mieux que ma mire. Prends-la sans pseudo ni salon privé visible.

### 5. Envoyer

Microsoft relit la soumission, en général en quelques jours. S'il y a un refus, envoie-moi le message.

## Fiche du Store

**Description courte**

> Stream en haute qualité entre amis : un vrai logiciel, avec le son de l'application de ton choix.

**Description**

> SpokaStream, c'est un salon privé pour streamer entre amis, sans passer par une plateforme publique.
>
> Partage ton jeu, une fenêtre ou ton écran avec le son de la seule application que tu choisis : tes potes entendent le jeu, pas ta musique ni ton Discord. L'image reste nette, jusqu'à 60 images par seconde et au-delà.
>
> Tes amis peuvent regarder depuis l'application ou directement dans leur navigateur, sans rien installer, même sur téléphone. Plusieurs personnes peuvent streamer en même temps.
>
> Regarde des vidéos ensemble avec la Watch Party, réagis dans le chat, dessine sur l'image, enregistre un clip du meilleur moment. Ton téléphone devient une régie façon Stream Deck.

**Fonctionnalités**

- Le son d'une seule application, sans celui du reste du PC
- Capture native à 60 images par seconde
- Regarder dans un navigateur, sans installation
- Plusieurs streams en même temps
- Watch Party, chat, réactions et dessin sur l'image
- Clips, enregistrement et scènes
- Régie sur téléphone
- Capture de jeu pour les jeux OpenGL, en option

**Mots-clés** : stream, streaming, partage d'écran, watch party, entre amis, gaming, capture de jeu

**Site web** : `https://github.com/Spokator/SpokaStream`

**Contact d'assistance** : `https://github.com/Spokator/SpokaStream/issues`, ou une adresse à toi si tu préfères.

## Si Partner Center demande pourquoi `runFullTrust`

> SpokaStream needs full trust for its native engine: per-application audio capture with process loopback, window and screen capture with Windows.Graphics.Capture, and global hotkeys. These desktop features are not available to a sandboxed app.

## Notes de certification

> SpokaStream is a screen and audio sharing app for private groups of friends. No test account is needed: enter any display name on first launch. To test, create a room, press "Diffuser", choose a window and press "Lancer le stream". Open the room link in a browser to watch.
>
> runFullTrust is required by the native engine (resources/native/SpokaAudio.exe), which captures the audio of a single application with process loopback, captures windows through Windows.Graphics.Capture, and sends the frames to the app on localhost.
>
> Optional feature, off by default: "Capture de jeu" in Settings, Diffusion. When the user enables it and picks a 64-bit OpenGL game, the engine loads resources/native/SpokaHook.dll into that game to read rendered frames, the same technique as OBS and Discord. Windows capture hides the mouse pointer in these games, which is the reason this feature exists. It only runs after the user has opted in and chosen that window. It is refused for 32-bit processes, browsers and games where an anti-cheat is detected, and it reads the image only.
>
> The source code is public: https://github.com/Spokator/SpokaStream

## Si Microsoft refuse la capture de jeu

On retire `SpokaHook.dll` de la version Store et l'option disparaît. Tout le reste ne dépend pas d'elle, et la version GitHub la garde.

## Pour une nouvelle version

1. Publier la version GitHub, puis `npm run dist:store` sur son tag, avec `SPOKA_WINSDK` si le PC n'a pas de kit Windows.
2. Le fichier sort dans `dist-store/`, avec l'identité de `electron-builder.store.yml`. Il n'est pas signé : c'est le Store qui le signe. Pour un essai local, remettre un éditeur fictif et lancer l'application avec un profil vide.
3. Dans Partner Center : **Mettre à jour** la soumission, remplacer le paquet, envoyer.
