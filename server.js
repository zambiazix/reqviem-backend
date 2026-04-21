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
// 🟢 ADICIONE ESTAS LINHAS NO TOPO (junto com os outros imports)
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { PassThrough } from 'stream';

// 🟢 Configurar caminhos do ffmpeg (logo após os imports)
ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

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
   📤 CONFIGURAÇÃO UPLOAD
================================ */

const uploadsDir = path.join(process.cwd(), "uploads_tmp");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.memoryStorage();
const upload = multer({ storage });

// 🟢 FUNÇÃO PARA UPLOAD DE IMAGEM (IMGBB)
async function uploadToImgBB(file) {
  const IMGBB_KEY = process.env.IMGBB_API_KEY;
  if (!IMGBB_KEY) throw new Error("IMGBB_API_KEY não configurada");

  const form = new FormData();
  form.append("key", IMGBB_KEY);
  form.append("image", file.buffer.toString("base64"));

  const resp = await axios.post("https://api.imgbb.com/1/upload", form, {
    headers: form.getHeaders(),
  });

  return resp.data?.data?.url;
}

// 🟢 FUNÇÃO PARA UPLOAD DE ÁUDIO (CLOUDINARY)
async function uploadToCloudinary(file) {
  try {
    console.log('📤 Iniciando upload para Cloudinary...');
    console.log('📤 Nome do arquivo:', file.originalname);
    console.log('📤 MIME type:', file.mimetype);
    console.log('📤 Tamanho:', file.size, 'bytes');
    
    const formData = new FormData();
    
    formData.append("file", file.buffer, {
      filename: file.originalname,
      contentType: file.mimetype
    });
    formData.append("upload_preset", "requiem");
    formData.append("resource_type", "auto");
    
    console.log('📤 Enviando para Cloudinary com preset:', 'requiem');
    
    const resp = await axios.post(
      "https://api.cloudinary.com/v1_1/dwaxw0l83/auto/upload",
      formData,
      { 
        headers: { 
          ...formData.getHeaders(),
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      }
    );
    
    console.log('✅ Resposta Cloudinary completa:', JSON.stringify(resp.data, null, 2));
    
    if (resp.data?.secure_url) {
      console.log('✅ URL segura:', resp.data.secure_url);
      return resp.data.secure_url;
    } else if (resp.data?.url) {
      console.log('✅ URL:', resp.data.url);
      return resp.data.url;
    } else {
      console.error('❌ Resposta sem URL:', resp.data);
      throw new Error("Cloudinary não retornou URL");
    }
  } catch (err) {
    console.error('❌ Erro detalhado Cloudinary:', {
      message: err.message,
      response: err.response?.data,
      status: err.response?.status,
      statusText: err.response?.statusText
    });
    throw err;
  }
}

// 🟢 FUNÇÃO PARA COMPRIMIR ÁUDIO (DEIXE APENAS UMA!)
async function compressAudio(buffer, originalName) {
  return new Promise((resolve, reject) => {
    const inputStream = new PassThrough();
    inputStream.end(buffer);
    
    const outputBuffers = [];
    const outputStream = new PassThrough();
    
    outputStream.on('data', chunk => outputBuffers.push(chunk));
    outputStream.on('end', () => resolve(Buffer.concat(outputBuffers)));
    outputStream.on('error', reject);
    
    console.log('🎵 Comprimindo áudio...');
    
    ffmpeg(inputStream)
      .audioBitrate('64k')
      .audioChannels(1)
      .audioFrequency(22050)
      .format('mp3')
      .on('start', (cmd) => console.log('🎵 FFmpeg iniciado'))
      .on('end', () => console.log('✅ Compressão concluída'))
      .on('error', (err) => {
        console.error('❌ Erro FFmpeg:', err);
        reject(err);
      })
      .pipe(outputStream);
  });
}

// 🟢🟢🟢 AQUI! COLOQUE A ROTA /upload AGORA! 🟢🟢🟢
app.post("/upload", upload.single("file"), async (req, res) => {
  console.log("=".repeat(50));
  console.log("📤 NOVO UPLOAD RECEBIDO");
  console.log("=".repeat(50));
  
  try {
    if (!req.file) {
      console.error("❌ NENHUM ARQUIVO RECEBIDO");
      return res.status(400).json({ error: "Nenhum arquivo enviado" });
    }

    const file = req.file;
    console.log("📤 Arquivo recebido:", {
      nome: file.originalname,
      mime: file.mimetype,
      tamanhoOriginal: (file.size / 1024 / 1024).toFixed(2) + 'MB'
    });
    
    const isAudio = file.mimetype.startsWith('audio/');
    
    if (isAudio) {
      let audioBuffer = file.buffer;
      
      // 🟢 COMPRIME SE FOR MAIOR QUE 5MB
      if (file.size > 5 * 1024 * 1024) {
        console.log('🎵 Arquivo > 5MB, comprimindo...');
        try {
          audioBuffer = await compressAudio(file.buffer, file.originalname);
          console.log('✅ Compressão OK! Tamanho final:', (audioBuffer.length / 1024 / 1024).toFixed(2) + 'MB');
        } catch (compressErr) {
          console.error('❌ Erro na compressão, enviando original:', compressErr);
          audioBuffer = file.buffer;
        }
      }
      
      console.log('🎵 Enviando para Cloudinary...');
      
      const formData = new FormData();
      formData.append("file", audioBuffer, {
        filename: file.originalname.replace(/\.[^.]+$/, '.mp3'),
        contentType: 'audio/mp3'
      });
      
      // 🟢 Tenta sem preset primeiro
      const resp = await axios.post(
        "https://api.cloudinary.com/v1_1/dwaxw0l83/auto/upload",
        formData,
        { 
          headers: formData.getHeaders(),
          timeout: 60000
        }
      );
      
      const url = resp.data?.secure_url || resp.data?.url;
      
      if (url) {
        console.log("✅✅✅ SUCESSO! URL:", url);
        return res.json({ url });
      } else {
        throw new Error("Cloudinary não retornou URL");
      }
      
    } else {
      // 🟢 IMAGEM
      console.log('🖼️ Enviando imagem para ImgBB...');
      
      const IMGBB_KEY = process.env.IMGBB_API_KEY;
      if (!IMGBB_KEY) {
        throw new Error("IMGBB_API_KEY não configurada");
      }
      
      const form = new FormData();
      form.append("key", IMGBB_KEY);
      form.append("image", file.buffer.toString("base64"));
      
      const resp = await axios.post("https://api.imgbb.com/1/upload", form, {
        headers: form.getHeaders(),
      });
      
      const url = resp.data?.data?.url;
      if (url) {
        console.log("✅ Upload ImgBB sucesso:", url);
        res.json({ url });
      } else {
        throw new Error("ImgBB não retornou URL");
      }
    }
  } catch (err) {
    console.error("=".repeat(50));
    console.error("❌❌❌ ERRO NO UPLOAD ❌❌❌");
    console.error("Mensagem:", err.message);
    console.error("Dados do erro:", err.response?.data);
    console.error("=".repeat(50));
    
    res.status(500).json({ 
      error: "Falha no upload",
      message: err.message
    });
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

  socket.emit("init", tokens);

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

  socket.on("play-music", (url) => {
  console.log('🎵 Play recebido:', url);
  // Envia a URL para TODOS os outros clientes
  socket.broadcast.emit("play-music", url);
});

socket.on("stop-music", (url) => {
  console.log('🎵 Stop recebido:', url);
  // Envia a URL para TODOS os outros clientes
  socket.broadcast.emit("stop-music", url);
});

socket.on("stop-all-music", () => {
  console.log('🎵 Stop ALL recebido');
  socket.broadcast.emit("stop-all-music");
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

let redgifsToken = null;
let redgifsTokenExpire = 0;

async function getRedgifsToken() {
  if (redgifsToken && Date.now() < redgifsTokenExpire) {
    return redgifsToken;
  }

  const response = await axios.get(
    "https://api.redgifs.com/v2/auth/temporary"
  );

  redgifsToken = response.data.token;
  redgifsTokenExpire = Date.now() + 60 * 60 * 1000;

  return redgifsToken;
}

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

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});