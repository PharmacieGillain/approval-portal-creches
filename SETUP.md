# Configuration de la base de données (PostgreSQL)

Le portail stocke désormais les crèches et leurs commandes dans une base
PostgreSQL au lieu de fichiers JSON locaux (`db/creches.json`,
`db/pending-orders.json`). C'est nécessaire car le disque des services
**Render Free** est éphémère : tout fichier écrit sur le disque est perdu à
chaque redéploiement ou redémarrage du service.

## Mode dégradé sans base de données

Si `DATABASE_URL` n'est pas défini (ou si la connexion échoue), le serveur
démarre quand même — il ne plante plus. Seul le portail crèche self-service
est désactivé (inscription, connexion, envoi de commande, et les pages admin
`/admin/creches` et `/admin/commandes-creches` affichent un message
« temporairement indisponible »). Le reste de l'application — connexion
admin, tableau de bord, historique, approbation/refus des commandes Shopify —
continue de fonctionner normalement, car ces routes n'utilisent pas la base
de données.

## 1. Créer la base PostgreSQL gratuite sur Render

Deux façons de faire, selon comment ce service a été créé sur Render :

### Option A — Le service a été créé via "New Blueprint" (render.yaml)

`render.yaml` déclare maintenant une base `approval-portal-creches-db` (plan
Free) et relie automatiquement `DATABASE_URL` dessus via `fromDatabase`. Si
vous (re)synchronisez le Blueprint sur Render (dashboard → votre Blueprint →
**Sync**, ou en créant le service via **New +** → **Blueprint** en pointant
sur ce repo), Render crée la base et remplit `DATABASE_URL` tout seul — rien
d'autre à faire, passez à l'étape 3.

### Option B — Le service a été créé manuellement ("New Web Service")

C'est probablement le cas actuellement (le service existait déjà avant ce
`render.yaml`). Render ne lit alors pas la section `databases:` du fichier,
donc il faut créer la base à la main :

1. Dans le [dashboard Render](https://dashboard.render.com), cliquez sur
   **New +** → **PostgreSQL**.
2. Donnez-lui un nom (ex. `approval-portal-creches-db`).
3. Choisissez le plan **Free**.
4. Choisissez la même région que votre service web (pour des connexions
   internes plus rapides).
5. Cliquez sur **Create Database** et attendez que le statut passe à
   **Available**.

> ⚠️ Le plan gratuit PostgreSQL de Render expire après un certain temps
> (actuellement 30 jours) et est ensuite supprimé si vous ne passez pas à un
> plan payant. Pensez à surveiller les emails de Render à ce sujet, ou passez
> à un plan payant avant l'expiration si l'application est en production.

## 2. Relier la base au service web (Option B uniquement)

Si vous avez suivi l'Option A ci-dessus, `DATABASE_URL` est déjà configuré —
passez à l'étape 3.

1. Ouvrez la page de la base de données que vous venez de créer.
2. Copiez la valeur **Internal Database URL** (à utiliser si le service web
   est aussi hébergé sur Render — plus rapide et gratuit en bande passante).
   Utilisez l'**External Database URL** uniquement si vous devez vous
   connecter depuis l'extérieur de Render (ex. en local).
3. Allez sur le service web `approval-portal-creches` → onglet
   **Environment**.
4. Ajoutez (ou modifiez) la variable `DATABASE_URL` avec la valeur copiée.
5. Sauvegardez — Render redéploie automatiquement le service.

Au démarrage, le serveur (`db.js`) crée automatiquement les tables
nécessaires si elles n'existent pas encore (`creches` et `pending_orders`).
Aucune migration manuelle n'est requise.

## 3. Configuration en local (développement)

Pour développer en local, installez PostgreSQL (ou utilisez un conteneur
Docker), créez une base, puis ajoutez sa chaîne de connexion dans votre
fichier `.env` :

```
DATABASE_URL=postgres://user:password@localhost:5432/approval_portal_creches
```

Exemple rapide avec Docker :

```bash
docker run --name approval-portal-db -e POSTGRES_PASSWORD=password -e POSTGRES_DB=approval_portal_creches -p 5432:5432 -d postgres:16
```

Puis dans `.env` :

```
DATABASE_URL=postgres://postgres:password@localhost:5432/approval_portal_creches
```

Démarrez ensuite le serveur normalement :

```bash
npm install
npm run dev
```

## 4. Vérification

Au démarrage, regardez les logs :

- Si `DATABASE_URL` est bien configuré et la connexion réussit :
  ```
  Base de données PostgreSQL connectée — tables vérifiées/créées.
  Portail Approbation Crèches démarré sur http://localhost:3000
  ```
- Si `DATABASE_URL` est absent ou la connexion échoue, le serveur démarre
  quand même, en mode dégradé (voir plus haut) :
  ```
  DATABASE_URL non défini : démarrage sans base de données. [...]
  Portail Approbation Crèches démarré sur http://localhost:3000
  Mode dégradé : le portail crèche self-service [...] est désactivé [...]
  ```

## Ancien stockage JSON

Les anciens fichiers `db/creches.json` et `db/pending-orders.json` ne sont
plus utilisés par l'application. Si vous aviez des crèches ou commandes
existantes dans ces fichiers, il faut les réinsérer manuellement dans la
nouvelle base (via un client PostgreSQL comme `psql` ou une interface comme
[TablePlus](https://tableplus.com/) ou [pgAdmin](https://www.pgadmin.org/)) :

- Table `creches` : colonnes `id, name, contact, email, password_hash, phone,
  address, status, created_at`. Le mot de passe (`password` dans l'ancien
  JSON) est un hash bcrypt — vous pouvez le copier tel quel dans
  `password_hash`.
- Table `pending_orders` : colonnes `id, creche_id, creche_name, items,
  total, status, rejection_reason, shopify_order_id, shopify_order_number,
  created_at`. `items` est un champ JSONB — copiez le tableau `items` du
  JSON tel quel.
