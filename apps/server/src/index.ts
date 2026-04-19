import { Server } from "colyseus";
import { monitor } from "@colyseus/monitor";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { GameRoom } from "./rooms/GameRoom.js";

const PORT = Number(process.env.PORT) || 2570;

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use("/colyseus", monitor());
app.get("/", (_req, res) => res.send("Shardrift server OK"));

const httpServer = createServer(app);

const gameServer = new Server({ server: httpServer });
gameServer.define("game_room", GameRoom);

httpServer.listen(PORT, () => {
  console.log(`[shardrift-server] running on http://localhost:${PORT}`);
  console.log(`[shardrift-server] monitor at http://localhost:${PORT}/colyseus`);
});
