const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const cookie = require("cookie");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const Datastore = require("nedb-promises");
const Stripe = require("stripe");
require("dotenv").config();

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" }) : null;

const app = express();
const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });
const usersDb = Datastore.create({ filename: path.join(dataDir, "users.db"), autoload: true });
const sessionsDb = Datastore.create({ filename: path.join(dataDir, "sessions.db"), autoload: true });
const eventsDb = Datastore.create({ filename: path.join(dataDir, "events.db"), autoload: true });

usersDb.ensureIndex({ fieldName: "email", unique: true, sparse: true });
usersDb.ensureIndex({ fieldName: "google_id", unique: true, sparse: true });
usersDb.ensureIndex({ fieldName: "stripe_customer_id", unique: true, sparse: true });
sessionsDb.ensureIndex({ fieldName: "token_hash", unique: true });
sessionsDb.ensureIndex({ fieldName: "expires_at" });
eventsDb.ensureIndex({ fieldName: "user_id" });

const nowIso = () => new Date().toISOString();

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const sessionCookieOptions = () => ({
  httpOnly: true,
  sameSite: "lax",
  secure: BASE_URL.startsWith("https://"),
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
});

const setSessionCookie = (res, token) => {
  res.setHeader("Set-Cookie", cookie.serialize("sid", token, sessionCookieOptions()));
};

const clearSessionCookie = (res) => {
  res.setHeader("Set-Cookie", cookie.serialize("sid", "", { ...sessionCookieOptions(), maxAge: 0 }));
};

const createSession = async (userId) => {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
  await sessionsDb.insert({ token_hash: tokenHash, user_id: userId, expires_at: expiresAt });
  return token;
};

const getUserFromRequest = async (req) => {
  const cookies = cookie.parse(req.headers.cookie || "");
  if (!cookies.sid) return null;
  const tokenHash = sha256(cookies.sid);
  const session = await sessionsDb.findOne({ token_hash: tokenHash, expires_at: { $gt: nowIso() } });
  if (!session) return null;
  const user = await usersDb.findOne({ _id: session.user_id });
  return user || null;
};

const isPaidStatus = (status) => status === "active" || status === "trialing";

passport.use(
  new GoogleStrategy(
    {
      clientID: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      callbackURL: `${BASE_URL}/auth/google/callback`,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const googleId = profile.id;
        const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
        if (!googleId || !email) return done(null, false);

        let user = await usersDb.findOne({ google_id: googleId });
        if (!user) {
          try {
            user = await usersDb.insert({ email, google_id: googleId, created_at: nowIso() });
          } catch (err) {
            user = await usersDb.findOne({ email });
            if (user && !user.google_id) {
              await usersDb.update({ _id: user._id }, { $set: { google_id: googleId } });
              user = await usersDb.findOne({ _id: user._id });
            }
          }
        }
        return done(null, user);
      } catch (err) {
        return done(err);
      }
    }
  )
);

app.post("/webhook/stripe", express.raw({ type: "application/json" }), (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.sendStatus(400);

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    const subscription = event.data.object;
    usersDb.update(
      { stripe_customer_id: subscription.customer },
      { $set: { stripe_subscription_status: subscription.status } }
    );
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    if (session.customer) {
      usersDb.update(
        { stripe_customer_id: session.customer },
        { $set: { stripe_subscription_status: "active" } }
      );
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(passport.initialize());

app.use(async (req, res, next) => {
  req.user = await getUserFromRequest(req);
  next();
});

const requireAuth = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "Nepřihlášený uživatel." });
  next();
};

const requirePaid = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "Nepřihlášený uživatel." });
  if (!isPaidStatus(req.user.stripe_subscription_status)) {
    return res.status(403).json({ error: "Bez aktivního předplatného." });
  }
  next();
};

app.get("/api/auth/me", (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({
    user: {
      id: req.user._id,
      email: req.user.email,
      subscriptionStatus: req.user.stripe_subscription_status || null,
      isPaid: isPaidStatus(req.user.stripe_subscription_status),
    },
  });
});

