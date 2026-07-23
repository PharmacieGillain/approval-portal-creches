// PostgreSQL data layer — replaces the old db/*.json file storage.
// Render's free web service filesystem is ephemeral (reset on every restart/deploy),
// so persistent data must live in a real database instead of local JSON files.

const { Pool } = require('pg');

// The pool is only created once DATABASE_URL is confirmed present (see init()),
// so a missing/unreachable database never triggers a stray connection attempt
// to a bogus default (localhost:5432).
let pool = null;
let available = false;

function isAvailable() {
  return available;
}

// Defense in depth: every exported query function calls this first, so even
// a route that forgets to check db.isAvailable() fails fast with a clear
// message instead of hanging on a connection that was never established.
function assertAvailable() {
  if (!available) {
    throw new Error('Base de données indisponible (DATABASE_URL non configuré ou connexion impossible).');
  }
}

async function init() {
  if (!process.env.DATABASE_URL) {
    console.warn(
      'DATABASE_URL non défini : démarrage sans base de données. ' +
      'Le portail crèche self-service (inscription, connexion, commandes) est désactivé. Voir SETUP.md.'
    );
    available = false;
    return false;
  }

  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS creches (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        contact TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        phone TEXT,
        address TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending_approval',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pending_orders (
        id UUID PRIMARY KEY,
        creche_id UUID NOT NULL REFERENCES creches(id),
        creche_name TEXT NOT NULL,
        items JSONB NOT NULL,
        total NUMERIC(10,2) NOT NULL,
        status TEXT NOT NULL DEFAULT 'en_attente',
        rejection_reason TEXT,
        shopify_order_id TEXT,
        shopify_order_number TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    available = true;
    console.log('Base de données PostgreSQL connectée — tables vérifiées/créées.');
    return true;
  } catch (e) {
    console.error('Erreur de connexion à la base de données :', e.message || e.code || e);
    available = false;
    return false;
  }
}

// --- Row <-> app object mapping ---
// Keeps the exact same shape (camelCase) that routes/views relied on
// when data came from creches.json / pending-orders.json.

function mapCreche(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    contact: row.contact,
    email: row.email,
    password: row.password_hash,
    phone: row.phone || '',
    address: row.address,
    status: row.status,
    createdAt: row.created_at,
  };
}

function mapOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    crecheId: row.creche_id,
    crecheName: row.creche_name,
    items: row.items,
    total: row.total,
    status: row.status,
    createdAt: row.created_at,
    rejectionReason: row.rejection_reason,
    shopifyOrderId: row.shopify_order_id,
    shopifyOrderNumber: row.shopify_order_number,
  };
}

// Postgres rejects malformed UUIDs with an error (22P02) instead of just
// finding no rows, unlike the old Array.find() lookups over JSON. Treat a
// malformed id as "not found" so routes keep redirecting gracefully instead
// of throwing on unexpected/tampered URL params.
async function queryTolerantToBadUuid(sql, params) {
  try {
    return await pool.query(sql, params);
  } catch (e) {
    if (e.code === '22P02') return { rows: [] };
    throw e;
  }
}

// --- Crèches ---

async function getAllCreches() {
  assertAvailable();
  const { rows } = await pool.query('SELECT * FROM creches');
  return rows.map(mapCreche);
}

async function getCrecheById(id) {
  assertAvailable();
  const { rows } = await queryTolerantToBadUuid('SELECT * FROM creches WHERE id = $1', [id]);
  return mapCreche(rows[0]);
}

async function getCrecheByEmail(email) {
  assertAvailable();
  const { rows } = await pool.query('SELECT * FROM creches WHERE email = $1', [email]);
  return mapCreche(rows[0]);
}

async function createCreche({ id, name, contact, email, passwordHash, phone, address, status, createdAt }) {
  assertAvailable();
  const { rows } = await pool.query(
    `INSERT INTO creches (id, name, contact, email, password_hash, phone, address, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [id, name, contact, email, passwordHash, phone, address, status, createdAt]
  );
  return mapCreche(rows[0]);
}

async function updateCrecheStatus(id, status) {
  assertAvailable();
  const { rows } = await queryTolerantToBadUuid(
    'UPDATE creches SET status = $1 WHERE id = $2 RETURNING *',
    [status, id]
  );
  return mapCreche(rows[0]);
}

// --- Pending orders (crèche self-service orders) ---

async function getAllOrders() {
  assertAvailable();
  const { rows } = await pool.query('SELECT * FROM pending_orders');
  return rows.map(mapOrder);
}

async function getOrderById(id) {
  assertAvailable();
  const { rows } = await queryTolerantToBadUuid('SELECT * FROM pending_orders WHERE id = $1', [id]);
  return mapOrder(rows[0]);
}

async function createOrder({ id, crecheId, crecheName, items, total, status, createdAt }) {
  assertAvailable();
  const { rows } = await pool.query(
    `INSERT INTO pending_orders (id, creche_id, creche_name, items, total, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [id, crecheId, crecheName, JSON.stringify(items), total, status, createdAt]
  );
  return mapOrder(rows[0]);
}

async function approveOrder(id, shopifyOrderId, shopifyOrderNumber) {
  assertAvailable();
  const { rows } = await queryTolerantToBadUuid(
    `UPDATE pending_orders
     SET status = 'approuvee', shopify_order_id = $1, shopify_order_number = $2
     WHERE id = $3 RETURNING *`,
    [shopifyOrderId, shopifyOrderNumber, id]
  );
  return mapOrder(rows[0]);
}

async function rejectOrder(id, reason) {
  assertAvailable();
  const { rows } = await queryTolerantToBadUuid(
    `UPDATE pending_orders
     SET status = 'rejetee', rejection_reason = $1
     WHERE id = $2 RETURNING *`,
    [reason, id]
  );
  return mapOrder(rows[0]);
}

module.exports = {
  init,
  isAvailable,
  getAllCreches,
  getCrecheById,
  getCrecheByEmail,
  createCreche,
  updateCrecheStatus,
  getAllOrders,
  getOrderById,
  createOrder,
  approveOrder,
  rejectOrder,
};
