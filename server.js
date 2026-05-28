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
// 🟢 ADICIONE ESTES IMPORTS NO TOPO DO ARQUIVO
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import serviceAccount from './serviceAccountKey.json' assert { type: 'json' };

// 🟢 ADICIONE APÓS OS IMPORTS
// Inicializa Firebase Admin SDK
initializeApp({
  credential: cert(serviceAccount),
});

const adminAuth = getAuth();
const adminDb = getFirestore();

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
    formData.append("upload_preset", "rpg_musicas");
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
      
      // 🟢🟢🟢 ADICIONE ESTAS DUAS LINHAS! 🟢🟢🟢
      formData.append("upload_preset", "rpg_musicas");
      formData.append("resource_type", "auto");
      
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

// 🟢🟢🟢 ROTA PARA DELETAR CONTA (APENAS MESTRE) 🟢🟢🟢
app.post("/api/admin/delete-user", async (req, res) => {
  try {
    const { email, mestreEmail } = req.body;
    
    // Verifica se quem está fazendo a requisição é o mestre
    const MASTER_EMAIL = "mestre@reqviemrpg.com";
    
    if (mestreEmail !== MASTER_EMAIL) {
      return res.status(403).json({ 
        error: "Apenas o mestre pode deletar contas" 
      });
    }
    
    if (!email) {
      return res.status(400).json({ 
        error: "Email do usuário a ser deletado é obrigatório" 
      });
    }
    
    // Não permite deletar a conta do próprio mestre
    if (email === MASTER_EMAIL) {
      return res.status(403).json({ 
        error: "Não é possível deletar a conta do mestre" 
      });
    }
    
    console.log(`🗑️ Tentando deletar conta: ${email}`);
    
    try {
      // 1. Buscar o usuário pelo email no Firebase Auth
      const userRecord = await adminAuth.getUserByEmail(email);
      const uid = userRecord.uid;
      
      // 2. Deletar o documento da ficha no Firestore
      try {
        await adminDb.collection('fichas').doc(email).delete();
        console.log(`📄 Ficha de ${email} deletada`);
      } catch (firestoreErr) {
        console.log(`⚠️ Ficha de ${email} não encontrada ou já deletada`);
      }
      
      // 3. Deletar o usuário do Firebase Auth
      await adminAuth.deleteUser(uid);
      console.log(`👤 Usuário ${email} deletado do Firebase Auth`);
      
      res.json({ 
        success: true, 
        message: `Conta ${email} deletada com sucesso!` 
      });
      
    } catch (authErr) {
      // Se o usuário não existir no Auth, mas a ficha existir
      if (authErr.code === 'auth/user-not-found') {
        // Tenta deletar apenas a ficha
        try {
          await adminDb.collection('fichas').doc(email).delete();
          console.log(`📄 Ficha de ${email} deletada (usuário não existia no Auth)`);
          
          res.json({ 
            success: true, 
            message: `Ficha de ${email} deletada! (Usuário não existia no Auth)` 
          });
        } catch (firestoreErr) {
          res.status(404).json({ 
            error: `Nenhum registro encontrado para ${email}` 
          });
        }
      } else {
        throw authErr;
      }
    }
    
  } catch (err) {
    console.error("❌ Erro ao deletar conta:", err);
    res.status(500).json({ 
      error: "Erro ao deletar conta",
      message: err.message 
    });
  }
});

// 🟢 ROTA PARA LISTAR TODAS AS CONTAS (APENAS MESTRE)
app.post("/api/admin/list-users", async (req, res) => {
  try {
    const { mestreEmail } = req.body;
    const MASTER_EMAIL = "mestre@reqviemrpg.com";
    
    if (mestreEmail !== MASTER_EMAIL) {
      return res.status(403).json({ 
        error: "Apenas o mestre pode listar contas" 
      });
    }
    
    const listUsersResult = await adminAuth.listUsers();
    const users = listUsersResult.users.map(user => ({
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      createdAt: user.metadata.creationTime,
      lastSignIn: user.metadata.lastSignInTime
    }));
    
    res.json({ users });
    
  } catch (err) {
    console.error("❌ Erro ao listar usuários:", err);
    res.status(500).json({ 
      error: "Erro ao listar usuários",
      message: err.message 
    });
  }
});

