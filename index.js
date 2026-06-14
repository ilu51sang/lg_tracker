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
    addVehicleDestroyed,
    addPlaytime,
    addLog,
    getLogs,
    addMetric,
    getMetrics
} = require('./db');

// Lecture des variables d'environnement
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const COMPTEUR_CHANNEL_ID = process.env.DISCORD_COMPTEUR_CHANNEL_ID || "";
const DISCORD_CHAT_WEBHOOK_URL = process.env.DISCORD_CHAT_WEBHOOK_URL || "";

// Suivi d'état session & anti-griefing
let estPrecedemmentHorsLigne = true;
let sessionTeamkills = {};
let activePlayerSessions = {};

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ type: '*/*' }));

// Initialisation du Bot Discord pour le salon dynamique
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

if (DISCORD_BOT_TOKEN) {
    client.once('ready', () => {
        console.log(`🤖 Bot Discord connecté en tant que ${client.user.tag}`);
        rafraichirSalonCompteur(true);
    });
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
    equipes: { US: [], URSS: [], FIA: [] },
    killfeed: [],
    chatfeed: [],
    map: { players: [], bases: [] }
};

// Fonction pour mettre à jour l'embed d'état du serveur
async function mettreAJourEmbedCompteur() {
    if (!COMPTEUR_CHANNEL_ID || !client.token) return;
    try {
        const channel = await client.channels.fetch(COMPTEUR_CHANNEL_ID);
        if (!channel) return;

        const isOnline = serverData.status === "online";
        const usCount = serverData.equipes.US ? serverData.equipes.US.length : 0;
        const urssCount = serverData.equipes.URSS ? serverData.equipes.URSS.length : 0;
        const fiaCount = serverData.equipes.FIA ? serverData.equipes.FIA.length : 0;
        const totalCount = isOnline ? serverData.joueursCount : 0;

        const description = isOnline 
            ? `🟢 **Serveur en ligne**\n\n🇺🇸 **US Army** : ${usCount} joueur(s)\n☭ **URSS** : ${urssCount} joueur(s)\n🔰 **FIA** : ${fiaCount} joueur(s)\n\n👥 **Total** : ${totalCount} joueur(s)`
            : `🔴 **Serveur hors ligne**\n\n🇺🇸 **US Army** : 0 joueur(s)\n☭ **URSS** : 0 joueur(s)\n🔰 **FIA** : 0 joueur(s)\n\n👥 **Total** : 0 joueur(s)`;

        const embed = {
            title: "État du Serveur",
            description: description,
            color: isOnline ? 3066993 : 15158332, // Vert / Rouge
            timestamp: new Date().toISOString()
        };

        // Récupérer les 10 derniers messages pour trouver le message du bot
        const messages = await channel.messages.fetch({ limit: 10 });
        const messageBot = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0 && m.embeds[0].title === "État du Serveur");

        if (messageBot) {
            await messageBot.edit({ embeds: [embed] });
        } else {
            await channel.send({ embeds: [embed] });
        }
    } catch (err) {
        console.error("❌ Erreur lors de la mise à jour de l'embed compteur Discord :", err.message);
    }
}

