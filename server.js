const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();
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

const db = new sqlite3.Database('./tracker.db', (err) => {
  if (err) console.error('DB Error:', err);
  else console.log('SQLite connected');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 1,
    name TEXT,
    url TEXT,
    current_price REAL,
    image_url TEXT,
    added_date TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, url)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER,
    price REAL,
    timestamp TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER,
    old_price REAL,
    new_price REAL,
    discount_percent REAL,
    timestamp TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`ALTER TABLE products ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`, () => {});
  db.run(`ALTER TABLE products ADD COLUMN image_url TEXT`, () => {});
  db.run(`ALTER TABLE products ADD COLUMN mrp REAL`, () => {});
  db.run(`ALTER TABLE products ADD COLUMN on_sale INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE alerts ADD COLUMN alert_type TEXT DEFAULT 'price_drop'`, () => {});
});

const dbGet = (sql, params) => new Promise((res, rej) => db.get(sql, params, (e, r) => e ? rej(e) : res(r)));
const dbAll = (sql, params) => new Promise((res, rej) => db.all(sql, params, (e, r) => e ? rej(e) : res(r)));
const dbRun = (sql, params) => new Promise((res, rej) => db.run(sql, params, function(e) { e ? rej(e) : res(this); }));

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

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
];

function randomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }
function randomDelay(min=2000, max=5000) { return new Promise(r => setTimeout(r, min + Math.random()*(max-min))); }

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

// Try Nykaa's internal product JSON API — bypasses HTML scraping entirely
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
        // Try multiple JSON shapes Nykaa uses
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
          const currentPrice = parseFloat(String(price).replace(/[^\d.]/g,''));
          const mrp = mrpRaw ? parseFloat(String(mrpRaw).replace(/[^\d.]/g,'')) : null;
          return { success: true, name: String(name), currentPrice, mrp: (mrp && mrp > currentPrice) ? mrp : null, imageUrl: image || null, source: 'api' };
        }
      }
    } catch {}
  }
  return null;
}

function extractProductId(url) {
  const fromPath = url.match(/\/p\/(\d+)/);
  if (fromPath) return fromPath[1];
  const fromQuery = url.match(/[?&]productId=(\d+)/);
  if (fromQuery) return fromQuery[1];
  return null;
}

