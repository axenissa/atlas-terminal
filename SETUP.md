# Mise en route (macOS)

Objectif : tout tourne dans le cloud, gratuitement. Le Mac ne sert qu'une fois, pour envoyer le code.
Compter 20 à 30 minutes.

## 0. Ce dont tu as besoin

- Un compte GitHub (gratuit)
- Un compte Cloudflare (gratuit, sans carte bancaire) : https://dash.cloudflare.com/sign-up
- Sur le Mac : `git` et Node.js (déjà présents si `git --version` et `node --version` répondent)

## 1. CB-Monitor sur GitHub

Le terminal lit les sorties de CB-Monitor sur son dépôt GitHub, et le workflow de CB-Monitor
(`.github/workflows/update.yml`) le met à jour tout seul chaque soir.

Conseil : sortir CB-Monitor d'iCloud avant d'en faire un dépôt git (iCloud et git font mauvais ménage,
et le dossier `.venv` de 257 Mo n'a rien à faire dans le cloud).

```bash
cp -R ~/Documents/bot-banques-centrales-brief/cb-monitor ~/Dev/cb-monitor
cd ~/Dev/cb-monitor
rm -rf .venv && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
echo ".venv/" >> .gitignore
git init && git add . && git commit -m "CB-Monitor"
```

Sur github.com : New repository > nom `cb-monitor` > Public (recommandé pour LinkedIn) > Create.
Puis :

```bash
git branch -M main
git remote add origin https://github.com/TON-PSEUDO/cb-monitor.git
git push -u origin main
```

Dans le dépôt : Actions > CB-Monitor update > Run workflow (première mise à jour et premier backtest).

Dépôt privé : créer un jeton GitHub en lecture seule (Settings > Developer settings > Fine-grained tokens,
accès "Contents: Read" au seul dépôt cb-monitor) et l'ajouter au dépôt atlas-terminal comme secret `CBM_TOKEN`.

## 2. Le terminal sur GitHub

Dans `config/settings.yaml`, renseigner le dépôt CB-Monitor :

```yaml
cbmonitor:
  repo: "TON-PSEUDO/cb-monitor"
```

Sur github.com : New repository > `atlas-terminal` > Public > Create. Puis :

```bash
cd ~/Dev/atlas-terminal
git init && git add . && git commit -m "Atlas Terminal"
git branch -M main
git remote add origin https://github.com/TON-PSEUDO/atlas-terminal.git
git push -u origin main
```

Dans le dépôt atlas-terminal :
1. Settings > Pages > Source : **GitHub Actions**
2. Actions > Refresh data and deploy > Run workflow > mode `all`

Au bout de 5 minutes environ, le site est en ligne sur `https://TON-PSEUDO.github.io/atlas-terminal/`
avec les données en cache (univers de `settings.yaml`). Le résumé du run affiche le contrôle croisé.

## 3. Le Worker Cloudflare (données en direct, recherche, FA)

```bash
cd ~/Dev/atlas-terminal/worker
npm install
npx wrangler login      # ouvre le navigateur, connexion au compte Cloudflare
npx wrangler deploy
```

La commande affiche une adresse du type `https://atlas-terminal.TON-COMPTE.workers.dev`. La reporter dans
`config/settings.yaml` :

```yaml
site:
  worker_url: "https://atlas-terminal.TON-COMPTE.workers.dev"
```

Puis dans `worker/wrangler.toml`, limiter le Worker à ton site :
`ALLOWED_ORIGINS = "https://TON-PSEUDO.github.io"`, et redéployer (`npx wrangler deploy`).

```bash
cd ~/Dev/atlas-terminal
git commit -am "Worker" && git push
```

Le site se redéploie au prochain run planifié (ou Actions > Run workflow).

C'est fini : le Mac peut rester éteint.

## Au quotidien

- Ajouter un actif au suivi complet (historique en cache, risque, sentiment FinBERT) : `universe` dans `config/settings.yaml`.
- Favoris : directement dans le site (☆), gardés dans ton navigateur.
- Nouvelle stratégie dans STRAT : une entrée dans `strategies`, avec un `summary.json` et un `equity.csv` au format de CB-Monitor.
- GitHub met en pause les tâches planifiées d'un dépôt sans activité pendant 60 jours ; le workflow s'en charge, sinon un mail de GitHub propose de les réactiver en un clic.

## Lancer en local (facultatif)

```bash
cd ~/Dev/atlas-terminal
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m pytest -q && node --test tests-js/*.test.mjs
python -m pipeline daily                 # sans FinBERT
python -m http.server 8000 -d site       # puis http://localhost:8000
```

FinBERT en local (environ 1 Go) : `pip install torch transformers` puis `python -m pipeline news`.
