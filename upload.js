import express from "express";
import fetch from "node-fetch";
import multer from "multer";

const router = express.Router();
const upload = multer(); // para ler arquivos enviados no FormData

router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado" });

    const apiKey = process.env.IMGBB_API_KEY;
    const imageBase64 = req.file.buffer.toString("base64");

    const formData = new URLSearchParams();
    formData.append("key", apiKey);
    formData.append("image", imageBase64);

    const response = await fetch("https://api.imgbb.com/1/upload", {
      method: "POST",
      body: formData
    });

    const data = await response.json();

    if (data.success) {
      return res.json({ url: data.data.url });
    } else {
      return res.status(500).json({ error: "Erro ao enviar para imgbb" });
    }
  } catch (err) {
    console.error("Erro upload:", err);
    res.status(500).json({ error: "Erro interno" });
  }
});

export default router;
