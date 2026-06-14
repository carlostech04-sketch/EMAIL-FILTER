const express = require("express");
const nodemailer = require("nodemailer");
const mongoose = require("mongoose");
require("dotenv").config();

const app = express();
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.header("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json());

mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/emailmgr")
  .then(() => console.log("MongoDB connected"))
  .catch(e => console.error("MongoDB error:", e.message));

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
});
const Send = mongoose.model("Send", sendSchema);

app.post("/send", async (req, res) => {
  try {
    const { host, port, user, pass, from, to, subject, body, fromName, trackingId } = req.body;
    if (!host || !user || !pass || !from || !to || !subject || !body)
      return res.status(400).json({ error: "All fields required" });

    const transporter = nodemailer.createTransport({
      host, port: parseInt(port) || 587,
      secure: parseInt(port) === 465,
      auth: { user, pass },
    });

    const fromAddr = fromName ? `${fromName} <${from}>` : from;

    let htmlBody = body;
    let textBody = body.replace(/<[^>]*>/g, "");

    if (trackingId) {
      const pixel = `<img src="${process.env.PUBLIC_URL || "http://localhost:3000"}/track/${trackingId}" width="1" height="1" alt="" />`;
      htmlBody = body.includes("<html") ? body.replace("</body>", pixel + "</body>") : body + pixel;
    }

    const info = await transporter.sendMail({
      from: fromAddr, to, subject,
      html: body.includes("<") ? htmlBody : undefined,
      text: body.includes("<") ? textBody : body,
    });

    await Send.create({
      email: to,
      trackingId: trackingId || undefined,
      subject,
      status: "sent",
      batchDate: new Date().toISOString().slice(0, 10),
    });

    res.json({ success: true, messageId: info.messageId });
  } catch (e) {
    if (req.body.trackingId) {
      await Send.create({
        email: req.body.to,
        trackingId: req.body.trackingId,
        subject: req.body.subject,
        status: "failed",
        error: e.message,
        batchDate: new Date().toISOString().slice(0, 10),
      }).catch(() => {});
    }
    res.status(500).json({ error: e.message });
  }
});

app.get("/track/:id", async (req, res) => {
  res.set("Content-Type", "image/gif");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.send(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));

  try {
    await Send.findOneAndUpdate(
      { trackingId: req.params.id, opened: false },
      { opened: true, openedAt: new Date() }
    );
  } catch (e) { /* ignore */ }
});

app.get("/api/reports", async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const sends = await Send.find().sort({ sentAt: -1 }).limit(200);
    const todaySends = sends.filter(s => s.batchDate === today);
    const stats = {
      todaySent: todaySends.filter(s => s.status === "sent").length,
      todayFailed: todaySends.filter(s => s.status === "failed").length,
      todayOpened: todaySends.filter(s => s.opened).length,
      totalSent: await Send.countDocuments({ status: "sent" }),
      totalOpened: await Send.countDocuments({ opened: true }),
      totalFailed: await Send.countDocuments({ status: "failed" }),
    };
    res.json({ sends, stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Backend on port " + PORT));
