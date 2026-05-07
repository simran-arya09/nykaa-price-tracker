const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const { Pool } = require('pg');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'nykaa_tracker_secret_2024';
const JWT_EXPIRES = '30d';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── PostgreSQL Setup ──────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/nykaa_tracker',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

pool.on('connect', () => {
  console.log('PostgreSQL connected');
});

const dbQuery = (sql, params = []) => pool.query(sql, params);

// ── Initialize Database ───────────────────────────────────────────────────────

async function initDB() {
  try {
    await dbQuery(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await dbQuery(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(500),
        url TEXT UNIQUE,
        current_price NUMERIC(10, 2),
        mrp NUMERIC(10, 2),
        image_url TEXT,
        on_sale BOOLEAN DEFAULT FALSE,
        added_date TIMESTAMP DEFAULT NOW()
      )
    `);

    await dbQuery(`
      CREATE TABLE IF NOT EXISTS price_history (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        price NUMERIC(10, 2),
        timestamp TIMESTAMP DEFAULT NOW()
      )
    `);

    await dbQuery(`
      CREATE TABLE IF NOT EXISTS alerts (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        old_price NUMERIC(10, 2),
        new_price NUMERIC(10, 2),
        discount_percent NUMERIC(5, 2),
        alert_type VARCHAR(50) DEFAULT 'price_drop',
        timestamp TIMESTAMP DEFAULT NOW()
      )
    `);

    console.log('Database tables initialized');
  } catch (e) {
    console.error('DB init error:', e.message);
  }
}

initDB();

// ── Auth Middleware ──────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'Not authenticated' });
  const token = header.replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

// ── Scraper Configuration ────────────────────────────────────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
];

function randomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }
function randomDelay(min = 5000, max = 10000) { return new Promise(r => setTimeout(r, min + Math.random() * (max - min))); }

function browserHeaders(ua) {
  return {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://www.nykaa.com/',
    'Origin': 'https://www.nykaa.com',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Upgrade-Insecure-Requests': '1',
    'DNT': '1',
    'Cache-Control': 'max-age=0',
    'Connection': 'keep-alive',
  };
}

async function tryNykaaApi(productId) {
  const endpoints = [
    `https://www.nykaa.com/api/product/products/${productId}?channel=web&version=v2`,
    `https://www.nykaa.com/api/product/v2/detail?id=${productId}&type=product&channel=web`,
  ];
  for (const endpoint of endpoints) {
    try {
      const res = await axios.get(endpoint, {
        headers: {
          ...browserHeaders(randomUA()),
          'Accept': 'application/json, text/plain, */*',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'X-Requested-With': 'XMLHttpRequest',
        },
        timeout: 15000,
        validateStatus: () => true,
      });
      if (res.status === 200 && res.data) {
        const d = res.data;
        const product = d.data?.product || d.product || d.data || d;
        const name = product.name || product.title || product.productName;
        const price = product.price || product.offerPrice || product.sellingPrice ||
                      product.priceDetails?.offerPrice || product.priceDetails?.price;
        const mrpRaw = product.mrp || product.mrpPrice || product.maximumRetailPrice ||
                       product.crossedPrice || product.regularPrice ||
                       product.priceDetails?.mrp || product.priceDetails?.maximumRetailPrice;
        const image = product.imageUrl || product.image_url || product.images?.[0]?.url ||
                      product.media?.[0]?.url || product.productImages?.[0];
        if (name && price) {
          const currentPrice = parseFloat(String(price).replace(/[^\d.]/g, ''));
          const mrp = mrpRaw ? parseFloat(String(mrpRaw).replace(/[^\d.]/g, '')) : null;
          return { success: true, name: String(name), currentPrice, mrp: (mrp && mrp > currentPrice) ? mrp : null, imageUrl: image || null, source: 'api' };
        }
      }
    } catch { }
  }
  return null;
}

function extractProductId(url) {
  const patterns = [
    /\/p\/(\d+)/,
    /[?&]productId=(\d+)/,
    /\/products\/(\d+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[match.length - 1];
  }
  return null;
}

function cleanName(raw) {
  if (!raw) return '';
  let s = raw;
  for (let i = 0; i < 5; i++) s = s.replace(/@media[^{]*\{[^{}]*\}/g, '');
  for (let i = 0; i < 5; i++) s = s.replace(/\.?css-[a-z0-9]+[^{]*\{[^{}]*\}/gi, '');
  s = s.replace(/@media[^(]*\([^)]*\)[^A-Za-z₹]*/g, '');
  s = s.replace(/\{[^{}]*\}/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

function parseHtml(html) {
  const $ = cheerio.load(html);

  let name = '';
  const ogTitle = $('meta[property="og:title"]').attr('content') || $('meta[name="og:title"]').attr('content');
  if (ogTitle) {
    name = ogTitle.replace(/\s*[\|–\-].*$/, '').trim();
  }
  if (!name) {
    const h1 = $('h1').first().clone();
    h1.find('style, script').remove();
    name = cleanName(h1.text());
  }
  if (!name) {
    name = $('title').text().replace(/[-|–].*$/, '').trim();
  }
  if (!name) name = 'Product';

  let price = null;
  let mrp = null;
  const ogPrice = $('meta[property="product:price:amount"]').attr('content') ||
                  $('meta[name="twitter:data1"]').attr('content');
  if (ogPrice) { const p = parseFloat(ogPrice.replace(/[^\d.]/g, '')); if (p > 0) price = p; }
  const salePriceMeta = $('meta[property="product:sale_price:amount"]').attr('content');
  if (salePriceMeta) {
    const sp = parseFloat(salePriceMeta.replace(/[^\d.]/g, ''));
    if (sp > 0 && price && sp < price) { mrp = price; price = sp; }
  }
  if (!price) {
    const priceSelectors = [
      'span.css-1jczs19', '[class*="pdpPrice"]', '[class*="PdpPrice"]',
      'span[class*="price"]', '.price-container span', '[data-testid*="price"]',
      'span[class*="Price"]', 'div[class*="price"] span',
    ];
    for (const sel of priceSelectors) {
      const text = $(sel).first().text().replace(/[^\d.]/g, '');
      const p = parseFloat(text);
      if (p && p > 0) { price = p; break; }
    }
  }
  if (!mrp) {
    const mrpSelectors = [
      'span.css-17x46n5', '[class*="mrp"]', '[class*="MRP"]',
      'span.price-info-mrp', 'del', 's',
    ];
    for (const sel of mrpSelectors) {
      const text = $(sel).first().text().replace(/[^\d.]/g, '');
      const p = parseFloat(text);
      if (p && p > 0 && (!price || p > price)) { mrp = p; break; }
    }
  }
  if (!price || !mrp) {
    try {
      const nextData = $('#__NEXT_DATA__').html();
      if (nextData) {
        if (!price) {
          const match = nextData.match(/"(?:offerPrice|sellingPrice)"\s*:\s*(\d+(?:\.\d+)?)/);
          if (match) price = parseFloat(match[1]);
        }
        if (!mrp) {
          const mrpMatch = nextData.match(/"(?:mrp|maximumRetailPrice|crossedPrice|regularPrice)"\s*:\s*(\d+(?:\.\d+)?)/);
          if (mrpMatch) { const m = parseFloat(mrpMatch[1]); if (!price || m > price) mrp = m; }
        }
      }
    } catch { }
  }

  let imageUrl = null;
  const ogImage = $('meta[property="og:image"]').attr('content') || $('meta[name="og:image"]').attr('content');
  if (ogImage && ogImage.startsWith('http')) imageUrl = ogImage;
  if (!imageUrl) {
    const twImg = $('meta[name="twitter:image"]').attr('content') || $('meta[property="twitter:image"]').attr('content');
    if (twImg && twImg.startsWith('http')) imageUrl = twImg;
  }
  if (!imageUrl) {
    try {
      const nextData = $('#__NEXT_DATA__').html();
      if (nextData) {
        const m = nextData.match(/"(?:imageUrl|image_url|imageURL)"\s*:\s*"(https?:\/\/[^"]+)"/);
        if (m) imageUrl = m[1];
      }
    } catch { }
  }
  if (!imageUrl) {
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html());
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          const img = item.image || item.logo;
          if (img) { imageUrl = Array.isArray(img) ? img[0] : img; return false; }
        }
      } catch { }
    });
  }
  if (!imageUrl) {
    $('img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || '';
      if ((src.includes('akamai') || src.includes('nykaa') || src.includes('cloudinary')) &&
          src.startsWith('http') && !src.includes('logo') && !src.includes('icon')) {
        imageUrl = src; return false;
      }
    });
  }

  return { name, price, mrp: (mrp && (!price || mrp > price)) ? mrp : null, imageUrl };
}

