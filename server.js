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

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const io = new Server(server, {
  cors: { origin: true, credentials: true },
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
   🔊 SOCKET.IO (MÚSICA)
================================ */

io.on("connection", (socket) => {
  console.log("🟢 Conectado:", socket.id);

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

/* =============================== */

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});