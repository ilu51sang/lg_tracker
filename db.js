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

    // Initialisation des nouvelles tables V2
    let queryLogs = "";
    let queryMetrics = "";
    if (isMysql) {
        queryLogs = `
            CREATE TABLE IF NOT EXISTS system_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                event_type VARCHAR(50) NOT NULL,
                player_name VARCHAR(255),
                details TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `;
        queryMetrics = `
            CREATE TABLE IF NOT EXISTS server_metrics (
                id INT AUTO_INCREMENT PRIMARY KEY,
                player_count INT NOT NULL,
                us_count INT NOT NULL,
                ussr_count INT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `;
    } else if (isPostgres) {
        queryLogs = `
            CREATE TABLE IF NOT EXISTS system_logs (
                id SERIAL PRIMARY KEY,
                event_type VARCHAR(50) NOT NULL,
                player_name VARCHAR(255),
                details TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `;
        queryMetrics = `
            CREATE TABLE IF NOT EXISTS server_metrics (
                id SERIAL PRIMARY KEY,
                player_count INT NOT NULL,
                us_count INT NOT NULL,
                ussr_count INT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `;
    } else {
        queryLogs = `
            CREATE TABLE IF NOT EXISTS system_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type VARCHAR(50) NOT NULL,
                player_name VARCHAR(255),
                details TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `;
        queryMetrics = `
            CREATE TABLE IF NOT EXISTS server_metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                player_count INTEGER NOT NULL,
                us_count INTEGER NOT NULL,
                ussr_count INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `;
    }

    if (isMysql) {
        await mysqlPool.query(queryLogs);
        await mysqlPool.query(queryMetrics);
    } else if (isPostgres) {
        await pgPool.query(queryLogs);
        await pgPool.query(queryMetrics);
    } else {
        dbSqlite.exec(queryLogs);
        dbSqlite.exec(queryMetrics);
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

async function addLog(eventType, playerName, details) {
    if (isMysql) {
        await mysqlPool.query(
            'INSERT INTO system_logs (event_type, player_name, details) VALUES (?, ?, ?)',
            [eventType, playerName, details]
        );
    } else if (isPostgres) {
        await pgPool.query(
            'INSERT INTO system_logs (event_type, player_name, details) VALUES ($1, $2, $3)',
            [eventType, playerName, details]
        );
    } else {
        dbSqlite.prepare(
            'INSERT INTO system_logs (event_type, player_name, details) VALUES (?, ?, ?)'
        ).run(eventType, playerName, details);
    }
}

async function getLogs(limit = 100, filter = "All", search = "") {
    let sql = 'SELECT id, event_type, player_name, details, created_at FROM system_logs';
    let conditions = [];
    let params = [];

    if (filter && filter !== "All") {
        conditions.push('event_type = ?');
        params.push(filter);
    }

    if (search && search.trim() !== "") {
        const term = `%${search.trim()}%`;
        conditions.push('(player_name LIKE ? OR details LIKE ?)');
        params.push(term, term);
    }

    if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY id DESC LIMIT ?';
    params.push(limit);

    // Adapt params for PostgreSQL ($1, $2...)
    if (isPostgres) {
        let pgSql = sql;
        let index = 1;
        pgSql = pgSql.replace(/\?/g, () => `$${index++}`);
        const res = await pgPool.query(pgSql, params);
        return res.rows;
    } else if (isMysql) {
        const [rows] = await mysqlPool.query(sql, params);
        return rows;
    } else {
        return dbSqlite.prepare(sql).all(params);
    }
}

async function addMetric(playerCount, usCount, ussrCount) {
    if (isMysql) {
        await mysqlPool.query(
            'INSERT INTO server_metrics (player_count, us_count, ussr_count) VALUES (?, ?, ?)',
            [playerCount, usCount, ussrCount]
        );
    } else if (isPostgres) {
        await pgPool.query(
            'INSERT INTO server_metrics (player_count, us_count, ussr_count) VALUES ($1, $2, $3)',
            [playerCount, usCount, ussrCount]
        );
    } else {
        dbSqlite.prepare(
            'INSERT INTO server_metrics (player_count, us_count, ussr_count) VALUES (?, ?, ?)'
        ).run(playerCount, usCount, ussrCount);
    }
}

async function getMetrics(limit = 288) {
    const sql = 'SELECT id, player_count, us_count, ussr_count, created_at FROM server_metrics ORDER BY id DESC LIMIT ?';
    if (isPostgres) {
        const res = await pgPool.query(sql.replace('?', '$1'), [limit]);
        return res.rows.reverse();
    } else if (isMysql) {
        const [rows] = await mysqlPool.query(sql, [limit]);
        return rows.reverse();
    } else {
        const rows = dbSqlite.prepare(sql).all(limit);
        return rows.reverse();
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
    addPlaytime,
    addLog,
    getLogs,
    addMetric,
    getMetrics
};
