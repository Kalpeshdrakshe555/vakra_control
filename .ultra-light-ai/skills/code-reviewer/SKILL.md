---
name: code-reviewer
description: Enforces strict code review standards, type safety, error boundaries, and zero placeholders.
trigger_rules: [review, audit, verify, refactor, quality]
---

# Code Reviewer Skill Instructions
When reviewing or refactoring code:
1. Ensure all function signatures have strict TypeScript/Python types.
2. Verify all async operations have proper try-catch or error-handling boundaries.
3. Prohibit any lazy ellipsis or placeholders (`// ...`).
4. Ensure minimal surgical diffs that preserve existing working conventions.
