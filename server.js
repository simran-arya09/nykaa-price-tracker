const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'nykaa_secret';
const app = express();
app.use(express.json());
app.use(express.static('public'));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const db = (sql, params) => pool.query(sql, params);

async function initDB() {
  try {
    await db(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name VARCHAR(255), email VARCHAR(255) UNIQUE, password_hash VARCHAR(255), created_at TIMESTAMP DEFAULT NOW())`);
    await db(`CREATE TABLE IF NOT EXISTS products (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), name VARCHAR(500), url TEXT UNIQUE, current_price NUMERIC(10,2), image_url TEXT, added_date TIMESTAMP DEFAULT NOW())`);
    await db(`CREATE TABLE IF NOT EXISTS price_history (id SERIAL PRIMARY KEY, product_id INTEGER REFERENCES products(id), price NUMERIC(10,2), timestamp TIMESTAMP DEFAULT NOW())`);
    console.log('DB ready');
  } catch (e) {
    console.log('DB error:', e.message);
  }
}
initDB();

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Not authenticated' });
  }
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const hash = await bcrypt.hash(password, 10);
    const result = await db('INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id', [name, email.toLowerCase(), hash]);
    const token = jwt.sign({ id: result.rows[0].id, name, email: email.toLowerCase() }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: result.rows[0].id, name, email: email.toLowerCase() } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await db('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = result.rows[0];
    if (!user || !await bcrypt.compare(password, user.password_hash)) {
      return res.status(401).json({ error: 'Wrong credentials' });
    }
    const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const result = await db('SELECT id, name, email FROM users WHERE id = $1', [req.user.id]);
    res.json(result.rows[0]);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/products/add', auth, async (req, res) => {
  try {
    const { url } = req.body;
    if (!url.includes('nykaa.com')) return res.status(400).json({ error: 'Invalid URL' });
    
    const response = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = cheerio.load(response.data);
    const name = $('meta[property="og:title"]').attr('content') || 'Product';
    const price = parseFloat($('meta[property="product:price:amount"]').attr('content') || '0');
    
    if (!price) return res.status(400).json({ error: 'Could not find price' });
    
    const result = await db('INSERT INTO products (user_id, name, url, current_price) VALUES ($1, $2, $3, $4) RETURNING id', [req.user.id, name, url, price]);
    await db('INSERT INTO price_history (product_id, price) VALUES ($1, $2)', [result.rows[0].id, price]);
    
    res.json({ id: result.rows[0].id, name, url, current_price: price });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Nykaa is blocking requests' });
  }
});

app.get('/api/products', auth, async (req, res) => {
  try {
    const result = await db('SELECT * FROM products WHERE user_id = $1 ORDER BY added_date DESC', [req.user.id]);
    res.json(result.rows);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/products/:id', auth, async (req, res) => {
  try {
    await db('DELETE FROM price_history WHERE product_id = $1', [req.params.id]);
    await db('DELETE FROM products WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server on ${PORT}`));