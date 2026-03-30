# Bukery Platform

멀티봇 플랫폼. 예측 시장, 차익거래 등 다양한 온체인 트레이딩 봇을 단일 인프라에서 운영한다.
Telegram TUI로 제어하고, Lightsail에서 24시간 돌아간다.

---

## 전체 아키텍처

```
[Telegram]
     │
     ▼
NanoClaw  (Lightsail, Docker, 24h 데몬)
  ├─ group: main          ← 관리자 전용 (플랫폼 전체 제어)
  ├─ group: predict-bot   ← Predict.fun 봇 TUI
  └─ group: [bot-N]       ← 향후 봇 추가 시 그룹 추가
     │  ANTHROPIC_BASE_URL=localhost:20128
     ▼
9router  (Lightsail, localhost:20128)
  ├─ 1순위: Claude Code / Codex 구독 티어
  ├─ 2순위: DeepSeek, Groq (저가)
  └─ 3순위: Gemini CLI (무료, 월 180K)
     │
     ▼
Bukery Bot Platform  (TypeScript, Lightsail)
  ├─ platform/        ← 봇 공유 인프라
  └─ bots/
      └─ predict-fun/ ← Predict.fun 트레이딩 봇
           │  @predictdotfun/sdk + ethers v6
           ▼
      Predict.fun API (BNB Chain)
        ├─ api-testnet.predict.fun  (개발, API 키 불필요)
        └─ api.predict.fun          (프로덕션, API 키 필요)
```

---

## 레포지토리 구조

> **두 개의 레포로 분리**
> NanoClaw는 upstream 병합 관리가 필요하므로 별도 fork 레포로 운영.
> 봇 플랫폼 코드는 이 레포(`bukery-platform`)에서 관리.

```
bukery-platform/               ← 이 레포 (봇 코드)
│
├─ platform/                   ← 봇 공유 인프라
│   ├─ registry.ts             # BotRegistry — 봇 등록/시작/중지
│   ├─ scheduler.ts            # 전략 실행 주기 관리
│   ├─ wallet/
│   │   ├─ WalletManager.ts    # BNB Chain 지갑 (privateKey → ethers.Wallet)
│   │   └─ GasEstimator.ts     # 가스 추정
│   ├─ risk/
│   │   ├─ RiskManager.ts      # 최대 포지션, 일일 손실 한도
│   │   └─ CircuitBreaker.ts   # 연속 손실 시 자동 정지
│   └─ notify/
│       └─ TelegramNotifier.ts # NanoClaw IPC → predict-bot 그룹으로 알림
│
├─ bots/
│   └─ predict-fun/
│       ├─ adapter/
│       │   ├─ PredictFunClient.ts    # REST API 래퍼 (@predictdotfun/sdk)
│       │   ├─ OrderManager.ts        # 주문 생성/서명/제출
│       │   └─ MarketDataStream.ts    # WebSocket 실시간 오즈 구독
│       ├─ strategies/
│       │   ├─ BaseStrategy.ts        # 전략 인터페이스
│       │   ├─ TrendFollow.ts         # 첫 전략 (트렌드 팔로우)
│       │   └─ ValueBet.ts            # 두 번째 전략 (기대값 기반)
│       └─ PredictFunBot.ts           # 봇 메인 (strategy 주입)
│
├─ nanoclaw-config/            ← NanoClaw 그룹 설정 (별도 fork레포와 동기화)
│   └─ groups/
│       ├─ main/CLAUDE.md      # 관리자 에이전트 역할
│       └─ predict-bot/CLAUDE.md  # 봇 제어 인터페이스
│
├─ deploy/
│   ├─ docker-compose.yml      # nanoclaw + platform + 9router + nginx
│   ├─ nginx.conf.template     # Telegram webhook 수신 전용
│   └─ scripts/
│       ├─ setup.sh            # Lightsail 초기 세팅
│       └─ deploy.sh           # 배포 + 헬스체크 + 롤백
│
└─ .github/workflows/
    └─ deploy.yml              # push to main → 자동 배포
```

---

## NanoClaw 그룹 설계

### `groups/main/CLAUDE.md` — 플랫폼 관리자
```markdown
You are the Bukery Platform administrator.

## 권한
- 전체 봇 시작/중지/재시작
- 리스크 한도 조정
- 배포 트리거
- 전체 P&L 조회

## 명령어
- "predict-fun 시작/중지" → PredictFunBot.start()/stop()
- "잔액 조회" → WalletManager.getBalance()
- "일일 P&L" → RiskManager.getDailySummary()
- "리스크 한도 {금액}으로 설정" → RiskManager.setDailyLimit()
```

