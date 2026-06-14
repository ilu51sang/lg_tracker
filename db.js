const fs = require('fs');
const path = require('path');

let isMysql = false;
let isPostgres = false;
let dbSqlite = null;
let mysqlPool = null;
let pgPool = null;

const DATABASE_URL = process.env.DATABASE_URL || "";

// Connexion dynamique selon l'environnement
if (process.env.DB_HOST || DATABASE_URL.startsWith('mysql://')) {
    isMysql = true;
    const mysql = require('mysql2/promise');
    let config = {};
    
    if (DATABASE_URL.startsWith('mysql://')) {
        try {
            const url = new URL(DATABASE_URL);
            config = {
                host: url.hostname,
                port: parseInt(url.port) || 3306,
                user: url.username,
                password: decodeURIComponent(url.password),
                database: url.pathname.substring(1),
                waitForConnections: true,
                connectionLimit: 10,
                queueLimit: 0
            };
        } catch (err) {
            console.error("❌ Erreur de parsing DATABASE_URL pour MySQL, tentative avec variables séparées :", err.message);
            config = {
                host: process.env.DB_HOST,
                port: parseInt(process.env.DB_PORT) || 3306,
                user: process.env.DB_USER,
                password: process.env.DB_PASSWORD,
                database: process.env.DB_NAME,
                waitForConnections: true,
                connectionLimit: 10,
                queueLimit: 0
            };
        }
    } else {
        config = {
            host: process.env.DB_HOST,
            port: parseInt(process.env.DB_PORT) || 3306,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        };
    }
    
    mysqlPool = mysql.createPool(config);
    console.log(`🔌 Connecté à la base de données cloud MySQL (Hôte: ${config.host}:${config.port}, DB: ${config.database})`);
} else if (DATABASE_URL.startsWith('postgres://') || DATABASE_URL.startsWith('postgresql://')) {
    isPostgres = true;
    const { Pool } = require('pg');
    pgPool = new Pool({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: false } // Requis pour Supabase/Render en production
    });
    console.log("🔌 Connecté à la base de données cloud PostgreSQL (Supabase)");
} else {
    const Database = require('better-sqlite3');
    const DB_FILE = path.join(__dirname, 'database.sqlite');
    dbSqlite = new Database(DB_FILE);
    console.log("🔌 Connecté à la base de données locale SQLite");
}

async function initDatabase() {
    const query = `
        CREATE TABLE IF NOT EXISTS leaderboard (
            player_name VARCHAR(255) PRIMARY KEY,
            kills INTEGER NOT NULL DEFAULT 0,
            deaths INTEGER NOT NULL DEFAULT 0,
            teamkills INTEGER NOT NULL DEFAULT 0,
            captures INTEGER NOT NULL DEFAULT 0,
            vehicles_destroyed INTEGER NOT NULL DEFAULT 0,
            playtime INTEGER NOT NULL DEFAULT 0,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `;

    if (isMysql) {
        await mysqlPool.query(query);
        try { await mysqlPool.query("ALTER TABLE leaderboard ADD COLUMN teamkills INTEGER NOT NULL DEFAULT 0;"); } catch(e){}
        try { await mysqlPool.query("ALTER TABLE leaderboard ADD COLUMN captures INTEGER NOT NULL DEFAULT 0;"); } catch(e){}
        try { await mysqlPool.query("ALTER TABLE leaderboard ADD COLUMN vehicles_destroyed INTEGER NOT NULL DEFAULT 0;"); } catch(e){}
        try { await mysqlPool.query("ALTER TABLE leaderboard ADD COLUMN playtime INTEGER NOT NULL DEFAULT 0;"); } catch(e){}
    } else if (isPostgres) {
        await pgPool.query(query);
        try { await pgPool.query("ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS teamkills INTEGER NOT NULL DEFAULT 0;"); } catch(e){}
        try { await pgPool.query("ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS captures INTEGER NOT NULL DEFAULT 0;"); } catch(e){}
        try { await pgPool.query("ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS vehicles_destroyed INTEGER NOT NULL DEFAULT 0;"); } catch(e){}
        try { await pgPool.query("ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS playtime INTEGER NOT NULL DEFAULT 0;"); } catch(e){}
    } else {
        dbSqlite.exec(query);
        try { dbSqlite.exec("ALTER TABLE leaderboard ADD COLUMN teamkills INTEGER NOT NULL DEFAULT 0;"); } catch(e){}
        try { dbSqlite.exec("ALTER TABLE leaderboard ADD COLUMN captures INTEGER NOT NULL DEFAULT 0;"); } catch(e){}
        try { dbSqlite.exec("ALTER TABLE leaderboard ADD COLUMN vehicles_destroyed INTEGER NOT NULL DEFAULT 0;"); } catch(e){}
        try { dbSqlite.exec("ALTER TABLE leaderboard ADD COLUMN playtime INTEGER NOT NULL DEFAULT 0;"); } catch(e){}
        await migrateFromLegacyJsonIfNeeded();
    }
}