// 🟢 ROTA DE AVALIAÇÃO DE HABILIDADES (IA) - VERSÃO CORRIGIDA E RIGOROSA
app.post("/api/avaliar-habilidade", async (req, res) => {
  try {
    const { nome, descricao, dado, tipoDano, custoPE, condicoes } = req.body;
    
    const descLower = (descricao || "").toLowerCase();
    const nomeLower = (nome || "").toLowerCase();
    
    // =============================================
    // 🟢 ANÁLISE DE PODER BASE (0 a 10)
    // =============================================
    let poderBase = 0;
    
    // --- PESO DO DADO (1-10) ---
    poderBase += (Number(dado) || 1) * 0.5;
    
    // --- TIPO DE DANO ---
    const danosFortes = ["Aurano", "Psíquico", "Tóxico", "Térmico"];
    if (danosFortes.includes(tipoDano)) poderBase += 1.5;
    
    // --- CUSTO DE PE (custo alto reduz poder) ---
    poderBase -= (Number(custoPE) || 0) * 0.15;
    
    // =============================================
    // 🟢 ANÁLISE SEMÂNTICA DA DESCRIÇÃO (MUITO MAIS RIGOROSA)
    // =============================================
    
    // 🔴 PALAVRAS DE PODER ABSOLUTO (muito overpower)
    if (descLower.includes("mata instantaneamente") || 
        descLower.includes("morte instantânea") ||
        descLower.includes("mata qualquer") ||
        descLower.includes("matar tudo") ||
        descLower.includes("todos os inimigos") && descLower.includes("mata")) {
      poderBase += 8; // Extremamente overpower
    }
    
    // 🔴 PALAVRAS DE MORTE GARANTIDA
    if (descLower.includes("morte certa") || 
        descLower.includes("mata na hora") ||
        descLower.includes("sem chance de defesa") ||
        descLower.includes("impossível de sobreviver")) {
      poderBase += 7;
    }
    
    // 🔴 DANO EM ÁREA MASSIVO
    if ((descLower.includes("todos") || descLower.includes("todos os inimigos")) && 
        (descLower.includes("dano") || descLower.includes("mata") || descLower.includes("destrói"))) {
      poderBase += 5;
    }
    
    // 🔴 INVENCIBILIDADE
    if (descLower.includes("invencível") || 
        descLower.includes("imune a tudo") ||
        descLower.includes("nada pode") && descLower.includes("atingir") ||
        descLower.includes("invulnerável")) {
      poderBase += 6;
    }
    
    // 🟠 PODERES MUITO FORTES
    if (descLower.includes("controla") && descLower.includes("mente")) poderBase += 4;
    if (descLower.includes("controla") && descLower.includes("tempo")) poderBase += 5;
    if (descLower.includes("controla") && descLower.includes("realidade")) poderBase += 6;
    if (descLower.includes("teleporte")) poderBase += 2;
    if (descLower.includes("invisível") || descLower.includes("invisibilidade")) poderBase += 2;
    if (descLower.includes("cura") && descLower.includes("tudo")) poderBase += 3;
    if (descLower.includes("ressuscita")) poderBase += 5;
    if (descLower.includes("paralisa")) poderBase += 2;
    
    // 🟡 DANO MODERADO
    if (descLower.includes("dano massivo") || descLower.includes("dano devastador")) poderBase += 4;
    if (descLower.includes("dano alto") || descLower.includes("dano grande")) poderBase += 3;
    if (descLower.includes("explosão")) poderBase += 2;
    if (descLower.includes("corte profundo")) poderBase += 2;
    
    // 🟢 DEFESAS
    if (descLower.includes("escudo") || descLower.includes("defesa")) poderBase += 1;
    if (descLower.includes("barreira")) poderBase += 1.5;
    
    // 🔴 ANÁLISE DO NOME (nomes muito sugestivos)
    if (nomeLower.includes("morte") || nomeLower.includes("destruição")) poderBase += 3;
    if (nomeLower.includes("juízo final") || nomeLower.includes("apocalipse")) poderBase += 5;
    if (nomeLower.includes("deus") || nomeLower.includes("divino")) poderBase += 4;
    
    // =============================================
    // 🟢 NÍVEL DE RESTRIÇÃO (0 a 10)
    // =============================================
    let nivelRestricao = 0;
    
    const condicoesAnalisadas = (condicoes || []).map(cond => {
      const descCond = (cond.descricao || "").toLowerCase();
      let dificuldade = cond.dificuldade || 0;
      let janela = cond.janela || 0;
      let custo = cond.custo || 0;
      let risco = cond.risco || 0;
      
      // Só analisa se não foi avaliado manualmente
      if (dificuldade === 0 && janela === 0 && custo === 0 && risco === 0) {
        // Dificuldade
        if (descCond.includes("50 pulos") || descCond.includes("100 flexões") || 
            descCond.includes("correr 10km") || descCond.includes("1 hora")) dificuldade = 4;
        else if (descCond.includes("concentração") || descCond.includes("meditar")) dificuldade = 2;
        else if (descCond.includes("gritar") || descCond.includes("falar")) dificuldade = 1;
        
        // Janela
        if (descCond.includes("eclipse") || descCond.includes("lua cheia") || 
            descCond.includes("alinhamento")) janela = 5;
        else if (descCond.includes("noite") || descCond.includes("escuridão")) janela = 3;
        else if (descCond.includes("dia") || descCond.includes("manhã")) janela = 2;
        else if (descCond.includes("uma vez por") || descCond.includes("1 vez por")) janela = 4;
        
        // Custo
        if (descCond.includes("vida") || descCond.includes("sangue") || 
            descCond.includes("morte") || descCond.includes("alma")) custo = 5;
        else if (descCond.includes("energia") || descCond.includes("cansaço")) custo = 3;
        else if (descCond.includes("pe") || descCond.includes("aura")) custo = 2;
        
        // Risco
        if (descCond.includes("chance de morrer") || descCond.includes("morte certa")) risco = 5;
        else if (descCond.includes("pode falhar") || descCond.includes("chance de")) risco = 3;
        else if (descCond.includes("dano colateral") || descCond.includes("aliados")) risco = 2;
      }
      
      // Peso da condição individual
      const pesoCond = (dificuldade * 0.3) + (janela * 0.5) + (custo * 0.4) + (risco * 0.6);
      nivelRestricao += pesoCond;
      
      return { ...cond, dificuldade, janela, custo, risco };
    });
    
    // =============================================
    // 🟢 CÁLCULO DE BALANCEAMENTO
    // =============================================
    
    // Fator de restrição: 0 restrições = fator 1.0 (sem redução)
    // Muitas restrições = fator 0.2 (80% de redução)
    const fatorRestricao = Math.max(0.15, 1 - (nivelRestricao / 8));
    
    // Poder efetivo = poder base × fator de restrição
    const poderEfetivo = poderBase * fatorRestricao;
    
    // Limite máximo permitido (ajustável)
    const limiteMaximo = 3;
    const percentual = Math.min((poderEfetivo / limiteMaximo) * 100, 200);
    
    // =============================================
    // 🟢 CLASSIFICAÇÃO
    // =============================================
    let status, mensagem, sugestoes = [];
    
    if (nivelRestricao === 0 && poderBase > 5) {
      status = "Muito Desequilibrada 🔴🔴";
      mensagem = "Habilidade extremamente forte SEM nenhuma condição! Adicione restrições severas.";
      sugestoes = [
        "Adicione pelo menos 2 condições severas",
        "Condições como 'só funciona 1 vez por dia' ajudam muito",
        "Riscos como 'chance de perder a própria vida' são poderosos balanceadores"
      ];
    } else if (percentual <= 40) {
      status = "Perfeitamente Equilibrada ✅✅";
      mensagem = "Excelente! As restrições controlam perfeitamente o poder da habilidade.";
    } else if (percentual <= 70) {
      status = "Bem Equilibrada ✅";
      mensagem = "A habilidade está bem balanceada com as restrições atuais.";
    } else if (percentual <= 100) {
      status = "Equilibrada ✅";
      mensagem = "A habilidade está dentro do limite aceitável.";
    } else if (percentual <= 130) {
      status = "Pouco Equilibrada ⚠️";
      mensagem = "A habilidade está um pouco acima do ideal. Considere adicionar mais condições.";
      sugestoes = [
        "Adicione condições de dificuldade (ex: requer concentração)",
        "Restrinja o uso (ex: só funciona à noite)",
        "Adicione um custo (ex: consome 5 PE adicionais)"
      ];
    } else if (percentual <= 180) {
      status = "Desequilibrada 🔴";
      mensagem = "Habilidade muito forte para as restrições atuais. Precisa de mais limitações.";
      sugestoes = [
        "Adicione múltiplas condições severas",
        "Condições com risco de vida são as mais eficazes",
        "Reduza o dado de dano ou poder base"
      ];
    } else {
      status = "Extremamente Desequilibrada 🔴🔴";
      mensagem = "Esta habilidade quebra completamente o jogo! Necessita de restrições extremas.";
      sugestoes = [
        "Adicione uma condição de 'risco de morte' (nível 5)",
        "Restrinja para '1 uso por dia' ou menos",
        "Adicione custo de vida/sangue",
        "Considere reduzir drasticamente o poder base"
      ];
    }
    
    res.json({
      poderBase: Math.min(poderBase, 10),
      nivelRestricao: Math.min(nivelRestricao, 10),
      percentual,
      status,
      mensagem,
      sugestoes,
      condicoesAnalisadas
    });
    
  } catch (error) {
    console.error("Erro na avaliação:", error);
    res.status(500).json({ error: "Erro ao avaliar habilidade" });
  }
});
// 🟢 ROTA PARA SALVAR AVALIAÇÕES DO MESTRE (TREINAMENTO) - CORRIGIDA
app.post("/api/salvar-avaliacao", async (req, res) => {
  try {
    const { fichaId, habilidade, avaliacaoMestre, timestamp, mestreEmail } = req.body;
    
    console.log("📚 Salvando avaliação do mestre:", {
      fichaId,
      habilidade: habilidade.nome,
      mestre: mestreEmail
    });
    
    // 🟢 CORRIGIDO: Usa doc() com ID automático e set() para garantir criação
    const docRef = adminDb.collection('treinamentoIA').doc();
    await docRef.set({
      fichaId: fichaId || "",
      habilidade: habilidade || {},
      avaliacaoMestre: avaliacaoMestre || {},
      timestamp: timestamp || new Date().toISOString(),
      mestreEmail: mestreEmail || "",
      createdAt: new Date().toISOString()
    });
    
    console.log("✅ Avaliação salva com ID:", docRef.id);
    
    res.json({ 
      success: true, 
      message: "Avaliação salva para treinamento",
      id: docRef.id
    });
    
  } catch (error) {
    console.error("❌ Erro ao salvar avaliação:", error);
    res.status(500).json({ 
      error: "Erro ao salvar avaliação",
      message: error.message 
    });
  }
});

// 🟢 ROTA PARA CONSULTAR AVALIAÇÕES SALVAS (APENAS MESTRE) - CORRIGIDA
app.post("/api/consultar-avaliacoes", async (req, res) => {
  try {
    const { mestreEmail } = req.body;
    const MASTER_EMAIL = "mestre@reqviemrpg.com";
    
    if (mestreEmail !== MASTER_EMAIL) {
      return res.status(403).json({ error: "Apenas o mestre pode consultar" });
    }
    
    // 🟢 CORRIGIDO: Verifica se a coleção existe antes de consultar
    const snapshot = await adminDb.collection('treinamentoIA')
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
    
    const avaliacoes = [];
    
    if (!snapshot.empty) {
      snapshot.forEach(doc => {
        avaliacoes.push({ 
          id: doc.id, 
          ...doc.data() 
        });
      });
    }
    
    console.log(`📊 ${avaliacoes.length} avaliações encontradas`);
    
    res.json({ 
      avaliacoes,
      total: avaliacoes.length
    });
    
  } catch (error) {
    console.error("❌ Erro ao consultar avaliações:", error);
    res.status(500).json({ 
      error: "Erro ao consultar avaliações",
      message: error.message 
    });
  }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});