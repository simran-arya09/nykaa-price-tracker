const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const PORT = 5000;

// Middleware
app.use(express.json());

// ==================== DATABASE SETUP ====================
const dbPath = path.join(__dirname, 'tracker.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('DB Error:', err);
  else console.log('✅ Connected to SQLite database');
});

// Create tables on startup
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT UNIQUE NOT NULL,
      current_price REAL,
      added_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      price REAL NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(product_id) REFERENCES products(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      old_price REAL,
      new_price REAL,
      discount_percent REAL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(product_id) REFERENCES products(id)
    )
  `);
});

// ==================== SCRAPER FUNCTION ====================
async function scrapeProduct(url) {
  try {
    console.log('🔄 Scraping product...');
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 15000
    });

    const $ = cheerio.load(response.data);

    // Extract product name
    const productName = $('h1').first().text().trim() || 'Unknown Product';
    
    // Extract price
    let priceText = $('span.css-1jczs19').first().text();
    if (!priceText) priceText = $('[data-testid="discountedPrice"]').first().text();
    if (!priceText) priceText = $('.productDiscountedPrice').first().text();
    
    const currentPrice = parseFloat(priceText.replace(/[^\d.]/g, ''));

    if (!currentPrice || isNaN(currentPrice)) {
      return {
        success: false,
        error: 'Could not extract price from page'
      };
    }

    console.log('✅ Scraped:', productName, '- ₹' + currentPrice);

    return {
      name: productName,
      currentPrice: currentPrice,
      success: true
    };

  } catch (error) {
    console.error('❌ Scrape error:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

// ==================== API ROUTES ====================

// 1. ADD PRODUCT
app.post('/api/products/add', async (req, res) => {
  const { url } = req.body;

  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const productData = await scrapeProduct(url);

    if (!productData.success) {
      return res.status(500).json({ error: 'Failed to scrape: ' + productData.error });
    }

    db.run(
      `INSERT INTO products (name, url, current_price) VALUES (?, ?, ?)`,
      [productData.name, url, productData.currentPrice],
      function (err) {
        if (err) {
          if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Product already being tracked' });
          }
          return res.status(500).json({ error: 'Database error' });
        }

        const productId = this.lastID;

        db.run(
          `INSERT INTO price_history (product_id, price) VALUES (?, ?)`,
          [productId, productData.currentPrice]
        );

        res.json({
          id: productId,
          name: productData.name,
          url: url,
          current_price: productData.currentPrice,
          message: '✅ Product added successfully!'
        });
      }
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. GET ALL PRODUCTS
app.get('/api/products', (req, res) => {
  db.all(
    `SELECT id, name, url, current_price, added_date FROM products ORDER BY added_date DESC`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

// 3. GET SINGLE PRODUCT
app.get('/api/products/:id', (req, res) => {
  db.get(
    `SELECT * FROM products WHERE id = ?`,
    [req.params.id],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Product not found' });
      res.json(row);
    }
  );
});

// 4. GET PRICE HISTORY
app.get('/api/products/:id/history', (req, res) => {
  db.all(
    `SELECT price, timestamp FROM price_history WHERE product_id = ? ORDER BY timestamp ASC`,
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

// 5. REFRESH PRODUCT PRICE
app.post('/api/products/:id/refresh', async (req, res) => {
  db.get(
    `SELECT url, current_price FROM products WHERE id = ?`,
    [req.params.id],
    async (err, product) => {
      if (err || !product) return res.status(404).json({ error: 'Product not found' });

      try {
        const productData = await scrapeProduct(product.url);
        if (!productData.success) throw new Error(productData.error);

        const newPrice = productData.currentPrice;

        db.run(`UPDATE products SET current_price = ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?`, 
          [newPrice, req.params.id]);

        db.run(`INSERT INTO price_history (product_id, price) VALUES (?, ?)`, 
          [req.params.id, newPrice]);

        if (newPrice < product.current_price) {
          const discountPercent = ((product.current_price - newPrice) / product.current_price) * 100;
          db.run(
            `INSERT INTO alerts (product_id, old_price, new_price, discount_percent) VALUES (?, ?, ?, ?)`,
            [req.params.id, product.current_price, newPrice, discountPercent]
          );
        }

        res.json({
          success: true,
          old_price: product.current_price,
          new_price: newPrice,
          message: newPrice < product.current_price ? '✅ Price dropped!' : 'No change'
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    }
  );
});

// 6. GET ALERTS
app.get('/api/alerts', (req, res) => {
  db.all(
    `SELECT a.*, p.name FROM alerts a JOIN products p ON a.product_id = p.id ORDER BY a.timestamp DESC`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows || []);
    }
  );
});

// 7. DELETE PRODUCT
app.delete('/api/products/:id', (req, res) => {
  db.run(`DELETE FROM alerts WHERE product_id = ?`, [req.params.id]);
  db.run(`DELETE FROM price_history WHERE product_id = ?`, [req.params.id]);
  db.run(`DELETE FROM products WHERE id = ?`, [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Product deleted' });
  });
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║  🚀 NYKAA PRICE TRACKER SERVER         ║
║  Running on http://localhost:${PORT}    ║
║  Database: tracker.db                  ║
╚════════════════════════════════════════╝
  `);
});