async function migrateFromLegacyJsonIfNeeded() {
    const count = dbSqlite.prepare('SELECT COUNT(*) AS total FROM leaderboard').get().total;
    if (count > 0) return;
    const LEGACY_JSON_FILE = path.join(__dirname, 'database.json');
    if (!fs.existsSync(LEGACY_JSON_FILE)) return;

    let legacyData = {};
    try {
        legacyData = JSON.parse(fs.readFileSync(LEGACY_JSON_FILE, 'utf-8'));
    } catch (err) {
        console.error('❌ Impossible de lire database.json pour migration:', err.message);
        return;
    }

    const insert = dbSqlite.prepare(`
        INSERT OR REPLACE INTO leaderboard (player_name, kills, deaths, teamkills, captures, vehicles_destroyed, updated_at)
        VALUES (@player_name, @kills, @deaths, 0, 0, 0, CURRENT_TIMESTAMP)
    `);

    const transaction = dbSqlite.transaction((entries) => {
        for (const [playerName, stats] of entries) {
            insert.run({
                player_name: playerName,
                kills: Number(stats?.kills || 0),
                deaths: Number(stats?.morts || 0)
            });
        }
    });

    try {
        transaction(Object.entries(legacyData));
        console.log('✅ Migration initiale database.json -> SQLite terminée.');
    } catch (err) {
        console.error('❌ Erreur pendant la migration JSON -> SQLite:', err.message);
    }
}

async function getLeaderboardObject() {
    const leaderboard = {};
    const sql = 'SELECT player_name, kills, deaths, teamkills, captures, vehicles_destroyed, playtime FROM leaderboard';

    if (isMysql) {
        const [rows] = await mysqlPool.query(sql);
        for (const row of rows) {
            leaderboard[row.player_name] = {
                kills: row.kills,
                morts: row.deaths,
                teamkills: row.teamkills,
                captures: row.captures,
                vehicles_destroyed: row.vehicles_destroyed,
                playtime: row.playtime || 0
            };
        }
    } else if (isPostgres) {
        const res = await pgPool.query(sql);
        for (const row of res.rows) {
            leaderboard[row.player_name] = {
                kills: row.kills,
                morts: row.deaths,
                teamkills: row.teamkills,
                captures: row.captures,
                vehicles_destroyed: row.vehicles_destroyed,
                playtime: row.playtime || 0
            };
        }
    } else {
        const rows = dbSqlite.prepare(sql).all();
        for (const row of rows) {
            leaderboard[row.player_name] = {
                kills: row.kills,
                morts: row.deaths,
                teamkills: row.teamkills,
                captures: row.captures,
                vehicles_destroyed: row.vehicles_destroyed,
                playtime: row.playtime || 0
            };
        }
    }

    return leaderboard;
}

async function ensurePlayer(playerName) {
    if (isMysql) {
        await mysqlPool.query(`
            INSERT IGNORE INTO leaderboard (player_name, kills, deaths, teamkills, captures, vehicles_destroyed, updated_at)
            VALUES (?, 0, 0, 0, 0, 0, CURRENT_TIMESTAMP)
        `, [playerName]);
    } else if (isPostgres) {
        await pgPool.query(`
            INSERT INTO leaderboard (player_name, kills, deaths, teamkills, captures, vehicles_destroyed, updated_at)
            VALUES ($1, 0, 0, 0, 0, 0, CURRENT_TIMESTAMP)
            ON CONFLICT (player_name) DO NOTHING
        `, [playerName]);
    } else {
        dbSqlite.prepare(`
            INSERT OR IGNORE INTO leaderboard (player_name, kills, deaths, teamkills, captures, vehicles_destroyed, updated_at)
            VALUES (?, 0, 0, 0, 0, 0, CURRENT_TIMESTAMP)
        `).run(playerName);
    }
}

