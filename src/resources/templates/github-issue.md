# GitHub Issue Template

## Summary
Failure cluster `{{cluster_id}}` with **{{size}}** traces.
Fingerprint: `{{fingerprint}}`

## Impact
- **Cluster size**: {{size}} traces
- **Priority score**: {{priority_score}}
- **Trace name**: {{trace_name}}
- **Route**: {{route}}

## Evidence
### Symptoms
{{#symptoms}}
- {{.}}
{{/symptoms}}

### Suspected Root Causes
{{#hypotheses}}
- **{{cause}}** (confidence: {{confidence}}%)
  {{#evidence}}
  - {{.}}
  {{/evidence}}
{{/hypotheses}}

## Representative Traces
{{#representative_trace_ids}}
- `{{.}}`
{{/representative_trace_ids}}

## Recommended Actions
{{#actions}}
{{priority}}. **[{{owner}}]** {{action}}
   - Expected impact: {{expected_impact}}
{{/actions}}

## Done Criteria
- [ ] correctness 평균 0.82 이상
- [ ] faithfulness 0.85 이상
- [ ] 동일 cluster 재발률 50% 이상 감소
- [ ] p95 latency 15% 이상 악화 없음