### `groups/predict-bot/CLAUDE.md` — 봇 전용 TUI
```markdown
You are the Predict.fun trading bot interface.

## 읽기 전용 권한
- 현재 포지션 조회
- 오픈 주문 목록
- 최근 거래 내역
- 전략 상태

## 명령어
- "/status" → 현재 상태 출력
- "/positions" → 보유 포지션
- "/orders" → 오픈 주문
- "/strategy {name}" → 전략 전환 (admin 승인 필요)
- "/pause" → 봇 일시 정지
- "/resume" → 재개

## 자동 알림 (TelegramNotifier)
- 포지션 진입/청산 시
- 일일 P&L 요약 (매일 오전 9시)
- 리스크 한도 80% 도달 시 경고
- 서킷 브레이커 발동 시 즉시 알림
```

---

## Predict.fun 연동 핵심 정보

### 인증 플로우
```typescript
// 1. 서명 메시지 수신 (매번 새로 받아야 함, 하드코딩 금지)
GET /v1/auth/message

// 2. 지갑으로 서명
const signature = await wallet.signMessage(message);

// 3. JWT 수신
GET /v1/auth/jwt?signature=...

// 4. 이후 모든 개인 API에 Bearer 토큰으로 사용
```

### 주문 생성 플로우 (`@predictdotfun/sdk`)
```typescript
import { OrderBuilder, ChainId, Side } from "@predictdotfun/sdk";
import { Wallet } from "ethers";

const signer = new Wallet(process.env.WALLET_PRIVATE_KEY);
const orderBuilder = await OrderBuilder.make(ChainId.BnbTestnet, signer);

// 최초 1회: 컨트랙트 승인
await orderBuilder.setApprovals();

// LIMIT 주문
const { makerAmount, takerAmount } = orderBuilder.getLimitOrderAmounts({
  side: Side.BUY,
  pricePerShareWei: 400000000000000000n,  // 0.4 USDT
  quantityWei: 10000000000000000000n,     // 10 shares
});

const order = orderBuilder.buildOrder("LIMIT", {
  maker: signer.address,
  signer: signer.address,
  side: Side.BUY,
  tokenId: "OUTCOME_TOKEN_ID",  // GET /markets 에서 조회
  makerAmount, takerAmount,
  nonce: 0n,
  feeRateBps: 0,  // GET /markets 에서 조회
});

const typedData = orderBuilder.buildTypedData(order, {
  isNegRisk: true,
  isYieldBearing: true,
});
const signedOrder = await orderBuilder.signTypedDataOrder(typedData);
// → POST /v1/orders
```

### 주요 컨트랙트 주소

**BNB Testnet (Chain ID: 97)**
```
CTF_EXCHANGE:          0x2A6413639BD3d73a20ed8C95F634Ce198ABbd2d7
NEG_RISK_CTF_EXCHANGE: 0xd690b2bd441bE36431F6F6639D7Ad351e7B29680
USDT:                  0xB32171ecD878607FFc4F8FC0bCcE6852BB3149E0
```

**BNB Mainnet (Chain ID: 56)**
```
YIELD_BEARING_CTF_EXCHANGE:          0x6bEb5a40C032AFc305961162d8204CDA16DECFa5
YIELD_BEARING_NEG_RISK_CTF_EXCHANGE: 0x8A289d458f5a134bA40015085A8F50Ffb681B41d
USDT:                                0x55d398326f99059fF775485246999027B3197955
```

---

## Docker Compose (Lightsail)

```yaml
# deploy/docker-compose.yml
services:
  platform:
    build: .
    restart: unless-stopped
    env_file: .env
    environment:
      NODE_ENV: production
    networks: [bukery]

  nine-router:
    image: node:24-alpine
    command: npx -y 9router
    restart: unless-stopped
    ports:
      - "127.0.0.1:20128:20128"
    networks: [bukery]

  nginx:
    image: nginx:alpine
    restart: unless-stopped
    environment:
      DOMAIN: ${DOMAIN}
    volumes:
      - ./nginx.conf.template:/etc/nginx/templates/default.conf.template:ro
      - /etc/letsencrypt:/etc/letsencrypt:ro
    ports: ["80:80", "443:443"]
    networks: [bukery]

networks:
  bukery:
    driver: bridge
```

