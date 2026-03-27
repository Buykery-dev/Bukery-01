# Bukery Control Tower

멀티 AI 오케스트레이터. 프로덕션 에러를 자동 감지하고, Claude Code가 판단하며, Codex가 패치를 생성하고, 사람이 Telegram 버튼 하나로 머지한다.

---

## 아키텍처 개요

```
[프로덕션 서버]
    └─ app.log
         └─ OpenClo (openclo/agent.ts)
              └─ POST /webhook/alert
                   └─ AlertIngestFlow
                        ├─ ErrorFingerprint (중복 제거)
                        ├─ IssueQueue (dedup + cooldown)
                        └─ DecisionEngine ← claude-sonnet-4-6 (유일한 판단자)
                              ├─ assignTo: codex → PatchFlow
                              │    ├─ CodexAgent (OpenAI Codex)
                              │    ├─ GitHubClient → PR 자동 생성
                              │    ├─ DecisionEngine.reviewPatch() ← Claude Code 리뷰
                              │    └─ Telegram: Approve / Reject 버튼
                              ├─ assignTo: claude-code → Telegram 알림 (복잡한 변경)
                              └─ critical + requiresHumanApproval → CoworkDelegator
                                   ├─ GitHub Issue 자동 생성 (label: cowork-needed)
                                   └─ Telegram 알림
```

---

## 역할 분리

| 컴포넌트 | 역할 | 모델 |
|---|---|---|
| **DecisionEngine** | 유일한 판단자. 이슈 분석 → 담당 에이전트 지정 → 패치 리뷰 | claude-sonnet-4-6 |
| **CodexAgent** | 패치 실행자. 버그 수정 코드 생성 (< 50줄) | OpenAI Codex |
| **ClaudeAgent / GptAgent** | 조사 전용. 코드 변경 없이 분석만 | claude-sonnet-4-6 / gpt-4o |
| **CoworkDelegator** | 자동화 불가 시 Claude Cowork에 위임 | GitHub Issues + Telegram |
| **OpenClo** | 24시간 로그 감시. 에러 패턴 → Control Tower 알림 | — |

---

## 데이터 흐름 상세

### 1. 에러 감지 → 판단 (AlertIngestFlow)

```
OpenClo → POST /webhook/alert
  → ErrorFingerprint.fingerprint()     # SHA-256 8자 → 중복 이슈 식별
  → IssueQueue.upsert()                # 동일 fingerprint 5분 내 재발 → 무시
  → DecisionEngine.analyseIssue()      # Claude Code가 JSON 결정 반환
        {
          summary, recommendedAction,
          assignTo: "codex"|"claude-code"|"claude"|"gpt",
          priority: 1-5,
          requiresHumanApproval: bool,
          suggestedPrompt: "..."
        }
  → Telegram alert (formatIssueAlert)
        [🤖 Codex 패치 요청] [👀 Cowork 리뷰] [❌ 닫기] 버튼
```

### 2. 패치 생성 → PR → 머지 (PatchFlow)

```
Telegram 버튼 "Codex 패치 요청" 클릭
  → DecisionEngine 재확인 (codex/claude-code 적합한지)
  → CodexAgent.execute()               # OpenAI Codex가 { files, explanation } JSON 반환
  → DecisionEngine.reviewPatch()       # Claude Code가 diff 리뷰
  → GitHubClient.submitPatch()         # branch 생성 → commit → PR 오픈
  → Telegram: PR URL + 리뷰 결과
        [✅ Approve & Merge] [❌ Reject] 버튼

승인 버튼 클릭
  → GitHubClient.mergePR()             # squash merge
  → IssueQueue.updateStatus("approved")

거절 버튼 클릭
  → IssueQueue.updateStatus("open")    # 재오픈
```

### 3. 자동 위임 (CoworkDelegator)

위임 조건:
- `critical` severity + `requiresHumanApproval: true`
- Codex 패치 3회 실패
- 아키텍처 변경 필요 판단
- 전체 에이전트 예산 초과

위임 결과:
- GitHub Issue 자동 생성 (`cowork-needed` + `urgent` 라벨, 전체 컨텍스트 첨부)
- Telegram 알림 (이슈 링크 포함)

---

## 무한루프 방지

| 장치 | 동작 |
|---|---|
| ErrorFingerprint dedup | 동일 에러 fingerprint → 동일 IssueQueue 엔트리로 병합 |
| 5분 cooldown | 같은 fingerprint 5분 내 재발 → `null` 반환, 처리 스킵 |
| maxRetries: 3 | IssueQueue에 재시도 카운터, 초과 시 CoworkDelegator 위임 |
| requiresHumanApproval | true이면 자동 머지 절대 불가. Telegram 버튼 승인 필수 |

---

## 프로젝트 구조

