# Hopping Heads - Deployment Guide

## Repo Structure

```
contracts/           Solidity smart contracts (Base chain)
scripts/deploy.js    Hardhat deploy + BaseScan verify
server/              Node.js backend (Express + Socket.io + PostgreSQL)
  src/               Server source code
  public/            Game client (served as static HTML)
  Dockerfile         Production container config
client/              Game client source (v7 - 4 maps, minimap, audio, mobile)
landing/             Marketing landing page
railway.toml         Railway deployment config
```

## Quick Start (Local Dev)

```bash
# 1. Server
cd server
cp .env.example .env
# Edit .env with your values
npm ci
node src/index.js
# Game is at http://localhost:3000
# API is at http://localhost:3000/api/health
```

## Deploy to Railway

### Step 1: Push to GitHub

```bash
git init
git add -A
git commit -m "initial commit"
git remote add origin https://github.com/iam25th1/hoppingheads.git
git branch -M main
git push -u origin main
```

### Step 2: Create Railway Project

1. Go to https://railway.app/new
2. Click "Deploy from GitHub repo"
3. Select `iam25th1/hoppingheads`
4. Railway detects `railway.toml` automatically

### Step 3: Add PostgreSQL

1. In Railway project dashboard, click "+ New"
2. Select "Database" -> "PostgreSQL"
3. Railway auto-injects `DATABASE_URL` into your server

### Step 4: Initialize Database

1. Click the PostgreSQL service in Railway
2. Go to "Data" tab -> "Query"
3. Paste contents of `server/src/db/schema.sql` and run

### Step 5: Set Environment Variables

In Railway, click the server service -> "Variables" tab. Add:

```
NODE_ENV=production
JWT_SECRET=<generate a random 64-char string>
BASE_RPC_URL=https://sepolia.base.org
CHAIN_ID=84532
ALLOWED_ORIGINS=https://your-railway-url.up.railway.app
```

Contract addresses and operator key are added after contract deployment (Step 7).

### Step 6: Deploy

Railway auto-deploys on push. The Dockerfile:
- Uses `npm ci --ignore-scripts` (lockfile-strict, blocks postinstall attacks)
- Runs as non-root `node` user
- Health check at `/api/health`

Your game is live at the Railway URL.

### Step 7: Deploy Smart Contracts (when ready)

```bash
# From repo root
npm ci
npx hardhat compile

# Deploy to Base Sepolia testnet
npx hardhat run scripts/deploy.js --network baseSepolia

# Copy the printed contract addresses into Railway env vars:
# ASSET_REGISTRY_ADDRESS=0x...
# GAME_MANAGER_ADDRESS=0x...
# SEASON_MANAGER_ADDRESS=0x...
# OPERATOR_PRIVATE_KEY=0x... (the deployer wallet private key)
```

### Step 8: Landing Page

Deploy `landing/index.html` to Vercel or Netlify as a static site.
Point your domain to it, link to the Railway game URL.

## Security Notes

- Server uses Helmet for HTTP hardening
- Rate limiting on both HTTP (120/min) and WebSocket (10 connections/min)
- JWT auth with wallet signature verification
- Smart contracts use ReentrancyGuard + pull pattern for ETH
- Operator pattern separates backend authority from contract ownership
- All package-lock.json files committed (npm ci enforces exact versions)
- Dockerfile uses --ignore-scripts to block malicious postinstall hooks
- Non-root container execution

## Architecture

```
Browser (Three.js client)
    |
    |-- HTTP REST --> Express API (auth, rounds, leaderboard)
    |-- WebSocket --> Socket.io (real-time game state, 20 ticks/sec)
    |
Express Server (Railway)
    |-- PostgreSQL (Railway) --> players, rounds, events, seasons
    |-- ethers.js --> Base chain contracts (mint, resolve, prizes)
```
