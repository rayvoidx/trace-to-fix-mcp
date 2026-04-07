# Fix Experiment Plan

Generate an A/B testing and offline evaluation plan for the following fix proposal.

## Input
```json
{{fix_plan_json}}
```

## Requirements
1. Define baseline dataset extraction criteria
2. Specify control and treatment conditions
3. Define success metrics and thresholds
4. Outline evaluation steps
5. Include rollback criteria

## Output Format
- **Baseline**: how to extract the dataset
- **Control**: current behavior
- **Treatment**: proposed change
- **Metrics**: what to measure
- **Success criteria**: when to ship
- **Rollback criteria**: when to revert
