# Diagnose Cluster

You are analyzing a failure cluster from an LLM application's production traces.

## Input
The following JSON represents a failure cluster:
```json
{{cluster_json}}
```

## Task
1. Review the symptoms, feature summary, and root cause hypotheses
2. Validate or refine the automated hypotheses
3. Identify any additional root causes the heuristics may have missed
4. Rank causes by likely impact and confidence
5. Suggest the single most important action to take first

## Output Format
- **Primary cause**: (one sentence)
- **Confidence**: (0-1)
- **Evidence**: (bullet list)
- **Recommended first action**: (specific, actionable)
- **Additional considerations**: (if any)