```
Bukery-01/
├── src/
│   ├── agents/           # 5개 AI 에이전트 래퍼
│   │   ├── AgentRegistry.ts      # 에이전트 등록 + 가용성 확인
│   │   ├── BaseAgent.ts          # 공통 인터페이스
│   │   ├── ClaudeAgent.ts        # claude-sonnet-4-6
│   │   ├── ClaudeCodeAgent.ts    # claude-sonnet-4-6 (코드 특화)
│   │   ├── CodexAgent.ts         # OpenAI Codex (패치 실행자)
│   │   ├── GptAgent.ts           # gpt-4o
│   │   └── CursorAgent.ts        # stub (API 미공개)
│   │
│   ├── core/             # 오케스트레이션 엔진
│   │   ├── ControlTower.ts       # 태스크 실행 진입점 (Telegram 명령용)
│   │   ├── DecisionEngine.ts     # ★ 유일한 판단자 (Claude Code)
│   │   ├── TaskRouter.ts         # 태스크 타입 → 에이전트 선택
│   │   ├── ParallelExecutor.ts   # 병렬 실행 (p-limit)
│   │   ├── ResultEvaluator.ts    # 응답 품질 평가 (completeness/clarity/length/latency)
│   │   └── CostTracker.ts        # 일별/월별 비용 추적 + 예산 초과 차단
│   │
│   ├── flows/            # 비즈니스 파이프라인
│   │   ├── AlertIngestFlow.ts    # OpenClo 수신 → 분석 → Telegram 알림
│   │   ├── PatchFlow.ts          # Codex 패치 → PR → 머지
│   │   └── CommandFlow.ts        # Telegram 수동 명령 처리
│   │
│   ├── gateway/          # Telegram 인터페이스
│   │   ├── TelegramGateway.ts    # 봇 polling + 명령 핸들러
│   │   ├── TelegramFormatter.ts  # Telegram 메시지 포맷 (MarkdownV2)
│   │   └── CallbackQueryHandler.ts  # 인라인 버튼 콜백 처리
│   │
│   ├── github/
│   │   └── GitHubClient.ts       # GitHub REST API 직접 호출 (PR 생성/머지)
│   │
│   ├── cowork/
│   │   └── CoworkDelegator.ts    # 자동 위임 → GitHub Issue + Telegram
│   │
│   ├── monitor/
│   │   └── ErrorFingerprint.ts   # SHA-256 에러 fingerprint + 심각도 분류
│   │
│   ├── queue/
│   │   └── IssueQueue.ts         # 이슈 영속 저장 (JSON) + dedup + cooldown
│   │
│   ├── webhook/
│   │   ├── WebhookServer.ts      # native node:http 서버 (X-Webhook-Secret 검증)
│   │   └── WebhookRoutes.ts      # /webhook/* 라우트 dispatch
│   │
│   ├── config/
│   │   ├── index.ts              # Zod 환경변수 검증 + control-tower.json 로드
│   │   └── control-tower.json    # 에이전트 설정, 라우팅, 예산, 관찰설정
│   │
│   ├── types/            # TypeScript 인터페이스 전용
│   └── utils/            # logger (pino), retry 헬퍼
│
├── openclo/
│   └── agent.ts          # 로그 파일 tail → 에러 패턴 → POST /webhook/alert
│
├── deploy/
│   ├── docker-compose.yml        # tower + openclo + nginx
│   ├── nginx.conf.template       # envsubst 템플릿 (TOWER_DOMAIN)
│   ├── Dockerfile.openclo        # OpenClo 전용 이미지
│   └── scripts/
│       ├── setup.sh              # Lightsail 초기 세팅 (Docker, certbot, TLS)
│       └── deploy.sh             # 빌드 + 헬스체크 + 롤백
│
├── .github/workflows/
│   └── deploy.yml        # push to main → typecheck → build → SSH 배포 → Telegram 알림
│
├── Dockerfile            # Control Tower 이미지
├── .env.example          # 필요한 환경변수 목록
└── package.json          # ESM, TypeScript, tsx
```

---

## 환경변수 (.env)

`.env.example` 복사 후 값 입력:

```bash
cp .env.example .env
```

| 변수 | 필수 | 설명 |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | @BotFather에서 발급 |
| `TELEGRAM_ALERT_CHAT_ID` | ✅ | 알림 받을 채팅/그룹 ID |
| `ANTHROPIC_API_KEY` | ✅ | Claude (DecisionEngine) |
| `OPENAI_API_KEY` | ✅ | Codex (PatchFlow) |
| `GITHUB_TOKEN` | ✅ | PR 생성/머지 (repo 권한) |
| `GITHUB_OWNER` | ✅ | GitHub 유저명 또는 org |
| `GITHUB_REPO` | ✅ | 저장소 이름 |
| `WEBHOOK_SECRET` | ✅ | OpenClo ↔ Tower 공유 시크릿 |
| `WEBHOOK_PORT` | — | 기본 3000 |
| `TOWER_DOMAIN` | 배포 시 | nginx TLS 도메인 |
| `CURSOR_API_KEY` | — | stub, 현재 미사용 |