function cleanName(raw) {
  if (!raw) return '';
  let s = raw;
  // Remove full @media blocks with nested braces
  for (let i = 0; i < 5; i++) s = s.replace(/@media[^{]*\{[^{}]*\}/g, '');
  // Remove remaining CSS class blocks
  for (let i = 0; i < 5; i++) s = s.replace(/\.?css-[a-z0-9]+[^{]*\{[^{}]*\}/gi, '');
  // Remove leftover @media prefixes (no braces left)
  s = s.replace(/@media[^(]*\([^)]*\)[^A-Za-z₹]*/g, '');
  // Remove stray braces and their content
  s = s.replace(/\{[^{}]*\}/g, '');
  // Collapse whitespace
  return s.replace(/\s+/g, ' ').trim();
}

function parseHtml(html) {
  const $ = cheerio.load(html);

  // Name — og:title is always clean; h1 may have CSS injected by styled-components
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

  // Price — try meta tags first (often reliable), then DOM selectors
  let price = null;
  let mrp = null;
  const ogPrice = $('meta[property="product:price:amount"]').attr('content') ||
                  $('meta[name="twitter:data1"]').attr('content');
  if (ogPrice) { const p = parseFloat(ogPrice.replace(/[^\d.]/g,'')); if (p > 0) price = p; }
  const salePriceMeta = $('meta[property="product:sale_price:amount"]').attr('content');
  if (salePriceMeta) {
    const sp = parseFloat(salePriceMeta.replace(/[^\d.]/g,''));
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
  // MRP from strikethrough / del / s elements
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
  // Try __NEXT_DATA__ for price too
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
    } catch {}
  }

  // Image
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
    } catch {}
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
      } catch {}
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
    // Strategy 1: internal JSON API (fastest, cleanest, no HTML parsing)
    const productId = extractProductId(url);
    if (productId) {
      await randomDelay(500, 1500);
      const apiResult = await tryNykaaApi(productId);
      if (apiResult) {
        console.log(`[scraper] Got product via API: ${apiResult.name}`);
        return apiResult;
      }
    }

    // Strategy 2: fetch HTML page with full browser impersonation
    await randomDelay(2000, 4000);
    const ua = randomUA();
    const response = await axios.get(url, {
      headers: browserHeaders(ua),
      timeout: 30000,
      validateStatus: () => true,
      maxRedirects: 5,
    });

    if (response.status === 403 || response.status === 429) {
      // Strategy 3: retry once with a different UA and longer wait
      console.log(`[scraper] Got ${response.status}, retrying with different UA...`);
      await randomDelay(5000, 8000);
      const retry = await axios.get(url, {
        headers: browserHeaders(randomUA()),
        timeout: 30000,
        validateStatus: () => true,
        maxRedirects: 5,
      });
      if (retry.status === 403 || retry.status === 429) {
        return { success: false, error: 'Nykaa is blocking automated requests right now. Try again in a few minutes.' };
      }
      if (retry.status !== 200) return { success: false, error: `HTTP ${retry.status}` };
      const parsed = parseHtml(retry.data);
      if (!parsed.price) return { success: false, error: 'Could not find price. The page may have loaded differently.' };
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
    const existing = await dbGet('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });
    const hash = await bcrypt.hash(password, 10);
    const result = await dbRun('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)', [name.trim(), email.toLowerCase(), hash]);
    const token = jwt.sign({ id: result.lastID, name: name.trim(), email: email.toLowerCase() }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res.json({ token, user: { id: result.lastID, name: name.trim(), email: email.toLowerCase() } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const user = await dbGet('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
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
  const user = await dbGet('SELECT id, name, email, created_at FROM users WHERE id = ?', [req.user.id]);
  res.json(user);
});

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email, name, newPassword } = req.body;
    if (!email || !name || !newPassword) return res.status(400).json({ error: 'Email, name and new password are required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const user = await dbGet('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (!user) return res.status(404).json({ error: 'No account with that email' });
    if (user.name.toLowerCase().trim() !== name.toLowerCase().trim()) {
      return res.status(401).json({ error: 'Name does not match our records' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await dbRun('UPDATE users SET password_hash = ? WHERE id = ?', [hash, user.id]);
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
    const onSale = (data.mrp && data.currentPrice < data.mrp) ? 1 : 0;
    const result = await dbRun(
      'INSERT OR IGNORE INTO products (user_id, name, url, current_price, mrp, on_sale, image_url) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.user.id, data.name, url, data.currentPrice, data.mrp || null, onSale, data.imageUrl || null]
    );
    if (result.changes === 0) return res.status(409).json({ error: 'You are already tracking this product' });
    await dbRun('INSERT INTO price_history (product_id, price) VALUES (?, ?)', [result.lastID, data.currentPrice]);
    res.json({ id: result.lastID, name: data.name, url, current_price: data.currentPrice, mrp: data.mrp, on_sale: onSale, image_url: data.imageUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual add — when scraping is blocked, user provides name + price
app.post('/api/products/add-manual', authMiddleware, async (req, res) => {
  try {
    const { url, name, price, mrp } = req.body;
    if (!url || !name || !price) return res.status(400).json({ error: 'URL, name and price are required' });
    if (!url.includes('nykaa.com')) return res.status(400).json({ error: 'Please use a valid Nykaa product URL' });
    const currentPrice = parseFloat(price);
    const mrpVal = mrp ? parseFloat(mrp) : null;
    if (isNaN(currentPrice) || currentPrice <= 0) return res.status(400).json({ error: 'Invalid price' });
    const onSale = (mrpVal && currentPrice < mrpVal) ? 1 : 0;
    const result = await dbRun(
      'INSERT OR IGNORE INTO products (user_id, name, url, current_price, mrp, on_sale, image_url) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.user.id, name.trim(), url, currentPrice, mrpVal, onSale, null]
    );
    if (result.changes === 0) return res.status(409).json({ error: 'You are already tracking this product' });
    await dbRun('INSERT INTO price_history (product_id, price) VALUES (?, ?)', [result.lastID, currentPrice]);
    res.json({ id: result.lastID, name: name.trim(), url, current_price: currentPrice, mrp: mrpVal, on_sale: onSale, image_url: null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/products', authMiddleware, async (req, res) => {
  const products = await dbAll('SELECT * FROM products WHERE user_id = ? ORDER BY added_date DESC', [req.user.id]);
  res.json(products);
});

app.get('/api/products/:id/history', authMiddleware, async (req, res) => {
  const product = await dbGet('SELECT id FROM products WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!product) return res.status(404).json({ error: 'Not found' });
  const history = await dbAll('SELECT * FROM price_history WHERE product_id = ? ORDER BY timestamp ASC', [req.params.id]);
  res.json(history);
});

app.post('/api/products/:id/refresh', authMiddleware, async (req, res) => {
  try {
    const product = await dbGet('SELECT * FROM products WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!product) return res.status(404).json({ error: 'Not found' });
    const data = await scrapeProduct(product.url);
    if (!data.success) return res.status(500).json({ error: data.error });
    const oldPrice = product.current_price;
    const newPrice = data.currentPrice;
    const newMrp = data.mrp || product.mrp || null;
    const nowOnSale = (newMrp && newPrice < newMrp) ? 1 : 0;
    const wasOnSale = product.on_sale || 0;
    await dbRun(
      'UPDATE products SET current_price = ?, mrp = COALESCE(?, mrp), on_sale = ?, image_url = COALESCE(?, image_url), name = ? WHERE id = ?',
      [newPrice, newMrp, nowOnSale, data.imageUrl || null, data.name, product.id]
    );
    // Only record history when price actually changes
    const lastEntry = await dbGet('SELECT price FROM price_history WHERE product_id = ? ORDER BY timestamp DESC LIMIT 1', [product.id]);
    if (!lastEntry || lastEntry.price !== newPrice) {
      await dbRun('INSERT INTO price_history (product_id, price) VALUES (?, ?)', [product.id, newPrice]);
    }
    let dropped = false;
    let saleStarted = false;
    if (newPrice < oldPrice) {
      dropped = true;
      const pct = ((oldPrice - newPrice) / oldPrice) * 100;
      await dbRun(
        'INSERT INTO alerts (product_id, old_price, new_price, discount_percent, alert_type) VALUES (?, ?, ?, ?, ?)',
        [product.id, oldPrice, newPrice, pct, 'price_drop']
      );
      console.log(`[alert] Price drop on "${data.name}": ₹${oldPrice} → ₹${newPrice} (${pct.toFixed(1)}% off)`);
    }
    if (nowOnSale && !wasOnSale) {
      saleStarted = true;
      const pct = newMrp > 0 ? ((newMrp - newPrice) / newMrp) * 100 : 0;
      await dbRun(
        'INSERT INTO alerts (product_id, old_price, new_price, discount_percent, alert_type) VALUES (?, ?, ?, ?, ?)',
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
  const alerts = await dbAll(
    `SELECT a.*, p.name, p.image_url FROM alerts a
     LEFT JOIN products p ON a.product_id = p.id
     WHERE p.user_id = ? ORDER BY a.timestamp DESC`,
    [req.user.id]
  );
  res.json(alerts);
});

app.post('/api/products/fix-images', authMiddleware, async (req, res) => {
  const products = await dbAll('SELECT * FROM products WHERE user_id = ? AND (image_url IS NULL OR image_url = "")', [req.user.id]);
  res.json({ total: products.length });
  for (const p of products) {
    const data = await scrapeProduct(p.url);
    if (data.success && data.imageUrl) {
      await dbRun('UPDATE products SET image_url = ? WHERE id = ?', [data.imageUrl, p.id]);
    }
  }
});

app.delete('/api/products/:id', authMiddleware, async (req, res) => {
  const product = await dbGet('SELECT id FROM products WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!product) return res.status(404).json({ error: 'Not found' });
  await dbRun('DELETE FROM alerts WHERE product_id = ?', [req.params.id]);
  await dbRun('DELETE FROM price_history WHERE product_id = ?', [req.params.id]);
  await dbRun('DELETE FROM products WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// ── Startup: clean dirty CSS-injected names already in DB ─────────────────────
setTimeout(async () => {
  try {
    const products = await dbAll('SELECT id, name FROM products', []);
    for (const p of products) {
      if (p.name && p.name.includes('{')) {
        const cleaned = cleanName(p.name);
        if (cleaned !== p.name) {
          await dbRun('UPDATE products SET name = ? WHERE id = ?', [cleaned, p.id]);
          console.log(`[migrate] Cleaned name for product ${p.id}: "${cleaned}"`);
        }
      }
    }
  } catch (e) { console.error('[migrate] Name cleanup failed:', e.message); }
}, 3000);

// ── Cron ──────────────────────────────────────────────────────────────────────

cron.schedule('*/15 * * * *', async () => {
  const products = await dbAll('SELECT * FROM products', []);
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
      const nowOnSale = (newMrp && newPrice < newMrp) ? 1 : 0;
      const wasOnSale = p.on_sale || 0;
      await dbRun(
        'UPDATE products SET current_price = ?, mrp = COALESCE(?, mrp), on_sale = ?, image_url = COALESCE(?, image_url), name = ? WHERE id = ?',
        [newPrice, newMrp, nowOnSale, data.imageUrl || null, data.name, p.id]
      );
      // Only insert price history when price actually changes
      const lastEntry = await dbGet('SELECT price FROM price_history WHERE product_id = ? ORDER BY timestamp DESC LIMIT 1', [p.id]);
      if (!lastEntry || lastEntry.price !== newPrice) {
        await dbRun('INSERT INTO price_history (product_id, price) VALUES (?, ?)', [p.id, newPrice]);
        console.log(`[cron] Price changed for "${data.name}": ₹${oldPrice} → ₹${newPrice}`);
      }
      if (newPrice < oldPrice) {
        const pct = ((oldPrice - newPrice) / oldPrice) * 100;
        await dbRun(
          'INSERT INTO alerts (product_id, old_price, new_price, discount_percent, alert_type) VALUES (?, ?, ?, ?, ?)',
          [p.id, oldPrice, newPrice, pct, 'price_drop']
        );
        console.log(`[cron] 🔔 PRICE DROP on "${data.name}": ₹${oldPrice} → ₹${newPrice} (${pct.toFixed(1)}% off)`);
      }
      if (nowOnSale && !wasOnSale) {
        const pct = newMrp > 0 ? ((newMrp - newPrice) / newMrp) * 100 : 0;
        await dbRun(
          'INSERT INTO alerts (product_id, old_price, new_price, discount_percent, alert_type) VALUES (?, ?, ?, ?, ?)',
          [p.id, newMrp, newPrice, pct, 'sale']
        );
        console.log(`[cron] 🏷️ SALE started on "${data.name}": MRP ₹${newMrp} → ₹${newPrice} (${pct.toFixed(1)}% off)`);
      }
    } catch (e) {
      console.error(`[cron] Error processing product ${p.id}:`, e.message);
    }
  }
  console.log(`[cron] Done.`);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
