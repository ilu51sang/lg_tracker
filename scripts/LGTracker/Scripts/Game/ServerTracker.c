class TrackerCallback : RestCallback
{
	protected SCR_BaseGameMode m_GameMode;
	
	void SetGameMode(SCR_BaseGameMode gameMode)
	{
		m_GameMode = gameMode;
	}
	
	override void OnError(int errorCode) { Print("TRACKER : ❌ Erreur réseau."); }
	override void OnSuccess(string data, int dataSize)
	{
		Print("TRACKER : ✅ Envoyé. Reponse: " + data);
		if (m_GameMode && data != "")
		{
			m_GameMode.ProcessServerResponse(data);
		}
	}
}

modded class SCR_BaseGameMode
{
	// true: mode local API Node ou passerelle Cloudflare Worker, false: mode Discord direct
	protected bool m_UseLocalApiMode = true;

	// Local test / Cloudflare bridge mode
	protected string m_LocalApiBaseUrl = "http://localhost:3000";
	protected string m_LocalApiPath = "/api/arma-event";
	protected string m_BridgeAuthToken = "CHANGE_ME";

	// Discord direct mode (sauvegardé de manière externe pour la sécurité)
	protected string m_DiscordLogsWebhookPath = "";
	protected string m_DiscordCounterWebhookPath = "";
	protected int m_RenameCooldownMs = 120000;
	protected bool m_EnableHeartbeatLog = false;

	protected int m_CurrentPlayers = 0;
	protected int m_USPlayers = 0;
	protected int m_USSRPlayers = 0;
	protected int m_FIAPlayers = 0;
	protected int m_LastRenameTimestamp = 0;
	protected int m_LastAnnouncedPlayers = -1;
	protected bool m_ConfigLoaded = false;
	protected bool m_IsWorldCleaningUp = false;
	protected ref TrackerCallback m_TrackerCallback;

	protected string CleanString(string input)
	{
		string result = "";
		int len = input.Length();
		for (int i = 0; i < len; i++)
		{
			string charStr = input.Substring(i, 1);
			if (charStr != " " && charStr != "," && charStr != "\"" && charStr != "'" && charStr != "\r" && charStr != "\n")
			{
				result = result + charStr;
			}
		}
		return result;
	}

	protected string ReplaceString(string input, string sample, string replacement)
	{
		string result = "";
		int len = sample.Length();
		if (len == 0) return input;
		
		int pos = input.IndexOf(sample);
		while (pos != -1)
		{
			result = result + input.Substring(0, pos) + replacement;
			input = input.Substring(pos + len, input.Length() - pos - len);
			pos = input.IndexOf(sample);
		}
		return result + input;
	}

	protected string ExtractValue(string line, string key)
	{
		int colonIdx = line.IndexOf(":");
		if (colonIdx == -1) return "";
		
		string val = line.Substring(colonIdx + 1, line.Length() - colonIdx - 1);
		return CleanString(val);
	}

	protected void LoadTrackerConfig()
	{
		if (m_ConfigLoaded) return;
		m_ConfigLoaded = true;
		string configPath = "$profile:LGTrackerConfig.json";
		
		// Si le fichier n'existe pas, création avec les valeurs par défaut
		if (!FileIO.FileExists(configPath))
		{
			Print("TRACKER : ⚠️ Fichier de configuration manquant. Création d'un fichier par défaut.");
			FileHandle writeHandle = FileIO.OpenFile(configPath, FileMode.WRITE);
			if (writeHandle)
			{
				string dq = "\"";
				writeHandle.WriteLine("{");
				writeHandle.WriteLine("  " + dq + "m_UseLocalApiMode" + dq + ": true,");
				writeHandle.WriteLine("  " + dq + "m_LocalApiBaseUrl" + dq + ": " + dq + "http://localhost:3000" + dq + ",");
				writeHandle.WriteLine("  " + dq + "m_LocalApiPath" + dq + ": " + dq + "/api/arma-event" + dq + ",");
				writeHandle.WriteLine("  " + dq + "m_BridgeAuthToken" + dq + ": " + dq + "CHANGE_ME" + dq + ",");
				writeHandle.WriteLine("  " + dq + "m_EnableHeartbeatLog" + dq + ": false,");
				writeHandle.WriteLine("  " + dq + "m_RenameCooldownMs" + dq + ": 120000,");
				writeHandle.WriteLine("  " + dq + "m_DiscordLogsWebhookPath" + dq + ": " + dq + dq + ",");
				writeHandle.WriteLine("  " + dq + "m_DiscordCounterWebhookPath" + dq + ": " + dq + dq);
				writeHandle.WriteLine("}");
				writeHandle.Close();
				Print("TRACKER : ✅ Fichier de configuration par défaut créé à " + configPath + ". Veuillez le configurer.");
			}
		}

		FileHandle fileHandle = FileIO.OpenFile(configPath, FileMode.READ);
		if (fileHandle)
		{
			string line;
			while (!fileHandle.IsEOF())
			{
				fileHandle.ReadLine(line);
				if (line.IndexOf("m_UseLocalApiMode") != -1)
				{
					string val = ExtractValue(line, "m_UseLocalApiMode");
					m_UseLocalApiMode = (val == "true");
				}
				else if (line.IndexOf("m_LocalApiBaseUrl") != -1)
				{
					// Gestion du double-point de l'URL
					int colonIdx = line.IndexOf(":");
					if (colonIdx != -1)
					{
						string val = line.Substring(colonIdx + 1, line.Length() - colonIdx - 1);
						m_LocalApiBaseUrl = CleanString(val);
					}
				}
				else if (line.IndexOf("m_LocalApiPath") != -1)
				{
					m_LocalApiPath = ExtractValue(line, "m_LocalApiPath");
				}
				else if (line.IndexOf("m_BridgeAuthToken") != -1)
				{
					m_BridgeAuthToken = ExtractValue(line, "m_BridgeAuthToken");
				}
				else if (line.IndexOf("m_EnableHeartbeatLog") != -1)
				{
					string val = ExtractValue(line, "m_EnableHeartbeatLog");
					m_EnableHeartbeatLog = (val == "true");
				}
				else if (line.IndexOf("m_RenameCooldownMs") != -1)
				{
					string val = ExtractValue(line, "m_RenameCooldownMs");
					m_RenameCooldownMs = val.ToInt();
				}
				else if (line.IndexOf("m_DiscordLogsWebhookPath") != -1)
				{
					int colonIdx = line.IndexOf(":");
					if (colonIdx != -1)
					{
						string val = line.Substring(colonIdx + 1, line.Length() - colonIdx - 1);
						m_DiscordLogsWebhookPath = CleanString(val);
					}
				}
				else if (line.IndexOf("m_DiscordCounterWebhookPath") != -1)
				{
					int colonIdx = line.IndexOf(":");
					if (colonIdx != -1)
					{
						string val = line.Substring(colonIdx + 1, line.Length() - colonIdx - 1);
						m_DiscordCounterWebhookPath = CleanString(val);
					}
				}
			}
			fileHandle.Close();
			Print("TRACKER : ✅ Configuration chargée avec succès depuis " + configPath);
			Print("TRACKER : 🔑 Token chargé = " + m_BridgeAuthToken);
			Print("TRACKER : 🌐 URL chargée = " + m_LocalApiBaseUrl);
		}
		else
		{
			Print("TRACKER : ❌ Impossible d'ouvrir le fichier de configuration.");
		}
	}

	override void OnGameStart()
	{
		m_TrackerCallback = new TrackerCallback();
		m_TrackerCallback.SetGameMode(this);
		m_IsWorldCleaningUp = false;
		LoadTrackerConfig();
		super.OnGameStart();
		RefreshCurrentPlayerCount();
		
		// Envoi d'un heartbeat immédiat au démarrage pour initialiser le statut sur Discord
		SendTrackerData("heartbeat", "Serveur actif", "", "", "", "", "");
		
		GetGame().GetCallqueue().CallLater(SendHeartbeat, 10000, true);
	}

	override void OnGameEnd()
	{
		Print("TRACKER : 🌍 OnGameEnd - Fin de la partie, envoi du statut offline.");
		OnWorldCleanup();
		super.OnGameEnd();
	}

	void SendHeartbeat()
	{
		if (m_IsWorldCleaningUp) return;
		RefreshCurrentPlayerCount();
		if (m_UseLocalApiMode || m_EnableHeartbeatLog) SendTrackerData("heartbeat", "Serveur actif", "", "", "", "", "");
		TryUpdateDiscordCounter();
		SendMapUpdate();
	}

	string BuildMapUpdateJson()
	{
		string dq = "\"";
		string json = "{\"auth\": " + dq + EscapeJson(m_BridgeAuthToken) + dq;
		json = json + ", \"type\": \"map_update\"";

		string mapName = "Eden";
		ResourceName worldFile = GetGame().GetWorldFile();
		if (worldFile != "")
		{
			int lastSlash = worldFile.LastIndexOf("/");
			int lastDot = worldFile.LastIndexOf(".");
			if (lastSlash != -1 && lastDot != -1 && lastDot > lastSlash)
			{
				mapName = worldFile.Substring(lastSlash + 1, lastDot - lastSlash - 1);
			}
			else
			{
				mapName = worldFile;
			}
		}

		float mapSize = 12800.0;
		string mapNameLower = mapName;
		mapNameLower.ToLower();
		if (mapNameLower.Contains("everon"))
		{
			mapSize = 12800.0;
		}
		else if (mapNameLower.Contains("arland"))
		{
			mapSize = 2048.0;
		}
		else if (mapNameLower.Contains("gulf"))
		{
			mapSize = 20480.0;
		}

		json = json + ", \"mapName\": \"" + EscapeJson(mapName) + "\"";
		json = json + ", \"mapSize\": " + ReplaceString(mapSize.ToString(), ",", ".");

		// 1. Liste des Joueurs
		json = json + ", " + dq + "players" + dq + ": [";
		PlayerManager pm = GetGame().GetPlayerManager();
		if (pm)
		{
			array<int> playerIds = new array<int>();
			pm.GetPlayers(playerIds);
			int count = playerIds.Count();
			bool firstPlayer = true;
			for (int i = 0; i < count; i++)
			{
				int playerId = playerIds[i];
				IEntity character = pm.GetPlayerControlledEntity(playerId);
				if (!character) continue;

				vector pos = character.GetOrigin();
				string name = pm.GetPlayerName(playerId);
				if (name == "") name = "Joueur_" + playerId.ToString();

				string factionKey = "Inconnue";
				SCR_FactionManager factionManager = SCR_FactionManager.Cast(GetGame().GetFactionManager());
				if (factionManager)
				{
					Faction playerFaction = factionManager.GetPlayerFaction(playerId);
					if (playerFaction) factionKey = playerFaction.GetFactionKey();
				}

				bool inVehicle = false;
				string vehicleType = "";
				CompartmentAccessComponent compAccess = CompartmentAccessComponent.Cast(character.FindComponent(CompartmentAccessComponent));
				if (compAccess && compAccess.IsInCompartment())
				{
					inVehicle = true;
					IEntity vehicle = CompartmentAccessComponent.GetVehicleIn(character);
					if (vehicle)
					{
						EntityPrefabData prefabData = vehicle.GetPrefabData();
						if (prefabData)
						{
							string fullPath = prefabData.GetPrefabName();
							int lastSlash = fullPath.LastIndexOf("/");
							if (lastSlash != -1)
							{
								vehicleType = fullPath.Substring(lastSlash + 1, fullPath.Length() - lastSlash - 1);
								vehicleType = ReplaceString(vehicleType, ".et", "");
							}
						}
					}
				}

				if (!firstPlayer) json = json + ",";
				firstPlayer = false;
				
				json = json + "{" + dq + "name" + dq + ": " + dq + EscapeJson(name) + dq;
				json = json + ", " + dq + "faction" + dq + ": " + dq + EscapeJson(factionKey) + dq;
				json = json + ", " + dq + "x" + dq + ": " + ReplaceString(pos[0].ToString(), ",", ".");
				json = json + ", " + dq + "y" + dq + ": " + ReplaceString(pos[2].ToString(), ",", ".");
				json = json + ", " + dq + "inVehicle" + dq + ": " + inVehicle.ToString();
				json = json + ", " + dq + "vehicleType" + dq + ": " + dq + EscapeJson(vehicleType) + dq + "}";
			}
		}
		json = json + "]";

		// 2. Liste des Bases
		json = json + ", " + dq + "bases" + dq + ": [";
		SCR_GameModeCampaign campaign = SCR_GameModeCampaign.Cast(this);
		if (campaign)
		{
			SCR_CampaignMilitaryBaseManager baseManager = campaign.GetBaseManager();
			if (baseManager)
			{
				array<SCR_CampaignMilitaryBaseComponent> bases = new array<SCR_CampaignMilitaryBaseComponent>();
				baseManager.GetBases(bases);
				int baseCount = bases.Count();
				bool firstBase = true;
				for (int j = 0; j < baseCount; j++)
				{
					SCR_CampaignMilitaryBaseComponent baseComp = bases[j];
					IEntity owner = baseComp.GetOwner();
					if (!owner) continue;

					vector pos = owner.GetOrigin();
					string baseName = baseComp.GetBaseName();

					string factionKey = "Aucune";
					FactionAffiliationComponent factionAffiliation = FactionAffiliationComponent.Cast(owner.FindComponent(FactionAffiliationComponent));
					if (factionAffiliation)
					{
						Faction fac = factionAffiliation.GetAffiliatedFaction();
						if (fac) factionKey = fac.GetFactionKey();
					}

					if (!firstBase) json = json + ",";
					firstBase = false;
					
					json = json + "{" + dq + "name" + dq + ": " + dq + EscapeJson(baseName) + dq;
					json = json + ", " + dq + "faction" + dq + ": " + dq + EscapeJson(factionKey) + dq;
					json = json + ", " + dq + "x" + dq + ": " + ReplaceString(pos[0].ToString(), ",", ".");
					json = json + ", " + dq + "y" + dq + ": " + ReplaceString(pos[2].ToString(), ",", ".") + "}";
				}
			}
		}
		json = json + "]}";

		return json;
	}

	void SendMapUpdate()
	{
		if (m_IsWorldCleaningUp) return;
		if (!m_ConfigLoaded) LoadTrackerConfig();

		RestApi restApi = GetGame().GetRestApi();
		if (!restApi) return;

		string jsonMessage = BuildMapUpdateJson();

		if (m_UseLocalApiMode)
		{
			RestContext ctxLocal = restApi.GetContext(m_LocalApiBaseUrl);
			if (!ctxLocal) return;
			ctxLocal.POST(m_TrackerCallback, m_LocalApiPath, jsonMessage);
			return;
		}
	}

	void OnWorldCleanup()
	{
		if (m_IsWorldCleaningUp) return;
		m_IsWorldCleaningUp = true;
		Print("TRACKER : 🌍 OnWorldCleanup - Notification de coupure immédiate.");
		SendTrackerData("offline", "Le serveur a été arrêté proprement", "", "", "", "", "");
	}

	override void OnPlayerConnected(int playerId)
	{
		if (m_IsWorldCleaningUp) return;
		super.OnPlayerConnected(playerId);
		RefreshCurrentPlayerCount();
		string playerName = "";
		PlayerManager playerManager = GetGame().GetPlayerManager();
		if (playerManager) playerName = playerManager.GetPlayerName(playerId);
		if (playerName == "") playerName = "Joueur_" + playerId.ToString();

		string factionId = "US";
		if (playerId % 2 == 0) factionId = "URSS";

		SendTrackerData("connexion", playerName + " a rejoint le secteur", playerName, factionId, "", "", "");
		TryUpdateDiscordCounter();
	}

	override void OnPlayerDisconnected(int playerId, KickCauseCode cause, int timeout)
	{
		if (m_IsWorldCleaningUp)
		{
			super.OnPlayerDisconnected(playerId, cause, timeout);
			return;
		}
		string playerName = "";
		PlayerManager playerManager = GetGame().GetPlayerManager();
		if (playerManager) playerName = playerManager.GetPlayerName(playerId);
		if (playerName == "") playerName = "Joueur_" + playerId.ToString();

		super.OnPlayerDisconnected(playerId, cause, timeout);
		RefreshCurrentPlayerCount();
		SendTrackerData("deconnexion", playerName + " a quitté la zone", playerName, "", "", "", "");
		TryUpdateDiscordCounter();
	}

	override void OnPlayerKilled(int playerId, IEntity playerEntity, IEntity killerEntity, notnull Instigator killer)
	{
		if (m_IsWorldCleaningUp)
		{
			super.OnPlayerKilled(playerId, playerEntity, killerEntity, killer);
			return;
		}
		super.OnPlayerKilled(playerId, playerEntity, killerEntity, killer);

		string victimName = "";
		PlayerManager playerManager = GetGame().GetPlayerManager();
		if (playerManager) victimName = playerManager.GetPlayerName(playerId);
		if (victimName == "") victimName = "Joueur_" + playerId.ToString();

		string victimFaction = "Inconnue";
		SCR_FactionManager factionManager = SCR_FactionManager.Cast(GetGame().GetFactionManager());
		if (factionManager)
		{
			Faction pFaction = factionManager.GetPlayerFaction(playerId);
			if (pFaction) victimFaction = pFaction.GetFactionKey();
		}

		string killerName = "Un sifflement dans le noir";
		string killerFaction = "Inconnue";
		int killerId = 0;

		if (playerManager && killerEntity) killerId = playerManager.GetPlayerIdFromControlledEntity(killerEntity);

		if (killerId > 0 && playerManager)
		{
			killerName = playerManager.GetPlayerName(killerId);
			if (killerName == "") killerName = "Joueur_" + killerId.ToString();
			if (factionManager)
			{
				Faction kFaction = factionManager.GetPlayerFaction(killerId);
				if (kFaction) killerFaction = kFaction.GetFactionKey();
			}
		}
		else if (killerEntity)
		{
			killerName = "IA / Bot";
		}

		string nomArme = "Inconnue";
		if (killerEntity)
		{
			IEntity weaponEntity = null;
			ChimeraCharacter character = ChimeraCharacter.Cast(killerEntity);
			if (character)
			{
				BaseWeaponComponent currentWeapon = SCR_WeaponLib.GetCurrentWeaponComponent(character);
				if (currentWeapon)
				{
					weaponEntity = currentWeapon.GetOwner();
				}
			}

			if (!weaponEntity)
			{
				weaponEntity = killerEntity;
			}

			if (weaponEntity)
			{
				EntityPrefabData prefabData = weaponEntity.GetPrefabData();
				if (prefabData)
				{
					string fullPath = prefabData.GetPrefabName();
					int lastSlash = fullPath.LastIndexOf("/");
					if (lastSlash != -1)
					{
						nomArme = fullPath.Substring(lastSlash + 1, fullPath.Length() - lastSlash - 1);
						nomArme = ReplaceString(nomArme, ".et", "");
						nomArme = ReplaceString(nomArme, "Weapon_", "");
						nomArme = ReplaceString(nomArme, "Vehicle_", "");
					}
				}
			}
		}

		string typeTir = "Inconnu";
		InstigatorType typeId = killer.GetInstigatorType();

		if (typeId == InstigatorType.INSTIGATOR_PLAYER || typeId == InstigatorType.INSTIGATOR_AI)
		{
			if (nomArme.Contains("Ural") || nomArme.Contains("BTR") || nomArme.Contains("Hummer") || nomArme.Contains("M151") || nomArme.Contains("UAZ") || nomArme.Contains("Car") || nomArme.Contains("Truck"))
				typeTir = "Ecrase / Accident de vehicule (" + nomArme + ")";
			else if (nomArme.Contains("Grenade") || nomArme.Contains("Mine") || nomArme.Contains("Explosive") || nomArme.Contains("Mortar") || nomArme.Contains("RPG") || nomArme.Contains("HE"))
				typeTir = "Explosion / Mortier (" + nomArme + ")";
			else
				typeTir = "Tir par Balle (" + nomArme + ")";
		}
		else
		{
			typeTir = "Suicide / Chute / Environnement";
			if (killerName == "Un sifflement dans le noir" || killerName == "IA / Bot")
			{
				killerName = "Lui-meme";
				killerFaction = victimFaction;
			}
		}

		string fatalHitZoneName = "Inconnue";
		if (playerEntity)
		{
			SCR_CharacterDamageManagerComponent damageManager = SCR_CharacterDamageManagerComponent.Cast(playerEntity.FindComponent(SCR_CharacterDamageManagerComponent));
			if (damageManager)
			{
				array<HitZone> hitZones = new array<HitZone>();
				damageManager.GetAllHitZones(hitZones);
				
				bool headHit = false;
				bool chestHit = false;
				bool otherHit = false;
				string otherHitName = "";
				
				foreach (HitZone hz : hitZones)
				{
					string hzName = hz.GetName();
					if (hzName == "Default" || hzName == "DefaultHitZone" || hzName == "Default_HitZone" || hzName == "virtual" || hzName == "resilience" || hzName == "Resilience")
						continue;
					
					if (hz.GetHealth() <= 0)
					{
						if (hzName.Contains("Head") || hzName.Contains("head"))
						{
							headHit = true;
						}
						else if (hzName.Contains("Chest") || hzName.Contains("chest") || hzName.Contains("Torso") || hzName.Contains("torso") || hzName.Contains("Spine") || hzName.Contains("spine"))
						{
							chestHit = true;
						}
						else
						{
							otherHit = true;
							otherHitName = hzName;
						}
					}
				}
				
				if (headHit) fatalHitZoneName = "Tete";
				else if (chestHit) fatalHitZoneName = "Torse";
				else if (otherHit)
				{
					if (otherHitName.Contains("Arm") || otherHitName.Contains("arm") || otherHitName.Contains("Hand") || otherHitName.Contains("hand"))
						fatalHitZoneName = "Bras / Main";
					else if (otherHitName.Contains("Leg") || otherHitName.Contains("leg") || otherHitName.Contains("Foot") || otherHitName.Contains("foot"))
						fatalHitZoneName = "Jambe / Pied";
					else
						fatalHitZoneName = otherHitName;
				}
			}
		}

		string coordStr = "";
		if (playerEntity)
		{
			vector pos = playerEntity.GetOrigin();
			coordStr = " @ " + ReplaceString(pos[0].ToString(), ",", ".") + "," + ReplaceString(pos[2].ToString(), ",", ".");
		}

		SendTrackerData("kill", killerName + " vs " + victimName + coordStr, victimName, victimFaction, killerName, killerFaction, typeTir, fatalHitZoneName);
	}

	void OnChatMessage(PlayerController pc, string message, string channelName)
	{
		if (m_IsWorldCleaningUp) return;
		if (!pc) return;

		int playerId = pc.GetPlayerId();
		string playerName = "";
		PlayerManager playerManager = GetGame().GetPlayerManager();
		if (playerManager) playerName = playerManager.GetPlayerName(playerId);
		if (playerName == "") playerName = "Joueur_" + playerId.ToString();

		string playerFaction = "Inconnue";
		SCR_FactionManager factionManager = SCR_FactionManager.Cast(GetGame().GetFactionManager());
		if (factionManager)
		{
			Faction pFaction = factionManager.GetPlayerFaction(playerId);
			if (pFaction) playerFaction = pFaction.GetFactionKey();
		}

		SendTrackerData("chat", "[" + channelName + "] " + playerName + ": " + message, playerName, playerFaction, channelName, "", message);
	}

	void OnBaseCaptured(string baseName, string prevFaction, string newFaction)
	{
		if (m_IsWorldCleaningUp) return;
		SendTrackerData("capture", "La base de " + baseName + " a ete capturee par " + newFaction + " (auparavant controlee par " + prevFaction + ")", baseName, newFaction, prevFaction, "", "");
	}

	void OnVehicleDestroyed(IEntity vehicle, array<int> playerIds)
	{
		if (m_IsWorldCleaningUp) return;
		if (!vehicle) return;

		string vehicleName = "Vehicule";
		EntityPrefabData prefabData = vehicle.GetPrefabData();
		if (prefabData)
		{
			string fullPath = prefabData.GetPrefabName();
			int lastSlash = fullPath.LastIndexOf("/");
			if (lastSlash != -1)
			{
				vehicleName = fullPath.Substring(lastSlash + 1, fullPath.Length() - lastSlash - 1);
				vehicleName = ReplaceString(vehicleName, ".et", "");
			}
		}

		string vehicleFaction = "Inconnue";
		FactionAffiliationComponent factionAffiliation = FactionAffiliationComponent.Cast(vehicle.FindComponent(FactionAffiliationComponent));
		if (factionAffiliation)
		{
			Faction fac = factionAffiliation.GetAffiliatedFaction();
			if (fac) vehicleFaction = fac.GetFactionKey();
		}

		string occupantsList = "";
		PlayerManager pm = GetGame().GetPlayerManager();
		if (pm)
		{
			foreach (int playerId : playerIds)
			{
				string name = pm.GetPlayerName(playerId);
				if (name == "") name = "Joueur_" + playerId.ToString();
				if (occupantsList == "") occupantsList = name;
				else occupantsList = occupantsList + ", " + name;
			}
		}

		if (occupantsList == "") occupantsList = "Aucun occupant";

		SendTrackerData("vehicle_destroyed", "Le vehicule " + vehicleName + " (" + vehicleFaction + ") a ete detruit. Occupants: " + occupantsList, vehicleName, vehicleFaction, occupantsList, "", "");
	}

	void SendTrackerData(string typeEvent, string detail, string player, string faction, string killer, string killerFaction, string typeTir, string hitZone = "")
	{
		if (!Replication.IsServer()) return;

		if (!m_ConfigLoaded) LoadTrackerConfig();

		RestApi restApi = GetGame().GetRestApi();
		if (!restApi) return;

		string jsonMessage = "{\"auth\": \"" + EscapeJson(m_BridgeAuthToken) + "\"";
		jsonMessage = jsonMessage + ", \"type\": \"" + EscapeJson(typeEvent) + "\"";
		jsonMessage = jsonMessage + ", \"detail\": \"" + EscapeJson(detail) + "\"";
		jsonMessage = jsonMessage + ", \"player\": \"" + EscapeJson(player) + "\"";
		jsonMessage = jsonMessage + ", \"faction\": \"" + EscapeJson(faction) + "\"";
		jsonMessage = jsonMessage + ", \"killer\": \"" + EscapeJson(killer) + "\"";
		jsonMessage = jsonMessage + ", \"killerFaction\": \"" + EscapeJson(killerFaction) + "\"";
		jsonMessage = jsonMessage + ", \"typeTir\": \"" + EscapeJson(typeTir) + "\"";
		jsonMessage = jsonMessage + ", \"hitZone\": \"" + EscapeJson(hitZone) + "\"";
		jsonMessage = jsonMessage + ", \"onlinePlayers\": \"" + m_CurrentPlayers.ToString() + "\"";
		jsonMessage = jsonMessage + ", \"usPlayers\": \"" + m_USPlayers.ToString() + "\"";
		jsonMessage = jsonMessage + ", \"ussrPlayers\": \"" + m_USSRPlayers.ToString() + "\"";
		jsonMessage = jsonMessage + ", \"fiaPlayers\": \"" + m_FIAPlayers.ToString() + "\"}";
		if (m_UseLocalApiMode)
		{
			RestContext ctxLocal = restApi.GetContext(m_LocalApiBaseUrl);
			if (!ctxLocal) return;
			ctxLocal.POST(m_TrackerCallback, m_LocalApiPath, jsonMessage);
			return;
		}

		if (m_DiscordLogsWebhookPath == "") return;

		RestContext ctx = restApi.GetContext("https://discord.com");
		if (!ctx) return;

		string webhookBody = BuildDiscordLogPayload(typeEvent, detail, player, faction, killer, killerFaction, typeTir, hitZone);
		ctx.POST(m_TrackerCallback, m_DiscordLogsWebhookPath, webhookBody);
	}

	void RefreshCurrentPlayerCount()
	{
		PlayerManager pm = GetGame().GetPlayerManager();
		if (!pm)
		{
			m_CurrentPlayers = 0;
			m_USPlayers = 0;
			m_USSRPlayers = 0;
			m_FIAPlayers = 0;
			return;
		}

		array<int> playerIds = new array<int>();
		pm.GetPlayers(playerIds);
		
		int total = playerIds.Count();
		int us = 0;
		int ussr = 0;
		int fia = 0;

		SCR_FactionManager factionManager = SCR_FactionManager.Cast(GetGame().GetFactionManager());
		if (factionManager)
		{
			foreach (int playerId : playerIds)
			{
				Faction playerFaction = factionManager.GetPlayerFaction(playerId);
				if (playerFaction)
				{
					string factionKey = playerFaction.GetFactionKey();
					if (factionKey == "US") us++;
					else if (factionKey == "USSR") ussr++;
					else if (factionKey == "FIA") fia++;
				}
			}
		}

		m_CurrentPlayers = total;
		m_USPlayers = us;
		m_USSRPlayers = ussr;
		m_FIAPlayers = fia;
	}

	void TryUpdateDiscordCounter()
	{
		if (m_UseLocalApiMode) return;
		if (m_DiscordCounterWebhookPath == "") return;

		int nowMs = System.GetUnixTime() * 1000;
		if ((nowMs - m_LastRenameTimestamp) < m_RenameCooldownMs) return;
		if (m_CurrentPlayers == m_LastAnnouncedPlayers) return;
		m_LastRenameTimestamp = nowMs;
		m_LastAnnouncedPlayers = m_CurrentPlayers;

		RestApi restApi = GetGame().GetRestApi();
		if (!restApi) return;

		RestContext ctx = restApi.GetContext("https://discord.com");
		if (!ctx) return;

		string payload = "{\"embeds\":[{\"title\":\"Compteur joueurs\",\"description\":\"En jeu : **" + m_CurrentPlayers.ToString() + "**\",\"color\":3447003}]}";
		string body = "payload_json=" + UrlEncode(payload);

		TrackerCallback callback = new TrackerCallback();
		ctx.POST(callback, m_DiscordCounterWebhookPath, body);
	}

	string BuildDiscordLogPayload(string typeEvent, string detail, string player, string faction, string killer, string killerFaction, string typeTir, string hitZone = "")
	{
		string title = "Evenement serveur";
		string description = EscapeJson(detail);
		string color = "16776960";

		if (typeEvent == "connexion")
		{
			title = "Connexion";
			description = "**" + EscapeJson(player) + "** a rejoint | Faction: " + EscapeJson(faction);
			color = "3066993";
		}
		else if (typeEvent == "deconnexion")
		{
			title = "Deconnexion";
			description = "**" + EscapeJson(player) + "** a quitte le serveur";
			color = "9807270";
		}
		else if (typeEvent == "kill")
		{
			title = "Kill";
			string text = "Tueur: **" + EscapeJson(killer) + "** (" + EscapeJson(killerFaction) + ")\nVictime: **" + EscapeJson(player) + "** (" + EscapeJson(faction) + ")\nType: " + EscapeJson(typeTir);
			if (hitZone != "" && hitZone != "Inconnue")
			{
				text = text + "\nLocalisation: **" + EscapeJson(hitZone) + "**";
			}
			description = text;
			color = "15158332";
		}
		else if (typeEvent == "heartbeat")
		{
			title = "Heartbeat";
			description = "Serveur actif | Joueurs: " + m_CurrentPlayers.ToString();
			color = "3447003";
		}

		string payload = "{\"embeds\":[{\"title\":\"" + title + "\",\"description\":\"" + description + "\",\"color\":" + color + "}]}";
		return "payload_json=" + UrlEncode(payload);
	}

	string EscapeJson(string value)
	{
		value = ReplaceString(value, "\"", "'");
		value = ReplaceString(value, "\n", " ");
		value = ReplaceString(value, "\r", " ");
		return value;
	}

	string UrlEncode(string value)
	{
		string encoded = value;
		encoded = ReplaceString(encoded, "%", "%25");
		encoded = ReplaceString(encoded, " ", "%20");
		encoded = ReplaceString(encoded, "\n", "%20");
		encoded = ReplaceString(encoded, "\r", "");
		encoded = ReplaceString(encoded, "&", "%26");
		encoded = ReplaceString(encoded, "=", "%3D");
		encoded = ReplaceString(encoded, "?", "%3F");
		encoded = ReplaceString(encoded, "#", "%23");
		encoded = ReplaceString(encoded, "+", "%2B");
		return encoded;
	}

	void ProcessServerResponse(string data)
	{
		int cmdStart = data.IndexOf("\"commands\":[");
		if (cmdStart == -1) return;
		
		cmdStart += 12; // Longueur de `"commands":[`
		int cmdEnd = data.LastIndexOf("]");
		if (cmdEnd == -1 || cmdEnd <= cmdStart) return;
		
		string commandsBlock = data.Substring(cmdStart, cmdEnd - cmdStart);
		if (commandsBlock == "" || commandsBlock == "\"\"") return;
		
		array<string> commands = new array<string>();
		string currentCmd = "";
		int len = commandsBlock.Length();
		bool inQuote = false;
		
		for (int i = 0; i < len; i++)
		{
			string charStr = commandsBlock.Substring(i, 1);
			if (charStr == "\"")
			{
				inQuote = !inQuote;
				if (!inQuote && currentCmd != "")
				{
					commands.Insert(currentCmd);
					currentCmd = "";
				}
			}
			else if (charStr == "," && !inQuote)
			{
				// Séparateur
			}
			else
			{
				currentCmd = currentCmd + charStr;
			}
		}
		
		foreach (string cmd : commands)
		{
			Print("TRACKER : 📡 Exécution de la commande RCON : " + cmd);
			ExecuteAdminCommand(cmd);
		}
	}

	void ExecuteAdminCommand(string cmd)
	{
		int colonIdx = cmd.IndexOf(":");
		if (colonIdx == -1) return;
		
		string action = cmd.Substring(0, colonIdx);
		string remainder = cmd.Substring(colonIdx + 1, cmd.Length() - colonIdx - 1);
		
		if (action == "announce")
		{
			BroadcastSystemMessage("[ADMIN] " + remainder);
		}
		else if (action == "kick")
		{
			string targetName = remainder;
			int targetId = FindPlayerIdByName(targetName);
			if (targetId != -1)
			{
				Print("TRACKER : 🥾 Expulsion du joueur " + targetName + " (ID: " + targetId.ToString() + ")");
				GetGame().GetPlayerManager().KickPlayer(targetId, 0, 0); // Kick avec cause 0 (Defaut)
				BroadcastSystemMessage("[ADMIN] " + targetName + " a été exclu du serveur.");
			}
			else
			{
				Print("TRACKER : ❌ Impossible de kicker " + targetName + " (non trouvé).");
			}
		}
		else if (action == "warn")
		{
			int nextColon = remainder.IndexOf(":");
			if (nextColon == -1) return;
			
			string targetName = remainder.Substring(0, nextColon);
			string msg = remainder.Substring(nextColon + 1, remainder.Length() - nextColon - 1);
			
			int targetId = FindPlayerIdByName(targetName);
			if (targetId != -1)
			{
				Print("TRACKER : ⚠️ Avertissement pour " + targetName + " : " + msg);
				SendSystemMessageToPlayer(targetId, "[ATTENTION] " + targetName + " : " + msg);
			}
		}
	}

	void BroadcastSystemMessage(string msg)
	{
		PlayerManager pm = GetGame().GetPlayerManager();
		if (!pm) return;
		
		array<int> playerIds = new array<int>();
		pm.GetPlayers(playerIds);
		
		foreach (int playerId : playerIds)
		{
			PlayerController pc = pm.GetPlayerController(playerId);
			if (pc)
			{
				SCR_ChatComponent chatComp = SCR_ChatComponent.Cast(pc.FindComponent(SCR_ChatComponent));
				if (chatComp)
				{
					chatComp.SendShowSystemMessage(msg);
				}
			}
		}
	}

	void SendSystemMessageToPlayer(int playerId, string msg)
	{
		PlayerManager pm = GetGame().GetPlayerManager();
		if (!pm) return;
		
		PlayerController pc = pm.GetPlayerController(playerId);
		if (pc)
		{
			SCR_ChatComponent chatComp = SCR_ChatComponent.Cast(pc.FindComponent(SCR_ChatComponent));
			if (chatComp)
			{
				chatComp.SendShowSystemMessage(msg);
			}
		}
	}

	int FindPlayerIdByName(string targetName)
	{
		PlayerManager pm = GetGame().GetPlayerManager();
		if (!pm) return -1;
		
		array<int> playerIds = new array<int>();
		pm.GetPlayers(playerIds);
		
		foreach (int playerId : playerIds)
		{
			string name = pm.GetPlayerName(playerId);
			if (name == targetName)
			{
				return playerId;
			}
		}
		return -1;
	}
}

