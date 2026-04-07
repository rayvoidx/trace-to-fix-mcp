# trace-to-fix-mcp

Langfuse trace를 분석하여 실패 원인을 진단하고, 수정 계획을 생성하고, GitHub 이슈 초안까지 만드는 MCP 서버.

## 설치

```bash
git clone https://github.com/rayvoidx/trace-to-fix-mcp.git
cd trace-to-fix-mcp
npm install
npm run build
```

## 환경 변수

```bash
cp .env.example .env
```

`.env`를 열어서 Langfuse API 키를 입력합니다.

| 변수 | 필수 | 설명 |
|---|---|---|
| `LANGFUSE_PUBLIC_KEY` | O | Langfuse > Settings > API Keys |
| `LANGFUSE_SECRET_KEY` | O | 같은 곳에서 복사 |
| `LANGFUSE_BASE_URL` | O | `https://cloud.langfuse.com` 또는 self-hosted URL |
| `DEFAULT_PROJECT` | - | 기본 프로젝트명 |
| `DEFAULT_ENV` | - | 기본 환경 (`prod`, `staging`, `dev`) |
| `GITHUB_TOKEN` | - | GitHub PAT (이슈 생성 시 필요) |
| `ENABLE_GITHUB_WRITE` | - | `true`로 설정해야 실제 이슈 생성 |
| `SELF_TRACE_ENABLED` | - | `true`면 서버 자체 동작을 Langfuse에 기록 |

## MCP 클라이언트 연결

### Claude Code

프로젝트 루트의 `.mcp.json`이 자동으로 로드됩니다. 또는 `~/.claude/settings.json`에 추가:

```json
{
  "mcpServers": {
    "trace-to-fix": {
      "command": "node",
      "args": ["--env-file=/path/to/trace-to-fix-mcp/.env", "/path/to/trace-to-fix-mcp/dist/index.js"]
    }
  }
}
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "trace-to-fix": {
      "command": "node",
      "args": ["--env-file=/path/to/trace-to-fix-mcp/.env", "/path/to/trace-to-fix-mcp/dist/index.js"]
    }
  }
}
```

## 사용법

연결 후 Claude에게 자연어로 요청하면 됩니다.

```
"최근 24시간 prod에서 실패한 trace 분석해줘"
"어제 대비 오늘 품질이 떨어졌는지 확인해줘"
"프롬프트 v1.0과 v2.0 중 어느 게 나은지 비교해줘"
"이 클러스터의 체인에서 어디가 병목인지 찾아줘"
"gpt-4o 대신 gpt-4o-mini로 바꾸면 얼마나 절약되는지 알려줘"
"분석 결과를 GitHub 이슈로 만들어줘"
```

## 도구 목록

### 기본 분석

| 도구 | 설명 |
|---|---|
| `lf_list_failing_traces` | 실패 trace 목록 조회 (점수, latency, 에러 필터) |
| `lf_get_trace_bundle` | 특정 trace의 observations + scores 전체 조회 |
| `lf_group_failure_patterns` | 실패 trace를 fingerprint 기반 클러스터로 그룹화 |
| `lf_suggest_fix_plan` | 클러스터 기반 수정 계획 생성 |
| `gh_create_issue_draft` | GitHub 이슈 초안 생성 (dry_run 지원) |
| `export_markdown_report` | 분석 결과를 Markdown 보고서로 내보내기 |

### 심화 분석

| 도구 | 설명 |
|---|---|
| `lf_detect_regression` | 베이스라인 대비 품질/성능 회귀 탐지 (Cohen's d, Welch's t-test) |
| `lf_compare_prompt_versions` | 프롬프트 버전 간 통계적 A/B 비교 |
| `lf_analyze_chain` | observation 체인 병목/실패 지점 분석 |
| `lf_analyze_cost_quality` | 모델별 비용-품질 트레이드오프 분석 |
| `lf_detect_recurrence` | 이전에 해결된 실패 패턴의 재발 감지 |
| `lf_resolve_cluster` | 클러스터를 해결 완료로 표시 (재발 추적용) |

## 일반적인 분석 흐름

```
1. lf_list_failing_traces        → 실패 trace 수집
2. lf_detect_regression          → 최근 품질 변화 확인
3. lf_group_failure_patterns     → 패턴별 그룹화
4. lf_analyze_chain              → 병목 지점 파악
5. lf_compare_prompt_versions    → 프롬프트 버전 비교
6. lf_analyze_cost_quality       → 비용 최적화 기회 탐색
7. lf_suggest_fix_plan           → 수정 계획 생성
8. gh_create_issue_draft         → GitHub 이슈 초안
```

## 개발

```bash
npm run dev      # 개발 서버 (tsx)
npm run build    # TypeScript 컴파일
npm run test     # 테스트 (vitest)
npm run lint     # 타입 체크
```

## License

MIT
