#!/bin/bash
# 배포 스크립트 — CI/CD에서 호출하거나 수동 실행
set -e

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_DIR"

COMMIT=$(git rev-parse --short HEAD)
echo "=== Deploy: $COMMIT ==="

export COMMIT_HASH=$COMMIT
export DEPLOY_VERSION=$(git describe --tags --always 2>/dev/null || echo "v0.0.0")

# 이전 이미지 태그 저장 (롤백용)
PREV_IMAGE=$(docker images Buykery_root_tower --format "{{.ID}}" | head -1 || true)

# 빌드 + 재시작
docker compose -f deploy/docker-compose.yml build tower nanoclaw
docker compose -f deploy/docker-compose.yml up -d --remove-orphans

# 헬스체크
echo "Waiting for tower health..."
for i in $(seq 1 12); do
  if curl -sf http://localhost:3000/webhook/health > /dev/null; then
    echo "Tower is healthy ✅ ($DEPLOY_VERSION @ $COMMIT_HASH)"
    # 이전 이미지 정리 (현재와 다를 때만)
    if [ -n "$PREV_IMAGE" ]; then
      CURR_IMAGE=$(docker images Buykery_root_tower --format "{{.ID}}" | head -1)
      if [ "$PREV_IMAGE" != "$CURR_IMAGE" ]; then
        docker rmi "$PREV_IMAGE" 2>/dev/null || true
      fi
    fi
    exit 0
  fi
  echo "  attempt $i/12…"
  sleep 5
done

echo "Health check failed ❌ — rolling back"

# 롤백: 이전 이미지가 있으면 태그 복원 후 재시작
if [ -n "$PREV_IMAGE" ]; then
  docker tag "$PREV_IMAGE" Buykery_root_tower:latest
  docker compose -f deploy/docker-compose.yml up -d tower nanoclaw
  echo "Rolled back to $PREV_IMAGE"
fi

exit 1
