/**
 * La politique de confidentialité, servie sur /confidentialite. Le Microsoft Store en exige une (règle 10.5.1).
 * Chaque chiffre vient du code : si IPS_KEPT, LIMITS.history, ROOM_MAX_IDLE_MS, KEPT ou AUTO_KEPT change, cette page change aussi.
 */
export const PRIVACY_UPDATED = "2 novembre 2026";

const SECTIONS: [string, string][] = [
  [
    "En bref",
    `<p>SpokaStream sert à streamer entre amis. Il n'y a ni publicité, ni pistage, ni revente de données. Tu n'as besoin ni d'adresse e-mail ni de mot de passe : ton identité est un jeton gardé sur ton appareil. Ce texte dit ce que le serveur conserve, ce qui passe directement entre vous, et ce qui ne quitte jamais ton PC.</p>`,
  ],
  [
    "Ce que garde le serveur",
    `<ul>
<li><b>Ton profil</b> : ton pseudo, ta couleur et ton avatar si tu en choisis un.</li>
<li><b>Ton compte et tes appareils</b> : un identifiant, le type d'appareil, la version de l'application, les dates de première et de dernière connexion, et les salons où tu es allé.</li>
<li><b>Tes dernières adresses IP</b> : les 8 dernières de ton compte. Elles servent à faire respecter les sanctions et à repérer les abus.</li>
<li><b>Les salons</b> : leur nom, leur code, leurs membres et les 200 derniers messages du chat, avec les dernières images collées.</li>
<li><b>Des totaux d'utilisation</b> : nombre de streams, minutes diffusées et regardées, nombre de messages.</li>
<li><b>Des mesures techniques pendant un stream</b> : débit, images par seconde, définition, codec, encodeur, délai réseau. Elles servent à repérer les pannes.</li>
<li><b>Les rapports d'erreur</b> : le message d'erreur et la version de l'application. Tu peux les couper dans Paramètres, À propos.</li>
<li><b>Ce que tu nous envoies</b> : si tu utilises « Signaler un problème », ton message part avec un diagnostic de l'appareil (système, processeur, mémoire, carte graphique, état de la connexion).</li>
<li><b>La modération</b> : les sanctions et les notes éventuelles sur un compte.</li>
<li><b>Les notifications</b> : si tu les actives sur le site, l'adresse d'envoi fournie par ton navigateur.</li>
</ul>`,
  ],
  [
    "Ce qui passe directement entre vous",
    `<p>L'image et le son d'un stream vont d'un appareil à l'autre sans être enregistrés par le serveur. Pour cela, <b>les personnes de ton salon peuvent voir ton adresse IP</b>, comme dans la plupart des appels vidéo. Quand une connexion directe est impossible, le flux passe par notre relais, qui le transmet sans le conserver. Les clips que tu partages vont aussi de PC à PC.</p>`,
  ],
  [
    "Ce qui reste sur ton PC",
    `<p>Tes réglages, ton jeton d'identité, tes clips et tes enregistrements restent sur ton appareil. Le micro et la caméra ne servent que lorsque tu les actives, et la capture ne porte que sur ce que tu choisis de diffuser.</p>
<p>L'option « Capture de jeu », désactivée par défaut, charge un petit module dans le jeu que tu choisis pour en lire l'image. Rien d'autre n'en sort, et elle ne s'active pas sur un jeu où un anti-triche est détecté.</p>`,
  ],
  [
    "Qui peut voir quoi",
    `<p>Les membres d'un salon voient ton profil, tes messages et tes streams. Ceux à qui tu donnes accès à un stream le reçoivent en direct et peuvent l'enregistrer de leur côté : ne partage que ce que tu acceptes de montrer. Les administrateurs du service peuvent consulter les données ci-dessus pour assurer le fonctionnement et la modération, et chaque lecture d'un chat est tracée. Rien n'est vendu ni transmis à d'autres, sauf obligation légale.</p>`,
  ],
  [
    "Services tiers",
    `<ul>
<li><b>YouTube</b>, si tu lances une vidéo YouTube dans une Watch Party : c'est le lecteur de YouTube qui la diffuse, selon les règles de Google.</li>
<li><b>Les sites que tu diffuses ou regardes</b> dans une page web ou une Watch Party.</li>
<li><b>Le service de notifications de ton navigateur</b>, si tu actives les notifications.</li>
<li><b>GitHub</b>, qui héberge les mises à jour de la version téléchargée, ou le <b>Microsoft Store</b> si tu l'as installée depuis le Store.</li>
</ul>`,
  ],
  [
    "Combien de temps",
    `<ul>
<li>Un salon sans activité est supprimé après 90 jours, avec son chat.</li>
<li>Seules les 8 dernières adresses IP d'un compte sont gardées.</li>
<li>Le journal du service garde ses 2 000 dernières lignes.</li>
<li>Les sauvegardes automatiques sont quotidiennes et les 7 dernières sont gardées.</li>
<li>Un compte est gardé jusqu'à ce que tu le supprimes.</li>
</ul>`,
  ],
  [
    "Tes droits",
    `<p><b>Tu peux supprimer ton compte toi-même</b> : dans l'application, Paramètres, Compte, ou sur le site, dans ton profil. Ton profil, tes appareils, tes messages et les salons que tu as créés sont effacés tout de suite, et disparaissent des sauvegardes sous 7 jours.</p>
<p>Tu peux aussi demander à consulter ou corriger tes données, ou t'opposer à leur traitement. Écris-nous depuis l'application, dans Paramètres, À propos, « Signaler un problème », ou sur <a href="https://github.com/Spokator/SpokaStream/issues">la page du projet</a>, sans y mettre d'information personnelle. Si tu estimes que tes droits ne sont pas respectés, tu peux saisir la <a href="https://www.cnil.fr">CNIL</a>.</p>
<p>Si tu as moins de 15 ans, demande l'accord d'un parent avant d'utiliser SpokaStream.</p>`,
  ],
  [
    "Qui s'en occupe",
    `<p>SpokaStream est un logiciel libre publié par Spokator, dont le code est <a href="https://github.com/Spokator/SpokaStream">consultable sur GitHub</a>. Cette page peut évoluer avec l'application, et sa date ci-dessus changera alors.</p>`,
  ],
];

const STYLE = `main{max-width:720px;text-align:left}h2{font-size:18px;margin:28px 0 8px}p,li{line-height:1.6;color:inherit}ul{padding-left:20px}a{color:#22d3ee}small{opacity:.7}`;

export function privacyPage(baseStyle: string) {
  const body = SECTIONS.map(([title, html]) => `<h2>${title}</h2>${html}`).join("");
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Confidentialité · SpokaStream</title><style>${baseStyle}${STYLE}</style></head><body><main><h1>Politique de confidentialité</h1><small>Mise à jour le ${PRIVACY_UPDATED}</small>${body}</main></body></html>`;
}