modded class SCR_ChatComponent
{
	override void OnNewMessage(string msg, int channelId, int senderId)
	{
		super.OnNewMessage(msg, channelId, senderId);
		
		PlayerController pc = PlayerController.Cast(GetOwner());
		if (!pc) return;
		
		Print("TRACKER DEBUG : OnNewMessage called, message: " + msg + ", channelId: " + channelId.ToString() + ", senderId: " + senderId.ToString() + ", pcPlayerId: " + pc.GetPlayerId().ToString() + ", IsServer: " + Replication.IsServer().ToString());
		
		if (Replication.IsServer())
		{
			if (senderId == pc.GetPlayerId())
			{
				ProcessChatMessageServer(msg, channelId, pc);
			}
		}
		else
		{
			PlayerController localPC = GetGame().GetPlayerController();
			if (localPC && localPC == pc && senderId == localPC.GetPlayerId())
			{
				Print("TRACKER DEBUG : Client sending chat to server via RPC: " + msg);
				Rpc(RpcServer_SendChatToServer, msg, channelId, senderId);
			}
		}
	}

	[RplRpc(RplChannel.Reliable, RplRcver.Server)]
	void RpcServer_SendChatToServer(string msg, int channelId, int senderId)
	{
		PlayerController pc = PlayerController.Cast(GetOwner());
		if (!pc) return;

		Print("TRACKER DEBUG : Server received chat RPC: " + msg + " from player " + senderId.ToString());
		ProcessChatMessageServer(msg, channelId, pc);
	}

	[RplRpc(RplChannel.Reliable, RplRcver.Owner)]
	void RpcClient_ShowSystemMessage(string msg)
	{
		ShowMessage(msg);
	}

	void SendShowSystemMessage(string msg)
	{
		Rpc(RpcClient_ShowSystemMessage, msg);
	}

	void ProcessChatMessageServer(string msg, int channelId, PlayerController pc)
	{
		SCR_BaseGameMode gameMode = SCR_BaseGameMode.Cast(GetGame().GetGameMode());
		if (gameMode)
		{
			string channelName = "Inconnu";
			BaseChatEntity chatEntity = GetGame().GetChat();
			if (chatEntity)
			{
				BaseChatChannel channel = chatEntity.GetChannel(channelId);
				if (channel) channelName = channel.GetName();
			}
			
			Print("TRACKER DEBUG : Server forwarding chat: " + msg + " from " + pc.GetPlayerId().ToString() + " in channel " + channelName);
			gameMode.OnChatMessage(pc, msg, channelName);
		}
	}
}


