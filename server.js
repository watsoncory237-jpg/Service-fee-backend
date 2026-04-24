require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const Stripe = require("stripe");

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const PORT = process.env.PORT || 3001;
const CHARGE_THRESHOLD = 0.50;

app.use("/api/webhook", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      balance NUMERIC(10,2) NOT NULL DEFAULT 0,
      total_charged NUMERIC(10,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      platform TEXT NOT NULL,
      amount NUMERIC(10,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getOrCreateUser(userId) {
  await pool.query(`INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [userId]);
  const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
  return rows[0];
}

app.get("/api/balance/:userId", async (req, res) => {
  try {
    const user = await getOrCreateUser(req.params.userId);
    const { rows: txns } = await pool.query(`SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [user.id]);
    res.json({ balance: parseFloat(user.balance), totalCharged: parseFloat(user.total_charged), transactions: txns, readyToCharge: parseFloat(user.balance) >= CHARGE_THRESHOLD, threshold: CHARGE_THRESHOLD });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/add-fee", async (req, res) => {
  const { userId, platform, feeAmount } = req.body;
  if (!userId || !platform || typeof feeAmount !== "number") return res.status(400).json({ error: "Missing fields" });
  if (feeAmount < 0.01 || feeAmount > 0.10) return res.status(400).json({ error: "feeAmount must be $0.01-$0.10" });
  try {
    await getOrCreateUser(userId);
    await pool.query(`UPDATE users SET balance = balance + $1 WHERE id = $2`, [feeAmount, userId]);
    await pool.query(`INSERT INTO transactions (id, user_id, platform, amount) VALUES ($1, $2, $3, $4)`, [`txn_${Date.now()}`, userId, platform, feeAmount]);
    const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
    const balance = parseFloat(rows[0].balance);
    res.json({ balance, readyToCharge: balance >= CHARGE_THRESHOLD, threshold: CHARGE_THRESHOLD });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/create-payment-intent", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    const user = await getOrCreateUser(userId);
    const balance = parseFloat(user.balance);
    if (balance < CHARGE_THRESHOLD) return res.status(400).json({ error: `Balance $${balance.toFixed(2)} below minimum` });
    const amountCents = Math.round(balance * 100);
    const paymentIntent = await stripe.paymentIntents.create({ amount: amountCents, currency: "usd", automatic_payment_methods: { enabled: true }, metadata: { userId } });
    res.json({ clientSecret: paymentIntent.client_secret, amount: balance });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/clear-balance", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  try {
    await pool.query(`UPDATE users SET total_charged = total_charged + balance, balance = 0 WHERE id = $1`, [userId]);
    await pool.query(`DELETE FROM transactions WHERE user_id = $1`, [userId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/health", async (req, res) => {
  try { await pool.query("SELECT 1"); res.json({ status: "ok", timestamp: new Date().toISOString() }); }
  catch { res.status(500).json({ status: "db_error" }); }
});

initDB().then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`))).catch(err => { console.error(err); process.exit(1); });
