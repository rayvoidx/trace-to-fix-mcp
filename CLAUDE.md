# Trace-to-Fix MCP Server

Langfuse 트레이스를 분석하여 장애 클러스터링, 원인 진단, 수정 계획 생성, GitHub 이슈 초안을 만드는 MCP 서버.

## 하네스 엔지니어링 4대 원칙

이 프로젝트는 컨텍스트 부패(context corruption)를 방지하기 위해 4가지 핵심 기둥을 코드 수준에서 강제한다.
참고: https://sshong.com/blog/20518

### 1. 아키텍처 제약 (Architecture Constraints)

**문서가 아닌 코드로 제약을 강제한다.**

- 모든 외부 입출력 경계에서 Zod 스키마로 데이터 구조 검증 (`src/validation/schemas.ts`)
- 도메인 불변조건을 코드로 강제 (`src/validation/invariants.ts`)
  - 클러스터 크기 일관성, confidence 범위 [0,1], 액션 우선순위 순차성 등
- 모듈 경계: `adapters/` (외부 API) → `diagnosis/` (분석 로직) → `server/` (MCP 핸들러) 단방향 의존
- `config/playbooks.yaml`로 휴리스틱 규칙을 선언적으로 관리

**코드 수정 시 반드시:**
- 새로운 외부 데이터 소스 추가 시 Zod 스키마를 먼저 정의할 것
- 도메인 규칙 변경 시 `invariants.ts`에 assertion 추가할 것
- `adapters/` 모듈이 `diagnosis/`나 `server/`에 직접 의존하지 않도록 할 것

### 2. 피드백 루프와 관찰 (Feedback Loop & Observability)

**에이전트가 결과를 스스로 검증하는 구조를 만든다.**

- 자기 관찰(Self-tracing): `src/observability/selfTrace.ts` — 서버 자체 분석 호출을 Langfuse에 기록
- 텔레메트리: `src/observability/telemetry.ts` — 내부 메트릭 수집
- Circuit Breaker: `src/validation/guardrails.ts` — 동일 실패 3회 반복 시 자동 차단
- 구조화된 로깅: `src/utils/logger.ts` (pino)

**코드 수정 시 반드시:**
- 새로운 tool 핸들러 추가 시 `selfTrace`로 감싸서 관찰 가능하게 할 것
- 외부 API 호출 실패 시 circuit breaker에 기록할 것
- 실패를 조용히 삼키지 말고 반드시 로깅할 것

### 3. 검증과 가드레일 (Validation & Guardrails)

**Generator(생성)와 Evaluator(검증)를 분리한다.**

- Generator: `src/diagnosis/` — 클러스터링, 원인 분석, 수정 계획 생성
- Evaluator: `src/validation/guardrails.ts` — 출력 품질 검증
  - `validateClusterOutput()`: 클러스터 무결성 검증
  - `validateFixPlanOutput()`: 수정 계획 완전성 검증
  - `validateIssueDraft()`: 이슈 초안 필수 섹션 확인
- `withGuardrail()` 래퍼로 모든 tool 출력에 자동 검증 적용
- Hard check(에러) vs Soft check(경고) 2단계 구분

**코드 수정 시 반드시:**
- 새로운 출력 타입 추가 시 대응하는 validator 함수를 작성할 것
- tool 핸들러 결과는 `withGuardrail()`을 통과시킬 것
- 이슈 본문에는 `## Summary`, `## Impact`, `## Evidence` 섹션이 필수

### 4. 지속적 문서화 (Living Documentation)

**이 CLAUDE.md 자체가 살아있는 규칙 파일이다.**

- 실패 경험을 발견하면 이 파일에 규칙으로 축적한다
- `config/playbooks.yaml`에 휴리스틱 규칙을 선언적으로 관리한다
- 작은 문서가 깊은 출처(코드)를 가리키게 한다

## 프로젝트 구조

```
src/
  adapters/          # 외부 시스템 연동 (Langfuse, GitHub)
    langfuse/        # Langfuse API 클라이언트 및 데이터 조회
    github/          # GitHub Issues 클라이언트
  diagnosis/         # 핵심 분석 로직
    normalize.ts     # 트레이스 정규화
    clustering.ts    # 장애 클러스터링
    heuristics.ts    # 휴리스틱 기반 원인 분석
    candidate.ts     # 후보 생성
    fixPlan.ts       # 수정 계획 생성
    priority.ts      # 우선순위 산정
  validation/        # 검증 레이어
    schemas.ts       # Zod 스키마 (아키텍처 제약)
    invariants.ts    # 도메인 불변조건 (코드 강제)
    guardrails.ts    # 출력 가드레일 (Generator/Evaluator 분리)
  observability/     # 관찰 가능성
    selfTrace.ts     # 자기 관찰 (Langfuse)
    telemetry.ts     # 텔레메트리
  server/            # MCP 서버
    mcpServer.ts     # 서버 및 tool 정의
    config.ts        # 설정 로딩
  storage/           # SQLite 캐시
  utils/             # 공통 유틸리티
  types.ts           # 공유 타입 정의
config/
  playbooks.yaml     # 휴리스틱 규칙 설정
```

## 개발 명령어

- `npm run build` — TypeScript 컴파일
- `npm run dev` — 개발 서버 (tsx)
- `npm run test` — 테스트 (vitest)
- `npm run lint` — 타입 체크

## 규칙

- Node.js >= 20, ESM (`"type": "module"`)
- import 경로에 `.js` 확장자 필수 (ESM 규칙)
- 환경 변수: `.env.example` 참고, 민감 정보는 절대 커밋하지 않는다
