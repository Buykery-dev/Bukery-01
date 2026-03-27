#!/bin/bash
# 배포 스크립트 — CI/CD에서 호출하거나 수동 실행
set -e

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_DIR"

echo "=== Deploy: $(git rev-parse --short HEAD) ==="

# 환경변수 주입
export COMMIT_HASH=$(git rev-parse --short HEAD)
export DEPLOY_VERSION=$(git describe --tags --always 2>/dev/null || echo "v0.0.0")

# 빌드 + 재시작
docker compose -f deploy/docker-compose.yml pull n8n
docker compose -f deploy/docker-compose.yml build tower openclo
docker compose -f deploy/docker-compose.yml up -d --remove-orphans

# 헬스체크
echo "Waiting for tower..."
for i in $(seq 1 12); do
  if curl -sf http://localhost:3000/webhook/health > /dev/null; then
    echo "Tower is healthy ✅"
    exit 0
  fi
  sleep 5
done

echo "Health check failed ❌" && exit 1
