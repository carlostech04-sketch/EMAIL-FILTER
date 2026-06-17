const dns = require("dns");

function ipv4Lookup(hostname, opts, cb) {
  dns.resolve4(hostname, (err, addresses) => {
    if (err || !addresses || !addresses.length) return dns.lookup(hostname, { family: 4, hints: dns.ADDRCONFIG }, cb);
    cb(null, addresses[0], 4);
  });
}

const express = require("express");
const nodemailer = require("nodemailer");
const mongoose = require("mongoose");
require("dotenv").config();

const app = express();

// Handle CORS manually
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.header("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.static("."));

mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/emailmgr")
  .then(() => console.log("MongoDB connected"))
  .catch(e => console.error("MongoDB error:", e.message));

const campaignSchema = new mongoose.Schema({
  name: { type: String, required: true },
  smtpHost: String,
  smtpUser: String,
  smtpFrom: String,
  totalSent: { type: Number, default: 0 },
  totalOpened: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});
const Campaign = mongoose.model("Campaign", campaignSchema);

const sendSchema = new mongoose.Schema({
  email: String,
  trackingId: { type: String, unique: true, sparse: true },
  sentAt: { type: Date, default: Date.now },
  openedAt: Date,
  opened: { type: Boolean, default: false },
  subject: String,
  status: String,
  error: String,
  batchDate: String,
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign" },
});
const Send = mongoose.model("Send", sendSchema);

function parseBool(value) {
  if (typeof value === "boolean") return value;
  if (value == null) return undefined;
  return ["1", "true", "yes", "ssl", "tls"].includes(String(value).toLowerCase());
}

function getSmtpConfig(body) {
  const port = parseInt(process.env.SMTP_PORT || body.port || "465", 10);
  const secure = parseBool(process.env.SMTP_SECURE ?? body.secure) ?? port === 465;
  const user = process.env.SMTP_USER || body.user;
  const pass = process.env.SMTP_PASS || body.pass;
  const from = process.env.SMTP_FROM || body.from || user;

  return {
    host: process.env.SMTP_HOST || body.host || "smtp.gmail.com",
    port,
    secure,
    user,
    pass,
    from,
  };
}

app.post("/send", async (req, res) => {
  try {
    const { to, subject, body, fromName, trackingId, campaignId } = req.body;
    const smtp = getSmtpConfig(req.body);
    if (!smtp.host || !smtp.user || !smtp.pass || !smtp.from || !to || !subject || !body) {
      return res.status(400).json({ error: "SMTP config, recipient, subject, and body are required" });
    }

    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.pass },
      connectionTimeout: 8000,
      greetingTimeout: 6000,
      socketTimeout: 10000,
      lookup: ipv4Lookup,
    });

    const fromAddr = fromName ? `${fromName} <${smtp.from}>` : smtp.from;

    let htmlBody = body;
    let textBody = body.replace(/<[^>]*>/g, "");

    if (trackingId) {
      const pixel = `<img src="${process.env.PUBLIC_URL || "http://localhost:3000"}/track/${trackingId}" width="1" height="1" alt="" />`;
      htmlBody = body.includes("<html") ? body.replace("</body>", pixel + "</body>") : body + pixel;
    }

    const info = await transporter.sendMail({
      from: fromAddr, to, subject,
      html: htmlBody,
      text: textBody,
    });

    if (trackingId) {
      const doc = { email: to, trackingId, subject, status: "sent", batchDate: new Date().toISOString().slice(0,10) };
      if (campaignId) doc.campaignId = campaignId;
      await Send.create(doc).catch(() => {});
      if (campaignId) {
        await Campaign.findByIdAndUpdate(campaignId, { $inc: { totalSent: 1 } }).catch(() => {});
      }
    }

    res.json({ success: true, messageId: info.messageId });
  } catch (e) {
    console.error("Send error:", e.code || e.command || "", e.message);
    if (req.body.trackingId) {
      const doc = { email: req.body.to, trackingId: req.body.trackingId, subject: req.body.subject, status: "failed", error: e.message, batchDate: new Date().toISOString().slice(0,10) };
      if (req.body.campaignId) doc.campaignId = req.body.campaignId;
      await Send.create(doc).catch(() => {});
    }
    res.status(500).json({ error: e.message });
  }
});

app.get("/track/:id", async (req, res) => {
  res.set("Content-Type", "image/gif");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.send(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));

  try {
    const updated = await Send.findOneAndUpdate(
      { trackingId: req.params.id, opened: false },
      { opened: true, openedAt: new Date() },
      { new: true }
    );
    if (updated && updated.campaignId) {
      await Campaign.findByIdAndUpdate(updated.campaignId, { $inc: { totalOpened: 1 } }).catch(() => {});
    }
  } catch (e) { /* ignore */ }
});

app.get("/api/campaigns", async (req, res) => {
  try {
    const campaigns = await Campaign.find().sort({ createdAt: -1 }).lean();
    res.json(campaigns);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/campaigns", async (req, res) => {
  try {
    const { name, smtpHost, smtpUser, smtpFrom } = req.body;
    const campaign = await Campaign.create({ name: name || "Campaign " + Date.now(), smtpHost, smtpUser, smtpFrom });
    res.json(campaign);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/reports", async (req, res) => {
  try {
    const { campaignId } = req.query;
    const filter = {};
    if (campaignId) filter.campaignId = campaignId;
    const today = new Date().toISOString().slice(0, 10);
    const sends = await Send.find(filter).sort({ sentAt: -1 }).limit(200);
    const todaySends = sends.filter(s => s.batchDate === today);
    const stats = {
      todaySent: todaySends.filter(s => s.status === "sent").length,
      todayFailed: todaySends.filter(s => s.status === "failed").length,
      todayOpened: todaySends.filter(s => s.opened).length,
      totalSent: await Send.countDocuments({ ...filter, status: "sent" }),
      totalOpened: await Send.countDocuments({ ...filter, opened: true }),
      totalFailed: await Send.countDocuments({ ...filter, status: "failed" }),
    };
    res.json({ sends, stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/export", async (req, res) => {
  try {
    const filter = { opened: true };
    let label = "all_campaigns";
    let campaignName = null;
    if (req.query.campaignId) {
      filter.campaignId = req.query.campaignId;
      const campaign = await Campaign.findById(req.query.campaignId).lean();
      campaignName = campaign ? campaign.name : null;
      label = campaignName ? campaignName.replace(/[^a-zA-Z0-9]/g,"_") : "campaign";
    }
    const sends = await Send.find(filter).sort({ openedAt: -1 }).lean();
    // Resolve campaign names for all sends
    const campIds = [...new Set(sends.map(s => s.campaignId).filter(id => id != null))];
    const camps = campIds.length ? await Campaign.find({ _id: { $in: campIds } }).lean() : [];
    const campMap = {};
    camps.forEach(c => campMap[c._id] = c.name);

    const BOM = "\uFEFF";
    let csv = BOM + "Email,Subject,Campaign,Sent At,Opened At\n";
    sends.forEach(s => {
      const cName = s.campaignId ? (campMap[s.campaignId] || String(s.campaignId).slice(-6)) : "—";
      const sent = s.sentAt ? new Date(s.sentAt).toLocaleString() : "";
      const opened = s.openedAt ? new Date(s.openedAt).toLocaleString() : "";
      csv += `"${s.email}","${(s.subject || "").replace(/"/g,'""')}","${cName}","${sent}","${opened}"\n`;
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="opens_${label}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Backend on port " + PORT));
