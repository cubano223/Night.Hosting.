import express from "express";
import cors from "cors";
import bodyParser from "body-parser";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(bodyParser.json());

// Página principal
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>🚀 Night Hosting API Online</title>
        <style>
          body {
            background-color: #0d0d0d;
            color: #00ffaa;
            font-family: monospace;
            text-align: center;
            margin-top: 20%;
          }
          h1 {
            color: #00ffcc;
          }
          a {
            color: #00ffaa;
            text-decoration: none;
          }
        </style>
      </head>
      <body>
        <h1>🚀 Night Hosting API Online</h1>
        <p>Servidor activo y escuchando en el puerto ${PORT}</p>
        <p>Endpoints disponibles en <code>/api/</code></p>
      </body>
    </html>
  `);
});

// Endpoints API
app.post("/api/create", (req, res) => {
  res.json({ message: "Servidor virtual creado correctamente ✅" });
});

app.post("/api/upload", (req, res) => {
  res.json({ message: "Archivo subido con éxito ✅" });
});

app.post("/api/action", (req, res) => {
  res.json({ message: "Acción ejecutada correctamente ✅" });
});

app.get("/api/status", (req, res) => {
  res.json({ status: "online", uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`Servidor activo en el puerto ${PORT}`);
});
