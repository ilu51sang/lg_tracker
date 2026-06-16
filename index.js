require('dotenv').config(); // Charge les variables depuis .env

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
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
    getMetrics,
    addNote,
    getNotes,
    addSanction,
    getSanctions,
    getPlayerProfile,
    addToWatchlist,
    removeFromWatchlist,
    getWatchlist,
    isOnWatchlist,
    getPeakPlayers,
    getPeakHours,
    getAllSanctions,
    startSession,
    endSession,
    getGameSessions,
    getActiveSession,
    closeActiveSessionsOnBoot,
    incrementSessionPlayerStat,
    getSessionPlayerStats,
    getSessionTimeline,
    getWeeklyLeaderboard,
    getPlayerKillsDetails,
    getSetting,
    setSetting
} = require('./db');

// Lecture et gestion dynamique de la configuration des cartes
let mapSizes = {
    "everon": 12800,
    "arland": 2048,
    "gulf": 20480,
    "gulfcoast": 20480,
    "eden": 12800
};

function loadMapSizes() {
    try {
        const configPath = path.join(__dirname, 'map_sizes.json');
        if (fs.existsSync(configPath)) {
            mapSizes = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } else {
            fs.writeFileSync(configPath, JSON.stringify(mapSizes, null, 2), 'utf8');
        }
    } catch (e) {
        console.error("⚠️ Erreur lors du chargement de map_sizes.json :", e.message);
    }
}
loadMapSizes();

// Lecture des variables d'environnement
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const COMPTEUR_CHANNEL_ID = process.env.DISCORD_COMPTEUR_CHANNEL_ID || "";
const DISCORD_CHAT_WEBHOOK_URL = process.env.DISCORD_CHAT_WEBHOOK_URL || "";
const DISCORD_WEEKLY_WEBHOOK_URL = process.env.DISCORD_WEEKLY_WEBHOOK_URL || "";

// Suivi d'état session & anti-griefing
let estPrecedemmentHorsLigne = true;
let sessionTeamkills = {};
let activePlayerSessions = {};

// Suivi de session pour le rapport de fin
let sessionStartTime = 0;
let sessionKillCount = 0;
let sessionTKCount = 0;
let sessionConnections = new Set();
let currentSessionId = null;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ type: '*/*' }));

// Utilitaire pour formater la durée de jeu pour le bot Discord
function formaterDureeBot(secondes) {
    if (!secondes || secondes <= 0) return "0s";
    const h = Math.floor(secondes / 3600);
    const m = Math.floor((secondes % 3600) / 60);
    const s = secondes % 60;
    if (h > 0) {
        return `${h}h ${m}m`;
    } else if (m > 0) {
        return `${m}m ${s}s`;
    } else {
        return `${s}s`;
    }
}

// Initialisation du Bot Discord pour le salon dynamique et les commandes slash
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

if (DISCORD_BOT_TOKEN) {
    client.once('ready', async () => {
        console.log(`🤖 Bot Discord connecté en tant que ${client.user.tag}`);
        rafraichirSalonCompteur(true);

        // Enregistrement des commandes slash
        try {
            await client.application.commands.set([
                {
                    name: 'lgstats',
                    description: 'Affiche vos statistiques de jeu Les Gaulois',
                    options: [
                        {
                            name: 'pseudo',
                            description: 'Votre pseudo en jeu',
                            type: 3, // STRING
                            required: true
                        }
                    ]
                }
            ]);
            console.log("✅ Commande Slash /lgstats enregistrée avec succès.");
        } catch (e) {
            console.error("❌ Erreur lors de l'enregistrement de la commande slash /lgstats :", e.message);
        }
    });

    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand()) return;

        if (interaction.commandName === 'lgstats') {
            const pseudoInput = interaction.options.getString('pseudo').trim();
            const pseudoInputLower = pseudoInput.toLowerCase();

            // Recherche exacte puis partielle du joueur
            let matchPlayer = Object.keys(leaderboard).find(k => k.toLowerCase() === pseudoInputLower);
            if (!matchPlayer) {
                matchPlayer = Object.keys(leaderboard).find(k => k.toLowerCase().includes(pseudoInputLower));
            }

            if (!matchPlayer) {
                return interaction.reply({
                    content: `❌ Aucun joueur trouvé avec le pseudo **"${pseudoInput}"** dans la base de données.`,
                    ephemeral: true
                });
            }

            const stats = leaderboard[matchPlayer];
            const kills = stats.kills || 0;
            const morts = stats.morts || stats.deaths || 0;
            const ratio = morts > 0 ? (kills / morts).toFixed(2) : kills.toFixed(2);
            const teamkills = stats.teamkills || 0;
            const captures = stats.captures || 0;
            const vehicles = stats.vehicles_destroyed || 0;
            const playtimeFormatted = formaterDureeBot(stats.playtime || 0);

            const embed = {
                title: `🪖 Fiche Opérateur : ${matchPlayer}`,
                color: 3447003, // Bleu
                thumbnail: {
                    url: "https://ilu51sang.github.io/site-les-gaulois/assets/logo.png"
                },
                fields: [
                    { name: "🕒 Temps de Jeu", value: `\`${playtimeFormatted}\``, inline: true },
                    { name: "⚔️ Éliminations (Kills)", value: `\`${kills}\``, inline: true },
                    { name: "💀 Morts", value: `\`${morts}\``, inline: true },
                    { name: "📊 Ratio K/D", value: `\`${ratio}\``, inline: true },
                    { name: "⚠️ Tirs Fratricides (TK)", value: `\`${teamkills}\``, inline: true },
                    { name: "💥 Véhicules Détruits", value: `\`${vehicles}\``, inline: true },
                    { name: "🚩 Bases Capturées", value: `\`${captures}\``, inline: true }
                ],
                footer: {
                    text: "Centre Tactique Les Gaulois"
                },
                timestamp: new Date().toISOString()
            };

            await interaction.reply({ embeds: [embed] });
        }
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

