require('dotenv').config(); // Charge les variables depuis .env

const express = require('express');
const cors = require('cors');
const { Client, GatewayIntentBits } = require('discord.js');
const {
    initDatabase,
    getLeaderboardObject,
    ensurePlayer,
    addKill,
    addDeath,
    addTeamkill,
    addCapture,
    addVehicleDestroyed
} = require('./db');

// Lecture des variables d'environnement
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const COMPTEUR_CHANNEL_ID = process.env.DISCORD_COMPTEUR_CHANNEL_ID || "";
const DISCORD_CHAT_WEBHOOK_URL = process.env.DISCORD_CHAT_WEBHOOK_URL || "";

// Suivi d'état session & anti-griefing
let estPrecedemmentHorsLigne = true;
let sessionTeamkills = {};

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ type: '*/*' }));

// Initialisation du Bot Discord pour le salon dynamique
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

if (DISCORD_BOT_TOKEN) {
    client.login(DISCORD_BOT_TOKEN).catch(err => {
        console.log("⚠️ Bot Discord non configuré ou token invalide.", err.message);
    });
} else {
    console.log("⚠️ DISCORD_BOT_TOKEN manquant dans le fichier .env, le bot ne sera pas lancé.");
}

// --- CHARGEMENT DU LEADERBOARD PERSISTANT ---
let leaderboard = {};

// File d'attente des commandes d'administration RCON
let pendingCommands = [];

let serverData = {
    status: "offline",
    lastHeartbeat: 0,
    joueursCount: 0,
    equipes: { US: [], URSS: [] },
    killfeed: [],
    chatfeed: [],
    map: { players: [], bases: [] }
};

// Fonction pour mettre à jour le nom du salon Discord (Max 1 fois toutes les 5 min à cause des limites de Discord)
let dernierChangementSalon = 0;
async function rafraichirSalonCompteur() {
    const maintenant = Date.now();
    if (maintenant - dernierChangementSalon < 300000) return; // Sécurité anti-spam (5 minutes)

    if (!COMPTEUR_CHANNEL_ID) {
        console.warn("⚠️ DISCORD_COMPTEUR_CHANNEL_ID manquant dans .env, impossible de rafraîchir le salon compteur.");
        return;
    }

    try {
        const salon = await client.channels.fetch(COMPTEUR_CHANNEL_ID);
        if (salon) {
            await salon.setName(`👥 En Jeu : ${serverData.joueursCount} joueur${serverData.joueursCount > 1 ? 's' : ''}`);
            dernierChangementSalon = maintenant;
        }
    } catch (err) {
        console.error("❌ Erreur lors de la mise à jour du salon compteur :", err.message);
    }
}

// Fonction Webhook Admin
async function envoyerLogDiscord(titre, description, couleur, champs = []) {
    if (!DISCORD_WEBHOOK_URL) return;
    if (DISCORD_WEBHOOK_URL.includes("TON_WEBHOOK")) return;

    const payload = {
        embeds: [{
            title: titre,
            description: description,
            color: couleur,
            fields: champs,
            timestamp: new Date().toISOString(),
            footer: { text: "Système Tactique" }
        }]
    };

    try {
        await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (err) {
        console.error("❌ Erreur lors de l'envoi du webhook Discord :", err.message);
    }
}

// Fonction Relais Chat Discord
async function envoyerChatDiscord(nomJoueur, faction, canal, message) {
    if (!DISCORD_CHAT_WEBHOOK_URL) return;
    if (DISCORD_CHAT_WEBHOOK_URL.includes("TON_WEBHOOK")) return;

    let factionEmoji = "👥";
    if (faction === "US") factionEmoji = "🇺🇸";
    else if (faction === "USSR") factionEmoji = "☭";
    else if (faction === "FIA") factionEmoji = "🔰";

    const content = `[${canal}] **${factionEmoji} ${nomJoueur}** : ${message}`;

    try {
        await fetch(DISCORD_CHAT_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content })
        });
    } catch (err) {
        console.error("❌ Erreur lors de l'envoi du message chat sur Discord :", err.message);
    }
}

