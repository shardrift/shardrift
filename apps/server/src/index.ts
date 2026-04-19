import { Server } from "colyseus";
import { monitor } from "@colyseus/monitor";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { GameRoom } from "./rooms/GameRoom.js";

const PORT = Number(process.env.PORT) || 2570;

const app = express();
app.get("/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send("ok");
});
app.get("/", (_req, res) => res.send("Shardrift server OK"));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use("/colyseus", monitor());

const httpServer = createServer(app);

const gameServer = new Server({ server: httpServer });
gameServer.define("game_room", GameRoom);

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[shardrift-server] running on 0.0.0.0:${PORT}`);
  console.log(`[shardrift-server] monitor at /colyseus`);
});
