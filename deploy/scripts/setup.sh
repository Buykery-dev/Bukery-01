#!/bin/bash
# Lightsail 초기 세팅 스크립트 (최초 1회 실행)
set -e

echo "=== Bukery Control Tower — Lightsail Setup ==="

# Docker 설치
if ! command -v docker &> /dev/null; then
  curl -fsSL https://get.docker.com | sh
  usermod -aG docker $USER
fi

# Docker Compose 설치
if ! command -v docker compose &> /dev/null; then
  apt-get install -y docker-compose-plugin
fi

# 로그 디렉토리
mkdir -p /var/log/bukery

# certbot (Let's Encrypt)
if ! command -v certbot &> /dev/null; then
  apt-get update && apt-get install -y certbot
fi

echo "=== Setup complete. Run deploy.sh to start services ==="