// Fonction pour mettre à jour le classement Top 10 sur Discord
async function mettreAJourEmbedStats() {
    const STATS_CHANNEL_ID = process.env.DISCORD_STATS_CHANNEL_ID || "";
    if (!STATS_CHANNEL_ID || !client.token) return;

    try {
        const channel = await client.channels.fetch(STATS_CHANNEL_ID);
        if (!channel) return;

        // Récupérer et trier les joueurs par kills
        const top10 = Object.keys(leaderboard)
            .map(name => ({ name, ...leaderboard[name] }))
            .sort((a, b) => (b.kills || 0) - (a.kills || 0))
            .slice(0, 10);

        let description = "Voici le classement actuel des 10 meilleurs opérateurs de la communauté :\n\n";

        if (top10.length === 0) {
            description += "*Aucune élimination enregistrée pour le moment.*";
        } else {
            top10.forEach((player, index) => {
                const ratio = (player.morts || 0) > 0 
                    ? ((player.kills || 0) / (player.morts || 0)).toFixed(2) 
                    : (player.kills || 0).toFixed(2);
                
                const emoji = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : `**#${index + 1}**`;
                const playtimeHours = ((player.playtime || 0) / 3600).toFixed(1);
                
                description += `${emoji} **${player.name}**\n` +
                               `└ ⚔️ Kills: \`${player.kills || 0}\` | 💀 Morts: \`${player.morts || 0}\` | 📊 K/D: \`${ratio}\` | 🕒 Jeu: \`${playtimeHours}h\`\n\n`;
            });
        }

        const embed = {
            title: "🏆 TOP 10 DES GAULOIS - CLASSEMENT",
            description: description,
            color: 15844367, // Or (Gold)
            thumbnail: {
                url: "https://ilu51sang.github.io/site-les-gaulois/assets/logo.png"
            },
            footer: {
                text: "Mise à jour en temps réel • Les Gaulois"
            },
            timestamp: new Date().toISOString()
        };

        const messages = await channel.messages.fetch({ limit: 10 });
        const messageBot = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0 && m.embeds[0].title === "🏆 TOP 10 DES GAULOIS - CLASSEMENT");

        if (messageBot) {
            await messageBot.edit({ embeds: [embed] });
        } else {
            await channel.send({ embeds: [embed] });
        }
    } catch (err) {
        console.error("❌ Erreur lors de la mise à jour de l'embed stats Discord :", err.message);
    }
}

