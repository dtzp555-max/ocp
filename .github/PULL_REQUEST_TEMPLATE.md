# Pull Request

## Summary

<!-- One or two sentences describing the change and why it is in scope for OCP. -->

## Claude Code Alignment Evidence (REQUIRED)

Per `ALIGNMENT.md`, every PR that touches `server.mjs` or any network-facing surface must fill out this section. PRs with this section blank or unchecked will receive a `request changes` review and cannot be merged.

- [ ] **Corresponding `cli.js` reference.** I have identified the `cli.js` function and line range that performs the operation this PR forwards. Citation (format `cli.js:NNNN` or `cli.js vE4 <functionName>`):
  <!-- e.g. cli.js:18423-18467 (function: sendUserMessage)  -->

- [ ] **If `cli.js` does not perform this operation**, I have stated this explicitly below and justified the scope under `ALIGNMENT.md` Rule 2. (Note: in almost all cases this means the PR should be closed, not merged. Proxy layers do not invent endpoints.)
  <!-- Justification, if applicable. Empty is fine when cli.js does perform the operation. -->

- [ ] **Commit message citations.** Every "Claude Code uses X" or "cli.js uses X" assertion in every commit of this PR is immediately followed by a `cli.js:NNNN` or `cli.js vE4 <functionName>` citation. I have verified this by rereading each commit message.

## Type of change

- [ ] Bug fix (alignment with existing `cli.js` behavior)
- [ ] Feature (new `cli.js` behavior now surfaced through OCP)
- [ ] Refactor (no wire-level behavior change)
- [ ] Deletion (unalignable feature removal per `ALIGNMENT.md` Unalignable Policy)
- [ ] Documentation / governance

## Reviewer checklist

Reviewers: this section is for you, not the author. Do not approve until every box is checked.

- [ ] I opened `cli.js` at the cited line range and confirmed the operation matches.
- [ ] I ran (or confirmed CI ran) `.github/workflows/alignment.yml` and it passed.
- [ ] I am not the commit author of any commit in this PR (Iron Rule 10).
- [ ] If the PR asserts scope without a `cli.js` citation, I confirmed the justification is sound per `ALIGNMENT.md` Rule 2.

## Related

- `ALIGNMENT.md` Rule(s) invoked: <!-- e.g. Rule 3 -->
- Related issue / prior PR: <!-- #NNN -->
- Historical lesson reference (if relevant): <!-- e.g. 2026-04-11 drift, b87992f -->