async function checkAndRegisterPlayer(name) {
    if (!name || name === "IA / Bot" || name === "Lui-meme" || name === "Un sifflement dans le noir" || name.startsWith("Joueur_")) return;
    if (!leaderboard[name]) {
        leaderboard[name] = { kills: 0, morts: 0, teamkills: 0, captures: 0, vehicles_destroyed: 0 };
        await ensurePlayer(name);
    }
}

// --- ROUTE 1 : ARMA ---
app.post('/api/arma-event', async (req, res) => {
    const { type, detail, player, faction, killer, killerFaction, typeTir } = req.body;
    let nomJoueur = player ? player.trim() : "";

    serverData.lastHeartbeat = Date.now();
    
    // Si c'est offline
    if (type === "offline") {
        serverData.status = "offline";
        estPrecedemmentHorsLigne = true;
        sessionTeamkills = {};
        serverData.joueursCount = 0;
        serverData.equipes.US = [];
        serverData.equipes.URSS = [];
        serverData.killfeed.unshift({ horaire: new Date().toLocaleTimeString('fr-FR'), message: "🔴 Le serveur a été arrêté proprement." });
        if (serverData.killfeed.length > 30) serverData.killfeed.pop();

        envoyerLogDiscord(
            "🔴 Liaison Satellite Interrompue",
            "Le serveur Arma Reforger a été **arrêté proprement**.",
            15158332 // Rouge
        );

        res.status(200).send({ message: "OK" });
        return;
    }

    // Gestion du statut En Ligne au premier heartbeat/connexion
    if (type !== "map_update") {
        if (estPrecedemmentHorsLigne) {
            estPrecedemmentHorsLigne = false;
            serverData.status = "online";
            sessionTeamkills = {};
            envoyerLogDiscord(
                "🟢 Liaison Satellite Établie",
                "Le serveur Arma Reforger est désormais **actif** et connecté au Centre Tactique.",
                3066993 // Vert
            );
        }
    }

    // Si c'est un heartbeat du serveur
    if (type === "heartbeat") {
        const cmds = [...pendingCommands];
        pendingCommands = []; // On vide la file
        res.status(200).send({ message: "OK", commands: cmds });
        return;
    }

    // Si c'est un update de la livemap
    if (type === "map_update") {
        serverData.map = {
            mapName: req.body.mapName || "Eden",
            mapSize: req.body.mapSize || 12800,
            players: req.body.players || [],
            bases: req.body.bases || []
        };
        res.status(200).send({ message: "OK" });
        return;
    }

    serverData.status = "online";

    if (type === "connexion" && nomJoueur) {
        await checkAndRegisterPlayer(nomJoueur);
        if (faction && serverData.equipes[faction] && !serverData.equipes[faction].includes(nomJoueur)) {
            serverData.equipes[faction].push(nomJoueur);

            envoyerLogDiscord(
                "📥 Connexion Opérateur",
                `**${nomJoueur}** a été parachuté.`,
                3066993,
                [{ name: "Faction", value: faction === "US" ? "🔵 OTAN" : "🔴 URSS", inline: true }]
            );
            rafraichirSalonCompteur();
        }
    }

    if (type === "deconnexion" && nomJoueur) {
        serverData.equipes.US = serverData.equipes.US.filter(p => p !== nomJoueur);
        serverData.equipes.URSS = serverData.equipes.URSS.filter(p => p !== nomJoueur);
        envoyerLogDiscord("📤 Déconnexion Opérateur", `**${nomJoueur}** a quitté la zone.`, 9807270);
        rafraichirSalonCompteur();
    }

    if (type === "kill") {
        await checkAndRegisterPlayer(nomJoueur);
        await checkAndRegisterPlayer(killer);

        let isTK = false;
        if (killer && killer !== "IA / Bot" && killer !== nomJoueur && killer !== "Lui-meme" && killer !== "Un sifflement dans le noir" && killerFaction && faction && killerFaction === faction && killerFaction !== "Inconnue") {
            isTK = true;
        }

        serverData.killfeed.unshift({ horaire: new Date().toLocaleTimeString('fr-FR'), message: isTK ? `⚠️ [TEAMKILL] ${detail}` : `💀 ${detail}` });
        if (serverData.killfeed.length > 30) serverData.killfeed.pop();

        // ---- ENREGISTREMENT DES STATS DANS LA BASE DE DONNÉES ----
        if (nomJoueur && leaderboard[nomJoueur]) {
            leaderboard[nomJoueur].morts += 1;
            await addDeath(nomJoueur);
        }
        
        if (isTK) {
            if (killer && leaderboard[killer]) {
                leaderboard[killer].teamkills += 1;
                await addTeamkill(killer);

                // Incrément session TK et alerte critique
                sessionTeamkills[killer] = (sessionTeamkills[killer] || 0) + 1;
                if (sessionTeamkills[killer] >= 3) {
                    envoyerLogDiscord(
                        "🚨 ALERTE ANTI-GRIEFING (TEAMKILLS)",
                        `⚠️ **@here Le joueur ${killer} a commis ${sessionTeamkills[killer]} teamkills en session !**`,
                        16753920
                    );
                }
            }
        } else {
            if (killer && leaderboard[killer] && killer !== "IA / Bot" && killer !== nomJoueur) {
                leaderboard[killer].kills += 1;
                await addKill(killer);
            }
        }

        // Log Admin Discord
        let typeTirNettoye = typeTir || "Inconnu";
        if (typeTirNettoye.includes("Character_")) typeTirNettoye = "Corps à Corps 🥊";

        envoyerLogDiscord(isTK ? "⚠️ Tir Fratricide" : "⚔️ Engagement Neutre", isTK ? "Alerte de tir fratricide !" : "Rapport d'élimination.", isTK ? 16753920 : 3447003, [
            { name: "Victime", value: `💀 **${nomJoueur}**`, inline: true },
            { name: "Tueur", value: `🔫 **${killer}**`, inline: true },
            { name: "Dégâts", value: `📊 ${typeTirNettoye}`, inline: false }
        ]);
    }

    if (type === "chat") {
        let channelName = killer || "Global";
        let message = typeTir || "";
        serverData.chatfeed.unshift({
            horaire: new Date().toLocaleTimeString('fr-FR'),
            player: player,
            faction: faction,
            channel: channelName,
            message: message
        });
        if (serverData.chatfeed.length > 30) serverData.chatfeed.pop();

        // Relais Discord en direct
        await envoyerChatDiscord(player, faction, channelName, message);
    }

    if (type === "capture") {
        let baseName = player || "Base";
        let newFaction = faction || "Inconnue";
        let prevFaction = killer || "Aucune";
        
        serverData.killfeed.unshift({
            horaire: new Date().toLocaleTimeString('fr-FR'),
            message: `🚩 [CAPTURE] La base de ${baseName} a été capturée par les forces de ${newFaction} (auparavant contrôlée par ${prevFaction}).`
        });
        if (serverData.killfeed.length > 30) serverData.killfeed.pop();

        // Envoi alerte Discord
        let couleurEmbed = 10066329; // Gris
        if (newFaction === "US") couleurEmbed = 3066993; // Bleu US
        else if (newFaction === "USSR") couleurEmbed = 15158332; // Rouge URSS

        envoyerLogDiscord(
            "🚩 Base Stratégique Capturée",
            `La base de **${baseName}** a été capturée par les forces de **${newFaction === 'US' ? 'OTAN 🇺🇸' : newFaction === 'USSR' ? 'URSS ☭' : 'FIA 🔰'}**.\n*(Auparavant contrôlée par : ${prevFaction})*`,
            couleurEmbed
        );
    }

    if (type === "vehicle_destroyed") {
        let vehicleName = player || "Véhicule";
        let vehicleFaction = faction || "Inconnue";
        let occupants = killer || "Aucun occupant";

        serverData.killfeed.unshift({
            horaire: new Date().toLocaleTimeString('fr-FR'),
            message: `💥 [DÉTRUIT] Le véhicule ${vehicleName} (${vehicleFaction}) a été détruit. Équipage : ${occupants}.`
        });
        if (serverData.killfeed.length > 30) serverData.killfeed.pop();

        // Envoi alerte Discord
        envoyerLogDiscord(
            "💥 Pertes de Véhicule",
            `Le véhicule **${vehicleName}** (${vehicleFaction === 'US' ? 'OTAN 🇺🇸' : vehicleFaction === 'USSR' ? 'URSS ☭' : 'FIA 🔰'}) a été détruit.\n\n💀 **Équipage touché :**\n${occupants}`,
            9830400 // Violet / rouge sombre
        );

        // Increment deaths / vehicle destructions for players inside the vehicle
        if (occupants && occupants !== "Aucun occupant") {
            const names = occupants.split(',').map(n => n.trim());
            for (const name of names) {
                if (name && name !== "") {
                    await checkAndRegisterPlayer(name);
                    if (leaderboard[name]) {
                        leaderboard[name].vehicles_destroyed += 1;
                        await addVehicleDestroyed(name);
                    }
                }
            }
        }
    }

    serverData.joueursCount = serverData.equipes.US.length + serverData.equipes.URSS.length;
    res.status(200).send({ message: "OK" });
});

