#!/bin/bash
# Lightsail 초기 세팅 스크립트 (최초 1회 실행)
set -e

echo "=== Bukery Control Tower — Lightsail Setup ==="

# Docker 설치
if ! command -v docker &> /dev/null; then
  curl -fsSL https://get.docker.com | sh
  usermod -aG docker "$USER"
fi

# Docker Compose 플러그인
if ! docker compose version &> /dev/null; then
  apt-get install -y docker-compose-plugin
fi

# 로그 디렉토리
mkdir -p /var/log/bukery

# certbot (Let's Encrypt)
if ! command -v certbot &> /dev/null; then
  apt-get update && apt-get install -y certbot
fi

# TOWER_DOMAIN 설정
if [ -z "$TOWER_DOMAIN" ]; then
  read -rp "Enter Control Tower domain (e.g. tower.yourdomain.com): " TOWER_DOMAIN
fi

echo "Requesting TLS certificate for $TOWER_DOMAIN..."
certbot certonly --standalone --non-interactive --agree-tos \
  --email "admin@${TOWER_DOMAIN}" \
  -d "$TOWER_DOMAIN" || echo "⚠️  certbot failed — ensure port 80 is open and DNS is pointed here"

# .env에 도메인 저장
ENV_FILE="$(dirname "$0")/../../.env"
if [ -f "$ENV_FILE" ]; then
  if ! grep -q "TOWER_DOMAIN" "$ENV_FILE"; then
    echo "TOWER_DOMAIN=$TOWER_DOMAIN" >> "$ENV_FILE"
  fi
else
  echo "TOWER_DOMAIN=$TOWER_DOMAIN" > "$ENV_FILE"
fi

echo "=== Setup complete. Run deploy.sh to start services ==="
echo "    TOWER_DOMAIN=$TOWER_DOMAIN"