async function addKill(playerName) {
    if (isMysql) {
        await mysqlPool.query(`
            UPDATE leaderboard
            SET kills = kills + 1, updated_at = CURRENT_TIMESTAMP
            WHERE player_name = ?
        `, [playerName]);
    } else if (isPostgres) {
        await pgPool.query(`
            UPDATE leaderboard
            SET kills = kills + 1, updated_at = CURRENT_TIMESTAMP
            WHERE player_name = $1
        `, [playerName]);
    } else {
        dbSqlite.prepare(`
            UPDATE leaderboard
            SET kills = kills + 1, updated_at = CURRENT_TIMESTAMP
            WHERE player_name = ?
        `).run(playerName);
    }
}

async function addDeath(playerName) {
    if (isMysql) {
        await mysqlPool.query(`
            UPDATE leaderboard
            SET deaths = deaths + 1, updated_at = CURRENT_TIMESTAMP
            WHERE player_name = ?
        `, [playerName]);
    } else if (isPostgres) {
        await pgPool.query(`
            UPDATE leaderboard
            SET deaths = deaths + 1, updated_at = CURRENT_TIMESTAMP
            WHERE player_name = $1
        `, [playerName]);
    } else {
        dbSqlite.prepare(`
            UPDATE leaderboard
            SET deaths = deaths + 1, updated_at = CURRENT_TIMESTAMP
            WHERE player_name = ?
        `).run(playerName);
    }
}

async function addTeamkill(playerName) {
    if (isMysql) {
        await mysqlPool.query(`
            UPDATE leaderboard
            SET teamkills = teamkills + 1, updated_at = CURRENT_TIMESTAMP
            WHERE player_name = ?
        `, [playerName]);
    } else if (isPostgres) {
        await pgPool.query(`
            UPDATE leaderboard
            SET teamkills = teamkills + 1, updated_at = CURRENT_TIMESTAMP
            WHERE player_name = $1
        `, [playerName]);
    } else {
        dbSqlite.prepare(`
            UPDATE leaderboard
            SET teamkills = teamkills + 1, updated_at = CURRENT_TIMESTAMP
            WHERE player_name = ?
        `).run(playerName);
    }
}

async function addCapture(playerName) {
    if (isMysql) {
        await mysqlPool.query(`
            UPDATE leaderboard
            SET captures = captures + 1, updated_at = CURRENT_TIMESTAMP
            WHERE player_name = ?
        `, [playerName]);
    } else if (isPostgres) {
        await pgPool.query(`
            UPDATE leaderboard
            SET captures = captures + 1, updated_at = CURRENT_TIMESTAMP
            WHERE player_name = $1
        `, [playerName]);
    } else {
        dbSqlite.prepare(`
            UPDATE leaderboard
            SET captures = captures + 1, updated_at = CURRENT_TIMESTAMP
            WHERE player_name = ?
        `).run(playerName);
    }
}

async function addVehicleDestroyed(playerName) {
    if (isMysql) {
        await mysqlPool.query(`
            UPDATE leaderboard
            SET vehicles_destroyed = vehicles_destroyed + 1, updated_at = CURRENT_TIMESTAMP
            WHERE player_name = ?
        `, [playerName]);
    } else if (isPostgres) {
        await pgPool.query(`
            UPDATE leaderboard
            SET vehicles_destroyed = vehicles_destroyed + 1, updated_at = CURRENT_TIMESTAMP
            WHERE player_name = $1
        `, [playerName]);
    } else {
        dbSqlite.prepare(`
            UPDATE leaderboard
            SET vehicles_destroyed = vehicles_destroyed + 1, updated_at = CURRENT_TIMESTAMP
            WHERE player_name = ?
        `).run(playerName);
    }
}

async function addPlaytime(playerName, seconds) {
    if (isMysql) {
        await mysqlPool.query(`
            UPDATE leaderboard
            SET playtime = playtime + ?, updated_at = CURRENT_TIMESTAMP
            WHERE player_name = ?
        `, [seconds, playerName]);
    } else if (isPostgres) {
        await pgPool.query(`
            UPDATE leaderboard
            SET playtime = playtime + $1, updated_at = CURRENT_TIMESTAMP
            WHERE player_name = $2
        `, [seconds, playerName]);
    } else {
        dbSqlite.prepare(`
            UPDATE leaderboard
            SET playtime = playtime + ?, updated_at = CURRENT_TIMESTAMP
            WHERE player_name = ?
        `).run(seconds, playerName);
    }
}

module.exports = {
    initDatabase,
    getLeaderboardObject,
    ensurePlayer,
    addKill,
    addDeath,
    addTeamkill,
    addCapture,
    addVehicleDestroyed,
    addPlaytime
};
