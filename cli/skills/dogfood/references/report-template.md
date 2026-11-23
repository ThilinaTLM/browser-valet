# Dogfood report: {APP NAME}

| Field | Value |
|---|---|
| Date | {DATE} |
| Target | {URL} |
| Scope | {SCOPE} |
| Session / browser | {SESSION}, {browser from `bvl status`} |

## Summary

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |
| **Total** | 0 |

By category: Functional 0 · UX 0 · Visual 0 · Console/network 0 · Accessibility 0 · Performance 0 · Content 0

Not tested (and why): {e.g. happy-path submits that would create real data}

---

## Issues

### ISSUE-001: {Short title}

| Field | Value |
|---|---|
| Severity | critical / high / medium / low |
| Category | functional / ux / visual / console-network / accessibility / performance / content |
| URL | {page where it happens} |

**Description**: {What is wrong, what was expected.}

**Repro steps** (interactive issues):

1. Open {URL}
   ![Step 1](screenshots/issue-001-step-1.png)
2. {Action}, e.g. click the "Save" button
   ![Step 2](screenshots/issue-001-step-2.png)
3. **Observe**: {what goes wrong}
   ![Result](screenshots/issue-001-result.png)

**Evidence** (static issues: one annotated screenshot; trim data to what matters):

![Issue](screenshots/issue-001.png)

```
{console / errors / `network request <id>` excerpt, if relevant}
```

---

<!-- Copy the ISSUE block for each further issue; delete the repro section for static issues. -->