modded class SCR_CampaignMilitaryBaseComponent
{
	override protected void OnFactionChanged(FactionAffiliationComponent owner, Faction previousFaction, Faction faction)
	{
		super.OnFactionChanged(owner, previousFaction, faction);
		
		if (Replication.IsServer())
		{
			SCR_BaseGameMode gameMode = SCR_BaseGameMode.Cast(GetGame().GetGameMode());
			if (gameMode)
			{
				string prevFactionKey = "Aucune";
				if (previousFaction) prevFactionKey = previousFaction.GetFactionKey();
				
				string newFactionKey = "Aucune";
				if (faction) newFactionKey = faction.GetFactionKey();
				
				gameMode.OnBaseCaptured(GetBaseName(), prevFactionKey, newFactionKey);
			}
		}
	}
}

modded class SCR_VehicleDamageManagerComponent
{
	override protected void OnDamageStateChanged(EDamageState newState, EDamageState previousDamageState, bool isJIP)
	{
		super.OnDamageStateChanged(newState, previousDamageState, isJIP);
		
		if (Replication.IsServer() && newState == EDamageState.DESTROYED && previousDamageState != EDamageState.DESTROYED)
		{
			IEntity vehicle = GetOwner();
			if (!vehicle) return;
			
			array<int> playerIds = new array<int>();
			PlayerManager playerManager = GetGame().GetPlayerManager();
			if (playerManager)
			{
				array<int> allPlayers = new array<int>();
				playerManager.GetPlayers(allPlayers);
				foreach (int playerId : allPlayers)
				{
					IEntity character = playerManager.GetPlayerControlledEntity(playerId);
					if (character)
					{
						CompartmentAccessComponent compAccess = CompartmentAccessComponent.Cast(character.FindComponent(CompartmentAccessComponent));
						if (compAccess && compAccess.IsInCompartment() && CompartmentAccessComponent.GetVehicleIn(character) == vehicle)
						{
							playerIds.Insert(playerId);
						}
					}
				}
			}
			
			SCR_BaseGameMode gameMode = SCR_BaseGameMode.Cast(GetGame().GetGameMode());
			if (gameMode)
			{
				gameMode.OnVehicleDestroyed(vehicle, playerIds);
			}
		}
	}
}