---

## GitHub Secrets (CI/CD)

`.github/workflows/deploy.yml` 자동 배포에 필요:

| Secret | 값 |
|---|---|
| `LIGHTSAIL_HOST` | Lightsail 인스턴스 퍼블릭 IP |
| `LIGHTSAIL_USER` | SSH 유저 (보통 `ubuntu`) |
| `LIGHTSAIL_SSH_KEY` | SSH 개인키 (PEM 전체 내용) |
| `TELEGRAM_BOT_TOKEN` | 위 .env와 동일 |
| `TELEGRAM_ALERT_CHAT_ID` | 위 .env와 동일 |

---

## 로컬 실행

```bash
npm install
cp .env.example .env   # API 키 입력 후
npm run dev            # tsx watch 모드
```

---

## 프로덕션 배포 (최초 1회)

```bash
# 1. Lightsail SSH 접속
ssh ubuntu@<LIGHTSAIL_HOST>

# 2. 저장소 클론
git clone https://github.com/buykery-dev/bukery-01.git /opt/bukery-01
cd /opt/bukery-01

# 3. 초기 세팅 (Docker + certbot + TLS)
bash deploy/scripts/setup.sh

# 4. .env 파일 생성
cp .env.example .env
nano .env   # 값 입력

# 5. 실행
bash deploy/scripts/deploy.sh
```

이후 `main` 브랜치에 push하면 GitHub Actions가 자동 배포.

---

## Telegram 명령어

| 명령어 | 동작 |
|---|---|
| `/compare <질문>` | Claude + GPT 병렬 비교 |
| `/code <질문>` | Claude Code + Codex 비교 |
| `/claude <질문>` | Claude 단독 |
| `/gpt <질문>` | GPT 단독 |
| `/cheap <질문>` | 가장 저렴한 에이전트 자동 선택 |
| `/merge <질문>` | 전체 에이전트 병렬 실행 후 최고 답변 선택 |

---

## 다음 할 일 (TODO)

### 즉시 가능 (코드 변경 없음)

- [ ] **GitHub Secrets 등록** — `LIGHTSAIL_HOST`, `LIGHTSAIL_USER`, `LIGHTSAIL_SSH_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALERT_CHAT_ID`
- [ ] **Lightsail 초기 세팅** — `bash deploy/scripts/setup.sh` (도메인 DNS 먼저 설정 필요)
- [ ] **`.env` 파일 작성** — `.env.example` 기준으로 API 키 입력
- [ ] **`openclaw.json` 생성** — 허용 Telegram 그룹 ID 등록

  ```json
  { "groupAllowFrom": [-100xxxxxxxxx] }
  ```

### 코드 작업 (Cowork 위임 가능)

- [ ] **IssueQueue 재시도 카운터** — 현재 `maxRetries` 설정은 있으나 `requestPatch()` 실패 시 카운터 증가 로직 미구현. `PatchFlow.ts`에 retry count 추적 + 초과 시 `CoworkDelegator` 호출 추가
- [ ] **PatchFlow 주석 정리** — `PatchFlow.ts:11` "n8n 없이 직접 처리" 주석 제거
- [ ] **ControlTower.buildTask() 타입** — `buildTask()`의 반환 타입과 `CommandFlow`에서 쓰는 `Task` 인터페이스 일치 여부 통합 테스트 필요
- [ ] **Codex 응답 구조 검증** — `PatchFlow.ts:66` `jsonMatch` 파싱 실패 시 에러 메시지가 부정확함. Zod 스키마로 응답 검증 추가
- [ ] **CostTracker 예산 초과 시 자동 위임** — `CostTracker`가 예산 초과를 감지하면 `CoworkDelegator.delegate({ reason: 'all_agents_over_budget' })`를 호출하도록 연결 필요
- [ ] **OpenClo 로그 경로 설정** — `deploy/docker-compose.yml`의 `LOG_PATH: /var/log/bukery/app.log`를 실제 앱 로그 경로로 수정

### 선택적 개선

- [ ] **단위 테스트** — `ErrorFingerprint`, `IssueQueue`, `DecisionEngine` mock 테스트
- [ ] **다중 서비스 모니터링** — OpenClo가 현재 단일 로그 파일만 감시. 여러 서비스 지원 시 `SERVICE_NAME` 배열화 필요
- [ ] **이슈 히스토리 UI** — 현재 Telegram 알림만 있음. 간단한 `/status` 명령으로 열린 이슈 목록 출력