// Fonction pour mettre à jour le nom du salon Discord (Max 1 fois toutes les 5 min à cause des limites de Discord)
let dernierChangementSalon = 0;
async function rafraichirSalonCompteur(force = false) {
    const maintenant = Date.now();
    
    // Toujours mettre à jour l'embed (non rate-limité comme setName)
    await mettreAJourEmbedCompteur();

    if (!force && (maintenant - dernierChangementSalon < 300000)) return; // Sécurité anti-spam (5 minutes)

    if (!COMPTEUR_CHANNEL_ID) {
        console.warn("⚠️ DISCORD_COMPTEUR_CHANNEL_ID manquant dans .env, impossible de rafraîchir le salon compteur.");
        return;
    }

    try {
        const salon = await client.channels.fetch(COMPTEUR_CHANNEL_ID);
        if (salon) {
            const name = serverData.status === "online" 
                ? `🟢-en-jeu-${serverData.joueursCount}-joueurs`
                : `🔴-serveur-hors-ligne`;
            await salon.setName(name);
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

    // US (Blue/3447003), USSR (Red/15158332), Others (Green/3066993)
    const color = faction === "US" ? 3447003 : (faction === "USSR" ? 15158332 : 3066993);

    const payload = {
        embeds: [{
            description: `💬 **[${canal}]** ${factionEmoji} **${nomJoueur}** : ${message}`,
            color: color,
            timestamp: new Date().toISOString()
        }]
    };

    try {
        await fetch(DISCORD_CHAT_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
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

async function logSystemEvent(type, player, details) {
    try {
        await addLog(type, player, details);
    } catch (err) {
        console.error(`❌ Erreur lors de l'écriture du log système (${type}) :`, err.message);
    }
}

let dernierEnregistrementMetrique = 0;
async function enregistrerMetriqueSiBesoin(force = false) {
    const maintenant = Date.now();
    if (force || (maintenant - dernierEnregistrementMetrique >= 300000)) { // 5 minutes
        const isOnline = serverData.status === "online";
        const playerCount = isOnline ? (serverData.joueursCount || 0) : 0;
        const usCount = isOnline ? ((serverData.equipes && serverData.equipes.US) ? serverData.equipes.US.length : 0) : 0;
        const ussrCount = isOnline ? ((serverData.equipes && serverData.equipes.URSS) ? serverData.equipes.URSS.length : 0) : 0;
        try {
            await addMetric(playerCount, usCount, ussrCount);
            dernierEnregistrementMetrique = maintenant;
            console.log(`📊 [METRIC SAVED] Actifs: ${playerCount} (US: ${usCount}, URSS: ${ussrCount})`);
        } catch (err) {
            console.error("❌ Erreur lors de l'enregistrement de la métrique périodique :", err.message);
        }
    }
}

// --- ROUTE 1 : ARMA ---
app.post('/api/arma-event', async (req, res) => {
    const { auth, type, detail, player, faction, killer, killerFaction, typeTir } = req.body;

    // Validation du token de sécurité (BRIDGE_AUTH_TOKEN)
    const BRIDGE_AUTH_TOKEN = process.env.BRIDGE_AUTH_TOKEN || "";
    if (BRIDGE_AUTH_TOKEN && auth !== BRIDGE_AUTH_TOKEN) {
        console.warn(`⚠️ [API AUTH FAILED] Token reçu: "${auth || 'aucun'}" | Attendu: "${BRIDGE_AUTH_TOKEN}"`);
        return res.status(401).json({ error: "Unauthorized" });
    }

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
        serverData.equipes.FIA = [];

        // Sauvegarde de fin de session pour tous les joueurs actifs
        for (const player in activePlayerSessions) {
            const elapsedSeconds = Math.round((Date.now() - activePlayerSessions[player]) / 1000);
            if (elapsedSeconds > 0) {
                try {
                    await addPlaytime(player, elapsedSeconds);
                    if (leaderboard[player]) {
                        leaderboard[player].playtime = (leaderboard[player].playtime || 0) + elapsedSeconds;
                    }
                } catch (e) {
                    console.error(`Error saving offline playtime for ${player}:`, e);
                }
            }
        }
        activePlayerSessions = {};

        serverData.killfeed.unshift({ horaire: new Date().toISOString(), message: "🔴 Le serveur a été arrêté proprement." });
        if (serverData.killfeed.length > 30) serverData.killfeed.pop();

        await logSystemEvent("offline", null, "Le serveur a été arrêté proprement.");
        await rafraichirSalonCompteur(true);

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
            await logSystemEvent("online", null, "Le serveur est désormais actif et connecté au Centre Tactique.");
            await rafraichirSalonCompteur(true);
            await enregistrerMetriqueSiBesoin(true);
            envoyerLogDiscord(
                "🟢 Liaison Satellite Établie",
                "Le serveur Arma Reforger est désormais **actif** et connecté au Centre Tactique.",
                3066993 // Vert
            );
        }
    }

    // Si c'est un heartbeat du serveur
    if (type === "heartbeat") {
        // Sauvegarde incrémentale du temps de jeu pour les joueurs actifs
        const maintenant = Date.now();
        for (const player in activePlayerSessions) {
            const elapsedSeconds = Math.round((maintenant - activePlayerSessions[player]) / 1000);
            if (elapsedSeconds >= 10) {
                activePlayerSessions[player] = maintenant; // reset timer
                try {
                    await addPlaytime(player, elapsedSeconds);
                    if (leaderboard[player]) {
                        leaderboard[player].playtime = (leaderboard[player].playtime || 0) + elapsedSeconds;
                    }
                } catch (e) {
                    console.error(`Error saving periodic playtime for ${player}:`, e);
                }
            }
        }

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

        // Initialiser la session des joueurs connectés si non encore suivis et reconstruire les équipes
        const maintenant = Date.now();
        if (req.body.players && Array.isArray(req.body.players)) {
            const tempEquipes = { US: [], URSS: [], FIA: [] };
            for (const p of req.body.players) {
                const pName = p.name;
                if (pName && pName !== "IA / Bot" && pName !== "Lui-meme" && pName !== "Un sifflement dans le noir" && !pName.startsWith("Joueur_")) {
                    await checkAndRegisterPlayer(pName);
                    if (!activePlayerSessions[pName]) {
                        activePlayerSessions[pName] = maintenant;
                    }
                    
                    let pFaction = p.faction || "";
                    if (pFaction === "USSR") pFaction = "URSS";
                    
                    if (pFaction && tempEquipes[pFaction]) {
                        tempEquipes[pFaction].push(pName);
                    }
                }
            }
            
            serverData.equipes.US = tempEquipes.US;
            serverData.equipes.URSS = tempEquipes.URSS;
            serverData.equipes.FIA = tempEquipes.FIA;
            serverData.joueursCount = serverData.equipes.US.length + serverData.equipes.URSS.length + (serverData.equipes.FIA ? serverData.equipes.FIA.length : 0);
            
            // Rafraîchir l'embed Discord si connecté
            rafraichirSalonCompteur();
        }

        res.status(200).send({ message: "OK" });
        return;
    }

    serverData.status = "online";

    if (type === "connexion" && nomJoueur) {
        await checkAndRegisterPlayer(nomJoueur);
        activePlayerSessions[nomJoueur] = Date.now(); // Démarrer le suivi de session
        await logSystemEvent("connexion", nomJoueur, `A rejoint la zone (Faction: ${faction || 'Inconnue'})`);
        
        let factionKey = faction;
        if (faction === "USSR") factionKey = "URSS";
        
        if (factionKey && serverData.equipes[factionKey] && !serverData.equipes[factionKey].includes(nomJoueur)) {
            serverData.equipes[factionKey].push(nomJoueur);

            let factionLabel = "Inconnue";
            if (faction === "US") factionLabel = "🔵 OTAN";
            else if (faction === "USSR") factionLabel = "🔴 URSS";
            else if (faction === "FIA") factionLabel = "🔰 FIA";

            envoyerLogDiscord(
                "📥 Connexion Opérateur",
                `**${nomJoueur}** a été parachuté.`,
                3066993,
                [{ name: "Faction", value: factionLabel, inline: true }]
            );
            rafraichirSalonCompteur();
        }
    }

    if (type === "deconnexion" && nomJoueur) {
        serverData.equipes.US = serverData.equipes.US.filter(p => p !== nomJoueur);
        serverData.equipes.URSS = serverData.equipes.URSS.filter(p => p !== nomJoueur);
        if (serverData.equipes.FIA) {
            serverData.equipes.FIA = serverData.equipes.FIA.filter(p => p !== nomJoueur);
        }

        // Sauvegarder le temps de jeu accumulé sur déconnexion
        if (activePlayerSessions[nomJoueur]) {
            const elapsedSeconds = Math.round((Date.now() - activePlayerSessions[nomJoueur]) / 1000);
            delete activePlayerSessions[nomJoueur];
            if (elapsedSeconds > 0) {
                try {
                    await addPlaytime(nomJoueur, elapsedSeconds);
                    if (leaderboard[nomJoueur]) {
                        leaderboard[nomJoueur].playtime = (leaderboard[nomJoueur].playtime || 0) + elapsedSeconds;
                    }
                } catch (e) {
                    console.error(`Error saving disconnect playtime for ${nomJoueur}:`, e);
                }
            }
        }

        await logSystemEvent("deconnexion", nomJoueur, "A quitté la zone");

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

        serverData.killfeed.unshift({ horaire: new Date().toISOString(), message: isTK ? `⚠️ [TEAMKILL] ${detail}` : `💀 ${detail}` });
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

        await logSystemEvent(isTK ? "teamkill" : "kill", killer || "Inconnu", `A éliminé ${nomJoueur} (${typeTirNettoye})`);

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
            horaire: new Date().toISOString(),
            player: player,
            faction: faction,
            channel: channelName,
            message: message
        });
        if (serverData.chatfeed.length > 30) serverData.chatfeed.pop();

        await logSystemEvent("chat", player, `[${channelName}] : ${message}`);

        // Relais Discord en direct
        await envoyerChatDiscord(player, faction, channelName, message);
    }

    if (type === "capture") {
        let baseName = player || "Base";
        let newFaction = faction || "Inconnue";
        let prevFaction = killer || "Aucune";
        
        serverData.killfeed.unshift({
            horaire: new Date().toISOString(),
            message: `🚩 [CAPTURE] La base de ${baseName} a été capturée par les forces de ${newFaction} (auparavant contrôlée par ${prevFaction}).`
        });
        if (serverData.killfeed.length > 30) serverData.killfeed.pop();

        await logSystemEvent("capture", null, `La base de ${baseName} a été capturée par les forces de ${newFaction} (auparavant contrôlée par ${prevFaction})`);

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
            horaire: new Date().toISOString(),
            message: `💥 [DÉTRUIT] Le véhicule ${vehicleName} (${vehicleFaction}) a été détruit. Équipage : ${occupants}.`
        });
        if (serverData.killfeed.length > 30) serverData.killfeed.pop();

        await logSystemEvent("vehicle_destroyed", occupants === "Aucun occupant" ? null : occupants, `Le véhicule ${vehicleName} (${vehicleFaction}) a été détruit. Équipage : ${occupants}`);

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

    serverData.joueursCount = serverData.equipes.US.length + serverData.equipes.URSS.length + (serverData.equipes.FIA ? serverData.equipes.FIA.length : 0);
    res.status(200).send({ message: "OK" });
});

