#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required but not found."
  exit 1
fi

echo "[1/4] Starting local Postgres container..."
docker compose up -d postgres

echo "[2/4] Installing npm dependencies..."
npm install

echo "[3/4] Pushing Prisma schema..."
DATABASE_URL="${DATABASE_URL:-postgresql://hushh:hushh@localhost:5432/hushh?schema=public}" npm run db:push

echo "[4/4] Generating Prisma client..."
DATABASE_URL="${DATABASE_URL:-postgresql://hushh:hushh@localhost:5432/hushh?schema=public}" npm run db:generate

echo "Local DB setup complete."
echo "Start backend with:"
echo "USE_POSTGRES=true DATABASE_URL=postgresql://hushh:hushh@localhost:5432/hushh?schema=public npm run start"
