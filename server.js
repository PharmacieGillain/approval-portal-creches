// Portail Crèches — v1.1.0 — includes crèche self-registration, login, ordering, and admin management
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;
const API_VERSION = '2025-01';

// --- Shopify helpers ---

function shopifyHeaders(hasBody = false) {
  const headers = { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN };
  if (hasBody) headers['Content-Type'] = 'application/json';
  return headers;
}

async function shopifyRest(method, endpoint, data = null) {
  const url = `https://${process.env.SHOPIFY_SHOP}/admin/api/${API_VERSION}/${endpoint}`;
  const res = await axios({ method, url, headers: shopifyHeaders(!!data), data, validateStatus: () => true });
  if (res.status >= 400) throw new Error(`Shopify HTTP ${res.status}: ${JSON.stringify(res.data)}`);
  return res.data;
}

async function shopifyGQL(query, variables = {}) {
  const url = `https://${process.env.SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`;
  const res = await axios.post(url, { query, variables }, { headers: shopifyHeaders(true) });
  if (res.data.errors) throw new Error(JSON.stringify(res.data.errors));
  return res.data.data;
}

// --- Email helper ---

async function sendNotification(subject, html) {
  if (!process.env.SMTP_HOST || !process.env.NOTIFICATION_EMAIL) return;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: process.env.NOTIFICATION_EMAIL,
    subject,
    html,
  });
}

// --- Formatting helpers ---

function getOrderStatus(order) {
  const tags = (order.tags || '').split(',').map(t => t.trim());
  if (tags.includes('validé')) return 'validé';
  if (tags.includes('refusé')) return 'refusé';
  if (tags.includes('en-attente-validation')) return 'en-attente-validation';
  return null;
}

function getCompanyName(order) {
  return (
    order.billing_address?.company ||
    order.shipping_address?.company ||
    order.customer?.default_address?.company ||
    ''
  );
}

function getCustomerName(order) {
  if (order.billing_address?.name) return order.billing_address.name;
  if (order.customer) {
    const { first_name, last_name } = order.customer;
    return `${first_name || ''} ${last_name || ''}`.trim() || 'Client inconnu';
  }
  return 'Client inconnu';
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function formatDateTime(dateStr) {
  return new Date(dateStr).toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function updateOrderTags(orderId, removeTag, addTag) {
  const data = await shopifyRest('GET', `orders/${orderId}.json`);
  const order = data.order;
  const tags = (order.tags || '').split(',').map(t => t.trim()).filter(Boolean);
  const newTags = tags.filter(t => t !== removeTag);
  if (addTag && !newTags.includes(addTag)) newTags.push(addTag);
  await shopifyRest('PUT', `orders/${orderId}.json`, {
    order: { id: parseInt(orderId), tags: newTags.join(', ') },
  });
  return order;
}

// --- Crèche discount ---

const CRECHE_DISCOUNT_RATE = 0.10; // 10% applied to all crèche Shopify orders

// --- DB helpers ---

const DB_DIR = path.join(__dirname, 'db');
const CRECHES_FILE = path.join(DB_DIR, 'creches.json');
const ORDERS_FILE = path.join(DB_DIR, 'pending-orders.json');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
if (!fs.existsSync(CRECHES_FILE)) fs.writeFileSync(CRECHES_FILE, '[]', 'utf8');
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]', 'utf8');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// --- Shopify order creation for crèche orders ---

async function createShopifyOrderForCreche(pendingOrder, creche) {
  const nameParts = (creche.contact || '').split(' ');
  const firstName = nameParts[0] || creche.name;
  const lastName = nameParts.slice(1).join(' ') || '';

  const line_items = pendingOrder.items.map(item => ({
    variant_id: parseInt(item.variantId),
    quantity: item.quantity,
    price: (parseFloat(item.price) * (1 - CRECHE_DISCOUNT_RATE)).toFixed(2),
  }));

  const addrBase = {
    first_name: firstName,
    last_name: lastName,
    company: creche.name,
    address1: creche.address || '',
    phone: creche.phone || '',
    country_code: 'BE',
  };

  const data = await shopifyRest('POST', 'orders.json', {
    order: {
      line_items,
      customer: { first_name: firstName, last_name: lastName, email: creche.email },
      billing_address: addrBase,
      shipping_address: addrBase,
      tags: 'validé, commande-creche',
      financial_status: 'pending',
      send_receipt: false,
      send_fulfillment_receipt: false,
      inventory_behaviour: 'bypass',
      note: `Commande Portail Crèches — ${creche.name}`,
    },
  });
  return data.order;
}

// --- Express setup ---

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'portal-secret-fallback',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 8 * 60 * 60 * 1000 },
  })
);

