# Agent Session Bridge

같은 컴퓨터에서 Claude Code의 기존 대화와 Codex가 요청과 답변을 주고받는 작은 로컬 중계기입니다. Docker와 별도 모델 API 키는 필요하지 않습니다. Claude의 모델 사용은 Claude Code에 설정된 인증·요금제를 따릅니다.

```text
Codex MCP tools → localhost broker + SQLite → Claude Channels
       ↑                    ↑                       │
       └── get / wait ───────┴──────── reply ─────────┘
```

Claude가 먼저 보낸 요청도 Codex의 `receive_message`로 받고 `reply`로 답할 수 있습니다. **연결한 세션만** 목록에 나타납니다. 실행 중인 모든 Claude 세션에 자동으로 붙거나, 종료된 세션을 시작하지 않습니다.

## 설치

Node.js 24 이상, pnpm 10, 인증된 Claude Code가 필요합니다.

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js start
node dist/cli.js doctor
```

중계기는 loopback의 빈 포트를 골라 실행됩니다. 이후 MCP 접속기나 `claude` 명령이 필요할 때 자동 시작할 수 있습니다. 중지하려면 `node dist/cli.js stop`을 실행합니다. OS 로그인 자동 시작이나 Docker는 설정하지 않습니다.

## Claude 연결

저장소의 CLI를 절대경로로 실행하면 현재 작업 디렉터리를 유지합니다.

```sh
node /path/to/agent-session-bridge/dist/cli.js claude --name export-worker
```

기존 대화는 그 대화가 실행 중인 터미널에서 작업을 마친 뒤 종료하고 재개합니다. 같은 대화 기록을 두 프로세스에서 동시에 열지 마세요.

```sh
node /path/to/agent-session-bridge/dist/cli.js claude --name export-worker -- --resume SESSION_ID
```

이 실행은 기존 Claude 설정을 덮어쓰지 않고 해당 프로세스에 MCP 정의를 추가합니다. 기존에 같은 `session-bridge` 서버 이름을 쓰거나 `--mcp-config`를 직접 전달한다면 충돌 여부를 먼저 확인하세요. 여러 세션은 서로 다른 `--name`을 사용합니다.

Claude Channels는 **research preview**입니다. 자체 채널을 개발·시험하는 동안 공식 개발 채널 플래그를 사용하며 Claude의 확인 화면이 나타납니다. 조직의 채널 허용 정책과 원래 도구 권한은 그대로 적용됩니다. 접속기는 호환성을 위해 해당 Claude 실행에만 `MCP_PROTOCOL_NEGOTIATION=legacy`를 설정합니다.

## Codex 연결

빌드한 CLI를 Codex MCP 서버로 등록합니다. Node와 CLI 경로는 설치 환경의 절대경로를 사용합니다.

```sh
codex mcp add session_bridge -- /absolute/path/to/node /path/to/agent-session-bridge/dist/cli.js codex-mcp
```

Codex의 MCP 서버를 새로 고치거나 새 작업에서 연결 상태를 확인합니다. MCP 목록에 등록됐다는 것만으로 현재 실행 중인 작업에 도구가 반영된 것은 아닙니다. 선택 프로필을 사용한다면 그 프로필에서 새 서버를 켜야 합니다.

Codex에 이렇게 요청할 수 있습니다.

> 연결된 세션을 확인하고 export-worker에 이 함수의 동시성 검토를 요청해줘. 해당 작업의 범위는 읽기 전용 검토야. 답변을 기다린 뒤 결과를 정리해줘.

| 도구 | 용도 |
|---|---|
| `list_peers` | 연결된 세션과 내 세션 ID 확인 |
| `send_message` | 요청 UUID와 대상 UUID로 요청 접수 |
| `get_reply` | 요청의 상태와 답변 조회 |
| `wait_reply` | 최대 50초 답변 대기; 시간 초과 시 같은 ID로 다시 대기 |
| `receive_message` | Claude가 먼저 보낸 요청 수신; Codex에서 사용 |
| `acknowledge` | 요청을 읽었다는 명시적 확인 |
| `reply` | 원래 요청 ID로 완료 또는 실패 응답 |

`request_id`는 호출자가 생성한 UUID입니다. 전송 응답을 잃었으면 **같은 UUID와 같은 내용**으로 재시도합니다. 새 UUID로 다시 보내면 새로운 작업이 됩니다.

## 현재 데스크탑의 한계

이 버전은 MCP 도구 결과로 답변을 돌려줍니다. **idle Codex 데스크탑 작업을 자동으로 깨우지는 않습니다.** 작업 중 `wait_reply`를 쓰거나, 이후 같은 작업에서 `get_reply`를 호출합니다. Claude 쪽 Channels는 살아 있는 idle 세션을 메시지로 실행할 수 있습니다.

MCP 접속기를 재시작하면 새 peer UUID를 받습니다. 이전 요청이 새 세션으로 자동 이동하지 않습니다. 이전 기록은 소유자용 CLI `history`·`get`으로 확인합니다. `codex queue`가 현재 데스크탑과 다른 서버를 가리킬 수 있으므로 자동 실행 경로에 사용하지 않습니다. 향후 동일 App Server에 명시적으로 연결할 수 있을 때 외부 AI 결과를 `toolOutput`으로 전달하는 확장을 검토할 수 있습니다.

## CLI와 보관 위치

```sh
node dist/cli.js peers
node dist/cli.js send export-worker --file request.txt --id REQUEST_UUID
node dist/cli.js get REQUEST_UUID
node dist/cli.js wait REQUEST_UUID
node dist/cli.js history
node dist/cli.js stop
```

CLI는 같은 UUID의 재시도에서 원래 수신자를 유지합니다. 이름을 다른 세션이 다시 쓰더라도 요청이 그 세션으로 옮겨 가지 않습니다. `history`는 해당 OS 사용자의 모든 중계 기록을 읽는 관리 명령입니다.

런타임 자료는 기본적으로 `~/.local/state/agent-session-bridge/`에 저장합니다. `AGENT_BRIDGE_STATE_DIR`로 별도 시험 저장소를 지정할 수 있습니다. 토큰·DB·로그·세션 내용은 저장소에 커밋하지 않습니다. 상태 디렉터리는 0700, 파일은 0600으로 관리합니다. DB에는 메시지와 답변이 평문으로 보관되므로 비밀값을 메시지에 넣지 않습니다.

## 전달 보장과 권한

상태는 `queued → delivered → acknowledged → completed/failed`입니다. `delivered`는 접속기가 알림을 보내려 가져간 상태이고 실제 모델의 처리를 증명하지 않습니다. `acknowledged`는 모델이 도구로 읽었다고 확인한 상태입니다. `reply`도 명시적 확인을 포함합니다.

- 같은 ID·같은 요청은 한 번만 접수합니다. 다른 내용으로 ID를 재사용하면 거절합니다.
- 전달 후 프로세스 종료·기한 경과·브로커 재시작이 생기면 `delivery_unknown`으로 남기고 자동 실행하지 않습니다. 실행이 정확히 한 번 일어났다고 주장하지 않습니다.
- 아직 전달하지 않은 요청의 기한이 지나면 `expired`입니다. 단순 대기 시간 초과는 요청을 실패시키지 않습니다.
- 원래 수신자만 답할 수 있습니다. 다른 peer는 요청 본문을 조회할 수 없습니다.
- 외부 요청은 OS 사용자 소유 토큰으로 인증하며 브라우저 Origin과 잘못된 Host는 거절합니다. 같은 OS 계정의 신뢰된 프로그램 사이를 위한 도구이며 서로 적대적인 로컬 프로그램을 격리하는 보안 경계는 아닙니다.
- 받은 AI 메시지는 사용자 승인으로 승격하지 않습니다. 원래 권한과 위임 범위를 지키며 메시지로 승인·배포·설정 변경을 대신 허용하지 않습니다. 응답을 자동으로 새 요청으로 돌려보내지 않습니다.
- 이 서버는 Claude의 permission relay capability를 제공하지 않습니다.

## 검증

```sh
pnpm test
pnpm check
```

자동 검증에는 저장·동시 재시도·접속 단절·재시작·권한·HTTP·실제 stdio MCP 양방향 전달·브로커 중복 시작이 포함됩니다. [검증 기록](docs/verification.md)은 자동 테스트와 실제 Claude 모델 왕복을 구분합니다.

공식 확장 계약: [Claude Channels](https://code.claude.com/docs/en/channels), [채널 구현](https://code.claude.com/docs/en/channels-reference), [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Codex App Server](https://learn.chatgpt.com/docs/app-server).