// --- ROUTE 2 : STATS POUR LE SITE WEB ---
app.get('/api/stats', (req, res) => {
    res.json({
        server: serverData,
        leaderboard: leaderboard
    });
});

// --- ROUTES ADMIN POUR LES LOGS ET LES METRIQUES ---
app.get('/api/admin/logs', async (req, res) => {
    const { password, limit, filter, search } = req.query;
    if (password !== "admin") {
        return res.status(403).json({ error: "Mot de passe admin invalide" });
    }
    try {
        const limitInt = parseInt(limit) || 100;
        const logs = await getLogs(limitInt, filter || "All", search || "");
        
        // Normaliser les dates pour forcer le format ISO UTC (notamment pour SQLite)
        const formattedLogs = logs.map(log => {
            let dateVal = log.created_at;
            if (typeof dateVal === 'string' && !dateVal.includes('T') && !dateVal.includes('Z')) {
                dateVal = dateVal.replace(' ', 'T') + 'Z';
            }
            return {
                ...log,
                created_at: typeof dateVal === 'string' ? dateVal : dateVal.toISOString()
            };
        });
        
        res.json(formattedLogs);
    } catch (err) {
        console.error("❌ Erreur lors de la récupération des logs :", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/metrics', async (req, res) => {
    const { password, limit } = req.query;
    if (password !== "admin") {
        return res.status(403).json({ error: "Mot de passe admin invalide" });
    }
    try {
        const limitInt = parseInt(limit) || 288;
        const metrics = await getMetrics(limitInt);
        
        // Normaliser les dates pour forcer le format ISO UTC (notamment pour SQLite)
        const formattedMetrics = metrics.map(m => {
            let dateVal = m.created_at;
            if (typeof dateVal === 'string' && !dateVal.includes('T') && !dateVal.includes('Z')) {
                dateVal = dateVal.replace(' ', 'T') + 'Z';
            }
            return {
                ...m,
                created_at: typeof dateVal === 'string' ? dateVal : dateVal.toISOString()
            };
        });
        
        res.json(formattedMetrics);
    } catch (err) {
        console.error("❌ Erreur lors de la récupération des métriques :", err.message);
        res.status(500).json({ error: err.message });
    }
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
        setInterval(async () => {
            const maintenant = Date.now();
            if (serverData.lastHeartbeat > 0 && (maintenant - serverData.lastHeartbeat > 40000)) {
                if (!estPrecedemmentHorsLigne) {
                    estPrecedemmentHorsLigne = true;
                    serverData.status = "offline";
                    serverData.joueursCount = 0;
                    serverData.equipes.US = [];
                    serverData.equipes.URSS = [];
                    serverData.equipes.FIA = [];
                    
                    // Sauvegarder le temps accumulé avant de couper
                    for (const player in activePlayerSessions) {
                        const elapsedSeconds = Math.round((maintenant - activePlayerSessions[player]) / 1000);
                        if (elapsedSeconds > 0) {
                            try {
                                await addPlaytime(player, elapsedSeconds);
                                if (leaderboard[player]) {
                                    leaderboard[player].playtime = (leaderboard[player].playtime || 0) + elapsedSeconds;
                                }
                            } catch (e) {
                                console.error(`Error saving watchdog playtime for ${player}:`, e);
                            }
                        }
                    }
                    activePlayerSessions = {};
                    
                    sessionTeamkills = {};
                    await rafraichirSalonCompteur(true);
                    
                    await logSystemEvent("offline", null, "Signal satellite perdu (le serveur ne répond plus).");
                    
                    envoyerLogDiscord(
                        "⚠️ Signal Satellite Perdu",
                        "Le serveur Arma Reforger ne répond plus. Liaison interrompue.",
                        15158332 // Rouge
                    );
                }
            }
        }, 10000);

        // Enregistrement périodique des métriques d'activité et rafraîchissement Discord
        setInterval(async () => {
            await enregistrerMetriqueSiBesoin();
            await rafraichirSalonCompteur();
        }, 60000);

        app.listen(PORT, () => console.log(`🤖 Cerveau V2 connecté sur le port ${PORT}`));
    } catch (err) {
        console.error("❌ Impossible de démarrer le serveur API :", err);
        process.exit(1);
    }
})();