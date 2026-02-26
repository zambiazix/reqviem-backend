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
import { AccessToken } from "livekit-server-sdk";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const allowedOrigins = [
  "https://reqviem.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000"
];

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"]
  }
});

/* ===============================
   📤 UPLOAD IMGBB
================================ */

const uploadsDir = path.join(process.cwd(), "uploads_tmp");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.memoryStorage();
const upload = multer({ storage });

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ error: "Nenhum arquivo enviado" });

    const IMGBB_KEY = process.env.IMGBB_API_KEY;
    if (!IMGBB_KEY)
      return res.status(500).json({ error: "IMGBB_API_KEY não configurada" });

    const form = new FormData();
    form.append("key", IMGBB_KEY);
    form.append("image", req.file.buffer.toString("base64"));

    const resp = await axios.post("https://api.imgbb.com/1/upload", form, {
      headers: form.getHeaders(),
    });

    const url = resp.data?.data?.url;
    res.json({ url });
  } catch (err) {
    console.error("Erro upload:", err);
    res.status(500).json({ error: "Falha no upload" });
  }
});

/* ===============================
   🎵 PASTA DE MÚSICAS
================================ */

const musicDir = path.join(__dirname, "musicas");
if (!fs.existsSync(musicDir)) fs.mkdirSync(musicDir);

app.use("/musicas", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Accept-Ranges", "bytes");
  next();
});

app.use("/musicas", express.static(musicDir));

/* ===============================
   🎤 LIVEKIT TOKEN (CORRIGIDO)
================================ */

app.post("/livekit/token", async (req, res) => {
  try {
    const { room, identity, name, avatar } = req.body;

    if (!room || !identity) {
      return res.status(400).json({
        error: "room e identity são obrigatórios",
      });
    }

    const token = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity,
        name: name || identity,
        metadata: JSON.stringify({
          avatar: avatar || null,
        }),
      }
    );

    token.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });

    const jwt = await token.toJwt();

    res.json({ token: jwt });
  } catch (err) {
    console.error("LiveKit token error:", err);
    res.status(500).json({ error: "Erro ao gerar token" });
  }
});

/* ===============================
   🔊 SOCKET.IO (MÚSICA + GRID)
================================ */

let tokens = [];

io.on("connection", (socket) => {
  console.log("🟢 Conectado:", socket.id);

  /* ===== Envia estado atual do grid para quem entrou ===== */
  socket.emit("init", tokens);

  /* ===== GRID ===== */

  socket.on("addToken", (token) => {
    tokens.push(token);
    io.emit("addToken", token);
  });

  socket.on("updateToken", (updatedToken) => {
    tokens = tokens.map((t) =>
      t.id === updatedToken.id ? updatedToken : t
    );
    socket.broadcast.emit("updateToken", updatedToken);
  });

  socket.on("deleteToken", (id) => {
    tokens = tokens.filter((t) => t.id !== id);
    io.emit("deleteToken", id);
  });

  socket.on("reorder", (newOrder) => {
    tokens = newOrder;
    io.emit("reorder", tokens);
  });

  /* ===== MÚSICA ===== */

  socket.on("play-music", (url) => {
    socket.broadcast.emit("play-music", {
      url,
      startedAt: Date.now(),
    });
  });

  socket.on("stop-music", () => {
    socket.broadcast.emit("stop-music");
  });

  socket.on("volume-music", (data) => {
    socket.broadcast.emit("volume-music", data);
  });

  socket.on("disconnect", () => {
    console.log("🔴 Desconectado:", socket.id);
  });
});


/* ===============================
   🎞️ GIF SEARCH (GIPHY + REDGIFS)
================================ */

// Cache do token RedGifs
let redgifsToken = null;
let redgifsTokenExpire = 0;

// 🔐 Função para pegar token temporário RedGifs
async function getRedgifsToken() {
  if (redgifsToken && Date.now() < redgifsTokenExpire) {
    return redgifsToken;
  }

  const response = await axios.get(
    "https://api.redgifs.com/v2/auth/temporary"
  );

  redgifsToken = response.data.token;
  redgifsTokenExpire = Date.now() + 60 * 60 * 1000; // 1 hora

  return redgifsToken;
}

/* ===============================
   🔴 REDGIFS SEARCH
================================ */

app.get("/api/redgifs/search", async (req, res) => {
  try {
    const { q = "", count = 20 } = req.query;

    const token = await getRedgifsToken();

    const response = await axios.get(
      "https://api.redgifs.com/v2/gifs/search",
      {
        params: {
          search_text: q,
          count,
        },
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    const gifs = response.data.gifs.map((g) => ({
      id: g.id,
      preview: g.urls.small,
      original: g.urls.hd || g.urls.sd,
    }));

    res.json(gifs);
  } catch (err) {
    console.error("RedGifs error:", err.response?.data || err.message);
    res.status(500).json({ error: "Erro ao buscar RedGifs" });
  }
});

/* ===============================
   🟣 GIPHY SEARCH
================================ */

app.get("/api/giphy/search", async (req, res) => {
  try {
    const { q = "", offset = 0 } = req.query;

    const response = await axios.get(
      "https://api.giphy.com/v1/gifs/search",
      {
        params: {
          api_key: process.env.GIPHY_KEY,
          q,
          limit: 20,
          offset,
          rating: "r",
        },
      }
    );

    const gifs = response.data.data.map((g) => ({
      id: g.id,
      preview: g.images.fixed_height.url,
      original: g.images.original.url,
    }));

    res.json(gifs);
  } catch (err) {
    console.error("Giphy error:", err.response?.data || err.message);
    res.status(500).json({ error: "Erro ao buscar Giphy" });
  }
});
/* =============================== */

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});