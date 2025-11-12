// server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import multer from "multer";
import path from "path";
import fs from "fs";
import cors from "cors";
import axios from "axios";
import FormData from "form-data";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

function getAllowedOrigins() {
  const fromEnv = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const defaults = [
    "http://localhost:5173",
    "http://localhost:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:3000",
    "https://reqviem.vercel.app",
    "https://www.reqviem.vercel.app",
    "https://reqviem-backend.vercel.app",
  ];
  return Array.from(new Set([...fromEnv, ...defaults]));
}
const ALLOWED_ORIGINS = getAllowedOrigins();

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      console.warn("Socket.IO CORS blocked origin:", origin);
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      console.warn("HTTP CORS blocked origin:", origin);
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true,
  })
);
app.options(/.*/, cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const uploadsDir = path.join(process.cwd(), "uploads_tmp");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const isServerless = Boolean(process.env.RENDER || process.env.VERCEL);
const storage = isServerless
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (req, file, cb) => cb(null, uploadsDir),
      filename: (req, file, cb) =>
        cb(null, Date.now() + path.extname(file.originalname)),
    });
const upload = multer({ storage });

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ error: "Nenhum arquivo enviado" });

    const IMGBB_KEY = process.env.IMGBB_API_KEY;
    if (!IMGBB_KEY)
      return res
        .status(500)
        .json({ error: "IMGBB_API_KEY não configurada no servidor" });

    const form = new FormData();
    form.append("key", IMGBB_KEY);

    if (isServerless) {
      const base64 = req.file.buffer.toString("base64");
      form.append("image", base64);
    } else {
      form.append("image", fs.createReadStream(req.file.path));
    }

    const resp = await axios.post("https://api.imgbb.com/1/upload", form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 60000,
    });

    if (!isServerless && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {}
    }

    const url = resp.data?.data?.url || resp.data?.data?.display_url;
    if (!url)
      return res
        .status(500)
        .json({ error: "Erro: Imgbb não retornou URL válida", raw: resp.data });

    res.json({ url });
  } catch (err) {
    console.error("❌ Erro upload Imgbb:", err.response?.data || err.message);
    res.status(500).json({
      error: "Falha no upload",
      details: err.response?.data || err.message,
    });
  }
});

const musicDir = path.join(__dirname, "musicas");
if (!fs.existsSync(musicDir)) {
  try {
    fs.mkdirSync(musicDir);
  } catch (e) {
    console.warn("Não foi possível criar pasta musicas:", e);
  }
}
app.use("/musicas", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.setHeader("Accept-Ranges", "bytes");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(
  "/musicas",
  express.static(musicDir, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".mp3")) {
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Accept-Ranges", "bytes");
      } else if (filePath.endsWith(".m4a")) {
        res.setHeader("Content-Type", "audio/mp4");
        res.setHeader("Accept-Ranges", "bytes");
      }
    },
  })
);

// tokens
let tokens = [];
const TOKENS_FILE = path.join(process.cwd(), "tokens.json");
function loadTokens() {
  try {
    const raw = fs.readFileSync(TOKENS_FILE, "utf8");
    return JSON.parse(raw) || [];
  } catch {
    return [];
  }
}
function saveTokens(data) {
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn("Erro ao salvar tokens:", e);
  }
}
tokens = loadTokens();

// voice participants
let participants = {}; // { socket.id: { id, nick, speaking } }

// negotiation lock queue (NEW)
let negotiationQueue = [];
let negotiationOwner = null; // socket.id which currently holds negotiation right

function requestNegotiation(socketId) {
  if (!negotiationOwner) {
    negotiationOwner = socketId;
    return { granted: true };
  }
  if (negotiationOwner === socketId) return { granted: true };
  if (!negotiationQueue.includes(socketId)) negotiationQueue.push(socketId);
  return { granted: false, position: negotiationQueue.indexOf(socketId) + 1 };
}

