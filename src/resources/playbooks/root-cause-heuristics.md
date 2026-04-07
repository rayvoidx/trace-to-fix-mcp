# Root Cause Heuristics

## Retrieval Quality Issue
- **When**: context_relevance < 0.65 AND retrieval_count ≤ 1
- **Likely cause**: 검색 필터가 너무 엄격하거나 reranker cutoff가 높음
- **Actions**: reranker cutoff 재검토, metadata filter 완화, embedding 모델 품질 확인

## Answer Grounding Issue
- **When**: context_relevance ≥ 0.65 AND faithfulness < 0.75
- **Likely cause**: 검색 결과는 적절하나 답변이 컨텍스트를 충분히 활용하지 않음
- **Actions**: 출처 인용 필수화, grounding check step 도입

## Over-Compression
- **When**: correctness < 0.7 AND conciseness > 0.85
- **Likely cause**: 과도한 요약으로 핵심 정보 누락
- **Actions**: 답변 최소 길이 기준 추가, 정보 누락 방지 규칙

## Infrastructure Latency
- **When**: latency > threshold AND quality scores normal
- **Likely cause**: GPU 가용성, 모델 서빙 병목, 네트워크 지연
- **Actions**: 타임아웃/배치 전략 점검, autoscaling 검토

## Prompt Bloat / Model Overuse
- **When**: cost > $0.05/call AND tokens > 4000
- **Likely cause**: 불필요한 context 포함, 과도한 system prompt
- **Actions**: 프롬프트 최적화, 모델 다운그레이드 평가