app.locals.formatDate = formatDate;
app.locals.formatDateTime = formatDateTime;
app.locals.getCustomerName = getCustomerName;
app.locals.getCompanyName = getCompanyName;
app.locals.getOrderStatus = getOrderStatus;

// --- Auth middleware ---

const requireAuth = (req, res, next) => {
  if (req.session.authenticated) return next();
  res.redirect('/login');
};

const requireCrecheAuth = (req, res, next) => {
  if (req.session.crecheId) return next();
  res.redirect('/creche/login');
};

// ================================================================
// EXISTING ADMIN ROUTES
// ================================================================

app.get('/', (req, res) => res.redirect('/tableau-de-bord'));

app.get('/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/tableau-de-bord');
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  if (req.body.password === process.env.PORTAL_PASSWORD) {
    req.session.authenticated = true;
    return res.redirect('/tableau-de-bord');
  }
  res.render('login', { error: 'Mot de passe incorrect. Veuillez réessayer.' });
});

app.get('/deconnexion', requireAuth, (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Historique — all crèche/foyer orders
app.get('/historique', requireAuth, async (req, res) => {
  try {
    const [pending, approved, rejected] = await Promise.all([
      shopifyRest('GET', 'orders.json?tag=en-attente-validation&status=any&limit=250'),
      shopifyRest('GET', 'orders.json?tag=valid%C3%A9&status=any&limit=250'),
      shopifyRest('GET', 'orders.json?tag=refus%C3%A9&status=any&limit=250'),
    ]);

    const seen = new Set();
    const orders = [];
    for (const order of [
      ...(pending.orders || []),
      ...(approved.orders || []),
      ...(rejected.orders || []),
    ]) {
      if (!seen.has(order.id)) {
        seen.add(order.id);
        orders.push(order);
      }
    }
    orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.render('historique', { orders, error: null });
  } catch (e) {
    console.error('Historique error:', e.message);
    res.render('historique', {
      orders: [],
      error: 'Impossible de charger l\'historique. Vérifiez la configuration Shopify.',
    });
  }
});

// Dashboard — list pending orders
app.get('/tableau-de-bord', requireAuth, async (req, res) => {
  const pendingCrecheCount = readJson(ORDERS_FILE).filter(o => o.status === 'en_attente').length;
  try {
    const data = await shopifyRest(
      'GET',
      'orders.json?tag=en-attente-validation&status=any&limit=250'
    );
    res.render('dashboard', { orders: data.orders || [], error: null, pendingCrecheCount });
  } catch (e) {
    console.error('Dashboard error:', e.message);
    res.render('dashboard', {
      orders: [],
      error: 'Impossible de charger les commandes. Vérifiez la configuration Shopify.',
      pendingCrecheCount,
    });
  }
});

// Order detail
app.get('/commandes/:id', requireAuth, async (req, res) => {
  try {
    const data = await shopifyRest('GET', `orders/${req.params.id}.json`);
    const flash = req.session.flash || {};
    delete req.session.flash;
    res.render('order', {
      order: data.order,
      error: flash.error || null,
      success: flash.success || null,
    });
  } catch (e) {
    console.error('Order detail error:', e.message);
    req.session.flash = { error: 'Commande introuvable.' };
    res.redirect('/tableau-de-bord');
  }
});

// Save order edits via GraphQL Order Editing API
app.post('/commandes/:id/modifier', requireAuth, async (req, res) => {
  const orderId = req.params.id;
  try {
    const { quantities, removed_items, new_variants, new_quantities } = req.body;
    const orderGid = `gid://shopify/Order/${orderId}`;

    const beginRes = await shopifyGQL(
      `mutation beginEdit($id: ID!) {
        orderEditBegin(id: $id) {
          calculatedOrder {
            id
            lineItems(first: 100) {
              edges { node { id quantity } }
            }
          }
          userErrors { field message }
        }
      }`,
      { id: orderGid }
    );

    const beginErrors = beginRes.orderEditBegin.userErrors;
    if (beginErrors.length) throw new Error(beginErrors.map(e => e.message).join(', '));

    const calcOrder = beginRes.orderEditBegin.calculatedOrder;
    const calcId = calcOrder.id;

    // Map numeric original line item ID -> CalculatedLineItem GID
    const calcIdMap = {};
    for (const edge of calcOrder.lineItems.edges) {
      const numericId = edge.node.id.split('/').pop();
      calcIdMap[numericId] = edge.node.id;
    }

    if (quantities && typeof quantities === 'object') {
      for (const [lineItemId, qty] of Object.entries(quantities)) {
        const calcLineItemId = calcIdMap[lineItemId];
        if (!calcLineItemId) continue;
        await shopifyGQL(
          `mutation setQty($id: ID!, $lineItemId: ID!, $qty: Int!) {
            orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $qty, restock: false) {
              calculatedOrder { id }
              userErrors { message }
            }
          }`,
          { id: calcId, lineItemId: calcLineItemId, qty: Math.max(0, parseInt(qty) || 0) }
        );
      }
    }

    const removedArr = removed_items
      ? Array.isArray(removed_items) ? removed_items : [removed_items]
      : [];
    for (const lineItemId of removedArr) {
      const calcLineItemId = calcIdMap[lineItemId];
      if (!calcLineItemId) continue;
      await shopifyGQL(
        `mutation removeItem($id: ID!, $lineItemId: ID!) {
          orderEditRemoveLineItem(id: $id, lineItemId: $lineItemId) {
            calculatedOrder { id }
            userErrors { message }
          }
        }`,
        { id: calcId, lineItemId: calcLineItemId }
      );
    }

    const newVariantsArr = new_variants
      ? Array.isArray(new_variants) ? new_variants : [new_variants]
      : [];
    const newQtysArr = new_quantities
      ? Array.isArray(new_quantities) ? new_quantities : [new_quantities]
      : [];

    for (let i = 0; i < newVariantsArr.length; i++) {
      if (!newVariantsArr[i]) continue;
      const variantGid = `gid://shopify/ProductVariant/${newVariantsArr[i]}`;
      const qty = Math.max(1, parseInt(newQtysArr[i]) || 1);
      await shopifyGQL(
        `mutation addVariant($id: ID!, $variantId: ID!, $qty: Int!) {
          orderEditAddVariant(id: $id, variantId: $variantId, quantity: $qty, allowDuplicates: true) {
            calculatedOrder { id }
            userErrors { message }
          }
        }`,
        { id: calcId, variantId: variantGid, qty }
      );
    }

    const commitRes = await shopifyGQL(
      `mutation commit($id: ID!) {
        orderEditCommit(id: $id, notifyCustomer: false, staffNote: "Modifié via le Portail Crèches") {
          order { id }
          userErrors { message }
        }
      }`,
      { id: calcId }
    );

    const commitErrors = commitRes.orderEditCommit.userErrors;
    if (commitErrors.length) throw new Error(commitErrors.map(e => e.message).join(', '));

    req.session.flash = { success: 'Commande modifiée avec succès.', error: null };
  } catch (e) {
    console.error('Edit error:', e.message);
    req.session.flash = { error: `Erreur lors de la modification : ${e.message}`, success: null };
  }
  res.redirect(`/commandes/${orderId}`);
});

// Approve order
app.post('/commandes/:id/approuver', requireAuth, async (req, res) => {
  const orderId = req.params.id;
  try {
    const order = await updateOrderTags(orderId, 'en-attente-validation', 'validé');
    const name = getCustomerName(order);
    const company = getCompanyName(order);

    await sendNotification(
      `Commande #${order.order_number} approuvée — ${company || name}`,
      `<div style="font-family:Arial,sans-serif;max-width:600px;padding:20px">
        <h2 style="color:#16a34a;border-bottom:2px solid #16a34a;padding-bottom:10px">✅ Commande approuvée</h2>
        <p>La commande <strong>#${order.order_number}</strong> a été <strong>approuvée</strong> par le Portail Crèches.</p>
        <table style="width:100%;border-collapse:collapse;margin:20px 0">
          <tr style="background:#f0fdf4"><td style="padding:10px;font-weight:bold;width:40%">Client</td><td style="padding:10px">${name}</td></tr>
          ${company ? `<tr><td style="padding:10px;font-weight:bold">Établissement</td><td style="padding:10px">${company}</td></tr>` : ''}
          <tr style="background:#f0fdf4"><td style="padding:10px;font-weight:bold">Total</td><td style="padding:10px">${parseFloat(order.total_price).toFixed(2)} ${order.currency}</td></tr>
          <tr><td style="padding:10px;font-weight:bold">Date</td><td style="padding:10px">${formatDate(order.created_at)}</td></tr>
        </table>
        <p style="color:#666;font-size:12px;border-top:1px solid #eee;padding-top:10px">Portail Crèches</p>
      </div>`
    );

    res.redirect('/tableau-de-bord');
  } catch (e) {
    console.error('Approve error:', e.message);
    req.session.flash = { error: `Erreur lors de l'approbation : ${e.message}`, success: null };
    res.redirect(`/commandes/${orderId}`);
  }
});

// Reject order
app.post('/commandes/:id/refuser', requireAuth, async (req, res) => {
  const orderId = req.params.id;
  try {
    const { comment } = req.body;
    const order = await updateOrderTags(orderId, 'en-attente-validation', 'refusé');

    if (comment && comment.trim()) {
      const existingNote = order.note || '';
      const timestamp = formatDate(new Date().toISOString());
      const updatedNote = [existingNote, `[REFUS — ${timestamp}] ${comment.trim()}`]
        .filter(Boolean)
        .join('\n\n');
      await shopifyRest('PUT', `orders/${orderId}.json`, {
        order: { id: parseInt(orderId), note: updatedNote },
      });
    }

    const name = getCustomerName(order);
    const company = getCompanyName(order);

    await sendNotification(
      `Commande #${order.order_number} refusée — ${company || name}`,
      `<div style="font-family:Arial,sans-serif;max-width:600px;padding:20px">
        <h2 style="color:#dc2626;border-bottom:2px solid #dc2626;padding-bottom:10px">❌ Commande refusée</h2>
        <p>La commande <strong>#${order.order_number}</strong> a été <strong>refusée</strong> par le Portail Crèches.</p>
        <table style="width:100%;border-collapse:collapse;margin:20px 0">
          <tr style="background:#fef2f2"><td style="padding:10px;font-weight:bold;width:40%">Client</td><td style="padding:10px">${name}</td></tr>
          ${company ? `<tr><td style="padding:10px;font-weight:bold">Établissement</td><td style="padding:10px">${company}</td></tr>` : ''}
          <tr style="background:#fef2f2"><td style="padding:10px;font-weight:bold">Total</td><td style="padding:10px">${parseFloat(order.total_price).toFixed(2)} ${order.currency}</td></tr>
          <tr><td style="padding:10px;font-weight:bold">Date</td><td style="padding:10px">${formatDate(order.created_at)}</td></tr>
          ${comment ? `<tr style="background:#fef2f2"><td style="padding:10px;font-weight:bold;color:#dc2626">Motif du refus</td><td style="padding:10px;color:#dc2626">${comment}</td></tr>` : ''}
        </table>
        <p style="color:#666;font-size:12px;border-top:1px solid #eee;padding-top:10px">Portail Crèches</p>
      </div>`
    );

    res.redirect('/tableau-de-bord');
  } catch (e) {
    console.error('Reject error:', e.message);
    req.session.flash = { error: `Erreur lors du refus : ${e.message}`, success: null };
    res.redirect(`/commandes/${orderId}`);
  }
});

// All products in collection (AJAX — initial load)
app.get('/api/produits/collection', requireAuth, async (req, res) => {
  try {
    const data = await shopifyRest(
      'GET',
      'products.json?collection_id=644698014029&limit=250&status=active'
    );
    const results = [];
    for (const product of data.products || []) {
      for (const variant of product.variants) {
        results.push({
          variantId: variant.id,
          productTitle: product.title,
          variantTitle: variant.title !== 'Default Title' ? variant.title : null,
          price: parseFloat(variant.price).toFixed(2),
          sku: variant.sku || '',
        });
      }
    }
    res.json(results);
  } catch (e) {
    console.error('Collection products error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Product search API (AJAX)
app.get('/api/produits/recherche', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json([]);

    const data = await shopifyRest(
      'GET',
      `products.json?collection_id=644698014029&title=${encodeURIComponent(q)}&limit=10&status=active`
    );

    const results = [];
    for (const product of data.products || []) {
      for (const variant of product.variants) {
        results.push({
          variantId: variant.id,
          productTitle: product.title,
          variantTitle: variant.title !== 'Default Title' ? variant.title : null,
          price: parseFloat(variant.price).toFixed(2),
          sku: variant.sku || '',
        });
      }
    }
    res.json(results.slice(0, 20));
  } catch (e) {
    console.error('Product search error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ================================================================
// CRÈCHE SELF-SERVICE PORTAL
// ================================================================

// --- Registration ---

app.get('/creche/register', (req, res) => {
  if (req.session.crecheId) return res.redirect('/creche/commande');
  res.render('creche-register', { error: null, success: null });
});

app.post('/creche/register', async (req, res) => {
  const { name, contact, email, password, phone, address } = req.body;

  if (!name || !contact || !email || !password || !address) {
    return res.render('creche-register', {
      error: 'Veuillez remplir tous les champs obligatoires.',
      success: null,
    });
  }

  const creches = readJson(CRECHES_FILE);
  if (creches.find(c => c.email.toLowerCase() === email.toLowerCase())) {
    return res.render('creche-register', {
      error: 'Un compte avec cette adresse email existe déjà.',
      success: null,
    });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const newCreche = {
    id: crypto.randomUUID(),
    name: name.trim(),
    contact: contact.trim(),
    email: email.trim().toLowerCase(),
    password: hashedPassword,
    phone: (phone || '').trim(),
    address: address.trim(),
    status: 'pending_approval',
    createdAt: new Date().toISOString(),
  };

  creches.push(newCreche);
  writeJson(CRECHES_FILE, creches);

  res.render('creche-register', {
    error: null,
    success: 'Votre compte est en attente de validation par l\'enseigne. Vous recevrez une confirmation dès que votre accès sera activé.',
  });
});

// --- Login ---

app.get('/creche/login', (req, res) => {
  if (req.session.crecheId) return res.redirect('/creche/commande');
  res.render('creche-login', { error: null });
});

app.post('/creche/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.render('creche-login', { error: 'Veuillez remplir tous les champs.' });
  }

  const creches = readJson(CRECHES_FILE);
  const creche = creches.find(c => c.email === email.trim().toLowerCase());

  if (!creche || !(await bcrypt.compare(password, creche.password))) {
    return res.render('creche-login', { error: 'Email ou mot de passe incorrect.' });
  }

  if (creche.status === 'pending_approval') {
    return res.render('creche-login', {
      error: 'Votre compte n\'est pas encore approuvé par l\'enseigne. Veuillez patienter.',
    });
  }

  if (creche.status === 'rejected') {
    return res.render('creche-login', {
      error: 'Votre demande d\'accès a été refusée. Veuillez contacter l\'enseigne.',
    });
  }

  req.session.crecheId = creche.id;
  req.session.crecheName = creche.name;
  res.redirect('/creche/commande');
});

app.get('/creche/deconnexion', requireCrecheAuth, (req, res) => {
  req.session.destroy(() => res.redirect('/creche/login'));
});

// --- Order page ---

app.get('/creche/commande', requireCrecheAuth, async (req, res) => {
  const flash = req.session.flash || {};
  delete req.session.flash;

  try {
    const data = await shopifyRest(
      'GET',
      'products.json?collection_id=644698014029&limit=250&status=active'
    );
    const products = [];
    for (const product of data.products || []) {
      for (const variant of product.variants) {
        products.push({
          variantId: String(variant.id),
          productTitle: product.title,
          variantTitle: variant.title !== 'Default Title' ? variant.title : null,
          price: parseFloat(variant.price).toFixed(2),
          sku: variant.sku || '',
        });
      }
    }

    res.render('creche-commande', {
      products,
      crecheName: req.session.crecheName,
      discountRate: CRECHE_DISCOUNT_RATE,
      error: flash.error || null,
      success: flash.success || null,
    });
  } catch (e) {
    console.error('Creche commande load error:', e.message);
    res.render('creche-commande', {
      products: [],
      crecheName: req.session.crecheName,
      discountRate: CRECHE_DISCOUNT_RATE,
      error: 'Impossible de charger les produits. Veuillez réessayer.',
      success: null,
    });
  }
});

app.post('/creche/commande', requireCrecheAuth, async (req, res) => {
  const { qty, ptitle, pvtitle, pprice, psku } = req.body;

  const items = [];
  if (qty && typeof qty === 'object') {
    for (const [variantId, quantity] of Object.entries(qty)) {
      const qtyNum = parseInt(quantity) || 0;
      if (qtyNum > 0) {
        items.push({
          variantId,
          productTitle: (ptitle && ptitle[variantId]) || '',
          variantTitle: (pvtitle && pvtitle[variantId]) || null,
          price: (pprice && pprice[variantId]) || '0',
          sku: (psku && psku[variantId]) || '',
          quantity: qtyNum,
        });
      }
    }
  }

  if (items.length === 0) {
    req.session.flash = { error: 'Veuillez sélectionner au moins un produit.' };
    return res.redirect('/creche/commande');
  }

  const total = items
    .reduce((sum, item) => sum + parseFloat(item.price) * item.quantity, 0)
    .toFixed(2);

  const order = {
    id: crypto.randomUUID(),
    crecheId: req.session.crecheId,
    crecheName: req.session.crecheName,
    items,
    total,
    status: 'en_attente',
    createdAt: new Date().toISOString(),
    rejectionReason: null,
    shopifyOrderId: null,
    shopifyOrderNumber: null,
  };

  const orders = readJson(ORDERS_FILE);
  orders.push(order);
  writeJson(ORDERS_FILE, orders);

  req.session.flash = {
    success: 'Votre commande a été envoyée à l\'enseigne pour validation.',
  };
  res.redirect('/creche/commande');
});

// ================================================================
// ADMIN — CRÈCHE MANAGEMENT
// ================================================================

app.get('/admin/creches', requireAuth, (req, res) => {
  const flash = req.session.flash || {};
  delete req.session.flash;
  const creches = readJson(CRECHES_FILE);
  creches.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render('admin-creches', {
    creches,
    error: flash.error || null,
    success: flash.success || null,
  });
});

app.post('/admin/creches/:id/approuver', requireAuth, (req, res) => {
  const creches = readJson(CRECHES_FILE);
  const idx = creches.findIndex(c => c.id === req.params.id);
  if (idx !== -1) {
    creches[idx].status = 'approved';
    writeJson(CRECHES_FILE, creches);
    req.session.flash = { success: `Crèche "${creches[idx].name}" approuvée.` };
  }
  res.redirect('/admin/creches');
});

app.post('/admin/creches/:id/rejeter', requireAuth, (req, res) => {
  const creches = readJson(CRECHES_FILE);
  const idx = creches.findIndex(c => c.id === req.params.id);
  if (idx !== -1) {
    creches[idx].status = 'rejected';
    writeJson(CRECHES_FILE, creches);
    req.session.flash = { success: `Crèche "${creches[idx].name}" refusée.` };
  }
  res.redirect('/admin/creches');
});

// ================================================================
// ADMIN — CRÈCHE ORDERS MANAGEMENT
// ================================================================

app.get('/admin/commandes-creches', requireAuth, (req, res) => {
  const flash = req.session.flash || {};
  delete req.session.flash;
  const orders = readJson(ORDERS_FILE);
  orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render('admin-commandes-creches', {
    orders,
    discountRate: CRECHE_DISCOUNT_RATE,
    error: flash.error || null,
    success: flash.success || null,
  });
});

app.get('/admin/commandes-creches/:id/facture', requireAuth, (req, res) => {
  const orders = readJson(ORDERS_FILE);
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.redirect('/admin/commandes-creches');
  const creches = readJson(CRECHES_FILE);
  const creche = creches.find(c => c.id === order.crecheId) || null;
  res.render('facture', {
    order,
    creche,
    discountRate: CRECHE_DISCOUNT_RATE,
    pharmacyName: process.env.PHARMACY_NAME || 'Pharmacie Gillain',
  });
});

app.post('/admin/commandes-creches/:id/approuver', requireAuth, async (req, res) => {
  const orders = readJson(ORDERS_FILE);
  const idx = orders.findIndex(o => o.id === req.params.id);

  if (idx === -1) {
    req.session.flash = { error: 'Commande introuvable.' };
    return res.redirect('/admin/commandes-creches');
  }

  const order = orders[idx];
  const creches = readJson(CRECHES_FILE);
  const creche = creches.find(c => c.id === order.crecheId);

  if (!creche) {
    req.session.flash = { error: 'Crèche associée à cette commande introuvable.' };
    return res.redirect('/admin/commandes-creches');
  }

  try {
    const shopifyOrder = await createShopifyOrderForCreche(order, creche);
    orders[idx].status = 'approuvee';
    orders[idx].shopifyOrderId = String(shopifyOrder.id);
    orders[idx].shopifyOrderNumber = shopifyOrder.order_number;
    writeJson(ORDERS_FILE, orders);
    req.session.flash = {
      success: `Commande de ${order.crecheName} approuvée — commande Shopify #${shopifyOrder.order_number} créée.`,
    };
  } catch (e) {
    console.error('Shopify order creation error:', e.message);
    req.session.flash = {
      error: `Erreur lors de la création de la commande Shopify : ${e.message}`,
    };
  }

  res.redirect('/admin/commandes-creches');
});

app.post('/admin/commandes-creches/:id/rejeter', requireAuth, (req, res) => {
  const { reason } = req.body;
  const orders = readJson(ORDERS_FILE);
  const idx = orders.findIndex(o => o.id === req.params.id);

  if (idx !== -1) {
    orders[idx].status = 'rejetee';
    orders[idx].rejectionReason = (reason || '').trim() || null;
    writeJson(ORDERS_FILE, orders);
    req.session.flash = { success: `Commande de ${orders[idx].crecheName} refusée.` };
  }

  res.redirect('/admin/commandes-creches');
});

// ================================================================

app.listen(PORT, () => {
  console.log(`Portail Approbation Crèches démarré sur http://localhost:${PORT}`);
});
