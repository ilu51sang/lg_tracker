# 🗃️ Profils de Configuration — LGTracker

Ce document sert à stocker toutes les clés et identifiants nécessaires pour basculer facilement entre ton environnement de **Test** et ton environnement de **Production (Serveur Principal)**.

---

## 📋 1. Variables d'Environnement (À configurer sur Render ou dans le fichier `.env`)

Voici la liste de toutes les variables nécessaires pour faire tourner l'API Node.js.

### 🔴 PROFIL : PRODUCTION (Serveur Principal)
*À renseigner sur le service Render de production.*

| Variable | Description / Exemple | Valeur à remplir |
| :--- | :--- | :--- |
| `DB_HOST` | Hôte MySQL de Serverse principal (ex: `78.40.111.158`) | |
| `DB_PORT` | Port MySQL de Serverse (ex: `20300`) | |
| `DB_USER` | Utilisateur MySQL principal | |
| `DB_PASSWORD` | Mot de passe MySQL principal | |
| `DB_NAME` | Nom de la base de données principale (ex: `s677_lg_tracker`) | |
| `BRIDGE_AUTH_TOKEN` | Clé secrète de liaison avec le serveur principal (ex: `MonTokenSuperSecuriseProd`) | |
| `DISCORD_WEBHOOK_URL` | Webhook Discord pour les logs de jeu et alertes du serveur principal | |
| `DISCORD_CHAT_WEBHOOK_URL` | Webhook Discord pour relayer le chat en jeu du serveur principal | |
| `DISCORD_BOT_TOKEN` | Token du Bot Discord principal pour modifier le compteur vocal | |
| `DISCORD_COMPTEUR_CHANNEL_ID` | ID du salon vocal compteur sur ton Discord de production | |

---

### 🟡 PROFIL : TEST (Serveur de Test)
*À renseigner sur le service Render de test (ou dans ton fichier `.env` local).*

| Variable | Description / Exemple | Valeur à remplir |
| :--- | :--- | :--- |
| `DB_HOST` | Hôte MySQL de Serverse test (ou vide si SQLite local) | |
| `DB_PORT` | Port MySQL de Serverse test (ou vide si SQLite local) | |
| `DB_USER` | Utilisateur MySQL de test | |
| `DB_PASSWORD` | Mot de passe MySQL de test | |
| `DB_NAME` | Nom de la base de données de test (ex: `s677_lg_tracker_test`) | |
| `BRIDGE_AUTH_TOKEN` | Clé secrète de liaison avec le serveur de test (ex: `TokenDeTest123`) | |
| `DISCORD_WEBHOOK_URL` | Webhook Discord pour les salons de test / dev | |
| `DISCORD_CHAT_WEBHOOK_URL` | Webhook Discord pour le chat de test | |
| `DISCORD_BOT_TOKEN` | Token du Bot Discord de test | |
| `DISCORD_COMPTEUR_CHANNEL_ID` | ID du salon vocal compteur sur ton Discord de test | |

---

## 🎮 2. Configuration du Mod Arma (`LGTrackerConfig.json` dans le dossier `$profile`)

Ce fichier indique au mod présent sur le serveur Arma où envoyer les données.

### 🔴 Sur le Serveur Principal (Production)
```json
{
  "m_UseLocalApiMode": true,
  "m_LocalApiBaseUrl": "https://lgtracker-api.onrender.com",
  "m_LocalApiPath": "/api/arma-event",
  "m_BridgeAuthToken": "METTRE_ICI_LE_BRIDGE_AUTH_TOKEN_DE_PROD"
}
```

### 🟡 Sur le Serveur de Test
```json
{
  "m_UseLocalApiMode": true,
  "m_LocalApiBaseUrl": "https://lgtracker-api-test.onrender.com",
  "m_LocalApiPath": "/api/arma-event",
  "m_BridgeAuthToken": "METTRE_ICI_LE_BRIDGE_AUTH_TOKEN_DE_TEST"
}
```
*(Remplace l'URL de base si tu utilises un autre hébergement ou le deuxième service Render de test).*
