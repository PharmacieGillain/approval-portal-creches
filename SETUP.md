# Configuration de la base de données (PostgreSQL)

Le portail stocke désormais les crèches et leurs commandes dans une base
PostgreSQL au lieu de fichiers JSON locaux (`db/creches.json`,
`db/pending-orders.json`). C'est nécessaire car le disque des services
**Render Free** est éphémère : tout fichier écrit sur le disque est perdu à
chaque redéploiement ou redémarrage du service.

## 1. Créer la base PostgreSQL gratuite sur Render

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

## 2. Relier la base au service web

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

Si `DATABASE_URL` n'est pas défini, le serveur refuse de démarrer et affiche
un message d'erreur explicite au lancement. Si la variable est bien
configurée, vous devriez voir dans les logs :

```
Portail Approbation Crèches démarré sur http://localhost:3000
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