app.post("/api/auth/register", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: "Zadejte e-mail a heslo (min. 8 znaků)." });
  }
  const exists = await usersDb.findOne({ email });
  if (exists) return res.status(400).json({ error: "Účet už existuje." });
  const passwordHash = bcrypt.hashSync(password, 10);
  const user = await usersDb.insert({ email, password_hash: passwordHash, created_at: nowIso() });
  const token = await createSession(user._id);
  setSessionCookie(res, token);
  return res.json({ ok: true });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const user = await usersDb.findOne({ email });
  if (!user || !user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(400).json({ error: "Nesprávný e-mail nebo heslo." });
  }
  const token = await createSession(user._id);
  setSessionCookie(res, token);
  return res.json({ ok: true });
});

app.post("/api/auth/logout", requireAuth, async (req, res) => {
  const cookies = cookie.parse(req.headers.cookie || "");
  if (cookies.sid) {
    await sessionsDb.remove({ token_hash: sha256(cookies.sid) }, { multi: false });
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/auth/google", (req, res, next) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(501).send("Google OAuth není nakonfigurovaný.");
  }
  return passport.authenticate("google", { scope: ["profile", "email"], session: false })(req, res, next);
});

app.get(
  "/auth/google/callback",
  (req, res, next) => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return res.status(501).send("Google OAuth není nakonfigurovaný.");
    }
    return passport.authenticate("google", { session: false })(req, res, next);
  },
  async (req, res) => {
    const token = await createSession(req.user._id);
    setSessionCookie(res, token);
    res.redirect("/");
  }
);

app.post("/api/stripe/checkout", requireAuth, async (req, res) => {
  if (!stripe || !STRIPE_PRICE_ID) {
    return res.status(500).json({ error: "Stripe není nakonfigurovaný." });
  }
  let customerId = req.user.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: req.user.email });
    customerId = customer.id;
    await usersDb.update({ _id: req.user._id }, { $set: { stripe_customer_id: customerId } });
  }
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
    allow_promotion_codes: true,
    success_url: `${BASE_URL}/?checkout=success`,
    cancel_url: `${BASE_URL}/?checkout=cancel`,
  });
  res.json({ url: session.url });
});

app.get("/api/events", requirePaid, async (req, res) => {
  const { month } = req.query;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: "Chybí parametr month ve formátu YYYY-MM." });
  }
  const [year, monthIndex] = month.split("-").map(Number);
  const start = `${year}-${String(monthIndex).padStart(2, "0")}-01`;
  const endDate = new Date(year, monthIndex, 0);
  const end = `${year}-${String(monthIndex).padStart(2, "0")}-${String(endDate.getDate()).padStart(2, "0")}`;

  const rows = await eventsDb
    .find({ user_id: req.user._id, date_key: { $gte: start, $lte: end } })
    .sort({ date_key: 1, time: 1 })
    .exec();

  const grouped = {};
  rows.forEach((row) => {
    if (!grouped[row.date_key]) grouped[row.date_key] = [];
    grouped[row.date_key].push({
      id: row._id,
      date_key: row.date_key,
      time: row.time,
      title: row.title,
    });
  });
  res.json({ events: grouped });
});

app.post("/api/events", requirePaid, async (req, res) => {
  const { dateKey, time, title } = req.body || {};
  if (!dateKey || !title) {
    return res.status(400).json({ error: "Chybí datum nebo název." });
  }
  const event = await eventsDb.insert({
    user_id: req.user._id,
    date_key: dateKey,
    time: time || null,
    title: title.trim(),
    created_at: nowIso(),
  });
  res.json({ id: event._id });
});

app.delete("/api/events/:id", requirePaid, async (req, res) => {
  const id = req.params.id;
  await eventsDb.remove({ _id: id, user_id: req.user._id }, { multi: false });
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server běží na ${BASE_URL}`);
});