// Fonction pour mettre à jour le nom du salon Discord (Max 1 fois toutes les 5 min à cause des limites de Discord)
let dernierChangementSalon = 0;
async function rafraichirSalonCompteur(force = false) {
    const maintenant = Date.now();
    
    // Toujours mettre à jour les embeds (non rate-limités comme setName)
    await mettreAJourEmbedCompteur();
    await mettreAJourEmbedStats();

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

function formaterTempsJeu(secondes) {
    if (secondes <= 0) return "0m";
    const h = Math.floor(secondes / 3600);
    const m = Math.floor((secondes % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function BuildWeeklyLeaderboardText(weeklyData) {
    let text = "";
    const topData = weeklyData.slice(0, 10);
    topData.forEach((p, idx) => {
        const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : `**#${idx + 1}**`;
        const ratio = p.deaths > 0 ? (p.kills / p.deaths).toFixed(2) : p.kills.toFixed(2);
        const playtimeStr = formaterTempsJeu(p.playtime);
        
        text += `${medal} **${p.player_name}**\n`;
        text += ` ⚔️ **${p.kills}** Kills | 💀 **${p.deaths}** Morts | 📊 Ratio **${ratio}** | 🚩 **${p.captures}** Caps | 🕒 **${playtimeStr}**\n\n`;
    });
    
    text += `*Classement complet et fiches de profil sur le [Centre Tactique](https://site-les-gaulois.github.io).*`;
    return text;
}

async function actualiserDiscordWeeklyStats() {
    if (!DISCORD_WEEKLY_WEBHOOK_URL) return;
    if (DISCORD_WEEKLY_WEBHOOK_URL.includes("TON_WEBHOOK")) return;

    try {
        const now = new Date();
        const day = now.getDay();
        const diff = now.getDate() - day + (day === 0 ? -6 : 1);
        const startOfWeek = new Date(now.setDate(diff));
        startOfWeek.setHours(0, 0, 0, 0);
        const currentWeekStr = startOfWeek.toISOString().slice(0, 10);
        
        let messageId = await getSetting('weekly_discord_msg_id');
        let registeredWeek = await getSetting('weekly_discord_msg_week');

        if (!registeredWeek) {
            await setSetting('weekly_discord_msg_week', currentWeekStr);
            registeredWeek = currentWeekStr;
        }

        // Si la semaine a changé, on clôture le message existant et on réinitialise
        if (registeredWeek !== currentWeekStr) {
            console.log(`⏰ [WEEKLY RESET] Transition de semaine détectée : ${registeredWeek} -> ${currentWeekStr}.`);
            
            if (messageId) {
                const startStr = `${registeredWeek} 00:00:00`;
                const endStr = `${currentWeekStr} 00:00:00`;
                const pastWeeklyData = await getWeeklyLeaderboard(startStr, endStr);

                const finalPayload = {
                    embeds: [{
                        title: `🏆 CLASSEMENT HEBDOMADAIRE (SEMAINE DU ${registeredWeek}) - CLÔTURÉ`,
                        description: "Les compteurs ont été réinitialisés pour la nouvelle semaine !\n\n" + BuildWeeklyLeaderboardText(pastWeeklyData),
                        color: 15158332,
                        timestamp: new Date().toISOString()
                    }]
                };

                try {
                    console.log(`📦 [WEEKLY RESET] Envoi de l'embed de clôture pour le message ${messageId}...`);
                    await fetch(`${DISCORD_WEEKLY_WEBHOOK_URL}/messages/${messageId}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(finalPayload)
                    });
                } catch (e) {
                    console.error("❌ Erreur lors de l'envoi de la clôture sur Discord :", e.message);
                }
            }

            await setSetting('weekly_discord_msg_id', '');
            await setSetting('weekly_discord_msg_week', currentWeekStr);
            messageId = null;
            registeredWeek = currentWeekStr;
        }

        const weeklyData = await getWeeklyLeaderboard();

        let description = "⚡ **Opérateurs les plus actifs cette semaine (depuis lundi 00h00) :**\n\n";

        if (weeklyData.length === 0) {
            description += "*Aucune opération menée pour le moment cette semaine.*";
        } else {
            description += BuildWeeklyLeaderboardText(weeklyData);
        }

        const payload = {
            embeds: [{
                title: "⚡ CLASSEMENT HEBDOMADAIRE LIVE",
                description: description,
                color: 3447003,
                footer: {
                    text: "Mise à jour automatique chaque minute • Remise à zéro le lundi à 00h00"
                },
                timestamp: new Date().toISOString()
            }]
        };

        if (messageId) {
            const res = await fetch(`${DISCORD_WEEKLY_WEBHOOK_URL}/messages/${messageId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                console.warn("⚠️ [WEEKLY STATS] Le message d'embed hebdomadaire n'a pas pu être modifié. Suppression de l'ID invalide.");
                await setSetting('weekly_discord_msg_id', '');
            }
        } else {
            const res = await fetch(`${DISCORD_WEEKLY_WEBHOOK_URL}?wait=true`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                const resData = await res.json();
                if (resData && resData.id) {
                    await setSetting('weekly_discord_msg_id', resData.id);
                    console.log(`✅ [WEEKLY STATS] Nouvel embed hebdomadaire créé sur Discord (ID: ${resData.id})`);
                }
            } else {
                console.error("❌ [WEEKLY STATS] Impossible d'envoyer l'embed hebdomadaire sur Discord :", res.statusText);
            }
        }

    } catch (err) {
        console.error("❌ [WEEKLY STATS] Erreur de mise à jour de l'embed hebdomadaire :", err.message);
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

        // Sauvegarde de fin de session pour tous les Gaulois actifs
        for (const player in activePlayerSessions) {
            const elapsedSeconds = Math.round((Date.now() - activePlayerSessions[player]) / 1000);
            if (elapsedSeconds > 0) {
                try {
                    await addPlaytime(player, elapsedSeconds);
                    if (leaderboard[player]) {
                        leaderboard[player].playtime = (leaderboard[player].playtime || 0) + elapsedSeconds;
                    }
                    if (currentSessionId) {
                        await incrementSessionPlayerStat(currentSessionId, player, 'playtime', elapsedSeconds);
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
        if (currentSessionId) {
            try {
                await endSession(currentSessionId, sessionConnections.size, sessionKillCount, sessionTKCount);
                console.log(`🎮 [SESSION ENDED] ID: ${currentSessionId} updated in DB.`);
                currentSessionId = null;
            } catch (e) {
                console.error("❌ Erreur d'enregistrement de fin de session :", e.message);
            }
        }
        await rafraichirSalonCompteur(true);

        // Rapport de session avant notification Discord
        if (sessionStartTime > 0) {
            const dureeMs = Date.now() - sessionStartTime;
            const dureeMin = Math.round(dureeMs / 60000);
            const heures = Math.floor(dureeMin / 60);
            const minutes = dureeMin % 60;
            envoyerLogDiscord(
                "📊 Rapport de Session",
                `La session est terminée après **${heures}h${minutes.toString().padStart(2, '0')}**.`,
                3447003, // Bleu
                [
                    { name: "👥 Connexions", value: `${sessionConnections.size} joueur(s)`, inline: true },
                    { name: "⚔️ Kills", value: `${sessionKillCount}`, inline: true },
                    { name: "⚠️ Teamkills", value: `${sessionTKCount}`, inline: true }
                ]
            );
        }

        envoyerLogDiscord(
            "🔴 Liaison Satellite Interrompue",
            "Le serveur Arma Reforger a été **arrêté proprement**.",
            15158332 // Rouge
        );

        res.status(200).send({ message: "OK" });
        return;
    }

    // Gestion du statut En Ligne au premier heartbeat/connexion/map_update
    if (estPrecedemmentHorsLigne) {
        estPrecedemmentHorsLigne = false;
        serverData.status = "online";
        sessionTeamkills = {};
        // Initialisation des compteurs de session
        sessionStartTime = Date.now();
        sessionKillCount = 0;
        sessionTKCount = 0;
        sessionConnections = new Set();

        const currentMap = serverData.map ? (serverData.map.mapName || "Eden") : "Eden";
        try {
            currentSessionId = await startSession(currentMap);
            console.log(`🎮 [SESSION STARTED] ID: ${currentSessionId} (Map: ${currentMap})`);
        } catch (e) {
            console.error("❌ Erreur de création de session dans la base de données :", e.message);
        }

        await logSystemEvent("online", null, "Le serveur est désormais actif et connecté au Centre Tactique.");
        await rafraichirSalonCompteur(true);
        await enregistrerMetriqueSiBesoin(true);
        envoyerLogDiscord(
            "🟢 Liaison Satellite Établie",
            "Le serveur Arma Reforger est désormais **actif** et connecté au Centre Tactique.",
            3066993 // Vert
        );
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
                    if (currentSessionId) {
                        await incrementSessionPlayerStat(currentSessionId, player, 'playtime', elapsedSeconds);
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
        // Alias pour les noms de carte génériques envoyés par le mod
        const mapAliases = {
            "unnamed.ent": "shervika",
            "unnamed": "shervika"
        };
        let mapName = req.body.mapName || "Eden";
        // Résoudre l'alias si le nom est générique
        const mapNameLowerRaw = mapName.toLowerCase();
        if (mapAliases[mapNameLowerRaw]) {
            mapName = mapAliases[mapNameLowerRaw];
        }
        const mapNameLower = mapName.toLowerCase();
        let mapSize = req.body.mapSize || 12800;
        
        // Recharger les tailles de cartes pour prendre en compte les changements à chaud
        loadMapSizes();
        
        for (const [key, size] of Object.entries(mapSizes)) {
            if (mapNameLower.includes(key.toLowerCase())) {
                mapSize = size;
                break;
            }
        }

        serverData.map = {
            mapName: mapName,
            mapSize: mapSize,
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
        sessionConnections.add(nomJoueur); // Compteur de session
        await logSystemEvent("connexion", nomJoueur, `A rejoint la zone (Faction: ${faction || 'Inconnue'})`);

        // Alerte watchlist si le joueur est surveillé
        try {
            const surveille = await isOnWatchlist(nomJoueur);
            if (surveille) {
                envoyerLogDiscord(
                    "🚨 ALERTE WATCHLIST",
                    `⚠️ Le joueur surveillé **${nomJoueur}** vient de se connecter !`,
                    16753920 // Orange
                );
            }
        } catch (e) {
            console.error(`❌ Erreur lors de la vérification watchlist pour ${nomJoueur}:`, e.message);
        }
        
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
                    if (currentSessionId) {
                        await incrementSessionPlayerStat(currentSessionId, nomJoueur, 'playtime', elapsedSeconds);
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
        let nomTueur = killer ? killer.trim() : "";
        await checkAndRegisterPlayer(nomJoueur);
        await checkAndRegisterPlayer(nomTueur);

        // Extraire les coordonnées géographiques du détail si présentes
        let coordonnees = null;
        let detailNettoye = detail || "";
        const coordMatch = detailNettoye.match(/@\s*([0-9.]+)\s*,\s*([0-9.]+)/);
        if (coordMatch) {
            coordonnees = { x: parseFloat(coordMatch[1]), y: parseFloat(coordMatch[2]) };
            detailNettoye = detailNettoye.replace(/\s*@\s*[0-9.]+,\s*[0-9.]+/, '').trim();
        }

        let isTK = false;
        if (nomTueur && nomTueur !== "IA / Bot" && nomTueur !== nomJoueur && nomTueur !== "Lui-meme" && nomTueur !== "Un sifflement dans le noir" && killerFaction && faction && killerFaction === faction && killerFaction !== "Inconnue") {
            isTK = true;
        }

        serverData.killfeed.unshift({ horaire: new Date().toISOString(), message: isTK ? `⚠️ [TEAMKILL] ${detailNettoye}` : `💀 ${detailNettoye}` });
        if (serverData.killfeed.length > 30) serverData.killfeed.pop();

        // Incrémenter les compteurs de session
        sessionKillCount++;
        if (isTK) sessionTKCount++;

        // ---- ENREGISTREMENT DES STATS DANS LA BASE DE DONNÉES ----
        if (nomJoueur && leaderboard[nomJoueur]) {
            leaderboard[nomJoueur].morts += 1;
            await addDeath(nomJoueur);
            if (currentSessionId) {
                await incrementSessionPlayerStat(currentSessionId, nomJoueur, 'deaths', 1);
            }
        }
        
        if (isTK) {
            if (nomTueur && leaderboard[nomTueur]) {
                leaderboard[nomTueur].teamkills += 1;
                await addTeamkill(nomTueur);
                if (currentSessionId) {
                    await incrementSessionPlayerStat(currentSessionId, nomTueur, 'teamkills', 1);
                }

                // Incrément session TK et alerte critique
                sessionTeamkills[nomTueur] = (sessionTeamkills[nomTueur] || 0) + 1;
                if (sessionTeamkills[nomTueur] >= 3) {
                    envoyerLogDiscord(
                        "🚨 ALERTE ANTI-GRIEFING (TEAMKILLS)",
                        `⚠️ **@here Le joueur ${nomTueur} a commis ${sessionTeamkills[nomTueur]} teamkills en session !**`,
                        16753920
                    );
                }
            }
        } else {
            if (nomTueur && leaderboard[nomTueur] && nomTueur !== "IA / Bot" && nomTueur !== nomJoueur) {
                leaderboard[nomTueur].kills += 1;
                await addKill(nomTueur);
                if (currentSessionId) {
                    await incrementSessionPlayerStat(currentSessionId, nomTueur, 'kills', 1);
                }
            }
        }

        // Log Admin Discord
        let typeTirNettoye = typeTir || "Inconnu";
        if (typeTirNettoye.includes("Character_")) typeTirNettoye = "Corps à Corps 🥊";

        // Sauvegarder les coordonnées dans le log système pour la heatmap
        let logMessage = `A éliminé ${nomJoueur} (${typeTirNettoye})`;
        if (coordonnees) {
            logMessage += ` @ ${coordonnees.x},${coordonnees.y}`;
        }
        await logSystemEvent(isTK ? "teamkill" : "kill", nomTueur || "Inconnu", logMessage);

        envoyerLogDiscord(isTK ? "⚠️ Tir Fratricide" : "⚔️ Engagement Neutre", isTK ? "Alerte de tir fratricide !" : "Rapport d'élimination.", isTK ? 16753920 : 3447003, [
            { name: "Victime", value: `💀 **${nomJoueur}**`, inline: true },
            { name: "Tueur", value: `🔫 **${nomTueur}**`, inline: true },
            { name: "Dégâts", value: `📊 ${typeTirNettoye}`, inline: false }
        ]);
    }

    if (type === "chat") {
        let channelName = killer || "Global";
        let message = (typeTir || "").trim();
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

        // --- COMMANDES DE CHAT IN-GAME ---
        if (message.startsWith("!")) {
            const args = message.split(" ");
            const command = args[0].toLowerCase();
            const targetPlayer = player; // L'expéditeur du message

            if (command === "!ping") {
                pendingCommands.push(`warn:${targetPlayer}:Pong ! 🏓`);
            }
            else if (command === "!stats") {
                let searchedName = targetPlayer;
                if (args.length > 1) {
                    searchedName = args.slice(1).join(" ").trim();
                }

                if (!currentSessionId) {
                    pendingCommands.push(`warn:${targetPlayer}:Aucune session active sur le serveur.`);
                } else {
                    try {
                        const sessionStats = await getSessionPlayerStats(currentSessionId);
                        const pStats = sessionStats.find(s => s.player_name.toLowerCase() === searchedName.toLowerCase());

                        if (pStats) {
                            const kills = pStats.kills || 0;
                            const deaths = pStats.deaths || 0;
                            const ratio = deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2);
                            const captures = pStats.captures || 0;
                            const playtimeStr = formaterTempsJeu(pStats.playtime || 0);

                            const statsMsg = `📈 Session : ⚔️ ${kills} Kills | 💀 ${deaths} Morts | 📊 Ratio ${ratio} | 🚩 ${captures} Caps | 🕒 ${playtimeStr}`;
                            pendingCommands.push(`warn:${targetPlayer}:${statsMsg}`);
                        } else {
                            pendingCommands.push(`warn:${targetPlayer}:Aucune donnée de session pour "${searchedName}" pour le moment.`);
                        }
                    } catch (err) {
                        console.error("❌ Erreur de récupération des stats de session :", err.message);
                        pendingCommands.push(`warn:${targetPlayer}:Erreur de liaison satellite.`);
                    }
                }
            }
            else if (command === "!aide" || command === "!help") {
                const aideMsg = `Dispo : !stats (vos stats) | !stats [nom] (stats d'un joueur) | !ping`;
                pendingCommands.push(`warn:${targetPlayer}:${aideMsg}`);
            }
        }
    }

    if (type === "capture") {
        let baseName = player || "Base";
        let newFaction = faction || "Inconnue";
        let prevFaction = killer || "Aucune";
        
        let capturers = [];
        
        // Calcul de proximité des joueurs pour créditer la capture
        if (serverData.map && Array.isArray(serverData.map.bases) && Array.isArray(serverData.map.players)) {
            const baseObj = serverData.map.bases.find(b => b.name && b.name.toLowerCase() === baseName.toLowerCase());
            if (baseObj) {
                const baseX = parseFloat(baseObj.x);
                const baseY = parseFloat(baseObj.y);
                
                for (const p of serverData.map.players) {
                    let pFaction = p.faction || "";
                    if (pFaction === "USSR") pFaction = "URSS";
                    let capFaction = newFaction;
                    if (capFaction === "USSR") capFaction = "URSS";
                    
                    if (pFaction === capFaction && p.name) {
                        const px = parseFloat(p.x);
                        const py = parseFloat(p.y);
                        if (!isNaN(baseX) && !isNaN(baseY) && !isNaN(px) && !isNaN(py)) {
                            const dist = Math.sqrt(Math.pow(px - baseX, 2) + Math.pow(py - baseY, 2));
                            if (dist <= 250) { // Rayon de 250m autour de la base
                                const name = p.name.trim();
                                await checkAndRegisterPlayer(name);
                                if (leaderboard[name]) {
                                    leaderboard[name].captures += 1;
                                    await addCapture(name);
                                    if (currentSessionId) {
                                        await incrementSessionPlayerStat(currentSessionId, name, 'captures', 1);
                                    }
                                    capturers.push(name);
                                    console.log(`🚩 [CAPTURE] ${name} crédité pour la base ${baseName} (distance: ${Math.round(dist)}m)`);
                                }
                            }
                        }
                    }
                }
            }
        }
        
        let msgLog = `La base de ${baseName} a été capturée par les forces de ${newFaction} (auparavant contrôlée par ${prevFaction}).`;
        if (capturers.length > 0) {
            msgLog += ` Opérateurs sur zone : ${capturers.join(', ')}.`;
        }

        serverData.killfeed.unshift({
            horaire: new Date().toISOString(),
            message: `🚩 [CAPTURE] ${baseName} capturée par ${newFaction === 'US' ? 'OTAN' : newFaction === 'USSR' ? 'URSS' : 'FIA'}.${capturers.length > 0 ? ' Zone sécurisée par : ' + capturers.join(', ') : ''}`
        });
        if (serverData.killfeed.length > 30) serverData.killfeed.pop();

        await logSystemEvent("capture", capturers.length > 0 ? capturers.join(', ') : null, msgLog);

        // Envoi alerte Discord
        let couleurEmbed = 10066329; // Gris
        if (newFaction === "US") couleurEmbed = 3066993; // Bleu US
        else if (newFaction === "USSR") couleurEmbed = 15158332; // Rouge URSS

        const fields = [];
        if (capturers.length > 0) {
            fields.push({ name: "🎖️ Opérateurs sur zone", value: capturers.map(name => `🪖 **${name}**`).join('\n'), inline: false });
        }

        envoyerLogDiscord(
            "🚩 Base Stratégique Capturée",
            `La base de **${baseName}** a été capturée par les forces de **${newFaction === 'US' ? 'OTAN 🇺🇸' : newFaction === 'USSR' ? 'URSS ☭' : 'FIA 🔰'}**.\n*(Auparavant contrôlée par : ${prevFaction})*`,
            couleurEmbed,
            fields
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
                        if (currentSessionId) {
                            await incrementSessionPlayerStat(currentSessionId, name, 'vehicles_destroyed', 1);
                        }
                    }
                }
            }
        }
    }

    serverData.joueursCount = serverData.equipes.US.length + serverData.equipes.URSS.length + (serverData.equipes.FIA ? serverData.equipes.FIA.length : 0);
    const cmds = [...pendingCommands];
    pendingCommands = [];
    res.status(200).send({ message: "OK", commands: cmds });
});

// --- ROUTE 2 : STATS POUR LE SITE WEB ---
app.get('/api/stats', (req, res) => {
    res.json({
        server: {
            ...serverData,
            currentSessionId: currentSessionId
        },
        leaderboard: leaderboard
    });
});

app.get('/api/sessions', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 30;
        const sessions = await getGameSessions(limit);
        res.json(sessions);
    } catch (err) {
        console.error("❌ Erreur lors de la récupération des sessions :", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sessions/:id/players', async (req, res) => {
    try {
        const sessionId = parseInt(req.params.id);
        if (isNaN(sessionId)) {
            return res.status(400).json({ error: "ID de session invalide" });
        }
        const players = await getSessionPlayerStats(sessionId);
        res.json(players);
    } catch (err) {
        console.error("❌ Erreur lors de la récupération des joueurs de la session :", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sessions/:id/timeline', async (req, res) => {
    try {
        const sessionId = parseInt(req.params.id);
        if (isNaN(sessionId)) {
            return res.status(400).json({ error: "ID de session invalide" });
        }
        const timeline = await getSessionTimeline(sessionId);
        
        // Normaliser les dates pour forcer le format ISO UTC (notamment pour SQLite)
        const formattedTimeline = timeline.map(log => ({
            ...log,
            created_at: normaliserDate(log.created_at)
        }));
        
        res.json(formattedTimeline);
    } catch (err) {
        console.error("❌ Erreur lors de la récupération de la timeline de session :", err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- ROUTE DU CLASSEMENT HEBDOMADAIRE ---
app.get('/api/leaderboard/weekly', async (req, res) => {
    try {
        const weeklyData = await getWeeklyLeaderboard();
        res.json(weeklyData);
    } catch (err) {
        console.error("❌ Erreur lors de la récupération du classement hebdomadaire :", err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- ROUTE POUR LA FICHE PROFIL PUBLIQUE D'UN JOUEUR ---
app.get('/api/players/:name', async (req, res) => {
    try {
        const playerName = req.params.name;
        
        // 1. Récupérer le profil du joueur
        const profile = await getPlayerProfile(playerName);
        if (!profile || !profile.stats) {
            return res.status(404).json({ error: "Joueur non trouvé" });
        }
        
        const stats = profile.stats;
        
        // 2. Calculer le grade militaire
        const kills = stats.kills || 0;
        let grade = "Recrue";
        let gradeIcon = "🪖";
        if (kills >= 2000) {
            grade = "Général d'Armée";
            gradeIcon = "⭐⭐⭐⭐⭐";
        } else if (kills >= 1000) {
            grade = "Major";
            gradeIcon = "👑";
        } else if (kills >= 500) {
            grade = "Capitaine";
            gradeIcon = "⚓";
        } else if (kills >= 250) {
            grade = "Lieutenant";
            gradeIcon = "⚡";
        } else if (kills >= 100) {
            grade = "Sergent";
            gradeIcon = "🛡️";
        } else if (kills >= 30) {
            grade = "Caporal";
            gradeIcon = "🎖️";
        } else if (kills >= 10) {
            grade = "Soldat de 1ère classe";
            gradeIcon = "🔰";
        } else if (kills > 0) {
            grade = "Soldat de 2ème classe";
            gradeIcon = "🪖";
        }
        
        // 3. Badges / Titres honorifiques
        const badges = [];
        const playtimeHours = (stats.playtime || 0) / 3600;
        const kd = stats.deaths > 0 ? (stats.kills / stats.deaths) : stats.kills;
        
        if (stats.vehicles_destroyed >= 5) {
            badges.push({ name: "Briseur de Blindés", icon: "💥", desc: "A détruit plus de 5 véhicules ennemis." });
        }
        if (stats.captures >= 10) {
            badges.push({ name: "Conquérant", icon: "🚩", desc: "A capturé plus de 10 zones." });
        }
        if (kills >= 50 && kd >= 2.0) {
            badges.push({ name: "Survivant d'Élite", icon: "💀", desc: "Ratio K/D supérieur à 2.0 avec plus de 50 kills." });
        }
        if (playtimeHours >= 20) {
            badges.push({ name: "Vétéran", icon: "⏳", desc: "Plus de 20 heures passées sur le champ de bataille." });
        }
        if (stats.teamkills === 0 && kills >= 30) {
            badges.push({ name: "Frère d'Armes Idéal", icon: "🤝", desc: "Zéro tir fratricide sur plus de 30 éliminations." });
        }
        if (kills >= 500) {
            badges.push({ name: "Terreur Tactique", icon: "🔥", desc: "Plus de 500 éliminations au compteur." });
        }
        
        // 4. Calcul des armes favorites via getPlayerKillsDetails
        const killLogs = await getPlayerKillsDetails(playerName);
        const weaponCounts = {};
        killLogs.forEach(log => {
            const match = log.details.match(/\(([^)]+)\)/);
            if (match && match[1]) {
                const weapon = match[1].trim();
                weaponCounts[weapon] = (weaponCounts[weapon] || 0) + 1;
            }
        });
        
        const favoriteWeapons = Object.entries(weaponCounts)
            .filter(entry => {
                const wName = entry[0].toLowerCase();
                return !wName.includes("suicide") && 
                       !wName.includes("chute") && 
                       !wName.includes("environnement") && 
                       !wName.includes("inconnu") &&
                       !wName.includes("collision") &&
                       !wName.includes("accident");
            })
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(entry => ({ name: entry[0], kills: entry[1] }));

        // 5. Activités récentes publiques (uniquement kills, captures, véhicules détruits)
        const recentActivities = (profile.recent_logs || []).filter(log => 
            ['kill', 'teamkill', 'capture', 'vehicle_destroyed'].includes(log.event_type)
        ).slice(0, 10).map(log => ({
            event_type: log.event_type,
            details: log.details,
            created_at: normaliserDate(log.created_at)
        }));

        res.json({
            stats: {
                player_name: stats.player_name,
                playtime: stats.playtime,
                kills: stats.kills,
                deaths: stats.deaths || stats.morts || 0,
                teamkills: stats.teamkills,
                captures: stats.captures,
                vehicles_destroyed: stats.vehicles_destroyed
            },
            grade,
            gradeIcon,
            badges,
            favoriteWeapons,
            recentActivities
        });
    } catch (err) {
        console.error("❌ Erreur lors de la récupération de la fiche publique du joueur :", err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- ROUTES ADMIN POUR LES LOGS ET LES METRIQUES ---
app.get('/api/admin/logs', async (req, res) => {
    const { password, limit, filter, search, startDate, endDate } = req.query;
    if (password !== "admin") {
        return res.status(403).json({ error: "Mot de passe admin invalide" });
    }
    try {
        const limitInt = parseInt(limit) || 100;
        const logs = await getLogs(limitInt, filter || "All", search || "", startDate || "", endDate || "");
        
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

// --- ROUTES ADMIN POUR LES PEAKS ET SANCTIONS GENERALES ---
app.get('/api/admin/stats-summary', async (req, res) => {
    const { password } = req.query;
    if (password !== "admin") {
        return res.status(403).json({ error: "Mot de passe admin invalide" });
    }
    try {
        const peaks = await getPeakPlayers();
        const peakHours = await getPeakHours();
        res.json({ peaks, peakHours });
    } catch (err) {
        console.error("❌ Erreur lors de la récupération du résumé de stats :", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/sanctions-history', async (req, res) => {
    const { password, limit } = req.query;
    if (password !== "admin") {
        return res.status(403).json({ error: "Mot de passe admin invalide" });
    }
    try {
        const limitInt = parseInt(limit) || 100;
        const sanctions = await getAllSanctions(limitInt);
        const formatted = sanctions.map(s => ({ ...s, created_at: normaliserDate(s.created_at) }));
        res.json(formatted);
    } catch (err) {
        console.error("❌ Erreur lors de la récupération de l'historique des sanctions :", err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- ROUTE ADMIN : QUEUE DES COMMANDES RCON ---
app.post('/api/admin/command', async (req, res) => {
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

    // Enregistrer la sanction automatiquement
    try {
        if (action === "kick" && target) {
            await addSanction(target, 'kick', 'Kicked via RCON');
        } else if (action === "warn" && target) {
            await addSanction(target, 'warn', message || 'Avertissement admin');
        }
    } catch (e) {
        console.error(`❌ Erreur lors de l'enregistrement de la sanction :`, e.message);
    }

    res.json({ status: "success", command: cmdString });
});

// --- Fonction utilitaire : normalisation des dates (SQLite => ISO) ---
function normaliserDate(dateVal) {
    if (typeof dateVal === 'string' && !dateVal.includes('T') && !dateVal.includes('Z')) {
        return dateVal.replace(' ', 'T') + 'Z';
    }
    return typeof dateVal === 'string' ? dateVal : dateVal.toISOString();
}

// --- ROUTES ADMIN : PROFIL JOUEUR, NOTES, WATCHLIST, SANCTIONS ---

// Profil complet d'un joueur
app.get('/api/admin/player/:name', async (req, res) => {
    const { password } = req.query;
    if (password !== "admin") {
        return res.status(403).json({ error: "Mot de passe admin invalide" });
    }
    try {
        const profile = await getPlayerProfile(req.params.name);
        // Normaliser les dates dans logs, notes et sanctions
        if (profile.logs) {
            profile.logs = profile.logs.map(l => ({ ...l, created_at: normaliserDate(l.created_at) }));
        }
        if (profile.notes) {
            profile.notes = profile.notes.map(n => ({ ...n, created_at: normaliserDate(n.created_at) }));
        }
        if (profile.sanctions) {
            profile.sanctions = profile.sanctions.map(s => ({ ...s, created_at: normaliserDate(s.created_at) }));
        }
        res.json(profile);
    } catch (err) {
        console.error("❌ Erreur lors de la récupération du profil joueur :", err.message);
        res.status(500).json({ error: err.message });
    }
});

// Ajouter une note
app.post('/api/admin/notes', async (req, res) => {
    const { password, player_name, note } = req.body;
    if (password !== "admin") {
        return res.status(403).json({ error: "Mot de passe admin invalide" });
    }
    if (!player_name || !note) {
        return res.status(400).json({ error: "player_name et note sont requis" });
    }
    try {
        await addNote(player_name, note);
        res.json({ status: "success" });
    } catch (err) {
        console.error("❌ Erreur lors de l'ajout de la note :", err.message);
        res.status(500).json({ error: err.message });
    }
});

// Récupérer les notes d'un joueur
app.get('/api/admin/notes/:player', async (req, res) => {
    const { password } = req.query;
    if (password !== "admin") {
        return res.status(403).json({ error: "Mot de passe admin invalide" });
    }
    try {
        const notes = await getNotes(req.params.player);
        const formatted = notes.map(n => ({ ...n, created_at: normaliserDate(n.created_at) }));
        res.json(formatted);
    } catch (err) {
        console.error("❌ Erreur lors de la récupération des notes :", err.message);
        res.status(500).json({ error: err.message });
    }
});

// Récupérer la watchlist
app.get('/api/admin/watchlist', async (req, res) => {
    const { password } = req.query;
    if (password !== "admin") {
        return res.status(403).json({ error: "Mot de passe admin invalide" });
    }
    try {
        const list = await getWatchlist();
        const formatted = list.map(w => ({ ...w, created_at: normaliserDate(w.created_at) }));
        res.json(formatted);
    } catch (err) {
        console.error("❌ Erreur lors de la récupération de la watchlist :", err.message);
        res.status(500).json({ error: err.message });
    }
});

// Ajouter un joueur à la watchlist
app.post('/api/admin/watchlist', async (req, res) => {
    const { password, player_name, reason } = req.body;
    if (password !== "admin") {
        return res.status(403).json({ error: "Mot de passe admin invalide" });
    }
    if (!player_name) {
        return res.status(400).json({ error: "player_name est requis" });
    }
    try {
        await addToWatchlist(player_name, reason || null);
        res.json({ status: "success" });
    } catch (err) {
        console.error("❌ Erreur lors de l'ajout à la watchlist :", err.message);
        res.status(500).json({ error: err.message });
    }
});

// Retirer un joueur de la watchlist
app.delete('/api/admin/watchlist/:player', async (req, res) => {
    const { password } = req.query;
    if (password !== "admin") {
        return res.status(403).json({ error: "Mot de passe admin invalide" });
    }
    try {
        await removeFromWatchlist(req.params.player);
        res.json({ status: "success" });
    } catch (err) {
        console.error("❌ Erreur lors du retrait de la watchlist :", err.message);
        res.status(500).json({ error: err.message });
    }
});

// Récupérer les sanctions d'un joueur
app.get('/api/admin/sanctions/:player', async (req, res) => {
    const { password } = req.query;
    if (password !== "admin") {
        return res.status(403).json({ error: "Mot de passe admin invalide" });
    }
    try {
        const sanctions = await getSanctions(req.params.player);
        const formatted = sanctions.map(s => ({ ...s, created_at: normaliserDate(s.created_at) }));
        res.json(formatted);
    } catch (err) {
        console.error("❌ Erreur lors de la récupération des sanctions :", err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- DÉMARRAGE ASYNCHRONE ---
(async () => {
    try {
        await initDatabase();
        leaderboard = await getLeaderboardObject();
        
        // Résilience aux redémarrages de l'API (Render) : Restauration de la session active
        try {
            const activeSession = await getActiveSession();
            if (activeSession) {
                currentSessionId = activeSession.id;
                estPrecedemmentHorsLigne = false;
                serverData.status = "online";
                serverData.lastHeartbeat = Date.now(); // Initialiser pour éviter un timeout immédiat du watchdog
                console.log(`🎮 [SESSION RESTORED] ID: ${currentSessionId} (Map: ${activeSession.map_name})`);
            } else {
                console.log("🎮 Aucune session active à restaurer au démarrage.");
            }
        } catch (e) {
            console.error("❌ Impossible de restaurer la session active au démarrage :", e.message);
            try {
                await closeActiveSessionsOnBoot();
                console.log("🎮 Sessions actives précédentes fermées proprement en secours.");
            } catch (err) {
                console.error("❌ Impossible de fermer les sessions ouvertes en secours :", err.message);
            }
        }
        
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
                                if (currentSessionId) {
                                    await incrementSessionPlayerStat(currentSessionId, player, 'playtime', elapsedSeconds);
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
                    if (currentSessionId) {
                        try {
                            await endSession(currentSessionId, sessionConnections.size, sessionKillCount, sessionTKCount);
                            console.log(`🎮 [SESSION ENDED BY WATCHDOG] ID: ${currentSessionId} updated in DB.`);
                            currentSessionId = null;
                        } catch (e) {
                            console.error("❌ Erreur d'enregistrement de fin de session par watchdog :", e.message);
                        }
                    }

                    // Rapport de session avant notification Discord
                    if (sessionStartTime > 0) {
                        const dureeMs = maintenant - sessionStartTime;
                        const dureeMin = Math.round(dureeMs / 60000);
                        const heures = Math.floor(dureeMin / 60);
                        const minutes = dureeMin % 60;
                        envoyerLogDiscord(
                            "📊 Rapport de Session",
                            `La session est terminée après **${heures}h${minutes.toString().padStart(2, '0')}**.`,
                            3447003, // Bleu
                            [
                                { name: "👥 Connexions", value: `${sessionConnections.size} joueur(s)`, inline: true },
                                { name: "⚔️ Kills", value: `${sessionKillCount}`, inline: true },
                                { name: "⚠️ Teamkills", value: `${sessionTKCount}`, inline: true }
                            ]
                        );
                    }
                    
                    envoyerLogDiscord(
                        "⚠️ Signal Satellite Perdu",
                        "Le serveur Arma Reforger ne répond plus. Liaison interrompue.",
                        15158332 // Rouge
                    );
                }
            }
        }, 10000);

        // Enregistrement périodique des métriques, rafraîchissement Discord et stats hebdo
        setInterval(async () => {
            await enregistrerMetriqueSiBesoin();
            await rafraichirSalonCompteur();
            await actualiserDiscordWeeklyStats();
        }, 60000);

        app.listen(PORT, () => console.log(`🤖 Cerveau V2 connecté sur le port ${PORT}`));
    } catch (err) {
        console.error("❌ Impossible de démarrer le serveur API :", err);
        process.exit(1);
    }
})();