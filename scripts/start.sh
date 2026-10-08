#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export API_PORT="${API_PORT:-8789}"

cleanup() {
  local status=$?
  trap - INT TERM EXIT

  if [[ -n "${API_PID:-}" ]]; then
    kill "$API_PID" 2>/dev/null || true
  fi
  if [[ -n "${FRONTEND_PID:-}" ]]; then
    kill "$FRONTEND_PID" 2>/dev/null || true
  fi

  wait "${API_PID:-}" 2>/dev/null || true
  wait "${FRONTEND_PID:-}" 2>/dev/null || true
  exit "$status"
}

trap cleanup INT TERM EXIT

echo "[start] Seeding demo data..."
npm run seed

echo "[start] Starting engine, RES, and CEP services..."
docker compose up --build -d engine res cep-build cep-res

echo "[start] Starting Team Server on http://127.0.0.1:${API_PORT}..."
npm run api &
API_PID=$!

echo "[start] Starting frontend on http://127.0.0.1:5173..."
npm run dev &
FRONTEND_PID=$!

echo "[start] All services are running. Press Ctrl+C to stop the local API and frontend."
wait "$API_PID" "$FRONTEND_PID"