async function scrapeProduct(url) {
  try {
    const productId = extractProductId(url);
    if (productId) {
      await randomDelay(500, 1500);
      const apiResult = await tryNykaaApi(productId);
      if (apiResult) {
        console.log(`[scraper] Got product via API: ${apiResult.name}`);
        return apiResult;
      }
    }

    await randomDelay(5000, 10000);
    const ua = randomUA();
    const response = await axios.get(url, {
      headers: browserHeaders(ua),
      timeout: 30000,
      validateStatus: () => true,
      maxRedirects: 5,
    });

    if (response.status === 403 || response.status === 429) {
      console.log(`[scraper] Got ${response.status}, retrying with different UA...`);
      await randomDelay(10000, 15000);
      const retry = await axios.get(url, {
        headers: browserHeaders(randomUA()),
        timeout: 30000,
        validateStatus: () => true,
        maxRedirects: 5,
      });
      if (retry.status === 403 || retry.status === 429) {
        return { success: false, error: 'Nykaa is blocking automated requests. Try again in a few minutes.' };
      }
      if (retry.status !== 200) return { success: false, error: `HTTP ${retry.status}` };
      const parsed = parseHtml(retry.data);
      if (!parsed.price) return { success: false, error: 'Could not find price. Page may have loaded differently.' };
      return { success: true, name: parsed.name, currentPrice: parsed.price, mrp: parsed.mrp, imageUrl: parsed.imageUrl };
    }

    if (response.status !== 200) return { success: false, error: `HTTP ${response.status}` };

    const parsed = parseHtml(response.data);
    if (!parsed.price) return { success: false, error: 'Could not find price on this page.' };
    console.log(`[scraper] Got product via HTML: ${parsed.name}${parsed.mrp ? ` (MRP ₹${parsed.mrp})` : ''}`);
    return { success: true, name: parsed.name, currentPrice: parsed.price, mrp: parsed.mrp, imageUrl: parsed.imageUrl };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Auth Routes ───────────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    
    const existing = await dbQuery('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'An account with this email already exists' });
    
    const hash = await bcrypt.hash(password, 10);
    const result = await dbQuery(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [name.trim(), email.toLowerCase(), hash]
    );
    
    const userId = result.rows[0].id;
    const token = jwt.sign({ id: userId, name: name.trim(), email: email.toLowerCase() }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res.json({ token, user: { id: userId, name: name.trim(), email: email.toLowerCase() } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    
    const result = await dbQuery('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = result.rows[0];
    
    if (!user) return res.status(401).json({ error: 'No account found with this email' });
    
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect password' });
    
    const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const result = await dbQuery('SELECT id, name, email, created_at FROM users WHERE id = $1', [req.user.id]);
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email, name, newPassword } = req.body;
    if (!email || !name || !newPassword) return res.status(400).json({ error: 'Email, name and new password are required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    
    const result = await dbQuery('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = result.rows[0];
    
    if (!user) return res.status(404).json({ error: 'No account with that email' });
    if (user.name.toLowerCase().trim() !== name.toLowerCase().trim()) {
      return res.status(401).json({ error: 'Name does not match our records' });
    }
    
    const hash = await bcrypt.hash(newPassword, 10);
    await dbQuery('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Product Routes ────────────────────────────────────────────────────────────

app.post('/api/products/add', authMiddleware, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    if (!url.includes('nykaa.com')) return res.status(400).json({ error: 'Please use a valid Nykaa product URL' });
    
    const data = await scrapeProduct(url);
    if (!data.success) return res.status(500).json({ error: data.error });
    
    const onSale = (data.mrp && data.currentPrice < data.mrp) ? true : false;
    try {
      const result = await dbQuery(
        'INSERT INTO products (user_id, name, url, current_price, mrp, on_sale, image_url) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
        [req.user.id, data.name, url, data.currentPrice, data.mrp || null, onSale, data.imageUrl || null]
      );
      
      const productId = result.rows[0].id;
      await dbQuery('INSERT INTO price_history (product_id, price) VALUES ($1, $2)', [productId, data.currentPrice]);
      
      res.json({ id: productId, name: data.name, url, current_price: data.currentPrice, mrp: data.mrp, on_sale: onSale, image_url: data.imageUrl });
    } catch (e) {
      if (e.code === '23505') { // unique violation
        return res.status(409).json({ error: 'You are already tracking this product' });
      }
      throw e;
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/products', authMiddleware, async (req, res) => {
  try {
    const result = await dbQuery('SELECT * FROM products WHERE user_id = $1 ORDER BY added_date DESC', [req.user.id]);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/products/:id/history', authMiddleware, async (req, res) => {
  try {
    const product = await dbQuery('SELECT id FROM products WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (product.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    
    const history = await dbQuery('SELECT * FROM price_history WHERE product_id = $1 ORDER BY timestamp ASC', [req.params.id]);
    res.json(history.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/products/:id/refresh', authMiddleware, async (req, res) => {
  try {
    const productResult = await dbQuery('SELECT * FROM products WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (productResult.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    
    const product = productResult.rows[0];
    const data = await scrapeProduct(product.url);
    if (!data.success) return res.status(500).json({ error: data.error });
    
    const oldPrice = product.current_price;
    const newPrice = data.currentPrice;
    const newMrp = data.mrp || product.mrp || null;
    const nowOnSale = (newMrp && newPrice < newMrp) ? true : false;
    const wasOnSale = product.on_sale || false;
    
    await dbQuery(
      'UPDATE products SET current_price = $1, mrp = COALESCE($2, mrp), on_sale = $3, image_url = COALESCE($4, image_url), name = $5 WHERE id = $6',
      [newPrice, newMrp, nowOnSale, data.imageUrl || null, data.name, product.id]
    );
    
    const lastEntry = await dbQuery('SELECT price FROM price_history WHERE product_id = $1 ORDER BY timestamp DESC LIMIT 1', [product.id]);
    if (lastEntry.rows.length === 0 || lastEntry.rows[0].price !== newPrice) {
      await dbQuery('INSERT INTO price_history (product_id, price) VALUES ($1, $2)', [product.id, newPrice]);
    }
    
    let dropped = false;
    let saleStarted = false;
    
    if (newPrice < oldPrice) {
      dropped = true;
      const pct = ((oldPrice - newPrice) / oldPrice) * 100;
      await dbQuery(
        'INSERT INTO alerts (product_id, old_price, new_price, discount_percent, alert_type) VALUES ($1, $2, $3, $4, $5)',
        [product.id, oldPrice, newPrice, pct, 'price_drop']
      );
      console.log(`[alert] Price drop on "${data.name}": ₹${oldPrice} → ₹${newPrice} (${pct.toFixed(1)}% off)`);
    }
    
    if (nowOnSale && !wasOnSale) {
      saleStarted = true;
      const pct = newMrp > 0 ? ((newMrp - newPrice) / newMrp) * 100 : 0;
      await dbQuery(
        'INSERT INTO alerts (product_id, old_price, new_price, discount_percent, alert_type) VALUES ($1, $2, $3, $4, $5)',
        [product.id, newMrp, newPrice, pct, 'sale']
      );
      console.log(`[alert] 🏷️ SALE started on "${data.name}": MRP ₹${newMrp} → ₹${newPrice} (${pct.toFixed(1)}% off)`);
    }
    
    res.json({ success: true, old_price: oldPrice, new_price: newPrice, mrp: newMrp, on_sale: nowOnSale, dropped, sale_started: saleStarted, name: data.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/alerts', authMiddleware, async (req, res) => {
  try {
    const result = await dbQuery(
      `SELECT a.*, p.name, p.image_url FROM alerts a
       LEFT JOIN products p ON a.product_id = p.id
       WHERE p.user_id = $1 ORDER BY a.timestamp DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/products/:id', authMiddleware, async (req, res) => {
  try {
    const product = await dbQuery('SELECT id FROM products WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (product.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    
    await dbQuery('DELETE FROM alerts WHERE product_id = $1', [req.params.id]);
    await dbQuery('DELETE FROM price_history WHERE product_id = $1', [req.params.id]);
    await dbQuery('DELETE FROM products WHERE id = $1', [req.params.id]);
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Cron Job (Every 15 minutes) ───────────────────────────────────────────────

cron.schedule('*/15 * * * *', async () => {
  try {
    const result = await dbQuery('SELECT * FROM products');
    const products = result.rows;
    console.log(`[cron] Checking prices for ${products.length} products at ${new Date().toISOString()}`);
    
    for (const p of products) {
      try {
        const data = await scrapeProduct(p.url);
        if (!data.success) {
          console.log(`[cron] Scrape failed for product ${p.id}: ${data.error}`);
          continue;
        }
        
        const oldPrice = p.current_price;
        const newPrice = data.currentPrice;
        const newMrp = data.mrp || p.mrp || null;
        const nowOnSale = (newMrp && newPrice < newMrp) ? true : false;
        const wasOnSale = p.on_sale || false;
        
        await dbQuery(
          'UPDATE products SET current_price = $1, mrp = COALESCE($2, mrp), on_sale = $3, image_url = COALESCE($4, image_url), name = $5 WHERE id = $6',
          [newPrice, newMrp, nowOnSale, data.imageUrl || null, data.name, p.id]
        );
        
        const lastEntry = await dbQuery('SELECT price FROM price_history WHERE product_id = $1 ORDER BY timestamp DESC LIMIT 1', [p.id]);
        if (lastEntry.rows.length === 0 || lastEntry.rows[0].price !== newPrice) {
          await dbQuery('INSERT INTO price_history (product_id, price) VALUES ($1, $2)', [p.id, newPrice]);
          console.log(`[cron] Price changed for "${data.name}": ₹${oldPrice} → ₹${newPrice}`);
        }
        
        if (newPrice < oldPrice) {
          const pct = ((oldPrice - newPrice) / oldPrice) * 100;
          await dbQuery(
            'INSERT INTO alerts (product_id, old_price, new_price, discount_percent, alert_type) VALUES ($1, $2, $3, $4, $5)',
            [p.id, oldPrice, newPrice, pct, 'price_drop']
          );
          console.log(`[cron] 🔔 PRICE DROP on "${data.name}": ₹${oldPrice} → ₹${newPrice} (${pct.toFixed(1)}% off)`);
        }
        
        if (nowOnSale && !wasOnSale) {
          const pct = newMrp > 0 ? ((newMrp - newPrice) / newMrp) * 100 : 0;
          await dbQuery(
            'INSERT INTO alerts (product_id, old_price, new_price, discount_percent, alert_type) VALUES ($1, $2, $3, $4, $5)',
            [p.id, newMrp, newPrice, pct, 'sale']
          );
          console.log(`[cron] 🏷️ SALE started on "${data.name}": MRP ₹${newMrp} → ₹${newPrice} (${pct.toFixed(1)}% off)`);
        }
      } catch (e) {
        console.error(`[cron] Error processing product ${p.id}:`, e.message);
      }
    }
    console.log(`[cron] Done.`);
  } catch (e) {
    console.error('[cron] Job failed:', e.message);
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Database: ${process.env.DATABASE_URL ? 'PostgreSQL (Railway)' : 'PostgreSQL (Local)'}`);
});