// --- ROUTE 2 : STATS POUR LE SITE WEB ---
app.get('/api/stats', (req, res) => {
    res.json({
        server: serverData,
        leaderboard: leaderboard
    });
});

// --- ROUTE ADMIN : QUEUE DES COMMANDES RCON ---
app.post('/api/admin/command', (req, res) => {
    const { password, action, target, message } = req.body;
    if (password !== "admin") {
        return res.status(403).json({ error: "Mot de passe admin invalide" });
    }

    if (!action) {
        return res.status(400).json({ error: "Action manquante" });
    }

    let cmdString = "";
    if (action === "kick") {
        cmdString = `kick:${target}`;
    } else if (action === "warn") {
        cmdString = `warn:${target}:${message || 'Avertissement admin'}`;
    } else if (action === "announce") {
        cmdString = `announce:${message}`;
    } else {
        return res.status(400).json({ error: "Action inconnue" });
    }

    pendingCommands.push(cmdString);
    console.log(`📡 [ADMIN COMMAND QUEUED] : ${cmdString}`);
    res.json({ status: "success", command: cmdString });
});

// --- DÉMARRAGE ASYNCHRONE ---
(async () => {
    try {
        await initDatabase();
        leaderboard = await getLeaderboardObject();
        
        // Surveillance en arrière-plan (Watchdog) pour perte de signal satellite
        setInterval(() => {
            const maintenant = Date.now();
            if (serverData.lastHeartbeat > 0 && (maintenant - serverData.lastHeartbeat > 40000)) {
                if (!estPrecedemmentHorsLigne) {
                    estPrecedemmentHorsLigne = true;
                    serverData.status = "offline";
                    serverData.joueursCount = 0;
                    serverData.equipes.US = [];
                    serverData.equipes.URSS = [];
                    sessionTeamkills = {};
                    rafraichirSalonCompteur();
                    
                    envoyerLogDiscord(
                        "⚠️ Signal Satellite Perdu",
                        "Le serveur Arma Reforger ne répond plus. Liaison interrompue.",
                        15158332 // Rouge
                    );
                }
            }
        }, 10000);

        app.listen(PORT, () => console.log(`🤖 Cerveau V2 connecté sur le port ${PORT}`));
    } catch (err) {
        console.error("❌ Impossible de démarrer le serveur API :", err);
        process.exit(1);
    }
})();