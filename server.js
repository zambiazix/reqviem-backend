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

// --- Inicialização ---
const app = express();
const server = http.createServer(app);

// --- Helper: lista de origins permitidos ---
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

// --- Configura Socket.IO com CORS controlado ---
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

// --- Middleware CORS express com callback (origem dinâmica) ---
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

// ✅ Express 5 não aceita "*", substituímos por regex global:
app.options(/.*/, cors());

// --- Body parser / static ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// --- Pasta temporária ---
const uploadsDir = path.join(process.cwd(), "uploads_tmp");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// --- Detecta ambiente serverless ---
const isServerless = Boolean(process.env.RENDER || process.env.VERCEL);

// --- Multer config ---
const storage = isServerless
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (req, file, cb) => cb(null, uploadsDir),
      filename: (req, file, cb) =>
        cb(null, Date.now() + path.extname(file.originalname)),
    });
const upload = multer({ storage });

// --- Upload para Imgbb ---
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

// --- Servir músicas ---
const musicDir = path.join(__dirname, "musicas");
if (!fs.existsSync(musicDir)) {
  try {
    fs.mkdirSync(musicDir);
  } catch (e) {
    console.warn("Não foi possível criar pasta musicas:", e);
  }
}
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

// --- Tokens e Persistência ---
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

// --- Estado dos participantes de voz ---
let participants = {}; // { socket.id: { id, nick, speaking } }

// --- Sockets ---
io.on("connection", (socket) => {
  console.log("🟢 Novo jogador conectado:", socket.id);
  socket.emit("init", tokens);

  // --- TOKENS ---
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

  // --- MÚSICA ---
  socket.on("play-music", (url) => {
    console.log("🎵 Tocando música:", url);
    io.emit("play-music", url);
  });
  socket.on("stop-music", (url) => io.emit("stop-music", url));
  socket.on("stop-all-music", () => io.emit("stop-all-music"));
  socket.on("volume-music", (data) => io.emit("volume-music", data));

  // --- VOZ ---
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
    io.emit("voice-participants", Object.values(participants));
  });

  socket.on("disconnect", () => {
    delete participants[socket.id];
    io.emit("voice-participants", Object.values(participants));
  });
});

// --- Inicializa Servidor ---
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
  console.log("🔒 Allowed origins:", ALLOWED_ORIGINS);
  console.log("🎵 Music folder:", musicDir);
});
