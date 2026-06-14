# deploy.ps1 - Script de deploiement rapide Les Gaulois
# Usage : .\deploy.ps1 "message de commit"
# Si aucun message n'est fourni, un message automatique avec la date sera utilise.

param(
    [string]$Message
)

$ErrorActionPreference = "Stop"

# Couleurs
function Write-Header($text) { Write-Host "`n========================================" -ForegroundColor Cyan; Write-Host "  $text" -ForegroundColor Cyan; Write-Host "========================================" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "  [OK] $text" -ForegroundColor Green }
function Write-Info($text) { Write-Host "  [INFO] $text" -ForegroundColor Yellow }
function Write-Err($text) { Write-Host "  [ERROR] $text" -ForegroundColor Red }

$BackendPath = "E:\LGTracker"
$FrontendPath = "E:\LGTracker\siteserveur"

# Message de commit
if (-not $Message) {
    $dateStr = Get-Date -Format "yyyy-MM-dd HH:mm"
    $Message = "update: deploiement du $dateStr"
}

Write-Header "DEPLOIEMENT LES GAULOIS"
Write-Host "  Message : $Message" -ForegroundColor White
Write-Host ""

# --- BACKEND ---
Write-Header "1/2 - Backend (API Render)"

Set-Location $BackendPath
$backendChanges = git status --porcelain
if ($backendChanges) {
    git add -A
    git commit -m $Message
    git push origin main
    Write-Ok "Backend pousse sur GitHub -> Render va se redeployer automatiquement."
} else {
    Write-Info "Aucun changement detecte dans le backend. Rien a pousser."
}

# --- FRONTEND ---
Write-Header "2/2 - Frontend (GitHub Pages)"

Set-Location $FrontendPath
$frontendChanges = git status --porcelain
if ($frontendChanges) {
    git add -A
    git commit -m $Message
    git push origin main
    Write-Ok "Frontend pousse sur GitHub -> GitHub Pages va se mettre a jour."
} else {
    Write-Info "Aucun changement detecte dans le frontend. Rien a pousser."
}

# --- RESUME ---
Write-Header "DEPLOIEMENT TERMINE"
Write-Host ""
Write-Host "  Site web  : https://ilu51sang.github.io/site-les-gaulois/" -ForegroundColor White
Write-Host "  API       : https://lgtracker-api.onrender.com/api/stats" -ForegroundColor White
Write-Host "  Backend   : https://github.com/ilu51sang/lg_tracker" -ForegroundColor White
Write-Host "  Frontend  : https://github.com/ilu51sang/site-les-gaulois" -ForegroundColor White
Write-Host ""
Write-Ok "Tout est en ligne ! Les changements seront visibles sous 1-3 minutes."
Write-Host ""
