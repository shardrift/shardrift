# Shardrift

TMA-based 1v1 arena MMO. Scythe warrior, 3 skills + auto-attack, first to 5 wins.

## Local dev

```bash
pnpm install
pnpm dev
```

- Server: `http://localhost:2570`
- Client: `http://localhost:5173`

## Deploy frontend to Cloudflare Pages

1. **Push this repo to GitHub** (see "Git setup" below).
2. In Cloudflare dashboard → Workers & Pages → **Create → Pages → Connect to Git**.
3. Select the repo. Build settings:
   - **Framework preset**: None
   - **Build command**: `pnpm --filter @shardrift/client build`
   - **Build output directory**: `apps/client/dist`
   - **Root directory**: (leave empty)
4. **Environment variables**:
   - `VITE_SERVER_URL` = `wss://<your-tunnel-url>` (see "Expose local server" below)
5. Deploy.

## Expose local server (so Cloudflare-hosted client can reach it)

Option A — **cloudflared** (free, easy):
```bash
cloudflared tunnel --url http://localhost:2570
```
Gives you `https://something.trycloudflare.com`. Use `wss://something.trycloudflare.com` as `VITE_SERVER_URL`.

Option B — **ngrok**:
```bash
ngrok http 2570
```
Similar, `wss://xxxx.ngrok.io`.

Keep the tunnel running while you play. Re-deploy Cloudflare Pages if the URL changes (or use a reserved/paid tunnel).

## Telegram Mini App setup

1. Open [@BotFather](https://t.me/BotFather) in Telegram.
2. `/newbot` → give it a name and username.
3. `/newapp` (or `/mybots` → Bot Settings → Menu Button / Mini App).
4. Configure Mini App:
   - **URL**: your Cloudflare Pages URL (`https://shardrift.pages.dev`)
   - Upload an icon
5. Set the menu button:
   - `/mybots` → select bot → Bot Settings → Menu Button → Configure
   - Text: "Play Shardrift"
   - URL: same Cloudflare Pages URL
6. Open your bot in Telegram, tap menu → launches Shardrift in TMA.

## Git setup (first time)

```bash
git init
git add -A
git commit -m "Initial commit"
git branch -M main
git remote add origin git@github.com:<you>/shardrift.git
git push -u origin main
```

## Character pipeline

See `apps/client/public/character/` and `apps/client/public/vfx/` for assets.
Pipeline: Gemini (image) → Meshy (3D) → Mixamo (rig/anims) → `.fbx` + `.glb` in this folder.