function releaseNegotiation(socketId) {
  if (negotiationOwner === socketId) {
    negotiationOwner = null;
    const next = negotiationQueue.shift();
    if (next) {
      negotiationOwner = next;
      // notify next that it's granted
      if (io.sockets.sockets.get(next)) {
        io.to(next).emit("voice-negotiate-grant", { grantedTo: next });
      }
    }
    return true;
  } else {
    // if in queue, remove
    const idx = negotiationQueue.indexOf(socketId);
    if (idx !== -1) negotiationQueue.splice(idx, 1);
    return false;
  }
}

io.on("connection", (socket) => {
  console.log("🟢 Novo jogador conectado:", socket.id);
  socket.emit("init", tokens);

  socket.on("addToken", (token) => {
    if (!token || !token.id || !token.src) return;
    if (!tokens.find((t) => t.id === token.id)) {
      tokens.push(token);
      saveTokens(tokens);
      io.emit("addToken", token);
    }
  });

  socket.on("updateToken", (token) => {
    tokens = tokens.map((t) => (t.id === token.id ? token : t));
    saveTokens(tokens);
    io.emit("updateToken", token);
  });

  socket.on("reorder", (newTokens) => {
    tokens = Array.isArray(newTokens) ? newTokens : tokens;
    saveTokens(tokens);
    io.emit("reorder", tokens);
  });

  socket.on("deleteToken", (id) => {
    tokens = tokens.filter((t) => t.id !== id);
    saveTokens(tokens);
    io.emit("deleteToken", id);
  });

  // music
  socket.on("play-music", (url) => {
    console.log("🎵 Tocando música:", url);
    socket.broadcast.emit("play-music", url);
  });

  socket.on("stop-music", (url) => {
    console.log("⏹️ Parar música:", url);
    socket.broadcast.emit("stop-music", url);
  });

  socket.on("stop-all-music", () => {
    console.log("🛑 Parar todas as músicas");
    socket.broadcast.emit("stop-all-music");
  });

  socket.on("volume-music", (data) => {
    console.log("🎚️ Volume alterado:", data.url, data.value);
    socket.broadcast.emit("volume-music", data);
  });

  // voice
  socket.on("voice-join", ({ nick }) => {
    participants[socket.id] = {
      id: socket.id,
      nick: nick || "SemNome",
      speaking: false,
    };
    io.emit("voice-participants", Object.values(participants));
  });

  socket.on("voice-signal", ({ target, data }) => {
    if (target && io.sockets.sockets.get(target)) {
      io.to(target).emit("voice-signal", { from: socket.id, data });
    }
  });

  socket.on("voice-speaking", ({ id, speaking }) => {
    if (!id || !participants[id]) return;
    participants[id].speaking = !!speaking;
    io.emit("voice-speaking", { id, speaking: !!speaking });
  });

  socket.on("voice-leave", () => {
    delete participants[socket.id];
    // also release negotiation if owner or in queue
    releaseNegotiation(socket.id);
    io.emit("voice-participants", Object.values(participants));
  });

  // negotiation coordination events (NEW)
  socket.on("voice-negotiate-request", (cbId) => {
    const res = requestNegotiation(socket.id);
    // reply only to requester
    socket.emit("voice-negotiate-response", { granted: !!res.granted, position: res.position || 0, cbId });
    // if granted immediately, inform everyone (optional)
    if (res.granted) {
      socket.emit("voice-negotiate-grant", { grantedTo: socket.id });
    }
  });

  socket.on("voice-negotiate-release", () => {
    const prev = negotiationOwner;
    releaseNegotiation(socket.id);
    // optionally inform others
    io.emit("voice-negotiate-released", { releasedBy: socket.id, newOwner: negotiationOwner });
    // if there is a new owner, that owner receives a grant inside releaseNegotiation
  });

  socket.on("disconnect", () => {
    delete participants[socket.id];
    releaseNegotiation(socket.id);
    io.emit("voice-participants", Object.values(participants));
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log("🔒 Allowed origins:", ALLOWED_ORIGINS);
  console.log("🎵 Music folder:", musicDir);
});