> NanoClaw는 Docker Compose 외부에서 `systemctl --user`로 별도 실행
> (NanoClaw 자체가 Docker 컨테이너를 스폰하는 구조라 compose 내부 중첩이 불안정)

---

## 환경변수

```bash
# === Wallet ===
WALLET_PRIVATE_KEY=         # BNB Chain 지갑 개인키

# === Predict.fun ===
PREDICT_API_KEY=            # 메인넷 API 키 (테스트넷은 불필요)
PREDICT_ENV=testnet         # testnet | mainnet

# === NanoClaw (별도 .env) ===
ANTHROPIC_BASE_URL=http://localhost:20128   # 9router 경유
ANTHROPIC_API_KEY=          # 또는 CLAUDE_CODE_OAUTH_TOKEN
TELEGRAM_BOT_TOKEN=         # @BotFather에서 발급
ASSISTANT_NAME=Bukery

# === 공통 ===
LOG_LEVEL=info
```

---

## 작업 순서 (TODO)

### Phase 1 — 인프라 세팅 (코드 불필요, 환경 작업)

- [ ] Lightsail에 Docker + Node 24 설치
- [ ] 9router 설치: `npm install -g 9router` + systemd 서비스 등록
- [ ] NanoClaw fork: `gh repo fork qwibitai/nanoclaw --clone`
- [ ] NanoClaw `/setup` 실행 (Claude Code 내에서)
- [ ] NanoClaw `/add-telegram` 실행 → Telegram 봇 연결
- [ ] NanoClaw `.env` 설정:
  ```bash
  ANTHROPIC_BASE_URL=http://localhost:20128
  TELEGRAM_BOT_TOKEN=<token>
  ASSISTANT_NAME=Bukery
  ```
- [ ] NanoClaw 그룹 등록 (main, predict-bot)
- [ ] `groups/main/CLAUDE.md`, `groups/predict-bot/CLAUDE.md` 작성
- [ ] NanoClaw `systemctl --user enable/start nanoclaw`

### Phase 2 — Platform Core (코드 작업)

- [ ] `platform/registry.ts` — BotRegistry
- [ ] `platform/wallet/WalletManager.ts` — BNB 지갑 (ethers v6)
- [ ] `platform/risk/RiskManager.ts` — 포지션 한도, 일일 손실 한도
- [ ] `platform/risk/CircuitBreaker.ts` — 연속 손실 자동 정지
- [ ] `platform/notify/TelegramNotifier.ts` — NanoClaw IPC 연동
- [ ] `platform/scheduler.ts` — 전략 실행 루프

### Phase 3 — PredictFun Bot (코드 작업)

- [ ] `bots/predict-fun/adapter/PredictFunClient.ts`
  - 테스트넷 기준 (`api-testnet.predict.fun`, 키 불필요)
  - 마켓 목록, 오더북, 포지션 조회
- [ ] `bots/predict-fun/adapter/OrderManager.ts`
  - `@predictdotfun/sdk` + `ethers` v6
  - `setApprovals()` (최초 1회)
  - LIMIT / MARKET 주문 생성 + 서명 + 제출
- [ ] `bots/predict-fun/adapter/MarketDataStream.ts`
  - WebSocket 실시간 오즈 구독
- [ ] `bots/predict-fun/strategies/BaseStrategy.ts`
- [ ] `bots/predict-fun/strategies/TrendFollow.ts` — 첫 전략
- [ ] `bots/predict-fun/PredictFunBot.ts`

### Phase 4 — 통합 + 배포

- [ ] `deploy/docker-compose.yml` (platform + 9router + nginx)
- [ ] GitHub Actions CI/CD
- [ ] 테스트넷 E2E 테스트 (주문 → 체결 → 포지션 확인)
- [ ] 메인넷 전환 (API 키 + 실제 USDT)

---

## 확인 필요 사항

1. **거래 전략** — 어떤 기준으로 포지션 진입? (오즈 기준값, 특정 이벤트 카테고리, 자금 배분 방식)
2. **Predict.fun API 키** — Discord 티켓으로 신청 (테스트넷은 지금 바로 시작 가능)
3. **이 레포(Bukery-01) 처리** — 기존 Control Tower 코드 전체 교체 or 새 레포로 시작?
